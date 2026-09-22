import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftTask, waitingTask, workflowProposal } from '../testing/fixtures.js';
import { openStore } from './task-store.js';
import type { DomainEvent } from '../../shared/contracts.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'symphony-store-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe('durable task store', () => {
  it('replays the original operation result before checking an old revision', async () => {
    const store = await openStore(root);
    const task = await store.create(waitingTask(), 'create-1');
    const event: DomainEvent = { kind: 'human', command: { requestId: 'approve-1', taskId: task.id,
      expectedRevision: task.revision, action: { kind: 'approve', reviewId: 'workflow-review', artifactDigests: [] } } };
    const first = await store.apply(task.id, task.revision, 'approve-1', event);
    expect(first.revision).toBe(2);
    expect(await store.apply(task.id, task.revision, 'approve-1', event)).toEqual(first);
    const changed: DomainEvent = { kind: 'human', command: { ...event.command, action: { kind: 'cancel' } } };
    await expect(store.apply(task.id, task.revision, 'approve-1', changed)).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.apply(task.id, task.revision, 'another', event)).rejects.toMatchObject({ code: 'conflict' });
    const reopened = await openStore(root);
    expect(await reopened.apply(task.id, task.revision, 'approve-1', event)).toEqual(first);
    expect((await readdir(join(root, 'active', task.id, 'events'))).length).toBe(2);
  });

  it('preserves original idea bytes and rejects duplicate IDs', async () => {
    const store = await openStore(root);
    const task = draftTask();
    task.idea = '# Café\n';
    await store.create(task, 'create:one');
    expect(await readFile(join(root, 'active', task.id, 'idea.md'), 'utf8')).toBe(task.idea);
    await expect(store.create(task, 'create:two')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('resumes the same creation after a failure before the first event', async () => {
    const task = draftTask();
    const store = await openStore(root);
    const atomic = await import('./atomic.js');
    const real = atomic.writeAtomic;
    const spy = vi.spyOn(atomic, 'writeAtomic').mockImplementation(async (path, bytes) => {
      if (path.endsWith('idea.md')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return real(path, bytes);
    });
    await expect(store.create(task, 'create:one')).rejects.toMatchObject({ code: 'unavailable' });
    spy.mockRestore();
    const recovered = await openStore(root);
    expect(await recovered.get(task.id)).toEqual(task);
    expect(await recovered.create(task, 'create:one')).toEqual(task);
    await expect(recovered.create({ ...task, title: 'Different' }, 'create:one')).rejects.toMatchObject({ code: 'conflict' });
    expect(await readdir(join(root, 'active', task.id, 'events'))).toHaveLength(1);
  });

  it('can retry after a failure before the creation intent is published', async () => {
    const task = draftTask();
    const store = await openStore(root);
    const atomic = await import('./atomic.js');
    const real = atomic.writeAtomic;
    const spy = vi.spyOn(atomic, 'writeAtomic').mockImplementation(async (path, bytes) => {
      if (path.endsWith('intent.json')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return real(path, bytes);
    });
    await expect(store.create(task, 'create:one')).rejects.toMatchObject({ code: 'unavailable' });
    spy.mockRestore();
    const recovered = await openStore(root);
    expect((await recovered.list()).coordinator).toBe('ready');
    expect(await recovered.create(task, 'create:one')).toEqual(task);
    expect((await readdir(join(root, 'active', task.id, 'events')))).toHaveLength(1);
  });

  it('discards a crashed pre-intent stage containing only atomic temp files', async () => {
    const stage = join(root, '.creating', '33333333-3333-4333-8333-333333333333');
    await mkdir(stage, { recursive: true });
    await writeFile(join(stage, '.tmp-44444444-4444-4444-8444-444444444444'), 'partial intent');
    const recovered = await openStore(root);
    expect((await recovered.list()).coordinator).toBe('ready');
    await expect(readdir(stage)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await recovered.create(draftTask(), 'create:one')).toEqual(draftTask());
  });

  it('keeps unknown or symlinked files in an uncommitted stage as conflicts', async () => {
    const unknown = join(root, '.creating', '33333333-3333-4333-8333-333333333333');
    const linked = join(root, '.creating', '55555555-5555-4555-8555-555555555555');
    await mkdir(unknown, { recursive: true });
    await mkdir(linked);
    await writeFile(join(unknown, 'unexpected.txt'), 'unrelated');
    await symlink(join(unknown, 'unexpected.txt'), join(linked, '.tmp-44444444-4444-4444-8444-444444444444'));
    const recovered = await openStore(root);
    expect((await recovered.list()).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'creation-stage-33333333-3333-4333-8333-333333333333' }),
      expect.objectContaining({ id: 'creation-stage-55555555-5555-4555-8555-555555555555' }),
    ]));
    expect(await readdir(unknown)).toEqual(['unexpected.txt']);
    expect(await readdir(linked)).toHaveLength(1);
  });

  it('finishes a staged creation whose intent was persisted before the task-directory move', async () => {
    const task = draftTask();
    await (await openStore(root)).create(task, 'create:one');
    const stage = join(root, '.creating', '33333333-3333-4333-8333-333333333333');
    await mkdir(stage);
    await cp(join(root, 'active', task.id, 'intent.json'), join(stage, 'intent.json'));
    await rm(join(root, 'active', task.id), { recursive: true });
    const recovered = await openStore(root);
    expect(await recovered.get(task.id)).toEqual(task);
    expect(await recovered.create(task, 'create:one')).toEqual(task);
  });

  it('does not move a staged creation over an unrelated empty task directory', async () => {
    const task = draftTask();
    await (await openStore(root)).create(task, 'create:one');
    const stage = join(root, '.creating', '33333333-3333-4333-8333-333333333333');
    await mkdir(stage);
    await cp(join(root, 'active', task.id, 'intent.json'), join(stage, 'intent.json'));
    await rm(join(root, 'active', task.id), { recursive: true });
    await mkdir(join(root, 'active', task.id));
    const recovered = await openStore(root);
    await expect(recovered.get(task.id)).rejects.toMatchObject({ code: 'conflict' });
    expect(await readdir(join(root, 'active', task.id))).toHaveLength(0);
  });

  it('rejects conflicting bytes in an interrupted creation', async () => {
    const task = draftTask();
    const store = await openStore(root);
    const atomic = await import('./atomic.js');
    const real = atomic.writeAtomic;
    const spy = vi.spyOn(atomic, 'writeAtomic').mockImplementation(async (path, bytes) => {
      if (path.includes('/events/')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return real(path, bytes);
    });
    await expect(store.create(task, 'create:one')).rejects.toMatchObject({ code: 'unavailable' });
    spy.mockRestore();
    await writeFile(join(root, 'active', task.id, 'idea.md'), 'a different idea');
    const recovered = await openStore(root);
    await expect(recovered.get(task.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('never adopts an unrelated empty task directory without creation intent', async () => {
    const task = draftTask();
    await mkdir(join(root, 'active', task.id), { recursive: true });
    const store = await openStore(root);
    await expect(store.create(task, 'create:one')).rejects.toMatchObject({ code: 'conflict' });
    expect((await readdir(join(root, 'active', task.id)))).toHaveLength(0);
  });

  it('recovers a committed decision after snapshot publication fails', async () => {
    const store = await openStore(root);
    const task = await store.create(waitingTask(), 'create');
    const event: DomainEvent = { kind: 'human', command: { requestId: 'approve', taskId: task.id,
      expectedRevision: 1, action: { kind: 'approve', reviewId: 'workflow-review', artifactDigests: [] } } };
    const atomic = await import('./atomic.js');
    const real = atomic.writeAtomic;
    const spy = vi.spyOn(atomic, 'writeAtomic').mockImplementation(async (path, bytes) => {
      if (path.endsWith('task.json')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return real(path, bytes);
    });
    await expect(store.apply(task.id, 1, 'approve', event)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(store.get(task.id)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await store.list()).toMatchObject({ coordinator: 'degraded', issues: [{ taskId: task.id }] });
    spy.mockRestore();
    const reopened = await openStore(root);
    expect((await reopened.get(task.id)).revision).toBe(2);
    expect(await reopened.apply(task.id, 1, 'approve', event)).toEqual(await reopened.get(task.id));
    expect((await readdir(join(root, 'active', task.id, 'events'))).length).toBe(2);
  });

  it('does not advance state when event publication fails', async () => {
    const store = await openStore(root);
    const task = await store.create(draftTask(), 'create');
    const atomic = await import('./atomic.js');
    const real = atomic.writeAtomic;
    const spy = vi.spyOn(atomic, 'writeAtomic').mockImplementation(async (path, bytes) => {
      if (path.includes('/events/')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return real(path, bytes);
    });
    await expect(store.apply(task.id, 1, 'block', { kind: 'block', reason: 'offline' })).rejects.toMatchObject({ code: 'unavailable' });
    spy.mockRestore();
    expect((await readdir(join(root, 'active', task.id, 'events'))).length).toBe(1);
    expect((await (await openStore(root)).get(task.id)).revision).toBe(1);
  });

  it('flags missing event revisions and invalid snapshots', async () => {
    const store = await openStore(root);
    const task = await store.create(draftTask(), 'create');
    await store.apply(task.id, 1, 'block', { kind: 'block', reason: 'offline' });
    await store.apply(task.id, 2, 'block-again', { kind: 'block', reason: 'still offline' });
    const events = join(root, 'active', task.id, 'events');
    const second = (await readdir(events)).find(name => name.startsWith('0000000002'))!;
    await rm(join(events, second));
    await writeFile(join(root, 'active', task.id, 'task.json'), '{}');
    const reopened = await openStore(root);
    expect((await reopened.recover()).some(issue => issue.taskId === task.id)).toBe(true);
    await expect(reopened.get(task.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('moves terminal tasks after publishing state and completes interrupted moves', async () => {
    const store = await openStore(root);
    const task = await store.create(draftTask(), 'create');
    const done = await store.apply(task.id, 1, 'cancel', { kind: 'human', command: { requestId: 'cancel', taskId: task.id, expectedRevision: 1, action: { kind: 'cancel' } } });
    expect(done.status).toBe('cancelled');
    expect((await readFile(join(root, 'cancelled', task.id, 'task.json'), 'utf8'))).toContain('cancelled');
  });

  it('recovers a terminal move interrupted after the terminal event', async () => {
    const store = await openStore(root);
    const task = await store.create(draftTask(), 'create');
    const obstruction = join(root, 'cancelled', task.id);
    await mkdir(obstruction);
    await expect(store.apply(task.id, 1, 'cancel', { kind: 'human', command: {
      requestId: 'cancel', taskId: task.id, expectedRevision: 1, action: { kind: 'cancel' },
    } })).rejects.toMatchObject({ code: 'conflict' });
    expect(JSON.parse(await readFile(join(root, 'active', task.id, 'task.json'), 'utf8')).status).toBe('cancelled');
    await rm(obstruction, { recursive: true });
    const recovered = await openStore(root);
    expect((await recovered.get(task.id)).status).toBe('cancelled');
    expect(await readdir(join(root, 'cancelled', task.id, 'events'))).toHaveLength(2);
  });

  it('ignores incomplete atomic temp files but blocks duplicate task IDs', async () => {
    const store = await openStore(root);
    const task = await store.create(draftTask(), 'create');
    await writeFile(join(root, 'active', task.id, 'events', '.tmp-incomplete'), '{');
    expect((await (await openStore(root)).get(task.id)).revision).toBe(1);
    await cp(join(root, 'active', task.id), join(root, 'done', task.id), { recursive: true });
    const reopened = await openStore(root);
    expect((await reopened.recover()).some(issue => issue.taskId === task.id)).toBe(true);
    await expect(reopened.get(task.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('publishes immutable artifacts, workflows and fixed run files', async () => {
    const store = await openStore(root);
    const task = await store.create(draftTask(), 'create');
    const one = await store.publishArtifact(task.id, 'findings', new TextEncoder().encode('first'));
    const two = await store.publishArtifact(task.id, 'findings', new TextEncoder().encode('second'));
    expect([one.version, two.version]).toEqual([1, 2]);
    expect(await readFile(join(root, 'active', task.id, one.path), 'utf8')).toBe('first');
    await store.publishWorkflow(task.id, workflowProposal());
    await store.publishWorkflow(task.id, workflowProposal());
    await expect(store.publishWorkflow(task.id, { ...workflowProposal(), completionChecks: ['different'] })).rejects.toMatchObject({ code: 'conflict' });
    const attempt = '22222222-2222-4222-8222-222222222222';
    await store.publishRunFiles(task.id, attempt, { 'input.json': new TextEncoder().encode('{}') });
    await expect(store.publishRunFiles(task.id, attempt, { 'input.json': new TextEncoder().encode('{"changed":true}') })).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.publishRunFiles(task.id, attempt, { '../escape': new Uint8Array() })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('requires referenced artifact bytes before committing a completed result', async () => {
    const task = draftTask();
    task.status = 'running'; task.workflow = workflowProposal(); task.currentStepId = 'research'; task.generation = 1;
    const attemptId = '22222222-2222-4222-8222-222222222222';
    task.runs = [{ id: attemptId, stepId: 'research', workflowVersion: 1, generation: 1,
      phase: 'running', pid: 42, processStartedAt: task.createdAt, runtimeVersion: 'test', inputRefs: [], repos: [],
      startedAt: task.createdAt, endedAt: null, exitCode: null, retryCount: 0, nextRetryAt: null, result: null }];
    const store = await openStore(root);
    await store.create(task, 'create');
    const bytes = new TextEncoder().encode('findings');
    const missing = { id: 'findings', version: 1, path: 'artifacts/findings.1.bin',
      digest: '9412d0fd9238ae0933ebf22b110eea6504631c02ab5161d1bdcd05a2b8f2ba2e' };
    const result: DomainEvent = { kind: 'finished', attemptId, generation: 1, exitCode: 0,
      result: { kind: 'completed', taskId: task.id, attemptId, summary: 'done', artifacts: [missing], evidence: { findings: 'verified' } } };
    await expect(store.apply(task.id, 1, 'finish', result)).rejects.toMatchObject({ code: 'missing' });
    expect((await readdir(join(root, 'active', task.id, 'events'))).length).toBe(1);
    const artifactPath = join(root, 'active', task.id, missing.path);
    await mkdir(artifactPath);
    await expect(store.apply(task.id, 1, 'finish', result)).rejects.toMatchObject({ code: 'unavailable' });
    await rm(artifactPath, { recursive: true });
    const published = await store.publishArtifact(task.id, 'findings', bytes);
    result.result.artifacts = [published];
    await store.publishRunFiles(task.id, attemptId, { 'result.json': new TextEncoder().encode(JSON.stringify(result.result)) });
    const finished = await store.apply(task.id, 1, 'finish', result);
    expect(finished.status).toBe('waiting-for-human');
    expect(JSON.parse(await readFile(join(root, 'active', task.id, 'reviews', '0000000002.json'), 'utf8'))).toHaveLength(1);
    expect(JSON.parse(await readFile(join(root, 'active', task.id, 'runs', attemptId, 'record-0000000002.json'), 'utf8')).phase).toBe('ended');
    await rm(join(root, 'active', task.id, published.path));
    await expect(store.apply(task.id, finished.revision, 'approve-missing-artifact', {
      kind: 'human', command: { taskId: task.id, expectedRevision: finished.revision,
        requestId: 'approve-missing-artifact', action: { kind: 'approve',
          reviewId: finished.reviews[0].id, artifactDigests: [published.digest] } },
    })).rejects.toMatchObject({ code: 'missing' });
    expect((await readdir(join(root, 'active', task.id, 'events'))).length).toBe(2);
  });

  it('requires run inputs before publishing launch intent', async () => {
    const store = await openStore(root);
    const task = await store.create(draftTask(), 'create');
    const attemptId = '22222222-2222-4222-8222-222222222222';
    const run = { id: attemptId, stepId: '$triage', workflowVersion: null, generation: 1,
      phase: 'launch-intent' as const, pid: null, processStartedAt: null, runtimeVersion: 'test',
      inputRefs: [], repos: [], startedAt: task.createdAt, endedAt: null, exitCode: null,
      retryCount: 0, nextRetryAt: null, result: null };
    await expect(store.apply(task.id, 1, `launch:${attemptId}`, { kind: 'launch', run })).rejects.toMatchObject({ code: 'missing' });
    await store.publishRunFiles(task.id, attemptId, { 'input.json': new TextEncoder().encode('{}') });
    expect((await store.apply(task.id, 1, `launch:${attemptId}`, { kind: 'launch', run })).status).toBe('running');
    await rm(join(root, 'active', task.id, 'runs', attemptId, 'input.json'));
    const reopened = await openStore(root);
    expect((await reopened.recover()).some(issue => issue.taskId === task.id)).toBe(true);
    await expect(reopened.get(task.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('does not follow symlinked task directories', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'symphony-outside-'));
    try {
      await mkdir(join(root, 'active'));
      await symlink(outside, join(root, 'active', draftTask().id));
      const store = await openStore(root);
      expect((await store.recover()).length).toBeGreaterThan(0);
      await expect(store.get(draftTask().id)).rejects.toMatchObject({ code: 'conflict' });
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});
