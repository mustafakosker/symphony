import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { request } from 'node:http';
import { mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/task-store.js';
import { createIntake } from '../intake/intake.js';
import type { Coordinator } from '../coordinator/coordinator.js';
import { controlledRunner, draftTask, waitingTask } from '../testing/fixtures.js';
import { createCoordinator } from '../coordinator/coordinator.js';
import type { Registry } from '../config/registry.js';
import type { Settings } from '../config/settings.js';
import { createApi } from './api.js';

describe('internal API', () => {
  let root: string; let server: Server; let base: string; let store: Store;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'symphony-http-'));
    store = await openStore(root);
    const intake = createIntake(root, store, 0);
    const coordinator: Coordinator = { tick: async () => {}, stopTask: async () => {}, shutdown: async () => {} };
    server = createServer(createApi({ store, intake, coordinator, allowedOrigin: 'http://127.0.0.1:4317', runtimeVersion: () => 'fake-1' }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const post = (url: string, value: unknown, origin = 'http://127.0.0.1:4317') =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(value) });

  it('does not turn a stale browser decision into an approval', async () => {
    const task = await store.create(waitingTask(), 'create');
    const response = await post(`${base}/api/tasks/${task.id}/commands`, {
      requestId: 'stale', taskId: task.id, expectedRevision: 0,
      action: { kind: 'approve', reviewId: 'workflow-review', artifactDigests: [] },
    });
    expect(response.status).toBe(409);
    expect((await store.get(task.id)).status).toBe('waiting-for-human');
  });

  it('replays an accepted command after a lost response and rejects changed payload', async () => {
    const task = await store.create(waitingTask(), 'create');
    const url = `${base}/api/tasks/${task.id}/commands`;
    const command = { requestId: 'retry-1', taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'approve', reviewId: 'workflow-review', artifactDigests: [] } };
    const first = await post(url, command);
    expect(first.status).toBe(200);
    const accepted = await first.json();
    expect((await post(url, command)).status).toBe(200);
    expect((await store.get(task.id)).revision).toBe(accepted.revision);
    expect((await post(url, { ...command, action: { kind: 'reject', reviewId: 'workflow-review', text: 'changed' } })).status).toBe(409);
  });

  it('returns conflict for checkpoint insertion during pending review and still accepts Continue', async () => {
    const pending = waitingTask();
    pending.workflow = pending.proposedWorkflow;
    pending.proposedWorkflow = null;
    pending.currentStepId = 'research';
    pending.reviews = [{ id: 'pause-review', kind: 'pause', workflowVersion: 1,
      stepId: 'research', artifacts: [], prompt: 'Resume this task?', answer: null, decision: null }];
    const task = await store.create(pending, 'create');
    const url = `${base}/api/tasks/${task.id}/commands`;
    const inserted = await post(url, { requestId: 'insert-pending', taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'insert-review', beforeStepId: 'research', title: 'Review first' } });
    expect(inserted.status).toBe(409);
    expect((await store.get(task.id)).workflow?.version).toBe(1);
    const continued = await post(url, { requestId: 'continue-pending', taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'approve', reviewId: 'pause-review', artifactDigests: [] } });
    expect(continued.status).toBe(200);
    expect((await store.get(task.id)).status).toBe('queued');
  });

  it('validates routes, JSON, origin and body size before mutation', async () => {
    const task = await store.create(waitingTask(), 'create');
    const url = `${base}/api/tasks/${task.id}/commands`;
    const valid = { requestId: 'one', taskId: task.id, expectedRevision: task.revision, action: { kind: 'cancel' } };
    expect((await post(url, { ...valid, taskId: '22222222-2222-4222-8222-222222222222' })).status).toBe(400);
    expect((await fetch(url, { method: 'POST', headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/json' }, body: JSON.stringify(valid) })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', headers: { Origin: 'http://127.0.0.1:4317', 'Content-Type': 'application/json' }, body: '{' })).status).toBe(400);
    expect((await post(`${base}/api/drafts`, { requestId: 'huge', markdown: 'x'.repeat(1024 * 1024) })).status).toBe(413);
    expect((await store.get(task.id)).status).toBe('waiting-for-human');
  });

  it('returns workspace, task, draft receipt and health without credentials', async () => {
    const task = await store.create(waitingTask(), 'create');
    expect((await (await fetch(`${base}/api/workspace`)).json()).tasks[0].id).toBe(task.id);
    expect((await (await fetch(`${base}/api/tasks/${task.id}`)).json()).id).toBe(task.id);
    expect((await fetch(`${base}/api/tasks/22222222-2222-4222-8222-222222222222`)).status).toBe(404);
    expect((await post(`${base}/api/drafts`, { requestId: 'draft-1', markdown: '# Idea' })).status).toBe(202);
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ status: 'ready', runtimeVersion: 'fake-1' });
  });

  it('reads bounded UTF-8 run logs and only referenced artifact versions', async () => {
    const prepared = waitingTask();
    const runId = '33333333-3333-4333-8333-333333333333';
    const run = { id: runId, stepId: '$triage', workflowVersion: null, generation: 0,
      phase: 'ended' as const, pid: null, processStartedAt: null, runtimeVersion: 'fake-1',
      inputRefs: [], repos: [], startedAt: prepared.createdAt, endedAt: prepared.updatedAt,
      exitCode: 0, retryCount: 0, nextRetryAt: null, result: null };
    prepared.runs = [run];
    const task = await store.create(prepared, 'create');
    await store.publishRunFiles(task.id, runId, { 'stdout.log': Buffer.from('a'.repeat(65534) + '€tail') });
    const response = await store.readRunLog(task.id, runId, 0, 65536);
    expect(Buffer.byteLength(response.text)).toBeLessThanOrEqual(65536);
    expect(response.nextOffset).toBe(65534);
    expect(response.complete).toBe(false);
    const tail = await store.readRunLog(task.id, runId, response.nextOffset, 65536);
    expect(tail.text).toBe('€tail');
    expect(tail.complete).toBe(true);
    expect((await fetch(`${base}/api/tasks/${task.id}/artifacts/missing`)).status).toBe(404);
  });

  it('bounds the encoded JSON log response even when control characters expand', async () => {
    const prepared = waitingTask();
    const runId = '44444444-4444-4444-8444-444444444444';
    prepared.runs = [{ id: runId, stepId: '$triage', workflowVersion: null, generation: 0,
      phase: 'ended', pid: null, processStartedAt: null, runtimeVersion: 'fake-1',
      inputRefs: [], repos: [], startedAt: prepared.createdAt, endedAt: prepared.updatedAt,
      exitCode: 0, retryCount: 0, nextRetryAt: null, result: null }];
    const task = await store.create(prepared, 'create');
    await store.publishRunFiles(task.id, runId, { 'stdout.log': Buffer.alloc(65536, 0) });
    const response = await fetch(`${base}/api/tasks/${task.id}/runs/${runId}/log`);
    expect(response.status).toBe(200);
    expect(Buffer.byteLength(await response.text())).toBeLessThanOrEqual(65536);
  });

  it('rejects an offset inside a UTF-8 character', async () => {
    const prepared = waitingTask();
    const runId = '55555555-5555-4555-8555-555555555555';
    prepared.runs = [{ id: runId, stepId: '$triage', workflowVersion: null, generation: 0,
      phase: 'ended', pid: null, processStartedAt: null, runtimeVersion: 'fake-1',
      inputRefs: [], repos: [], startedAt: prepared.createdAt, endedAt: prepared.updatedAt,
      exitCode: 0, retryCount: 0, nextRetryAt: null, result: null }];
    const task = await store.create(prepared, 'create');
    await store.publishRunFiles(task.id, runId, { 'stdout.log': Buffer.from('€') });
    expect((await fetch(`${base}/api/tasks/${task.id}/runs/${runId}/log?offset=1`)).status).toBe(400);
  });

  it('rejects absolute-form and network-path request targets', async () => {
    for (const path of ['//foreign.example/api/workspace', 'http://foreign.example/api/workspace']) {
      const code = await new Promise<number>((resolve, reject) => {
        request(base, { path }, response => { response.resume(); resolve(response.statusCode ?? 0); }).on('error', reject).end();
      });
      expect(code).toBe(400);
    }
  });

  it('lets the UI inspect stderr from the same run log route', async () => {
    const prepared = waitingTask();
    const runId = '66666666-6666-4666-8666-666666666666';
    prepared.runs = [{ id: runId, stepId: '$triage', workflowVersion: null, generation: 0,
      phase: 'ended', pid: null, processStartedAt: null, runtimeVersion: 'fake-1',
      inputRefs: [], repos: [], startedAt: prepared.createdAt, endedAt: prepared.updatedAt,
      exitCode: 0, retryCount: 0, nextRetryAt: null, result: null }];
    const task = await store.create(prepared, 'create');
    await store.publishRunFiles(task.id, runId, { 'stdout.log': Buffer.from('out'), 'stderr.log': Buffer.from('err') });
    const output = await (await fetch(`${base}/api/tasks/${task.id}/runs/${runId}/log?stream=stderr`)).json();
    expect(output.text).toBe('err');
  });

  it('reads output from the owned local directory while an attempt is running', async () => {
    const task = await store.create(draftTask(), 'create');
    const control = controlledRunner();
    const registry: Registry = { projects: [], roles: [{ role: 'triage', instructions: 'Classify',
      skills: [], cliProfile: 'triage', actions: ['read'] }] };
    const settings = { workspaceRoot: root, localRoot: join(root, 'local'), concurrency: 1,
      stopGraceMs: 20 } as Settings;
    const intake = { async scan() {}, async submit() { throw new Error('unused'); }, async issues() { return []; } };
    const coordinator = createCoordinator({ store, intake, registry, runner: control.runner, settings });
    await coordinator.tick(new Date());
    const assignment = control.starts[0];
    expect((await store.get(task.id)).runs[0].phase).toBe('running');
    await writeFile(join(assignment.outputDir, 'stdout.log'), 'live output');
    server.removeAllListeners('request');
    server.on('request', createApi({ store, intake, coordinator, allowedOrigin: 'http://127.0.0.1:4317' }));
    try {
      const response = await fetch(`${base}/api/tasks/${task.id}/runs/${assignment.run.id}/log`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ text: 'live output', nextOffset: 11, complete: false });
      const wrongRun = '77777777-7777-4777-8777-777777777777';
      expect((await fetch(`${base}/api/tasks/${task.id}/runs/${wrongRun}/log`)).status).toBe(404);
      await writeFile(join(root, 'sentinel'), 'PRIVATE');
      await unlink(join(assignment.outputDir, 'stdout.log'));
      await symlink(join(root, 'sentinel'), join(assignment.outputDir, 'stdout.log'));
      const redirected = await fetch(`${base}/api/tasks/${task.id}/runs/${assignment.run.id}/log`);
      expect(redirected.status).not.toBe(200);
      expect(await redirected.text()).not.toContain('PRIVATE');
    } finally { await coordinator.shutdown(); }
  });
});
