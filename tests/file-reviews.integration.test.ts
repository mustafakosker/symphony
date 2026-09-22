import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startApplication, type Application } from '../server/main.js';
import { loadSettings } from '../server/config/settings.js';
import { createCodexRunner } from '../server/codex/adapter.js';
import { openStore } from '../server/store/task-store.js';
import { waitingTask } from '../server/testing/fixtures.js';
import { makeRequest, renderDraft } from '../server/file-reviews/document.js';
import { loadRecords } from '../server/file-reviews/io.js';
import { matchesBinding } from '../server/file-reviews/model.js';
import type { Task } from '../shared/contracts.js';

const roots: string[] = [];
const apps: Application[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>(done => server.close(() => done()));
  return address.port;
}
async function setup(enabled: boolean, beforeStart?: (workspaceRoot: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'symphony-file-reviews-app-')); roots.push(root);
  const workspaceRoot = join(root, 'workspace'); const localRoot = join(root, 'local');
  await Promise.all([mkdir(join(workspaceRoot, 'projects'), { recursive: true }),
    mkdir(join(workspaceRoot, 'roles'), { recursive: true }), mkdir(localRoot)]);
  await writeFile(join(workspaceRoot, 'projects/projects.json'), '{"projects":[]}');
  await writeFile(join(workspaceRoot, 'roles/roles.json'), JSON.stringify({ roles: [
    { role: 'triage', instructions: 'Fixture triage', skills: [], cliProfile: 'triage', actions: ['read'] },
    { role: 'researcher', instructions: 'Fixture research', skills: [], cliProfile: 'researcher', actions: ['read'] },
  ] }));
  await beforeStart?.(workspaceRoot);
  const port = await unusedPort(); const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ workspaceRoot, localRoot, codexBinary: process.execPath,
    port, allowedOrigin: `http://127.0.0.1:${port}`, scanMs: 25, stableMs: 1, stopGraceMs: 100,
    fileReviewsEnabled: enabled }));
  const settings = await loadSettings(configPath);
  const runner = createCodexRunner(settings, { executable: process.execPath,
    prefixArgs: [resolve('server/testing/lifecycle-cli.mjs')] });
  const buildDir = join(root, 'build'); await mkdir(join(buildDir, 'assets'), { recursive: true });
  await writeFile(join(buildDir, 'index.html'), '<h1>Fixture</h1>');
  const app = await startApplication({ configPath, buildDir, runner, verifyCapabilities: async () => {} });
  apps.push(app);
  return { workspaceRoot, localRoot, app };
}
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read(); if (check(value)) return value;
    await new Promise(done => setTimeout(done, 25));
  }
  throw new Error('Timed out waiting for file review');
}
async function workspace(app: Application): Promise<{ tasks: Task[]; issues: { message: string }[] }> {
  return await (await fetch(`${app.address}/api/workspace`)).json();
}

async function pendingReview(app: Application, id: string, kind: 'question' | 'workflow' | 'artifact', after = -1): Promise<Task> {
  return until(async () => (await workspace(app)).tasks.find(task => task.id === id)!, task =>
    task.revision > after && task.reviews.some(review => review.kind === kind && review.decision === null));
}

async function draftFor(workspaceRoot: string, text: string): Promise<string> {
  const names = await until(() => readdir(join(workspaceRoot, 'reviews')).catch(() => [] as string[]), asyncNames =>
    asyncNames.some(name => name.endsWith('.md') && !name.endsWith('.ready.md') && !name.endsWith('.receipt.md')));
  for (const name of names.filter(name => name.endsWith('.md') && !name.endsWith('.ready.md') && !name.endsWith('.receipt.md'))) {
    const path = join(workspaceRoot, 'reviews', name);
    if ((await readFile(path, 'utf8')).includes(text)) return path;
  }
  return until(async () => {
    const files = await readdir(join(workspaceRoot, 'reviews'));
    for (const name of files.filter(name => name.endsWith('.md') && !name.endsWith('.ready.md') && !name.endsWith('.receipt.md'))) {
      const path = join(workspaceRoot, 'reviews', name);
      if ((await readFile(path, 'utf8')).includes(text)) return path;
    }
    return '';
  }, Boolean);
}

async function submit(workspaceRoot: string, draft: string, action: string, body = ''): Promise<string> {
  const original = await readFile(draft, 'utf8');
  const response = `action: ${action}\n\n${body}`;
  await writeFile(draft, original.replace(/action: (?:answer)?\n\n[\s\S]*$/, response));
  const ready = draft.replace(/\.md$/, '.ready.md');
  const submitted = await readFile(draft, 'utf8');
  await rename(draft, ready);
  const receipt = await until(() => readFile(ready.replace('.ready.md', '.receipt.md'), 'utf8').catch(() => ''), Boolean);
  expect(receipt).toContain('# Review receipt: Accepted');
  expect(receipt.split('## Processed response\n')[1].match(/^(`{3,})\n([\s\S]*?)\n\1\n$/)?.[2]).toBe(submitted);
  return receipt;
}

it('completes questions, workflow and exact artifact approvals through saved files', async () => {
  const { workspaceRoot, localRoot, app } = await setup(true);
  await mkdir(join(workspaceRoot, 'drafts'));
  await writeFile(join(workspaceRoot, 'drafts', 'lifecycle.md'), '# Lifecycle [context-handoff]\n');
  const created = await until(async () => (await workspace(app)).tasks[0], Boolean);
  let previous = -1;
  const answer = 'BETA';
  {
    const task = await pendingReview(app, created.id, 'question', previous);
    const review = task.reviews.find(item => item.kind === 'question' && item.decision === null)!;
    const draft = await draftFor(workspaceRoot, 'Choose ALPHA or BETA?');
    expect((await loadRecords(localRoot)).records.find(item => draft.includes(item.basename))?.binding.taskRevision).toBe(task.revision);
    const original = await readFile(draft, 'utf8');
    await writeFile(draft, original.replace('action: answer\n\n', 'action: answer\n\npartial'));
    await new Promise(done => setTimeout(done, 100));
    expect((await workspace(app)).tasks.find(item => item.id === task.id)!.reviews.find(item => item.id === review.id)!.decision).toBeNull();
    const current = (await workspace(app)).tasks.find(item => item.id === task.id)!;
    const binding = (await loadRecords(localRoot)).records.find(item => draft.includes(item.basename))!.binding;
    expect(matchesBinding(current, binding)).toBe(true);
    await writeFile(draft, original.replace('action: answer\n\n', `action: answer\n\n${answer}`));
    await new Promise(done => setTimeout(done, 100));
    expect((await workspace(app)).tasks.find(item => item.id === task.id)!.reviews.find(item => item.id === review.id)!.decision).toBeNull();
    await submit(workspaceRoot, draft, 'answer', answer);
    const accepted = await until(async () => (await workspace(app)).tasks.find(item => item.id === task.id)!, item =>
      item.reviews.find(entry => entry.id === review.id)?.decision === 'answer');
    expect(accepted.reviews.find(item => item.id === review.id)?.answer).toBe(answer);
    previous = accepted.revision;
  }
  let task = await pendingReview(app, created.id, 'workflow', previous);
  const workflow = task.reviews.find(item => item.kind === 'workflow' && item.decision === null)!;
  await submit(workspaceRoot, await draftFor(workspaceRoot, '## Workflow approval'), 'approve');
  task = await pendingReview(app, created.id, 'artifact', task.revision);
  expect(task.reviews.find(item => item.id === workflow.id)?.decision).toBe('approve');
  const artifact = task.reviews.find(item => item.kind === 'artifact' && item.decision === null)!;
  expect(artifact.artifacts).toHaveLength(1);
  const material = artifact.artifacts[0];
  const draft = await draftFor(workspaceRoot, '## Artifact approval');
  const token = draft.match(/([0-9a-f-]{36})\.md$/)?.[1];
  expect(token).toBeTruthy();
  const materialPath = join(workspaceRoot, 'reviews', 'materials', token!, `${material.id}.v${material.version}.bin`);
  expect(await readFile(materialPath, 'utf8')).toContain('Fixture evidence.');
  expect(await readFile(draft, 'utf8')).toContain(material.digest);
  await submit(workspaceRoot, draft, 'approve');
  const done = await until(async () => (await workspace(app)).tasks.find(item => item.id === created.id)!, item => item.status === 'done');
  expect(done.reviews.find(item => item.id === artifact.id)?.decision).toBe('approve');
  expect(done.artifacts.some(item => item.digest === material.digest)).toBe(true);
  expect(await readFile(materialPath, 'utf8')).toContain('Fixture evidence.');
  const downloaded = await fetch(`${app.address}/api/tasks/${created.id}/artifacts/${material.id}?version=${material.version}`);
  expect(downloaded.status).toBe(200);
  expect(await downloaded.text()).toContain('Fixture evidence.');
}, 15_000);

it('rejects a separate task through a file and records its reason', async () => {
  const { workspaceRoot, app } = await setup(true);
  await mkdir(join(workspaceRoot, 'drafts'));
  await writeFile(join(workspaceRoot, 'drafts', 'reject.md'), '# Reject this workflow\n');
  const task = await until(async () => (await workspace(app)).tasks[0], item =>
    Boolean(item?.reviews.some(review => review.kind === 'workflow' && review.decision === null)));
  await submit(workspaceRoot, await draftFor(workspaceRoot, '## Workflow approval'), 'reject', 'Scope is wrong');
  const rejected = await until(async () => (await workspace(app)).tasks.find(item => item.id === task.id)!, item => item.status === 'rejected');
  expect(rejected.reviews.find(item => item.kind === 'workflow')?.decision).toBe('reject');
  expect(rejected.reviews.find(item => item.kind === 'workflow')?.answer).toBe('Scope is wrong');
});

it('accepts a renamed workflow approval and continues to the next review', async () => {
  const { workspaceRoot, app } = await setup(true);
  await mkdir(join(workspaceRoot, 'drafts'));
  await writeFile(join(workspaceRoot, 'drafts', 'idea.md'), '# File review idea\n');
  const task = await until(async () => (await workspace(app)).tasks[0],
    task => Boolean(task?.reviews.some(review => review.kind === 'workflow' && review.decision === null)));
  const draft = await until(() => readdir(join(workspaceRoot, 'reviews')).catch(() => [] as string[]),
    names => names.some(name => name.endsWith('.md') && !name.endsWith('.receipt.md')));
  const name = draft.find(item => item.endsWith('.md') && !item.endsWith('.receipt.md'))!;
  const path = join(workspaceRoot, 'reviews', name);
  const text = await readFile(path, 'utf8');
  expect(text).toContain('## Workflow scope');
  await writeFile(path, text.replace('action: \n', 'action: approve\n'));
  await rename(path, join(workspaceRoot, 'reviews', name.replace(/\.md$/, '.ready.md')));
  const continued = await until(async () => (await workspace(app)).tasks.find(item => item.id === task.id)!,
    item => item.reviews.some(review => review.kind === 'artifact' && review.decision === null));
  expect(continued.runs.some(run => run.stepId === 'research')).toBe(true);
  const receipt = await readFile(join(workspaceRoot, 'reviews', name.replace(/\.md$/, '.receipt.md')), 'utf8');
  expect(receipt).toContain('Accepted');
});

it('leaves ready files inert when disabled and reports unknown files when enabled', async () => {
  const pending = waitingTask();
  const disabled = await setup(false, async workspaceRoot => {
    const store = await openStore(workspaceRoot);
    await store.create(pending, 'seed-waiting');
    const request = makeRequest(pending, pending.reviews[0], crypto.randomUUID());
    await mkdir(join(workspaceRoot, 'reviews'));
    await writeFile(join(workspaceRoot, 'reviews', `${request.basename}.ready.md`),
      renderDraft(request).replace('action: \n', 'action: approve\n'));
  });
  await new Promise(done => setTimeout(done, 100));
  const unchanged = (await workspace(disabled.app)).tasks.find(task => task.id === pending.id)!;
  expect(unchanged).toMatchObject({ revision: pending.revision, status: 'waiting-for-human' });
  expect(unchanged.reviews[0].decision).toBeNull();
  await expect(readdir(join(disabled.localRoot, 'file-reviews'))).rejects.toMatchObject({ code: 'ENOENT' });
  const enabled = await setup(true, async workspaceRoot => {
    await mkdir(join(workspaceRoot, 'reviews'));
    await writeFile(join(workspaceRoot, 'reviews', 'stray.ready.md'), 'action: approve\n');
  });
  const view = await until(() => workspace(enabled.app), result => result.issues.some(issue => issue.message.includes('stray.ready.md')));
  expect(view.tasks).toHaveLength(0);
});
