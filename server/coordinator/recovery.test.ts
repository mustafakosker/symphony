import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore } from '../store/task-store.js';
import { draftTask } from '../testing/fixtures.js';
import { recoverAttempts } from './recovery.js';
import { stopProcessTree } from '../codex/process-control.js';
import type { Run } from '../../shared/contracts.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'symphony-recovery-')); roots.push(root);
  const store = await openStore(root); const task = await store.create(draftTask(), 'draft');
  const run: Run = { id: randomUUID(), stepId: '$triage', workflowVersion: null,
    generation: 1, phase: 'launch-intent', pid: null, processStartedAt: null,
    runtimeVersion: 'test', inputRefs: [], repos: [], startedAt: task.createdAt,
    endedAt: null, exitCode: null, retryCount: 0, nextRetryAt: null, result: null };
  await store.publishRunFiles(task.id, run.id, { 'input.json': Buffer.from('{}') });
  const launched = await store.apply(task.id, task.revision, run.id, { kind: 'launch', run });
  return { root, store, task, run, launched };
}

it('blocks a launch intent with no verified process registration', async () => {
  const { root, task, run } = await setup();
  const reopened = await openStore(root);
  const issues = await recoverAttempts(reopened, join(root, 'local'));
  const saved = await reopened.get(task.id);
  expect(saved.status).toBe('blocked');
  expect(saved.runs[0].phase).toBe('uncertain');
  expect(issues.some(issue => issue.taskId === task.id)).toBe(true);
  await recoverAttempts(reopened, join(root, 'local'));
  expect((await reopened.get(task.id)).runs).toHaveLength(1);
  expect(run.pid).toBeNull();
});

it('requeues a proven-dead read-only attempt and keeps its retry count', async () => {
  const { root, store, task, run, launched } = await setup();
  await store.apply(task.id, launched.revision, `${run.id}:started`, {
    kind: 'started', attemptId: run.id, pid: 2147483647, processStartedAt: task.createdAt });
  const reopened = await openStore(root);
  const issues = await recoverAttempts(reopened, join(root, 'local'));
  const saved = await reopened.get(task.id);
  expect(issues).toHaveLength(0);
  expect(saved.status).toBe('triaging');
  expect(saved.runs[0].phase).toBe('ended');
  expect(saved.runs[0].nextRetryAt).not.toBeNull();
});

it('preserves an output file published before the finish event during recovery', async () => {
  const { root, store, task, run, launched } = await setup();
  await store.apply(task.id, launched.revision, `${run.id}:started`, {
    kind: 'started', attemptId: run.id, pid: 2147483647, processStartedAt: task.createdAt });
  const result = { kind: 'needs_human', taskId: task.id, attemptId: run.id,
    summary: 'Partial question', artifacts: [], question: 'Which project?', checkpoint: 'Choose' };
  await store.publishRunFiles(task.id, run.id, { 'result.json': Buffer.from(JSON.stringify(result)) });
  const reopened = await openStore(root);
  await recoverAttempts(reopened, join(root, 'local'));
  expect((await reopened.get(task.id)).runs[0].result).toBeNull();
  expect(JSON.parse(await readFile(join(root, 'active', task.id, 'runs', run.id, 'result.json'), 'utf8'))).toEqual(result);
});

it('blocks a live PID with uncertain identity without sending a signal', async () => {
  const { root, store, task, run, launched } = await setup();
  await store.apply(task.id, launched.revision, `${run.id}:started`, {
    kind: 'started', attemptId: run.id, pid: process.pid, processStartedAt: task.createdAt });
  const reopened = await openStore(root);
  await recoverAttempts(reopened, join(root, 'local'));
  expect((await reopened.get(task.id)).status).toBe('blocked');
  expect((await reopened.get(task.id)).runs[0].phase).toBe('uncertain');
  expect(() => process.kill(process.pid, 0)).not.toThrow();
});

it.each(['pause', 'cancel'] as const)('recovers live %s intent as blocked and nonterminal', async kind => {
  const { root, store, task, run, launched } = await setup();
  let saved = await store.apply(task.id, launched.revision, 'started', {
    kind: 'started', attemptId: run.id, pid: process.pid, processStartedAt: task.createdAt });
  await store.apply(task.id, saved.revision, 'stop', { kind: 'human', command: {
    taskId: task.id, expectedRevision: saved.revision, requestId: 'stop', action: { kind } } });
  const reopened = await openStore(root);
  await recoverAttempts(reopened, root);
  saved = await reopened.get(task.id);
  expect(saved.status).toBe('blocked');
  expect(saved.intent).toBe(kind);
  expect(saved.runs[0].endedAt).toBeNull();
});

it.each(['pause', 'cancel', null] as const)('blocks recovery with %s intent when the leader exited but its child group survives', async kind => {
  const { spawn } = await import('node:child_process');
  const { root, store, task, run, launched } = await setup();
  const leader = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.stdout.write(String(child.pid));
    child.unref();
  `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  leader.stdout.on('data', chunk => { output += String(chunk); });
  const group = leader.pid!;
  try {
    await new Promise<void>((resolve, reject) => {
      leader.once('error', reject);
      leader.once('close', code => code === 0 ? resolve() : reject(new Error(`Fixture leader exited ${code}`)));
    });
    const childPid = Number(output);
    expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
    expect(() => process.kill(group, 0)).toThrow();
    expect(() => process.kill(childPid, 0)).not.toThrow();
    expect(() => process.kill(-group, 0)).not.toThrow();
    let saved = await store.apply(task.id, launched.revision, 'started', {
      kind: 'started', attemptId: run.id, pid: group, processStartedAt: task.createdAt });
    if (kind) saved = await store.apply(task.id, saved.revision, 'stop', { kind: 'human', command: {
      taskId: task.id, expectedRevision: saved.revision, requestId: 'stop', action: { kind } } });
    const reopened = await openStore(root);
    await recoverAttempts(reopened, root);
    saved = await reopened.get(task.id);
    expect(saved.status).toBe('blocked');
    expect(saved.intent).toBe(kind);
    expect(saved.runs[0].processExitConfirmed).toBe(false);
    expect(saved.runs[0].endedAt).toBeNull();
    expect(saved.runs[0].nextRetryAt).toBeNull();
    // Recovery observes only; it must not kill a recovered, potentially reused group.
    expect(() => process.kill(childPid, 0)).not.toThrow();
    await recoverAttempts(reopened, root);
    expect((await reopened.get(task.id)).status).toBe('blocked');
  } finally {
    await stopProcessTree(group, 10);
  }
});
