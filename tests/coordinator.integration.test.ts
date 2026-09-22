import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startApplication, type Application } from '../server/main.js';
import { loadSettings } from '../server/config/settings.js';
import { createCodexRunner } from '../server/codex/adapter.js';
import { openStore } from '../server/store/task-store.js';
import type { Task, HumanAction } from '../shared/contracts.js';

const roots: string[] = [];
const apps: Application[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No ephemeral port');
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  return address.port;
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'symphony-lifecycle-')); roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const localRoot = join(root, 'local');
  await Promise.all([mkdir(join(workspaceRoot, 'projects'), { recursive: true }),
    mkdir(join(workspaceRoot, 'roles'), { recursive: true }), mkdir(localRoot)]);
  await writeFile(join(workspaceRoot, 'projects/projects.json'), '{"projects":[]}');
  await writeFile(join(workspaceRoot, 'roles/roles.json'), JSON.stringify({ roles: [
    { role: 'triage', instructions: 'Fixture triage', skills: [], cliProfile: 'triage', actions: ['read'] },
    { role: 'researcher', instructions: 'Fixture research', skills: [], cliProfile: 'researcher', actions: ['read'] },
  ] }));
  const port = await unusedPort();
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ workspaceRoot, localRoot, codexBinary: process.execPath,
    port, allowedOrigin: `http://127.0.0.1:${port}`, scanMs: 25, stableMs: 1, stopGraceMs: 100 }));
  const settings = await loadSettings(configPath);
  const runner = createCodexRunner(settings, { executable: process.execPath,
    prefixArgs: [resolve('server/testing/lifecycle-cli.mjs')] });
  const buildDir = join(root, 'build');
  await mkdir(join(buildDir, 'assets'), { recursive: true });
  await writeFile(join(buildDir, 'index.html'), '<h1>Integration fixture</h1>');
  const app = await startApplication({ configPath, buildDir, runner, verifyCapabilities: async () => {} });
  apps.push(app);
  return { root, workspaceRoot, localRoot, app, configPath, buildDir, runner };
}
async function until<T>(read: () => Promise<T>, test: (value: T) => boolean, label: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (test(value)) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function tasks(app: Application): Promise<Task[]> {
  const response = await fetch(`${app.address}/api/workspace`);
  expect(response.ok).toBe(true);
  return ((await response.json()) as { tasks: Task[] }).tasks;
}
async function command(app: Application, task: Task, action: HumanAction, requestId = crypto.randomUUID()): Promise<Response> {
  return fetch(`${app.address}/api/tasks/${task.id}/commands`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: app.address },
    body: JSON.stringify({ taskId: task.id, expectedRevision: task.revision, requestId, action }) });
}
async function taskAt(app: Application, id: string, status: Task['status']): Promise<Task> {
  return until(async () => {
    const response = await fetch(`${app.address}/api/tasks/${id}`);
    return await response.json() as Task;
  }, task => task.status === status, `${id} ${status}`);
}
function approval(task: Task): HumanAction {
  const review = task.reviews.find(item => item.decision === null);
  if (!review) throw new Error('No pending approval');
  return { kind: 'approve', reviewId: review.id, artifactDigests: review.artifacts.map(item => item.digest) };
}
async function submitFile(workspaceRoot: string, app: Application, idea: string): Promise<Task> {
  await mkdir(join(workspaceRoot, 'drafts'), { recursive: true });
  await writeFile(join(workspaceRoot, 'drafts', 'idea.md'), idea);
  const list = await until(() => tasks(app), value => value.length === 1 && value[0].status === 'waiting-for-human', 'first review');
  return list[0];
}
async function nextReview(app: Application, id: string, kind: 'workflow' | 'artifact' | 'question', after = 0): Promise<Task> {
  return until(async () => (await tasks(app)).find(item => item.id === id)!,
    task => task.status === 'waiting-for-human' && task.reviews.filter(review => review.kind === kind && review.decision === null).length > 0 && task.revision > after,
    `${kind} review`);
}
async function countRuns(app: Application, id: string, stepId: string): Promise<number> {
  const task = (await tasks(app)).find(item => item.id === id)!;
  return task.runs.filter(run => run.stepId === stepId).length;
}

it('persists intake through triage, HTTP approvals, fake CLI research, final review and reopen', async () => {
  const { workspaceRoot, app } = await setup();
  const idea = '# Lifecycle idea\n\nA free-form Markdown draft.\n';
  const triaged = await submitFile(workspaceRoot, app, idea);
  expect(triaged.reviews[0].kind).toBe('workflow');
  expect(triaged.runs.filter(run => run.stepId === '$triage')).toHaveLength(1);
  expect((await command(app, triaged, approval(triaged))).status).toBe(200);
  const reviewed = await taskAt(app, triaged.id, 'waiting-for-human');
  const findingsReview = await until(async () => (await tasks(app)).find(item => item.id === triaged.id)!,
    task => task.reviews.some(review => review.kind === 'artifact' && review.decision === null), 'findings review');
  expect(findingsReview.runs.filter(run => run.stepId === 'research')).toHaveLength(1);
  expect((await command(app, findingsReview, approval(findingsReview))).status).toBe(200);
  const done = await taskAt(app, triaged.id, 'done');
  expect(done.runs.filter(run => run.stepId === 'research')).toHaveLength(1);
  expect((await readdir(join(workspaceRoot, 'done', triaged.id, 'events'))).length).toBeGreaterThan(5);
  expect(JSON.parse(await readFile(join(workspaceRoot, 'done', triaged.id, 'task.json'), 'utf8')).status).toBe('done');
  expect(await readFile(join(workspaceRoot, 'done', triaged.id, 'idea.md'), 'utf8')).toBe(idea);
  const reopened = await openStore(workspaceRoot);
  expect((await reopened.get(triaged.id)).status).toBe('done');
  expect((await reopened.get(triaged.id)).runs.filter(run => run.stepId === 'research')).toHaveLength(1);
  expect(reviewed.id).toBe(triaged.id);
});

it('keeps two clarification turns distinct before workflow approval', async () => {
  const { workspaceRoot, app } = await setup();
  let task = await submitFile(workspaceRoot, app, '# Clarify [two-questions]\n\nChoose twice.');
  for (const answer of ['first', 'second']) {
    expect(task.reviews.at(-1)?.kind).toBe('question');
    const revision = task.revision;
    expect((await command(app, task, { kind: 'answer', reviewId: task.reviews.at(-1)!.id, text: answer })).status).toBe(200);
    task = await nextReview(app, task.id, answer === 'first' ? 'question' : 'workflow', revision);
  }
  expect(task.runs.filter(run => run.stepId === '$triage')).toHaveLength(3);
  expect(task.reviews.filter(review => review.kind === 'question')).toHaveLength(2);
  expect((await command(app, task, approval(task))).status).toBe(200);
  const findings = await nextReview(app, task.id, 'artifact', task.revision);
  expect((await command(app, findings, approval(findings))).status).toBe(200);
  expect((await taskAt(app, task.id, 'done')).runs.filter(run => run.stepId === 'research')).toHaveLength(1);
}, 15_000);

it('repeats research after feedback with a new artifact, rejecting stale approval', async () => {
  const { workspaceRoot, localRoot, app } = await setup();
  const proposed = await submitFile(workspaceRoot, app, '# Changes loop\n\nReview findings.');
  expect((await command(app, proposed, approval(proposed))).status).toBe(200);
  const first = await nextReview(app, proposed.id, 'artifact', proposed.revision);
  expect(first.reviews.at(-1)?.artifacts[0].version).toBe(1);
  const oldApproval = approval(first);
  expect((await command(app, first, { kind: 'changes', reviewId: first.reviews.at(-1)!.id, text: 'Add detail' })).status).toBe(200);
  const stale = await command(app, first, oldApproval);
  expect(stale.status).toBe(409);
  const second = await until(async () => (await tasks(app))[0], task => task.status === 'waiting-for-human' &&
    task.reviews.some(review => review.kind === 'artifact' && review.decision === null && review.artifacts[0]?.version === 2), 'revised artifact');
  expect(second.runs.filter(run => run.stepId === 'research')).toHaveLength(2);
  expect(second.reviews.at(-1)?.artifacts[0].digest).not.toBe(first.reviews.at(-1)?.artifacts[0].digest);
  expect((await command(app, second, approval(second))).status).toBe(200);
  expect((await taskAt(app, proposed.id, 'done')).runs.filter(run => run.stepId === 'research')).toHaveLength(2);
  expect(await readFile(join(localRoot, 'tasks', proposed.id, 'research-count.txt'), 'utf8')).toBe('2');
});

it('pauses an active child-process run without accepting its late completion', async () => {
  const { workspaceRoot, localRoot, app } = await setup();
  const proposed = await submitFile(workspaceRoot, app, '# Slow [slow-child]\n\nPause me.');
  expect((await command(app, proposed, approval(proposed))).status).toBe(200);
  await until(async () => (await tasks(app))[0], task => task.status === 'running' &&
    task.runs.some(run => run.stepId === 'research' && run.phase === 'running'), 'registered child run');
  await until(async () => readFile(join(localRoot, 'tasks', proposed.id, 'child-pid.txt'), 'utf8').catch(() => ''), value => Boolean(value), 'child spawn');
  const running = await until(async () => (await tasks(app))[0], task => task.status === 'running' &&
    task.runs.some(run => run.stepId === 'research' && run.phase === 'running'), 'stable registered run');
  expect((await command(app, running, { kind: 'pause' })).status).toBe(200);
  const paused = await taskAt(app, proposed.id, 'waiting-for-human');
  expect(paused.reviews.at(-1)?.kind).toBe('pause');
  expect(paused.runs.filter(run => run.stepId === 'research')).toHaveLength(1);
  expect(paused.runs.at(-1)?.result).toBeNull();
  await new Promise(resolveWait => setTimeout(resolveWait, 100));
  expect(await countRuns(app, proposed.id, 'research')).toBe(1);
});

it('reopens after final fake output but before human acceptance without redispatch', async () => {
  const { workspaceRoot, app, configPath, buildDir, runner } = await setup();
  const proposed = await submitFile(workspaceRoot, app, '# Restart boundary\n\nPersist result.');
  expect((await command(app, proposed, approval(proposed))).status).toBe(200);
  const pending = await nextReview(app, proposed.id, 'artifact', proposed.revision);
  await app.close(); apps.splice(apps.indexOf(app), 1);
  const reopened = await startApplication({ configPath, buildDir, runner, verifyCapabilities: async () => {} });
  apps.push(reopened);
  const stable = await nextReview(reopened, proposed.id, 'artifact');
  expect(stable.runs.filter(run => run.stepId === 'research')).toHaveLength(1);
  expect((await command(reopened, stable, approval(stable))).status).toBe(200);
  expect((await taskAt(reopened, proposed.id, 'done')).runs.filter(run => run.stepId === 'research')).toHaveLength(1);
  expect(pending.id).toBe(stable.id);
});

it('recovers an exited fake CLI whose final output was written before acceptance, invoking research exactly twice', async () => {
  const { root, workspaceRoot, localRoot, app, configPath, buildDir, runner } = await setup();
  const proposed = await submitFile(workspaceRoot, app, '# Output boundary\n\nCrash after final output.');
  await app.close(); apps.splice(apps.indexOf(app), 1);
  await promisify(execFile)(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json']);
  const marker = join(root, 'result-held.json');
  const child = spawn(process.execPath, ['server/testing/held-application.mjs', configPath, buildDir, marker], {
    cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childOutput = '';
  let childClosed = false;
  const childDone = new Promise<void>(resolveClose => child.once('close', () => { childClosed = true; resolveClose(); }));
  child.stderr?.on('data', chunk => { childOutput += String(chunk); });
  try {
    await until(async () => {
      if (childClosed) throw new Error(`held app exited: ${childOutput}`);
      return fetch(`${app.address}/api/health`).then(response => response.ok).catch(() => false);
    }, Boolean, 'held application startup');
    expect((await command(app, proposed, approval(proposed))).status).toBe(200);
    const held = await until(async () => readFile(marker, 'utf8').then(JSON.parse).catch(() => null) as Promise<{ taskId: string; runId: string } | null>,
      value => Boolean(value), 'validated final output before acceptance');
    expect(held?.taskId).toBe(proposed.id);
    const finalPath = join(localRoot, 'tasks', proposed.id, 'runs', held!.runId, `${held!.runId}.final.json`);
    expect(JSON.parse(await readFile(finalPath, 'utf8')).kind).toBe('completed');
    const before = await until(async () => JSON.parse(await readFile(join(workspaceRoot, 'active', proposed.id, 'task.json'), 'utf8')) as Task,
      task => task.runs.some(run => run.id === held!.runId && run.phase === 'running'), 'persisted running state');
    expect(before.runs.find(run => run.id === held!.runId)?.phase).toBe('running');
    expect(before.runs.find(run => run.id === held!.runId)?.result).toBeNull();
    expect(await readFile(join(localRoot, 'tasks', proposed.id, 'research-count.txt'), 'utf8')).toBe('1');
    child.kill('SIGKILL');
    await childDone;
    const reopened = await startApplication({ configPath, buildDir, runner, verifyCapabilities: async () => {} });
    apps.push(reopened);
    const reviewed = await nextReview(reopened, proposed.id, 'artifact');
    expect(reviewed.runs.filter(run => run.stepId === 'research')).toHaveLength(2);
    expect(reviewed.runs.find(run => run.id === held!.runId)?.result).toBeNull();
    expect(await readFile(join(localRoot, 'tasks', proposed.id, 'research-count.txt'), 'utf8')).toBe('2');
    expect((await command(reopened, reviewed, approval(reviewed))).status).toBe(200);
    expect((await taskAt(reopened, proposed.id, 'done')).runs.filter(run => run.stepId === 'research')).toHaveLength(2);
    expect(await readFile(join(localRoot, 'tasks', proposed.id, 'research-count.txt'), 'utf8')).toBe('2');
  } finally {
    if (!childClosed) {
      child.kill('SIGKILL');
      await childDone;
    }
  }
});

it('preserves changed intake source as a conflict without another launch', async () => {
  const { workspaceRoot, app } = await setup();
  const proposed = await submitFile(workspaceRoot, app, '# Original\n\nKeep it.');
  await writeFile(join(workspaceRoot, 'drafts', 'idea.md'), '# Changed\n\nConflict.');
  await until(async () => (await (await fetch(`${app.address}/api/workspace`)).json()) as { issues: Array<{ message: string }> },
    view => view.issues.some(issue => issue.message.includes('conflict')), 'intake conflict');
  expect((await tasks(app))).toHaveLength(1);
  expect(await countRuns(app, proposed.id, '$triage')).toBe(1);
  expect(await countRuns(app, proposed.id, 'research')).toBe(0);
});

it('refuses an approval when its event directory cannot be written', async () => {
  const { workspaceRoot, localRoot, app } = await setup();
  const proposed = await submitFile(workspaceRoot, app, '# Write failure\n\nStop on persistence error.');
  const taskDir = join(workspaceRoot, 'active', proposed.id);
  await rename(join(taskDir, 'events'), join(taskDir, 'events-held'));
  await writeFile(join(taskDir, 'events'), 'A file blocks event publication');
  const response = await command(app, proposed, approval(proposed));
  expect(response.status).toBe(503);
  await new Promise(resolveWait => setTimeout(resolveWait, 100));
  const snapshot = JSON.parse(await readFile(join(taskDir, 'task.json'), 'utf8')) as Task;
  expect(snapshot.runs.filter(run => run.stepId === 'research')).toHaveLength(0);
  expect(snapshot.reviews.at(-1)?.decision).toBeNull();
  await expect(readFile(join(localRoot, 'tasks', proposed.id, 'research-count.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});


it('reviews versioned evidence-only reports after a meaningful fresh question handoff and restart', async () => {
  const { workspaceRoot, localRoot, app } = await setup();
  let task = await submitFile(workspaceRoot, app, '# Evidence lifecycle [context-handoff] [evidence-only]');
  expect(task.reviews.at(-1)?.prompt).toBe('Choose ALPHA or BETA?');
  expect((await command(app, task, { kind: 'answer', reviewId: task.reviews.at(-1)!.id, text: 'BETA' })).status).toBe(200);
  task = await nextReview(app, task.id, 'workflow', task.revision);
  expect((await command(app, task, approval(task))).status).toBe(200);
  const first = await nextReview(app, task.id, 'artifact', task.revision);
  const report = first.reviews.at(-1)!.artifacts[0];
  expect(report.version).toBe(1);
  const firstRun = first.runs.at(-1)!;
  const final = JSON.parse(await readFile(join(localRoot, 'tasks', task.id, 'runs', firstRun.id, `${firstRun.id}.final.json`), 'utf8'));
  expect(final.artifacts).toEqual([]);
  await expect(readFile(join(localRoot, 'tasks', task.id, 'runs', firstRun.id, 'findings.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await (await fetch(`${app.address}/api/tasks/${task.id}/artifacts/findings?version=1`)).text()).toContain('Unique report detail');
  expect((await command(app, first, { kind: 'changes', reviewId: first.reviews.at(-1)!.id, text: 'Add detail' })).status).toBe(200);
  const second = await nextReview(app, task.id, 'artifact', first.revision);
  expect(second.reviews.at(-1)!.artifacts[0].version).toBe(2);
  expect(second.reviews.at(-1)!.artifacts[0].digest).not.toBe(report.digest);
  expect((await command(app, second, approval(second))).status).toBe(200);
  await taskAt(app, task.id, 'done');
  const reopened = await openStore(workspaceRoot);
  const saved = await reopened.get(task.id);
  expect(saved.status).toBe('done');
  expect(saved.artifacts.map(ref => ref.version)).toEqual([1, 2]);
});
