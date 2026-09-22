import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftTask, waitingTask, workflowProposal } from '../testing/fixtures.js';
import { eligibleStep, reduceTask } from '../domain/workflow.js';
import { openStore } from '../store/task-store.js';
import type { Coordinator } from './coordinator.js';
import { applyHumanCommand } from './reviews.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'symphony-reviews-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function runningTask() {
  const task = draftTask();
  task.status = 'running';
  task.generation = 1;
  task.runs = [{ id: '22222222-2222-4222-8222-222222222222', stepId: '$triage',
    workflowVersion: null, generation: 1, phase: 'running', pid: 42,
    processStartedAt: task.createdAt, runtimeVersion: 'test', inputRefs: [], repos: [],
    startedAt: task.createdAt, endedAt: null, exitCode: null, retryCount: 0,
    nextRetryAt: null, result: null }];
  return task;
}

describe('human command boundary', () => {
  it('persists the pause barrier before requesting stop', async () => {
    const store = await openStore(root);
    const task = await store.create(runningTask(), 'create');
    let stopped = 0;
    const coordinator: Coordinator = { tick: async () => {}, shutdown: async () => {},
      stopTask: async (id, attemptId) => {
        stopped++;
        const saved = await store.get(id);
        expect(saved.intent).toBe('pause');
        expect(eligibleStep(saved)).toBeNull();
        expect(attemptId).toBe(task.runs[0].id);
        expect(() => reduceTask(saved, { kind: 'finished', attemptId: task.runs[0].id,
          generation: 1, exitCode: 0, result: { kind: 'propose_workflow_change',
            taskId: task.id, attemptId: task.runs[0].id, summary: 'Plan', artifacts: [],
            workflow: workflowProposal(), reason: 'Plan', title: task.title,
            taskType: task.type, projectId: task.projectId } }, task.updatedAt))
          .toThrow(/stale|superseded/i);
      } };
    const paused = await applyHumanCommand(store, coordinator, { taskId: task.id,
      expectedRevision: task.revision, requestId: 'pause-1', action: { kind: 'pause' } });
    expect(paused.intent).toBe('pause');
    expect(stopped).toBe(1);
  });

  it('rejects a stale approval before it changes the accepted workflow', async () => {
    const store = await openStore(root);
    const task = await store.create(waitingTask(), 'create');
    const coordinator: Coordinator = { tick: async () => {}, shutdown: async () => {}, stopTask: async () => {} };
    await expect(applyHumanCommand(store, coordinator, { taskId: task.id,
      expectedRevision: task.revision + 1, requestId: 'stale', action: {
        kind: 'approve', reviewId: 'workflow-review', artifactDigests: [],
      } })).rejects.toMatchObject({ code: 'conflict' });
    expect((await store.get(task.id)).workflow).toBeNull();
  });

  it('does not stop a later run when an old pause request is replayed', async () => {
    const store = await openStore(root);
    const task = await store.create(runningTask(), 'create');
    let stopped = 0;
    const coordinator: Coordinator = { tick: async () => {}, shutdown: async () => {},
      stopTask: async () => { stopped++; } };
    const command = { taskId: task.id, expectedRevision: task.revision,
      requestId: 'pause-replay', action: { kind: 'pause' as const } };
    const accepted = await applyHumanCommand(store, coordinator, command);
    const settled = await store.apply(task.id, accepted.revision, 'stopped', { kind: 'stopped',
      attemptId: task.runs[0].id, uncertainEffects: false });
    const review = settled.reviews.at(-1)!;
    await applyHumanCommand(store, coordinator, { taskId: task.id,
      expectedRevision: settled.revision, requestId: 'continue', action: {
        kind: 'approve', reviewId: review.id, artifactDigests: [],
      } });
    expect((await applyHumanCommand(store, coordinator, command)).revision).toBe(accepted.revision);
    expect(stopped).toBe(1);
  });
});
