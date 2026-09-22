import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildPrompt } from '../codex/prompt.js';
import { openStore } from '../store/task-store.js';
import { controlledRunner, draftTask, waitingTask, workflowProposal } from '../testing/fixtures.js';
import { createCoordinator } from './coordinator.js';
import { applyHumanCommand } from './reviews.js';
import type { Registry } from '../config/registry.js';
import type { Settings } from '../config/settings.js';
import type { Exit, Runner } from '../codex/adapter.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup(concurrency = 1) {
  const root = await mkdtemp(join(tmpdir(), 'symphony-coordinator-')); roots.push(root);
  const store = await openStore(join(root, 'workspace'));
  const control = controlledRunner();
  const registry: Registry = { projects: [], roles: [{ role: 'triage', instructions: 'Classify', skills: [], cliProfile: 'triage', actions: ['read'] }] };
  const settings = { workspaceRoot: join(root, 'workspace'), localRoot: join(root, 'local'), concurrency } as Settings;
  const intake = { async scan() {}, async submit() { throw new Error('unused'); }, async issues() { return []; } };
  const coordinator = createCoordinator({ store, intake, registry, runner: control.runner, settings });
  return { store, control, coordinator, registry, settings, intake };
}
function withId(task: ReturnType<typeof draftTask>, digit: string) {
  return { ...task, id: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}` };
}
async function until(test: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await test()) { await new Promise(resolve => setTimeout(resolve, 5)); return; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for coordinator state');
}

it('never dispatches a waiting task and does not await another run in tick', async () => {
  const { store, control, coordinator } = await setup();
  await store.create(withId(waitingTask(), '2'), 'waiting');
  const task = withId(draftTask(), '1');
  await store.create(task, 'draft');
  await coordinator.tick(new Date('2026-09-21T12:00:00Z'));
  expect(control.starts).toHaveLength(1);
  expect(control.starts[0].task.id).toBe(task.id);
  await coordinator.tick(new Date('2026-09-21T12:00:01Z'));
  expect(control.starts).toHaveLength(1);
});

it('runs the pre-dispatch hook before reading eligible tasks', async () => {
  const { store, control, registry, settings, intake } = await setup();
  const task = waitingTask(); task.proposedWorkflow = null;
  task.reviews = [{ id: 'question-review', kind: 'question', workflowVersion: null, stepId: '$triage',
    artifacts: [], prompt: 'Which version?', answer: null, decision: null }];
  const waiting = await store.create(task, 'waiting');
  const coordinator = createCoordinator({ store, intake, registry, runner: control.runner, settings,
    beforeDispatch: async () => {
      const current = await store.get(waiting.id);
      await applyHumanCommand(store, coordinator, { taskId: waiting.id, expectedRevision: current.revision,
        requestId: 'hook-answer', action: { kind: 'answer', reviewId: current.reviews[0].id, text: 'Java 17' } });
    } });
  await coordinator.tick(new Date('2026-09-21T12:00:00Z'));
  expect(control.starts).toHaveLength(1);
  expect(control.starts[0].task.id).toBe(waiting.id);
  expect(control.starts[0].step.id).toBe('$triage');
  expect((await store.get(waiting.id)).reviews[0]).toMatchObject({ decision: 'answer', answer: 'Java 17' });
});

it('rejects a failed pre-dispatch hook without launching agents', async () => {
  const { store, control, registry, settings, intake } = await setup();
  await store.create(draftTask(), 'draft');
  const coordinator = createCoordinator({ store, intake, registry, runner: control.runner, settings,
    beforeDispatch: async () => { throw new Error('journal unavailable'); } });
  await expect(coordinator.tick(new Date())).rejects.toThrow('journal unavailable');
  expect(control.starts).toHaveLength(0);
});

it('does not stop an active assignment with a different attempt ID', async () => {
  const { store, control, coordinator } = await setup();
  const task = await store.create(draftTask(), 'create');
  await coordinator.tick(new Date('2026-09-21T12:00:00Z'));
  expect(control.starts).toHaveLength(1);
  await coordinator.stopTask(task.id, '33333333-3333-4333-8333-333333333333');
  expect((await store.get(task.id)).runs[0].phase).toBe('running');
});

it('fills two slots in queue order and releases one after an ended attempt', async () => {
  const { store, control, coordinator } = await setup(2);
  for (const digit of ['1', '2', '3']) await store.create(withId(draftTask(), digit), `create-${digit}`);
  await coordinator.tick(new Date('2026-09-21T12:00:00Z'));
  expect(control.starts.map(item => item.task.id)).toEqual(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']);
  const first = control.starts[0];
  control.finish(first.run.id, { code: 1, signal: null, result: null, error: 'permanent failure' });
  await until(async () => (await store.get(first.task.id)).status === 'blocked');
  await until(async () => { await coordinator.tick(new Date('2026-09-21T12:00:01Z')); return control.starts.length === 3; });
  expect(control.starts).toHaveLength(3);
});

it('keeps a task waiting when triage asks a human and frees its slot', async () => {
  const { store, control, coordinator } = await setup();
  const first = withId(draftTask(), '1'); const second = withId(draftTask(), '2');
  await store.create(first, 'first'); await store.create(second, 'second');
  await coordinator.tick(new Date('2026-09-21T12:00:00Z'));
  const attempt = control.starts[0].run.id;
  control.finish(attempt, { code: 0, signal: null, error: null, result: {
    taskId: first.id, attemptId: attempt, kind: 'needs_human', summary: 'Need project choice',
    artifacts: [], question: 'Which project?', checkpoint: 'Select the project',
  } });
  await until(async () => (await store.get(first.id)).status === 'waiting-for-human');
  await until(async () => { await coordinator.tick(new Date('2026-09-21T12:00:01Z')); return control.starts.length === 2; });
  expect(control.starts.map(start => start.task.id)).toEqual([first.id, second.id]);
});

it('dispatches an uncertain attempt only after a human retry records reconciliation', async () => {
  const { store, control, coordinator } = await setup();
  const task = draftTask();
  task.status = 'blocked'; task.blockedReason = 'Unknown external effect'; task.generation = 1;
  task.runs = [{ id: '33333333-3333-4333-8333-333333333333', stepId: '$triage',
    workflowVersion: null, generation: 1, phase: 'uncertain', pid: 41,
    processStartedAt: task.createdAt, runtimeVersion: 'test', inputRefs: [], repos: [],
    startedAt: task.createdAt, endedAt: task.createdAt, exitCode: null,
    retryCount: 0, nextRetryAt: null, result: null }];
  await store.create(task, 'create');
  await coordinator.tick(new Date('2026-09-21T12:00:00Z'));
  expect(control.starts).toHaveLength(0);
  await applyHumanCommand(store, coordinator, { taskId: task.id, expectedRevision: task.revision,
    requestId: 'reconcile', action: { kind: 'retry', text: 'Provider confirms no side effect' } });
  await coordinator.tick(new Date('2026-09-21T12:00:01Z'));
  expect(control.starts).toHaveLength(1);
});

it('backs off read-only transient attempts at one and five seconds and never launches a fourth', async () => {
  const { store, control, coordinator } = await setup();
  const task = draftTask(); await store.create(task, 'draft');
  for (const [time, retry] of [['2026-09-21T12:00:00Z', 0], ['2026-09-21T12:00:01Z', 1], ['2026-09-21T12:00:06Z', 2]] as const) {
    await until(async () => { await coordinator.tick(new Date(time)); return control.starts.length === retry + 1; });
    const assignment = control.starts.at(-1)!;
    expect(assignment.run.retryCount).toBe(retry);
    control.finish(assignment.run.id, { code: 0, signal: null, error: null,
      result: { kind: 'failed', taskId: task.id, attemptId: assignment.run.id,
        summary: 'Transient', artifacts: [], reason: 'temporary upstream issue', retryable: true } });
    await until(async () => (await store.get(task.id)).runs.at(-1)?.phase === 'ended');
    if (retry < 2) {
      const saved = await store.get(task.id);
      expect(saved.runs.at(-1)?.nextRetryAt).toBe(retry === 0 ? '2026-09-21T12:00:01.000Z' : '2026-09-21T12:00:06.000Z');
    }
  }
  expect((await store.get(task.id)).status).toBe('blocked');
  await coordinator.tick(new Date('2026-09-21T12:01:00Z'));
  expect(control.starts).toHaveLength(3);
});

it('stops a running attempt after a persisted pause and never accepts its normal result', async () => {
  const { store, control, coordinator } = await setup();
  const task = await store.create(draftTask(), 'draft');
  await coordinator.tick(new Date('2026-09-21T12:00:00Z'));
  const running = await store.get(task.id);
  await store.apply(task.id, running.revision, 'pause', { kind: 'human', command: {
    requestId: 'pause', taskId: task.id, expectedRevision: running.revision, action: { kind: 'pause' },
  } });
  await coordinator.stopTask(task.id);
  await until(async () => (await store.get(task.id)).status === 'waiting-for-human');
  const saved = await store.get(task.id);
  expect(saved.runs[0].result).toBeNull();
  expect(saved.reviews.at(-1)?.kind).toBe('pause');
  await coordinator.tick(new Date('2026-09-21T12:00:01Z'));
  expect(control.starts).toHaveLength(1);
});

it('stages a bounded verified artifact as exact text for the assignment', async () => {
  const { store, control, registry, settings, intake } = await setup();
  const bytes = Buffer.from('source facts');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const task = draftTask();
  const input = { id: 'facts', version: 1, digest, path: 'artifacts/facts.1.bin' };
  task.status = 'queued'; task.projectId = 'one'; task.workflow = { version: 1, completionChecks: ['findings'], steps: [
    { kind: 'agent', id: 'research', title: 'Research', role: 'researcher', instructions: 'Research',
      inputs: [input], repositories: [], actions: ['read'], outputs: [], checks: ['findings'] },
  ] };
  task.currentStepId = 'research';
  await store.create(task, 'draft');
  expect(await store.publishArtifact(task.id, input.id, bytes)).toEqual(input);
  registry.roles.push({ role: 'researcher', instructions: 'Research', skills: [], cliProfile: 'researcher', actions: ['read'] });
  const actual = createCoordinator({ store, intake, registry, runner: control.runner, settings });
  await actual.tick(new Date('2026-09-21T12:00:00Z'));
  expect(control.starts[0].materials).toEqual([{ kind: 'artifact', name: 'facts@1', text: 'source facts' }]);
});

it('uses a read-only $resolve assignment before an MCP repository step', async () => {
  const { store, control, registry, settings, intake } = await setup();
  registry.roles.push({ role: 'researcher', instructions: 'Research', skills: [], cliProfile: 'researcher', actions: ['read'] });
  registry.projects.push({ id: 'one', names: ['One'], repositories: [
    { id: 'remote', localPath: null, mcpProfile: 'remote-read', baseRef: 'main', defaultRef: 'main' },
  ] });
  const task = draftTask(); task.status = 'queued'; task.projectId = 'one';
  task.workflow = { version: 1, completionChecks: ['findings'], steps: [
    { kind: 'agent', id: 'research', title: 'Research', role: 'researcher', instructions: 'Research',
      inputs: [], repositories: ['remote'], actions: ['read'], outputs: [], checks: ['findings'] },
  ] }; task.currentStepId = 'research';
  await store.create(task, 'draft');
  const coordinator = createCoordinator({ store, intake, registry, runner: control.runner, settings });
  await coordinator.tick(new Date('2026-09-21T12:00:00Z'));
  const preparation = control.starts[0];
  expect(preparation.step.id).toBe('$resolve:research');
  expect(preparation.repositoryAccess).toEqual([{ repository: 'remote', rule: 'main', commit: null, selectedCommits: [], localPath: null, checkoutPath: null, mcpProfile: 'remote-read' }]);
  expect(buildPrompt(preparation)).toContain('remote-read');
  expect(preparation.step.instructions).toContain("completed.evidence['repository-refs']");
  expect(preparation.step.instructions).toContain('Do not create a file artifact');
  const exact = [{ repository: 'remote', rule: 'main', commit: 'a'.repeat(40), selectedCommits: ['a'.repeat(40)] }];
  control.finish(preparation.run.id, { code: 0, signal: null, error: null, result: {
    kind: 'completed', taskId: task.id, attemptId: preparation.run.id, summary: 'Resolved', artifacts: [],
    evidence: { 'repository-refs': JSON.stringify(exact) },
  } });
  await until(async () => (await store.get(task.id)).runs[0]?.phase === 'ended');
  await until(async () => { await coordinator.tick(new Date('2026-09-21T12:00:01Z')); return control.starts.length === 2; });
  expect(control.starts[1].step.id).toBe('research');
  expect(control.starts[1].run.repos).toEqual(exact);
  expect(control.starts[1].repositoryAccess).toEqual([{ ...exact[0], localPath: null, checkoutPath: null, mcpProfile: 'remote-read' }]);
  expect(control.starts[1].materials[0].name).toBe('repository-refs@1');
});

it('accepts current work after a human inserts a review for a future step', async () => {
  const { store, control, registry, settings, intake } = await setup();
  registry.roles.push({ role: 'researcher', instructions: 'Research', skills: [], cliProfile: 'researcher', actions: ['read'] });
  const task = draftTask(); task.status = 'queued'; task.currentStepId = 'research';
  task.workflow = { version: 1, completionChecks: ['findings', 'draft'], steps: [
    { kind: 'agent', id: 'research', title: 'Research', role: 'researcher', instructions: 'Research',
      inputs: [], repositories: [], actions: ['read'], outputs: [], checks: ['findings'] },
    { kind: 'agent', id: 'write', title: 'Write', role: 'researcher', instructions: 'Write',
      inputs: [], repositories: [], actions: ['read'], outputs: [], checks: ['draft'] },
  ] };
  await store.create(task, 'draft');
  const coordinator = createCoordinator({ store, intake, registry, runner: control.runner, settings });
  await coordinator.tick(new Date('2026-09-21T12:00:00Z'));
  const launched = await store.get(task.id);
  const inserted = await store.apply(task.id, launched.revision, 'insert', { kind: 'human', command: {
    requestId: 'insert', taskId: task.id, expectedRevision: launched.revision,
    action: { kind: 'insert-review', beforeStepId: 'write', title: 'Review research' },
  } });
  expect(inserted.generation).toBe(launched.generation);
  const assignment = control.starts[0];
  control.finish(assignment.run.id, { code: 0, signal: null, error: null, result: {
    kind: 'completed', taskId: task.id, attemptId: assignment.run.id, summary: 'Research done',
    artifacts: [], evidence: { findings: 'Verified source' },
  } });
  await until(async () => (await store.get(task.id)).status === 'waiting-for-human');
  const saved = await store.get(task.id);
  expect(saved.completedStepIds).toContain('research');
  expect(saved.currentStepId).toMatch(/^review-/);
});

it('blocks an unsupported action profile before launch', async () => {
  const { store, control, registry, settings, intake } = await setup();
  registry.roles.push({ role: 'researcher', instructions: 'Research', skills: [], cliProfile: 'broad', actions: ['read', 'merge'] });
  const task = draftTask(); task.status = 'queued'; task.currentStepId = 'research';
  task.workflow = { version: 1, completionChecks: ['findings'], steps: [
    { kind: 'agent', id: 'research', title: 'Research', role: 'researcher', instructions: 'Research',
      inputs: [], repositories: [], actions: ['read'], outputs: [], checks: ['findings'] },
  ] };
  await store.create(task, 'draft');
  const coordinator = createCoordinator({ store, intake, registry, runner: control.runner, settings });
  await coordinator.tick(new Date('2026-09-21T12:00:00Z'));
  expect(control.starts).toHaveLength(0);
  expect((await store.get(task.id)).blockedReason).toMatch(/Unsupported action profile/);
});

it('stops a process when pause arrives before spawn registration', async () => {
  const { store, control, registry, settings, intake } = await setup();
  const task = await store.create(draftTask(), 'draft');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runner = { probe: control.runner.probe,
    async start(...args: Parameters<typeof control.runner.start>) { await gate; return control.runner.start(...args); } };
  const coordinator = createCoordinator({ store, intake, registry, runner, settings });
  const tick = coordinator.tick(new Date('2026-09-21T12:00:00Z'));
  await until(async () => {
    try { return (await store.get(task.id)).runs[0]?.phase === 'launch-intent'; }
    catch { return false; }
  });
  const launched = await store.get(task.id);
  await store.apply(task.id, launched.revision, 'pause', { kind: 'human', command: {
    requestId: 'pause', taskId: task.id, expectedRevision: launched.revision, action: { kind: 'pause' },
  } });
  release(); await tick;
  await until(async () => (await store.get(task.id)).status === 'waiting-for-human');
  expect((await store.get(task.id)).runs[0].result).toBeNull();
});

it('stops a spawned process when started-state persistence fails', async () => {
  const { store, control, registry, settings, intake } = await setup();
  const task = await store.create(draftTask(), 'draft');
  const apply = store.apply.bind(store);
  store.apply = async (...args) => {
    if (args[3].kind === 'started') throw new Error('injected started-state write failure');
    return apply(...args);
  };
  const coordinator = createCoordinator({ store, intake, registry, runner: control.runner, settings });
  await coordinator.tick(new Date('2026-09-21T12:00:00Z'));
  const saved = await store.get(task.id);
  expect(saved.status).toBe('blocked');
  expect(saved.runs[0].phase).toBe('uncertain');
  expect(control.starts).toHaveLength(1);
  await coordinator.tick(new Date('2026-09-21T12:00:01Z'));
  expect(control.starts).toHaveLength(1);
});

it.each(['started', 'process'] as const)('releases capacity and stop handles after %s persistence fails', async failure => {
  const { store, control, registry, settings, intake } = await setup();
  const first = withId(draftTask(), '1'); const second = withId(draftTask(), '2');
  await store.create(first, 'first'); await store.create(second, 'second');
  if (failure === 'started') {
    const apply = store.apply.bind(store);
    store.apply = async (...args) => {
      if (args[0] === first.id && args[3].kind === 'started') throw new Error('injected started write failure');
      return apply(...args);
    };
  } else {
    const publish = store.publishRunFiles.bind(store);
    store.publishRunFiles = async (...args) => {
      if (args[0] === first.id && 'process.json' in args[2]) throw new Error('injected process write failure');
      return publish(...args);
    };
  }
  const coordinator = createCoordinator({ store, intake, registry, runner: control.runner, settings });
  await coordinator.tick(new Date('2026-09-21T12:00:00Z'));
  expect((await store.get(first.id)).runs[0].phase).toBe('uncertain');
  await Promise.race([coordinator.stopTask(first.id), new Promise((_, reject) => setTimeout(() => reject(new Error('stopTask hung')), 1000))]);
  await coordinator.tick(new Date('2026-09-21T12:00:01Z'));
  expect(control.starts.map(assignment => assignment.task.id)).toEqual([first.id, second.id]);
  await Promise.race([coordinator.shutdown(), new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown hung')), 1000))]);
});

it('bounds shutdown for an unconfirmed mutating process and prevents replay after restart', async () => {
  const { store, registry, settings, intake } = await setup();
  settings.stopGraceMs = 20;
  registry.roles.push({ role: 'implementer', instructions: 'Implement', skills: [], cliProfile: 'implementer', actions: ['write-local'] });
  const task = draftTask();
  task.status = 'queued';
  task.currentStepId = 'implement';
  task.workflow = { version: 1, completionChecks: ['done'], steps: [{ kind: 'agent', id: 'implement',
    title: 'Implement', role: 'implementer', instructions: 'Do work', inputs: [], repositories: [],
    actions: ['write-local'], outputs: [], checks: ['done'] }] };
  await store.create(task, 'create');
  let finish!: (exit: Exit) => void;
  let starts = 0;
  let abandoned = 0;
  const runner: Runner = { probe: async () => ({ version: 'fake' }),
    async start() {
      starts++;
      const completion = new Promise<Exit>(resolve => { finish = resolve; });
      return { pid: 99999, processStartedAt: task.createdAt, completion,
        stop: () => new Promise<void>(() => {}), abandon: () => { abandoned++; } };
    } };
  const coordinator = createCoordinator({ store, intake, registry, runner, settings });
  await coordinator.tick(new Date());
  const running = await store.get(task.id);
  expect(running.runs[0].phase).toBe('running');
  await Promise.race([coordinator.shutdown(), new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown hung')), 2500))]);
  const saved = await store.get(task.id);
  expect(saved.runs[0].phase).toBe('uncertain');
  expect(saved.runs[0].nextRetryAt).toBeNull();
  expect(saved.status).toBe('blocked');
  expect(abandoned).toBe(1);
  finish({ code: 0, signal: null, error: null, result: { kind: 'completed', taskId: task.id,
    attemptId: saved.runs[0].id, summary: 'Late', artifacts: [], evidence: { done: 'yes' } } });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect((await store.get(task.id)).runs[0].result).toBeNull();
  const reopened = await openStore(settings.workspaceRoot);
  const restarted = createCoordinator({ store: reopened, intake, registry, runner, settings });
  await restarted.tick(new Date(Date.now() + 60_000));
  expect(starts).toBe(1);
  await restarted.shutdown();
});

it.each(['started', 'process'] as const)('bounds an unconfirmed stop during %s registration', async phase => {
  const { store, control, registry, settings, intake } = await setup();
  settings.stopGraceMs = 20;
  const task = await store.create(draftTask(), 'create');
  let entered!: () => void; let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  if (phase === 'started') {
    const original = store.apply.bind(store);
    store.apply = async (...args) => {
      if (args[3].kind === 'started') { entered(); await gate; }
      return original(...args);
    };
  } else {
    const original = store.publishRunFiles.bind(store);
    store.publishRunFiles = async (...args) => {
      if ('process.json' in args[2]) { entered(); await gate; }
      return original(...args);
    };
  }
  let abandoned = 0;
  const runner: Runner = { probe: control.runner.probe,
    async start(assignment, onLine) {
      const active = await control.runner.start(assignment, onLine);
      return { ...active, stop: () => new Promise<void>(() => {}), abandon: () => { abandoned++; } };
    } };
  const coordinator = createCoordinator({ store, intake, registry, runner, settings });
  const ticking = coordinator.tick(new Date());
  await reached;
  const pending = phase === 'started' ? coordinator.shutdown() : (async () => {
    const current = await store.get(task.id);
    return applyHumanCommand(store, coordinator, { requestId: 'pause-during-registration', taskId: task.id,
      expectedRevision: current.revision, action: { kind: 'pause' } });
  })();
  if (phase === 'process') {
    await until(async () => (await store.get(task.id)).intent === 'pause');
  }
  release();
  await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('registration stop hung')), 2500))]);
  await Promise.race([ticking, new Promise((_, reject) => setTimeout(() => reject(new Error('registration tick hung')), 2500))]);
  const saved = await store.get(task.id);
  expect(saved.runs[0].phase).toBe('uncertain');
  expect(saved.runs[0].nextRetryAt).toBeNull();
  expect(abandoned).toBe(1);
  if (phase === 'process') { expect(saved.status).toBe('blocked'); expect(saved.intent).toBe('pause'); }
  const reopened = await openStore(settings.workspaceRoot);
  expect((await reopened.get(task.id)).runs[0].phase).toBe('uncertain');
});

it('shuts down with the started-event gate still closed and fences its continuation', async () => {
  const { store, control, registry, settings, intake } = await setup();
  settings.stopGraceMs = 20;
  const task = await store.create(draftTask(), 'create');
  let entered!: () => void; let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = store.apply.bind(store);
  store.apply = async (...args) => {
    if (args[3].kind === 'started') { entered(); await gate; }
    return original(...args);
  };
  let abandoned = 0;
  const runner: Runner = { probe: control.runner.probe,
    async start(assignment, onLine) {
      const active = await control.runner.start(assignment, onLine);
      return { ...active, stop: () => new Promise<void>(() => {}), abandon: () => { abandoned++; } };
    } };
  const coordinator = createCoordinator({ store, intake, registry, runner, settings });
  const ticking = coordinator.tick(new Date());
  await reached;
  try {
    await Promise.race([coordinator.shutdown(), new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown waited for registration')), 2500))]);
    const saved = await store.get(task.id);
    expect(saved.runs[0].phase).toBe('uncertain');
    expect(saved.runs[0].nextRetryAt).toBeNull();
    expect(abandoned).toBe(1);
  } finally { release(); }
  await Promise.race([ticking, new Promise((_, reject) => setTimeout(() => reject(new Error('late registration hung')), 2500))]);
  control.finish(control.starts[0].run.id, { code: 1, signal: null, result: null, error: 'late result' });
  await coordinator.tick(new Date(Date.now() + 10_000));
  expect(control.starts).toHaveLength(1);
  expect((await store.get(task.id)).runs[0].phase).toBe('uncertain');
  expect((await store.get(task.id)).runs[0].result).toBeNull();
});

it('does not start a process after shutdown overtakes preparation', async () => {
  const { store, registry, settings, intake } = await setup();
  await store.create(draftTask(), 'create');
  let entered!: () => void; let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let starts = 0;
  const runner: Runner = { async probe() { entered(); await gate; return { version: 'fake' }; },
    async start() { starts++; throw new Error('Late spawn'); } };
  const coordinator = createCoordinator({ store, intake, registry, runner, settings });
  const ticking = coordinator.tick(new Date());
  await reached;
  try {
    await Promise.race([coordinator.shutdown(), new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown waited for preparation')), 2500))]);
  } finally { release(); }
  await Promise.race([ticking, new Promise((_, reject) => setTimeout(() => reject(new Error('late preparation hung')), 2500))]);
  expect(starts).toBe(0);
});

it('fails closed within the deadline when uncertainty cannot be persisted', async () => {
  const { store, control, registry, settings, intake } = await setup();
  settings.stopGraceMs = 20;
  const task = await store.create(draftTask(), 'create');
  let entered!: () => void; let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = store.apply.bind(store);
  store.apply = async (...args) => {
    if (args[3].kind === 'run-failed') { entered(); await gate; }
    return original(...args);
  };
  const runner: Runner = { probe: control.runner.probe,
    async start(assignment, onLine) {
      const active = await control.runner.start(assignment, onLine);
      return { ...active, stop: () => new Promise<void>(() => {}) };
    } };
  const coordinator = createCoordinator({ store, intake, registry, runner, settings });
  await coordinator.tick(new Date());
  try {
    const pending = coordinator.shutdown();
    await reached;
    await expect(Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown hung')), 2500))]))
      .rejects.toThrow(/Could not complete shutdown cleanup/);
    expect((await store.get(task.id)).runs[0].phase).toBe('running');
  } finally { release(); }
  await until(async () => (await store.get(task.id)).runs[0].phase === 'uncertain');
  expect((await store.get(task.id)).runs[0].nextRetryAt).toBeNull();
});

it('publishes declared output bytes and binds the accepted result to their new version', async () => {
  const { store, control, coordinator } = await setup();
  const task = await store.create(draftTask(), 'draft');
  await coordinator.tick(new Date('2026-09-21T12:00:00Z'));
  const assignment = control.starts[0];
  const bytes = Buffer.from('Review this workflow.');
  const digest = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(assignment.outputDir, 'brief.md'), bytes);
  control.finish(assignment.run.id, { code: 0, signal: null, error: null, result: {
    kind: 'propose_workflow_change', taskId: task.id, attemptId: assignment.run.id,
    summary: 'Workflow proposed', artifacts: [{ id: 'brief', version: 1, digest, path: 'brief.md' }],
    workflow: workflowProposal(), reason: 'Review plan', title: 'Idea', taskType: 'feature', projectId: null,
  } });
  await until(async () => (await store.get(task.id)).status === 'waiting-for-human');
  const saved = await store.get(task.id);
  expect(saved.runs[0].result?.artifacts[0]).toEqual({ id: 'brief', version: 1, digest, path: 'artifacts/brief.1.bin' });
  expect(Buffer.from(await store.readArtifact(task.id, saved.artifacts[0])).equals(bytes)).toBe(true);
});

it('derives retry count from durable attempts after a coordinator restart', async () => {
  const { store, control, coordinator, registry, settings, intake } = await setup();
  const task = await store.create(draftTask(), 'draft');
  await coordinator.tick(new Date('2026-09-21T12:00:00Z'));
  const first = control.starts[0];
  control.finish(first.run.id, { code: 0, signal: null, error: null, result: {
    kind: 'failed', taskId: task.id, attemptId: first.run.id, summary: 'Temporary', artifacts: [],
    reason: 'temporary outage', retryable: true,
  } });
  await until(async () => (await store.get(task.id)).runs[0].phase === 'ended');
  const reopened = await openStore(settings.workspaceRoot);
  const nextControl = controlledRunner();
  const restarted = createCoordinator({ store: reopened, intake, registry, runner: nextControl.runner, settings });
  await restarted.tick(new Date('2026-09-21T12:00:01Z'));
  expect(nextControl.starts).toHaveLength(1);
  expect(nextControl.starts[0].run.retryCount).toBe(1);
});

it('blocks merge without an approved checkpoint even with a matching role profile', async () => {
  const { store, control, registry, settings, intake } = await setup();
  registry.roles.push({ role: 'implementer', instructions: 'Merge', skills: [], cliProfile: 'merge', actions: ['merge'] });
  const task = draftTask(); task.status = 'queued'; task.currentStepId = 'merge';
  task.workflow = { version: 1, completionChecks: ['merged'], steps: [
    { kind: 'agent', id: 'merge', title: 'Merge', role: 'implementer', instructions: 'Merge',
      inputs: [], repositories: [], actions: ['merge'], outputs: [], checks: ['merged'] },
  ] };
  await store.create(task, 'draft');
  const coordinator = createCoordinator({ store, intake, registry, runner: control.runner, settings });
  await coordinator.tick(new Date('2026-09-21T12:00:00Z'));
  expect(control.starts).toHaveLength(0);
  expect((await store.get(task.id)).blockedReason).toMatch(/approved human checkpoint/);
});

it('rejects a mismatched final result without advancing the task', async () => {
  const { store, control, coordinator } = await setup();
  const task = await store.create(draftTask(), 'draft');
  await coordinator.tick(new Date('2026-09-21T12:00:00Z'));
  const assignment = control.starts[0];
  control.finish(assignment.run.id, { code: 0, signal: null, error: null, result: {
    kind: 'needs_human', taskId: '22222222-2222-4222-8222-222222222222', attemptId: assignment.run.id,
    summary: 'Wrong task', artifacts: [], question: 'Which?', checkpoint: 'Clarify',
  } });
  await until(async () => (await store.get(task.id)).status === 'blocked');
  expect((await store.get(task.id)).reviews).toHaveLength(0);
});

it('records only one result when a runner invokes its final callback twice', async () => {
  const { store, control, registry, settings, intake } = await setup();
  const task = await store.create(draftTask(), 'draft');
  const runner: Runner = { probe: control.runner.probe, async start(assignment, onLine) {
    const active = await control.runner.start(assignment, onLine);
    const completion = { then(onFulfilled: (exit: Exit) => unknown) {
      void active.completion.then(exit => { void onFulfilled(exit); void onFulfilled(exit); });
      return Promise.resolve();
    } } as Promise<Exit>;
    return { ...active, completion };
  } };
  const coordinator = createCoordinator({ store, intake, registry, runner, settings });
  await coordinator.tick(new Date('2026-09-21T12:00:00Z'));
  const attempt = control.starts[0].run.id;
  control.finish(attempt, { code: 0, signal: null, error: null, result: {
    kind: 'needs_human', taskId: task.id, attemptId: attempt, summary: 'Question',
    artifacts: [], question: 'Which project?', checkpoint: 'Select project',
  } });
  await until(async () => (await store.get(task.id)).status === 'waiting-for-human');
  expect((await store.get(task.id)).reviews).toHaveLength(1);
  expect((await store.get(task.id)).revision).toBe(4);
});

it('gives triage the configured project choices while allowing an unmatched draft', async () => {
  const { store, control, coordinator, registry } = await setup();
  registry.projects.push({ id: 'sales', names: ['Digital Sales', 'Sales'], repositories: [] });
  await store.create(draftTask(), 'draft');
  await coordinator.tick(new Date('2026-09-21T12:00:00Z'));
  expect(control.starts).toHaveLength(1);
  expect(control.starts[0].task.projectId).toBeNull();
  expect(control.starts[0].step.instructions).toContain('Digital Sales');
  expect(control.starts[0].step.instructions).toContain('needs_human');
});

it('instructs triage to use a repository-free workflow when no projects exist', async () => {
  const { store, control, coordinator } = await setup();
  await store.create(draftTask(), 'draft');
  await coordinator.tick(new Date('2026-09-21T12:00:00Z'));
  const instructions = control.starts[0].step.instructions;
  expect(instructions).toContain('projectId: null');
  expect(instructions).toContain('repositories: []');
  expect(instructions).not.toContain('return needs_human with the choices');
});

it.each(['pause', 'cancel'] as const)('preserves an unconfirmed %s barrier across restart until reconciliation', async kind => {
  const { store, registry, settings, intake, control } = await setup();
  const task = await store.create(draftTask(), 'create');
  const runner: Runner = { probe: control.runner.probe, async start(...args) {
    return { ...await control.runner.start(...args), async stop() { throw new Error('process still running; could not stop'); } };
  } };
  const coordinator = createCoordinator({ store, registry, settings, intake, runner });
  await coordinator.tick(new Date());
  let saved = await store.get(task.id);
  await applyHumanCommand(store, coordinator, { taskId: task.id, expectedRevision: saved.revision,
    requestId: 'stop', action: { kind } });
  saved = await store.get(task.id);
  expect(saved.status).toBe('blocked');
  expect(saved.intent).toBe(kind);
  expect(saved.runs[0].endedAt).toBeNull();
  const reopened = await openStore(settings.workspaceRoot);
  const restarted = createCoordinator({ store: reopened, registry, settings, intake, runner });
  await restarted.tick(new Date());
  expect(control.starts).toHaveLength(1);
  saved = await reopened.get(task.id);
  await applyHumanCommand(reopened, restarted, { taskId: task.id, expectedRevision: saved.revision,
    requestId: 'repeat-stop', action: { kind } });
  saved = await reopened.get(task.id);
  expect(saved.status).toBe('blocked');
  await applyHumanCommand(reopened, restarted, { taskId: task.id, expectedRevision: saved.revision,
    requestId: 'reconcile-stop', action: { kind: 'retry', text: 'Verified process tree absent and reconciled provider effects' } });
  saved = await reopened.get(task.id);
  expect(saved.intent).toBeNull();
  expect(saved.status).toBe(kind === 'cancel' ? 'cancelled' : 'waiting-for-human');
  expect(saved.runs[0].reconciliationNote).toContain('process tree absent');
});

it('materializes evidence-only declared reports before review and completes reviewed work', async () => {
  const { store, control, registry, settings, intake } = await setup();
  registry.roles.push({ role: 'researcher', instructions: 'Research', skills: [], cliProfile: 'researcher', actions: ['read'] });
  const task = draftTask(); task.status = 'queued'; task.currentStepId = 'research'; task.workflow = workflowProposal();
  await store.create(task, 'create');
  const coordinator = createCoordinator({ store, registry, settings, intake, runner: control.runner });
  await coordinator.tick(new Date());
  const assignment = control.starts[0];
  control.finish(assignment.run.id, { code: 0, signal: null, error: null, result: {
    kind: 'completed', taskId: task.id, attemptId: assignment.run.id, summary: 'Findings ready',
    artifacts: [], evidence: { findings: 'Detailed safe report with unique evidence' },
  } });
  await until(async () => (await store.get(task.id)).status === 'waiting-for-human');
  const saved = await store.get(task.id);
  expect(saved.artifacts).toHaveLength(1);
  const review = saved.reviews.at(-1)!;
  expect(review.artifacts).toEqual(saved.artifacts);
  expect(Buffer.from(await store.readArtifact(task.id, saved.artifacts[0])).toString()).toBe('Detailed safe report with unique evidence');
  await applyHumanCommand(store, coordinator, { taskId: task.id, expectedRevision: saved.revision,
    requestId: 'approve-report', action: { kind: 'approve', reviewId: review.id, artifactDigests: review.artifacts.map(ref => ref.digest) } });
  expect((await store.get(task.id)).status).toBe('done');
});


it.each([false, true])('routes selected local repositories with exact refs (mutable=%s)', async mutable => {
  const { store, control, registry, settings, intake } = await setup();
  const root = await mkdtemp(join(tmpdir(), 'symphony-mapping-')); roots.push(root);
  const repositories = [];
  for (const id of ['one', 'two', 'unselected']) {
    const source = join(root, id); await mkdir(source);
    for (const args of [['init', '-q'], ['config', 'user.email', 'fixture@example.invalid'], ['config', 'user.name', 'Fixture'], ['commit', '--allow-empty', '-qm', 'fixture']])
      execFileSync('git', ['-C', source, ...args]);
    repositories.push({ id, localPath: await realpath(source), mcpProfile: null, baseRef: 'HEAD', defaultRef: 'HEAD' });
  }
  registry.projects.push({ id: 'selected-project', names: [], repositories });
  const actions = mutable ? ['write-local' as const] : ['read' as const];
  registry.roles.push({ role: 'researcher', instructions: 'Research', skills: [], cliProfile: 'researcher', actions });
  const task = draftTask(); task.status = 'queued'; task.projectId = 'selected-project'; task.currentStepId = 'research';
  task.workflow = workflowProposal(); task.workflow.steps = [{ ...task.workflow.steps[0] as import('../../shared/contracts.js').AgentStep,
    repositories: ['one', 'two'], actions }];
  await store.create(task, 'create');
  const coordinator = createCoordinator({ store, registry, settings, intake, runner: control.runner });
  await coordinator.tick(new Date());
  expect(control.starts).toHaveLength(1);
  const assignment = control.starts[0];
  expect(assignment.repositoryAccess).toHaveLength(2);
  expect(buildPrompt(assignment)).not.toContain('unselected');
  for (const mapping of assignment.repositoryAccess!) {
    expect(mapping.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(buildPrompt(assignment)).toContain(mapping.localPath!);
    if (mutable) {
      expect(mapping.checkoutPath).toBe(join(await realpath(settings.localRoot), 'tasks', task.id, 'repositories', mapping.repository));
      expect(buildPrompt(assignment)).toContain(mapping.checkoutPath!);
    } else expect(mapping.checkoutPath).toBeNull();
  }
  if (mutable) expect(assignment.cwd).toBe(assignment.repositoryAccess![0].checkoutPath);
  await coordinator.shutdown();
});

it('bounds evidence-only report bytes before publishing any artifact', async () => {
  const { store, control, registry, settings, intake } = await setup();
  settings.outputLimitBytes = 16;
  registry.roles.push({ role: 'researcher', instructions: 'Research', skills: [], cliProfile: 'researcher', actions: ['read'] });
  const task = draftTask(); task.status = 'queued'; task.currentStepId = 'research'; task.workflow = workflowProposal();
  await store.create(task, 'create');
  const coordinator = createCoordinator({ store, registry, settings, intake, runner: control.runner });
  await coordinator.tick(new Date());
  const assignment = control.starts[0];
  control.finish(assignment.run.id, { code: 0, signal: null, error: null, result: {
    kind: 'completed', taskId: task.id, attemptId: assignment.run.id, summary: 'Too large', artifacts: [], evidence: { findings: 'x'.repeat(17) },
  } });
  await until(async () => (await store.get(task.id)).status === 'blocked');
  const saved = await store.get(task.id);
  expect(saved.blockedReason).toMatch(/material limit/);
  expect(saved.artifacts).toHaveLength(0);
  expect(saved.runs[0].result).toBeNull();
});

it('dispatches connected investigations from pinned snapshots after the source is removed', async () => {
 const { createProjectFixture, createRepository } = await import('../testing/projects.js');
 const { scanRoot } = await import('../projects/discovery.js');
 const { openProjectCatalog } = await import('../projects/catalog.js');
 const { openSnapshots, resolveSourceCommit } = await import('../projects/snapshots.js');
 const f = await createProjectFixture();
 try {
  await createRepository(f.root, 'shop', { 'README.md': 'Committed' });
  const root = { projectsRoot: f.root, generation: 'g1', revision: 'r1', state: 'ready' as const, message: null };
  const catalog = await openProjectCatalog(f.local), project = (await catalog.reconcile(root, await scanRoot(root, { timeoutMs: 5000 }))).records[0];
  const snapshots = await openSnapshots(f.local, { entries: 100, totalBytes: 10000, fileBytes: 10000, timeoutMs: 5000 });
  const resolved = await resolveSourceCommit(project, 'main'); await snapshots.importCommit(project, resolved);
  const snapshot = await snapshots.materialize(project, resolved);
  const task = { ...draftTask(), schemaVersion: 2 as const, purpose: 'project-brief' as const,
   projectContext: { version: 1 as const, generation: 'g1', resolutionRevision: 'a'.repeat(64), targetId: null, referenceIds: [project.id],
    projects: [{ projectId: project.id, repositoryId: project.id, name: 'shop', ref: 'main', snapshot, brief: null }] } };
  task.status = 'queued'; task.currentStepId = 'research'; task.workflow = workflowProposal();
  (task.workflow.steps[0] as import('../../shared/contracts.js').AgentStep).repositories = [project.id];
  const store = await openStore(f.workspace), control = controlledRunner(); await store.create(task, 'create');
  await rm(f.root, { recursive: true });
  const coordinator = createCoordinator({ store, runner: control.runner, settings: { localRoot: f.local, workspaceRoot: f.workspace, concurrency: 1 } as Settings,
   intake: { scan: async () => {}, issues: async () => [], submit: async () => ({ submissionId: 'unused' }) },
   registry: { projects: [], roles: [{ role: 'researcher', instructions: 'Read', skills: [], cliProfile: 'researcher', actions: ['read'] }] } });
  await coordinator.tick(new Date());
  expect(control.starts).toHaveLength(1);
  expect(control.starts[0].run.repos[0].commit).toBe(resolved.commit);
  expect(control.starts[0].repositoryAccess).toEqual([]);
  expect(control.starts[0].snapshotAccess?.[0].snapshotPath).toContain('/projects/snapshots/');
  expect(control.starts[0].snapshotAccess?.[0].snapshotPath).not.toContain('/sources/');
  control.finish(control.starts[0].run.id, { code: 1, signal: null, result: null, error: 'End fixture' });
  await until(async () => (await store.get(task.id)).status === 'blocked'); await coordinator.shutdown();
 } finally { await f.dispose(); }
});
