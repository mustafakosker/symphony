import { mkdtemp, mkdir, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { createCodexRunner, type Assignment } from './adapter.js';
import { buildPrompt } from './prompt.js';
import type { Settings } from '../config/settings.js';
import { draftTask } from '../testing/fixtures.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fake = resolve('server/testing/fake-cli.mjs');

async function setup(mode: string, overrides: Partial<Settings> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'symphony-codex-')); roots.push(root);
  const cwd = join(root, 'work'); const outputDir = join(root, 'output');
  await mkdir(cwd); await mkdir(outputDir);
  const task = draftTask(); task.idea = 'Run $(touch unwanted) literally';
  const run = { id: 'attempt-1', stepId: 'research', workflowVersion: 1,
    generation: 0, phase: 'launch-intent' as const, pid: null, processStartedAt: null,
    runtimeVersion: '0.fake.1', inputRefs: [], repos: [], startedAt: task.createdAt,
    endedAt: null, exitCode: null, retryCount: 0, nextRetryAt: null, result: null };
  const assignment: Assignment = { task, run, cwd, outputDir, materials: [],
    schemaPath: join(root, 'result.schema.json'),
    step: { kind: 'agent', id: 'research', title: 'Research', role: 'researcher',
      instructions: 'Investigate', inputs: [], repositories: [], actions: ['read'], outputs: [], checks: [] },
    role: { role: 'researcher', instructions: 'Use approved skills', skills: [], cliProfile: 'researcher', actions: ['read'] } };
  const settings: Settings = { workspaceRoot: join(root, 'synced'), localRoot: root,
    codexBinary: process.execPath, port: 4317, concurrency: 1, scanMs: 2000, stableMs: 2000,
    runTimeoutMs: 300, stopGraceMs: 100, outputLimitBytes: 2000,
    allowedOrigin: 'http://127.0.0.1:4317', environmentKeys: [], verifiedProfilesPath: null, fileReviewsEnabled: false, ...overrides };
  await writeFile(join(cwd, 'scenario.json'), JSON.stringify({ mode, taskId: task.id, attemptId: run.id }));
  return { root, cwd, outputDir, assignment, settings,
    runner: createCodexRunner(settings, { executable: process.execPath, prefixArgs: [fake] }) };
}

it('requires a validated final result even after exit zero and ignores JSONL as a result', async () => {
  const { assignment, runner } = await setup('zero-no-final');
  const active = await runner.start(assignment, () => {});
  const exit = await active.completion;
  expect(exit.code).toBe(0); expect(exit.result).toBeNull(); expect(exit.error).toMatch(/final/i);
});

it('passes shell-looking ideas literally through stdin and accepts a valid final envelope', async () => {
  const { assignment, runner, cwd } = await setup('success');
  const active = await runner.start(assignment, () => {});
  const exit = await active.completion;
  expect(exit.error).toBeNull(); expect(exit.result?.kind).toBe('completed');
  expect(await readFile(join(cwd, 'captured-prompt.txt'), 'utf8')).toContain('$(touch unwanted)');
  await expect(readFile(join(cwd, 'unwanted'))).rejects.toThrow();
});

it('assembles UTF-8 and JSON lines split across chunks', async () => {
  const { assignment, runner } = await setup('split-utf8');
  const lines: string[] = [];
  const active = await runner.start(assignment, line => lines.push(line));
  expect((await active.completion).result?.kind).toBe('completed');
  expect(lines).toContain('{"message":"Investigating café"}');
});

it.each(['malformed-final', 'nonzero'])('rejects %s output as completion', async mode => {
  const { assignment, runner } = await setup(mode);
  const exit = await (await runner.start(assignment, () => {})).completion;
  expect(exit.result).toBeNull(); expect(exit.error).toBeTruthy();
});

it.each(['overflow', 'hang'])('stops the process tree on %s', async mode => {
  const { assignment, runner, cwd } = await setup(mode, { runTimeoutMs: 250, outputLimitBytes: 150 });
  const active = await runner.start(assignment, () => {});
  const exit = await active.completion;
  expect(exit.result).toBeNull(); expect(exit.error).toMatch(mode === 'overflow' ? /output limit/i : /timeout/i);
  if (mode === 'hang') {
    const pid = Number(await readFile(join(cwd, 'child-pid.txt'), 'utf8'));
    let state = '';
    try { state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { /* Reaped. */ }
    expect(state === '' || state.startsWith('Z')).toBe(true);
  }
});

it('probes fake CLI capabilities without starting agent work', async () => {
  const { runner } = await setup('success');
  expect((await runner.probe()).version).toBe('0.fake.1');
});

it('allows coordinator work directories outside Git repositories', async () => {
  const { runner, assignment, cwd } = await setup('success');
  await (await runner.start(assignment, () => {})).completion;
  const args = JSON.parse(await readFile(join(cwd, 'captured-args.json'), 'utf8'));
  expect(args).toContain('--skip-git-repo-check');
});

it('returns a structured question for a human checkpoint', async () => {
  const { runner, assignment } = await setup('question');
  const exit = await (await runner.start(assignment, () => {})).completion;
  expect(exit.result?.kind).toBe('needs_human');
});

it('rejects an output artifact symlink before accepting the final result', async () => {
  const { runner, assignment, cwd, outputDir, root } = await setup('success');
  await writeFile(join(root, 'outside.txt'), 'unsafe');
  await symlink(join(root, 'outside.txt'), join(outputDir, 'report.md'));
  await writeFile(join(cwd, 'scenario.json'), JSON.stringify({ mode: 'success', result: {
    taskId: assignment.task.id, attemptId: assignment.run.id, kind: 'completed',
    summary: 'Done', artifacts: [{ id: 'report', version: 1, digest: 'x', path: 'report.md' }],
    evidence: { findings: 'done' },
  } }));
  const exit = await (await runner.start(assignment, () => {})).completion;
  expect(exit.result).toBeNull(); expect(exit.error).toMatch(/artifact|symlink/i);
});

it('includes staged artifact and skill text in a fresh prompt', async () => {
  const { assignment } = await setup('success');
  const skill = '/approved/review/SKILL.md';
  assignment.role.skills = [skill];
  assignment.run.inputRefs = [{ id: 'prd', version: 2, digest: 'abc', path: 'artifacts/prd.md' }];
  assignment.materials = [
    { kind: 'skill', name: skill, text: 'Use the review checklist.' },
    { kind: 'artifact', name: 'prd@2', text: 'Customer needs offline mode.' },
  ];
  const prompt = buildPrompt(assignment);
  expect(prompt).toContain('Use the review checklist.');
  expect(prompt).toContain('Customer needs offline mode.');
});

it('blocks launch when a staged input artifact is absent', async () => {
  const { assignment, runner } = await setup('success');
  assignment.run.inputRefs = [{ id: 'prd', version: 2, digest: 'abc', path: 'artifacts/prd.md' }];
  await expect(runner.start(assignment, () => {})).rejects.toThrow(/material|artifact/i);
});

it('rejects a workflow result with an unrecognized agent role', async () => {
  const { assignment, runner, cwd } = await setup('success');
  await writeFile(join(cwd, 'scenario.json'), JSON.stringify({ mode: 'success', result: {
    taskId: assignment.task.id, attemptId: assignment.run.id, kind: 'propose_workflow_change',
    summary: 'Plan', artifacts: [], reason: 'Required', title: 'Plan', taskType: 'feature', projectId: null,
    workflow: { version: 1, steps: [{ kind: 'agent', id: 'step', title: 'Step', role: 'administrator',
      instructions: 'Do work', inputs: [], repositories: [], actions: ['read'], outputs: [], checks: [] }],
      completionChecks: [] },
  } }));
  const exit = await (await runner.start(assignment, () => {})).completion;
  expect(exit.result).toBeNull(); expect(exit.error).toMatch(/workflow|final/i);
});

it('stops a hanging run promptly when a log write fails', async () => {
  const { assignment, runner, root } = await setup('hang', { runTimeoutMs: 2000 });
  const probe = await open(join(root, 'probe'), 'w');
  const spy = vi.spyOn(Object.getPrototypeOf(probe), 'writeFile').mockRejectedValue(new Error('disk full'));
  await probe.close();
  try {
    const started = Date.now();
    const exit = await (await runner.start(assignment, () => {})).completion;
    expect(exit.result).toBeNull(); expect(exit.error).toMatch(/log write failed/i);
    expect(Date.now() - started).toBeLessThan(1500);
  } finally { spy.mockRestore(); }
});

it('does not follow a replaced log path to an external sentinel', async () => {
  const { assignment, runner, cwd, root } = await setup('log-symlink');
  const sentinelPath = join(root, 'sentinel.txt'); await writeFile(sentinelPath, 'untouched');
  await writeFile(join(cwd, 'scenario.json'), JSON.stringify({ mode: 'log-symlink',
    sentinelPath, taskId: assignment.task.id, attemptId: assignment.run.id }));
  const exit = await (await runner.start(assignment, () => {})).completion;
  expect(await readFile(sentinelPath, 'utf8')).toBe('untouched');
  expect(exit.result).toBeNull(); expect(exit.error).toMatch(/log/i);
});

it('waits for orphaned group members when stop is called after leader exit', async () => {
  const { assignment, runner, cwd } = await setup('leader-exits');
  const active = await runner.start(assignment, () => {});
  await active.completion;
  await active.stop();
  const pid = Number(await readFile(join(cwd, 'child-pid.txt'), 'utf8'));
  let state = '';
  try { state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { /* Reaped. */ }
  expect(state === '' || state.startsWith('Z')).toBe(true);
});

it('does not settle completion before a delayed log failure stops an orphaned child', async () => {
  const { assignment, runner, cwd, root } = await setup('leader-exits',
    { runTimeoutMs: 2000, stopGraceMs: 400 });
  const probe = await open(join(root, 'probe'), 'w');
  const spy = vi.spyOn(Object.getPrototypeOf(probe), 'writeFile').mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 250));
    throw new Error('delayed disk full');
  });
  await probe.close();
  let active: Awaited<ReturnType<typeof runner.start>> | undefined;
  try {
    active = await runner.start(assignment, () => {});
    const exit = await active.completion;
    const pid = Number(await readFile(join(cwd, 'child-pid.txt'), 'utf8'));
    let state = '';
    try { state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { /* Reaped. */ }
    expect(exit.error).toMatch(/log write failed/i);
    expect(state === '' || state.startsWith('Z')).toBe(true);
  } finally {
    if (active) await active.stop();
    spy.mockRestore();
  }
});

it('stages meaningful saved question/checkpoint/answer and accepted evidence with identity', async () => {
  const { assignment } = await setup('success');
  const priorId = '33333333-3333-4333-8333-333333333333';
  assignment.task.runs = [{ ...assignment.run, id: priorId, phase: 'ended', workflowVersion: 2,
    result: { kind: 'needs_human', taskId: assignment.task.id, attemptId: priorId, summary: 'Choice',
      artifacts: [], question: 'Choose ALPHA or BETA?', checkpoint: 'Continuation fact: preserve invoice order' } },
    { ...assignment.run, id: '44444444-4444-4444-8444-444444444444', stepId: 'research', phase: 'ended', workflowVersion: 2,
      result: { kind: 'completed', taskId: assignment.task.id, attemptId: '44444444-4444-4444-8444-444444444444',
        summary: 'Research', artifacts: [], evidence: { findings: 'Unique fact: invoices are immutable' } } }];
  assignment.task.completedStepIds = ['research'];
  assignment.task.reviews = [{ id: 'question-one', kind: 'question', workflowVersion: 2, stepId: assignment.step.id,
    artifacts: [], prompt: 'Choose ALPHA or BETA?', answer: 'BETA', decision: 'answer' }];
  const prompt = buildPrompt(assignment);
  for (const text of ['Choose ALPHA or BETA?', 'preserve invoice order', 'BETA', 'invoices are immutable', priorId, 'workflowVersion']) expect(prompt).toContain(text);
});


it('passes every selected owned writable checkout and output directory to the CLI', async () => {
  const { assignment, runner, root, cwd, outputDir } = await setup('success');
  assignment.step.actions = ['write-local']; assignment.role.actions = ['write-local'];
  assignment.step.repositories = ['one', 'two'];
  assignment.repositoryAccess = [];
  for (const repository of assignment.step.repositories) {
    const checkoutPath = join(await realpath(root), 'tasks', assignment.task.id, 'repositories', repository);
    await mkdir(checkoutPath, { recursive: true });
    await mkdir(join(root, 'source', repository), { recursive: true });
    const ref = { repository, rule: 'main', commit: 'a'.repeat(40), selectedCommits: ['a'.repeat(40)] };
    assignment.run.repos.push(ref);
    assignment.repositoryAccess.push({ ...ref, localPath: await realpath(join(root, 'source', repository)), checkoutPath, mcpProfile: null });
  }
  expect((await (await runner.start(assignment, () => {})).completion).error).toBeNull();
  const args: string[] = JSON.parse(await readFile(join(cwd, 'captured-args.json'), 'utf8'));
  const writable = args.flatMap((value, index) => value === '--add-dir' ? [args[index + 1]] : []);
  expect(writable).toEqual([...assignment.repositoryAccess.map(item => item.checkoutPath), await realpath(outputDir)]);
});

it('rejects missing or redirected repository access before launching', async () => {
  const { assignment, runner } = await setup('success');
  assignment.step.repositories = ['remote'];
  await expect(runner.start(assignment, () => {})).rejects.toThrow(/repository access/i);
});

it('blocks oversized saved continuation before spawning the CLI', async () => {
  const { assignment, runner, cwd } = await setup('success');
  assignment.task.reviews = [{ id: 'large', stepId: 'research', kind: 'question', workflowVersion: 1,
    artifacts: [], prompt: 'Huge saved context', answer: 'x'.repeat(1024 * 1024), decision: 'answer' }];
  await expect(runner.start(assignment, () => {})).rejects.toThrow(/context exceeds/);
  await expect(readFile(join(cwd, 'captured-prompt.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects a symlinked writable repository mapping before launch', async () => {
  const { assignment, runner, root, cwd } = await setup('success');
  assignment.step.actions = ['write-local']; assignment.role.actions = ['write-local'];
  assignment.step.repositories = ['one'];
  const parent = join(await realpath(root), 'tasks', assignment.task.id, 'repositories');
  await mkdir(parent, { recursive: true });
  await symlink(await realpath(cwd), join(parent, 'one'));
  const ref = { repository: 'one', rule: 'main', commit: 'a'.repeat(40), selectedCommits: ['a'.repeat(40)] };
  assignment.run.repos = [ref];
  assignment.repositoryAccess = [{ ...ref, localPath: await realpath(cwd), checkoutPath: join(parent, 'one'), mcpProfile: null }];
  await expect(runner.start(assignment, () => {})).rejects.toThrow(/repository access/);
});

it('pairs repeated legacy questions with their own ordered answers', async () => {
  const { assignment } = await setup('success');
  assignment.task.runs = ['first', 'second'].map((checkpoint, index) => ({ ...assignment.run,
    id: `prior-${index}`, stepId: assignment.step.id, phase: 'ended',
    result: { kind: 'needs_human', taskId: assignment.task.id, attemptId: `prior-${index}`,
      summary: 'Choice', artifacts: [], question: 'Which?', checkpoint } }));
  assignment.task.reviews = ['ALPHA', 'BETA'].map((answer, index) => ({ id: `question-${index}`, kind: 'question',
    workflowVersion: assignment.run.workflowVersion, stepId: assignment.step.id, artifacts: [], prompt: 'Which?', answer, decision: 'answer' }));
  const records = JSON.parse(buildPrompt(assignment).match(/^Saved continuation and accepted results: (.+)$/m)![1]);
  expect(records.map((record: { attemptId: string; answer: string }) => [record.attemptId, record.answer]))
    .toEqual([['prior-0', 'ALPHA'], ['prior-1', 'BETA']]);
});
