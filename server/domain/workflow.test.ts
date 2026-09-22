import { describe, expect, it } from 'vitest';
import { draftTask, waitingTask, workflowProposal } from '../testing/fixtures.js';
import { eligibleStep, hasCurrentApproval, isTerminal, reduceTask } from './workflow.js';
import { parseTask } from '../../shared/validate.js';
import type { Run } from '../../shared/contracts.js';

const NOW = '2026-09-21T12:00:00Z';
const RUN_ID = '22222222-2222-4222-8222-222222222222';

function runningResearch(): { task: ReturnType<typeof draftTask>; run: Run } {
  const task = draftTask();
  task.status = 'running'; task.workflow = workflowProposal(); task.currentStepId = 'research';
  const run: Run = { id: RUN_ID, stepId: 'research', workflowVersion: 1,
    generation: 1, phase: 'running', pid: 42, processStartedAt: NOW,
    runtimeVersion: 'test', inputRefs: [], repos: [], startedAt: NOW,
    endedAt: null, exitCode: null, retryCount: 0, nextRetryAt: null, result: null };
  task.generation = 1; task.runs = [run];
  return { task, run };
}

function recordCompletedResearch(task: ReturnType<typeof draftTask>, artifacts: Run['inputRefs'] = []): void {
  task.runs.push({ ...runningResearch().run, phase: 'ended', endedAt: NOW, exitCode: 0,
    result: { kind: 'completed', taskId: task.id, attemptId: RUN_ID,
      summary: 'Research accepted', artifacts, evidence: { findings: 'checked' } } });
  task.generation = Math.max(task.generation, 1);
}

describe('workflow lifecycle', () => {
  it('permits the built-in triage step on a fresh draft', () => {
    expect(eligibleStep(draftTask())?.id).toBe('$triage');
    expect(eligibleStep(draftTask())?.actions).toEqual(['read']);
  });

  it('cannot dispatch proposed work before approval', () => {
    const t = waitingTask();
    expect(eligibleStep(t)).toBeNull();
    const next = reduceTask(t, { kind: 'human', command: {
      requestId: 'approve-1', taskId: t.id, expectedRevision: 1,
      action: { kind: 'approve', reviewId: 'workflow-review', artifactDigests: [] },
    } }, NOW);
    expect(next.workflow?.version).toBe(1);
    expect(eligibleStep(next)?.id).toBe('research');
    expect(next.revision).toBe(1);
  });

  it('persists a review inserted before the first agent and resumes that agent on approval', () => {
    const waiting = waitingTask();
    const approved = reduceTask(waiting, { kind: 'human', command: {
      requestId: 'approve-workflow', taskId: waiting.id, expectedRevision: 1,
      action: { kind: 'approve', reviewId: 'workflow-review', artifactDigests: [] },
    } }, NOW);
    const inserted = reduceTask(approved, { kind: 'human', command: {
      requestId: 'insert-scope', taskId: approved.id, expectedRevision: 1,
      action: { kind: 'insert-review', beforeStepId: 'research', title: 'Review scope' },
    } }, NOW);
    expect(parseTask(JSON.parse(JSON.stringify(inserted))).workflow?.steps[0]).toMatchObject({
      kind: 'human', producerStepId: '$triage', allowsStepId: 'research',
    });
    expect(inserted.status).toBe('waiting-for-human');
    const review = inserted.reviews.at(-1)!;
    const resumed = reduceTask(inserted, { kind: 'human', command: {
      requestId: 'approve-scope', taskId: inserted.id, expectedRevision: 1,
      action: { kind: 'approve', reviewId: review.id, artifactDigests: [] },
    } }, NOW);
    expect(eligibleStep(resumed)?.id).toBe('research');
  });

  it('rejects insertion during a pending pause review so Continue remains usable', () => {
    const task = waitingTask();
    task.workflow = workflowProposal();
    task.proposedWorkflow = null;
    task.currentStepId = 'research';
    task.reviews = [{ id: 'pause-review', kind: 'pause', workflowVersion: 1,
      stepId: 'research', artifacts: [], prompt: 'Resume this task?', answer: null, decision: null }];
    expect(() => reduceTask(task, { kind: 'human', command: { requestId: 'insert-while-paused',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'insert-review', beforeStepId: 'research', title: 'Review first' } } }, NOW))
      .toThrow(/pending|waiting|review/i);
    expect(task.workflow.version).toBe(1);
    const continued = reduceTask(task, { kind: 'human', command: { requestId: 'continue-pause',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'approve', reviewId: 'pause-review', artifactDigests: [] } } }, NOW);
    expect(continued.status).toBe('queued');
    expect(continued.workflow?.version).toBe(1);
  });

  it('rejects insertion while a stop intent is pending', () => {
    const { task } = runningResearch();
    task.workflow!.steps.push({ kind: 'agent', id: 'write', title: 'Write', role: 'prd-writer',
      instructions: 'Write', inputs: [], repositories: [], actions: ['write-local'], outputs: ['report'], checks: [] });
    task.intent = 'pause';
    expect(() => reduceTask(task, { kind: 'human', command: { requestId: 'insert-during-stop',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'insert-review', beforeStepId: 'write', title: 'Review first' } } }, NOW))
      .toThrow(/intent|pause|stop/i);
    expect(task.workflow?.version).toBe(1);
  });

  it('returns a pre-first-agent change request to triage', () => {
    const waiting = waitingTask();
    const approved = reduceTask(waiting, { kind: 'human', command: {
      requestId: 'approve-workflow', taskId: waiting.id, expectedRevision: 1,
      action: { kind: 'approve', reviewId: 'workflow-review', artifactDigests: [] },
    } }, NOW);
    const inserted = reduceTask(approved, { kind: 'human', command: {
      requestId: 'insert-scope', taskId: approved.id, expectedRevision: 1,
      action: { kind: 'insert-review', beforeStepId: 'research', title: 'Review scope' },
    } }, NOW);
    const review = inserted.reviews.at(-1)!;
    const changes = reduceTask(inserted, { kind: 'human', command: {
      requestId: 'change-scope', taskId: inserted.id, expectedRevision: 1,
      action: { kind: 'changes', reviewId: review.id, text: 'Narrow the scope' },
    } }, NOW);
    expect(parseTask(JSON.parse(JSON.stringify(changes))).currentStepId).toBe('$triage');
    expect(eligibleStep(changes)?.id).toBe('$triage');
  });

  it('keeps earlier checkpoint routing valid when inserting a review after it', () => {
    const task = draftTask();
    task.status = 'queued'; task.workflow = workflowProposal();
    task.workflow.steps[1] = { kind: 'human', id: 'findings', title: 'Review findings',
      producerStepId: 'research', artifactIds: [], allowsStepId: 'write' };
    task.workflow.steps.push({ kind: 'agent', id: 'write', title: 'Write',
      role: 'prd-writer', instructions: 'Write', inputs: [], repositories: [],
      actions: ['write-local'], outputs: ['report'], checks: ['report'] });
    task.currentStepId = 'write'; task.completedStepIds = ['research', 'findings'];
    recordCompletedResearch(task);
    task.reviews = [{ id: 'approved-findings', kind: 'artifact', workflowVersion: 1,
      stepId: 'findings', artifacts: [], prompt: 'Review findings', answer: null, decision: 'approve' }];
    const inserted = reduceTask(task, { kind: 'human', command: {
      requestId: 'insert-after-review', taskId: task.id, expectedRevision: 1,
      action: { kind: 'insert-review', beforeStepId: 'write', title: 'Review scope' },
    } }, NOW);
    const parsed = parseTask(JSON.parse(JSON.stringify(inserted)));
    expect(parsed.workflow?.steps[1]).toMatchObject({ kind: 'human',
      allowsStepId: parsed.workflow?.steps[2].id });
    const review = inserted.reviews.at(-1)!;
    const resumed = reduceTask(inserted, { kind: 'human', command: {
      requestId: 'approve-inserted', taskId: task.id, expectedRevision: 1,
      action: { kind: 'approve', reviewId: review.id, artifactDigests: [] },
    } }, NOW);
    expect(eligibleStep(resumed)?.id).toBe('write');
  });

  it('records approval provenance when an unchanged checkpoint survives insertion', () => {
    const task = draftTask();
    task.status = 'queued'; task.workflow = workflowProposal();
    task.workflow.steps[1] = { kind: 'human', id: 'findings', title: 'Review findings',
      producerStepId: 'research', artifactIds: [], allowsStepId: 'write' };
    task.workflow.steps.push({ kind: 'agent', id: 'write', title: 'Write',
      role: 'prd-writer', instructions: 'Write', inputs: [], repositories: [],
      actions: ['write-local'], outputs: ['report'], checks: ['report'] });
    task.currentStepId = 'write'; task.completedStepIds = ['research', 'findings'];
    recordCompletedResearch(task);
    task.reviews = [{ id: 'approved-findings', kind: 'artifact', workflowVersion: 1,
      stepId: 'findings', artifacts: [], prompt: 'Review findings', answer: null, decision: 'approve' }];
    const inserted = reduceTask(task, { kind: 'human', command: { requestId: 'insert-provenance',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'insert-review', beforeStepId: 'write', title: 'Review again' } } }, NOW);
    expect(inserted.approvalBindings).toContainEqual({ reviewId: 'approved-findings',
      originalWorkflowVersion: 1, workflowVersion: 2, stepId: 'findings', artifacts: [] });
    expect(parseTask(JSON.parse(JSON.stringify(inserted))).approvalBindings).toEqual(inserted.approvalBindings);
    expect(hasCurrentApproval(inserted, 'findings')).toBe(true);
  });

  it('invalidates a carried approval when its reviewed artifact changes', () => {
    const task = draftTask(); task.status = 'queued'; task.workflow = workflowProposal();
    task.workflow.steps[1] = { kind: 'human', id: 'findings', title: 'Review findings',
      producerStepId: 'research', artifactIds: ['findings'], allowsStepId: 'write' };
    task.workflow.steps.push({ kind: 'agent', id: 'write', title: 'Write',
      role: 'prd-writer', instructions: 'Write', inputs: [], repositories: [],
      actions: ['write-local'], outputs: ['report'], checks: ['report'] });
    task.currentStepId = 'write'; task.completedStepIds = ['research', 'findings'];
    const first = { id: 'findings', version: 1, digest: 'a'.repeat(64), path: 'artifacts/findings.1.bin' };
    task.artifacts = [first];
    recordCompletedResearch(task, [first]);
    task.reviews = [{ id: 'approved-findings', kind: 'artifact', workflowVersion: 1,
      stepId: 'findings', artifacts: [first], prompt: 'Review', answer: null, decision: 'approve' }];
    const inserted = reduceTask(task, { kind: 'human', command: { requestId: 'carry',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'insert-review', beforeStepId: 'write', title: 'Review again' } } }, NOW);
    expect(inserted.workflow?.steps[2]).toMatchObject({ kind: 'human', artifactIds: ['findings'] });
    expect(inserted.reviews.at(-1)?.artifacts).toEqual([first]);
    expect(hasCurrentApproval(inserted, 'findings')).toBe(true);
    const replacement = { id: 'findings', version: 2, digest: 'b'.repeat(64),
      path: 'artifacts/findings.2.bin' };
    inserted.artifacts.push(replacement);
    const replacementRunId = '33333333-3333-4333-8333-333333333333';
    inserted.runs.push({ ...inserted.runs[0], id: replacementRunId, generation: 2,
      result: { kind: 'completed', taskId: task.id, attemptId: replacementRunId,
        summary: 'Replacement', artifacts: [replacement], evidence: { findings: 'new' } } });
    expect(hasCurrentApproval(inserted, 'findings')).toBe(false);
  });

  it('cannot insert a checkpoint before a step that already started', () => {
    const task = draftTask(); task.status = 'queued'; task.workflow = workflowProposal();
    task.currentStepId = 'research';
    task.runs = [{ id: RUN_ID, stepId: 'research', workflowVersion: 1,
      generation: 1, phase: 'ended', pid: 42, processStartedAt: NOW,
      runtimeVersion: 'test', inputRefs: [], repos: [], startedAt: NOW,
      endedAt: NOW, exitCode: 1, retryCount: 0, nextRetryAt: null, result: null }];
    task.generation = 1;
    expect(() => reduceTask(task, { kind: 'human', command: { requestId: 'late-insert',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'insert-review', beforeStepId: 'research', title: 'Check' } } }, NOW))
      .toThrow(/started|pause|conflict/i);
  });

  it('opens each consecutive human checkpoint without leaving an idle queued task', () => {
    const { task } = runningResearch();
    task.workflow!.steps = [task.workflow!.steps[0],
      { kind: 'human', id: 'first', title: 'First review', producerStepId: 'research',
        artifactIds: [], allowsStepId: 'second' },
      { kind: 'human', id: 'second', title: 'Second review', producerStepId: 'research',
        artifactIds: [], allowsStepId: null }];
    const completed = reduceTask(task, { kind: 'finished', attemptId: RUN_ID,
      generation: 1, exitCode: 0, result: { kind: 'completed', taskId: task.id,
        attemptId: RUN_ID, summary: 'Findings', artifacts: [], evidence: { findings: 'verified' } } }, NOW);
    const firstReview = completed.reviews.at(-1)!;
    const afterFirst = reduceTask(completed, { kind: 'human', command: {
      requestId: 'approve-first', taskId: task.id, expectedRevision: 1,
      action: { kind: 'approve', reviewId: firstReview.id, artifactDigests: [] },
    } }, NOW);
    expect(afterFirst.status).toBe('waiting-for-human');
    expect(afterFirst.currentStepId).toBe('second');
    expect(afterFirst.reviews.at(-1)?.stepId).toBe('second');
    expect(eligibleStep(afterFirst)).toBeNull();
    const secondReview = afterFirst.reviews.at(-1)!;
    const done = reduceTask(afterFirst, { kind: 'human', command: {
      requestId: 'approve-second', taskId: task.id, expectedRevision: 1,
      action: { kind: 'approve', reviewId: secondReview.id, artifactDigests: [] },
    } }, NOW);
    expect(done.status).toBe('done');
  });

  it('retains unchanged completed prefix when a revised workflow is approved', () => {
    const task = waitingTask();
    task.workflow = workflowProposal();
    task.workflow.steps[1] = { kind: 'human', id: 'findings', title: 'Review findings',
      producerStepId: 'research', artifactIds: ['findings'], allowsStepId: 'write' };
    task.workflow.steps.push({ kind: 'agent', id: 'write', title: 'Write', role: 'prd-writer',
      instructions: 'Old instructions', inputs: [], repositories: [], actions: ['write-local'],
      outputs: ['report'], checks: ['report'] });
    task.proposedWorkflow = structuredClone(task.workflow);
    task.proposedWorkflow.version = 2;
    const proposedWrite = task.proposedWorkflow.steps[2];
    if (proposedWrite.kind !== 'agent') throw new Error('Fixture error');
    proposedWrite.instructions = 'Revised instructions';
    task.currentStepId = 'write'; task.completedStepIds = ['research', 'findings'];
    const ref = { id: 'findings', version: 1, digest: 'a'.repeat(64), path: 'artifacts/findings.1.bin' };
    task.artifacts = [ref]; recordCompletedResearch(task, [ref]);
    task.reviews = [{ id: 'findings-approval', kind: 'artifact', workflowVersion: 1,
      stepId: 'findings', artifacts: [ref], prompt: 'Review findings', answer: null, decision: 'approve' },
    { id: 'workflow-review', kind: 'workflow', workflowVersion: 2,
      stepId: 'write', artifacts: [], prompt: 'Approve revision?', answer: null, decision: null }];
    const next = reduceTask(task, { kind: 'human', command: { requestId: 'approve-v2',
      taskId: task.id, expectedRevision: 1,
      action: { kind: 'approve', reviewId: 'workflow-review', artifactDigests: [] } } }, NOW);
    expect(next.completedStepIds).toEqual(['research', 'findings']);
    expect(next.currentStepId).toBe('write');
    expect(eligibleStep(next)?.id).toBe('write');
  });

  it('binds a revised checkpoint to the latest available artifact', () => {
    const task = waitingTask();
    task.workflow = workflowProposal();
    task.proposedWorkflow = structuredClone(task.workflow);
    task.proposedWorkflow.version = 2;
    const revisedCheckpoint = task.proposedWorkflow.steps[1];
    if (revisedCheckpoint.kind !== 'human') throw new Error('Fixture error');
    revisedCheckpoint.title = 'Review revised findings';
    task.currentStepId = 'findings'; task.completedStepIds = ['research'];
    const ref = { id: 'findings', version: 1, digest: 'a'.repeat(64), path: 'artifacts/findings.1.bin' };
    task.artifacts = [ref];
    recordCompletedResearch(task, [ref]);
    task.reviews[0] = { id: 'workflow-revision', kind: 'workflow', workflowVersion: 2,
      stepId: 'research', artifacts: [], prompt: 'Approve revision?', answer: null, decision: null };
    const revised = reduceTask(task, { kind: 'human', command: { requestId: 'approve-revision',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'approve', reviewId: 'workflow-revision', artifactDigests: [] } } }, NOW);
    expect(revised.currentStepId).toBe('findings');
    expect(revised.reviews.at(-1)?.artifacts).toEqual([ref]);
  });

  it('invalidates downstream approval when earlier permissions change', () => {
    const task = waitingTask();
    task.workflow = workflowProposal();
    task.proposedWorkflow = structuredClone(task.workflow);
    task.proposedWorkflow.version = 2;
    const revisedResearch = task.proposedWorkflow.steps[0];
    if (revisedResearch.kind !== 'agent') throw new Error('Fixture error');
    revisedResearch.actions = ['write-local'];
    task.currentStepId = 'findings'; task.completedStepIds = ['research', 'findings'];
    task.reviews = [{ id: 'findings-approved', kind: 'artifact', workflowVersion: 1,
      stepId: 'findings', artifacts: [], prompt: 'Review', answer: null, decision: 'approve' },
    { id: 'workflow-revision', kind: 'workflow', workflowVersion: 2,
      stepId: 'research', artifacts: [], prompt: 'Approve permission change?', answer: null, decision: null }];
    const revised = reduceTask(task, { kind: 'human', command: { requestId: 'approve-permissions',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'approve', reviewId: 'workflow-revision', artifactDigests: [] } } }, NOW);
    expect(revised.currentStepId).toBe('research');
    expect(revised.completedStepIds).toEqual([]);
    expect(revised.staleStepIds).toEqual(expect.arrayContaining(['research', 'findings']));
    expect(hasCurrentApproval(revised, 'findings')).toBe(false);
  });

  it('reopens a checkpoint when a revision cannot carry its effective artifact approval', () => {
    const task = waitingTask(); task.workflow = workflowProposal();
    task.workflow.steps[1] = { kind: 'human', id: 'findings', title: 'Review findings',
      producerStepId: 'research', artifactIds: ['findings'], allowsStepId: 'write' };
    task.workflow.steps.push({ kind: 'agent', id: 'write', title: 'Write',
      role: 'prd-writer', instructions: 'Old instructions', inputs: [], repositories: [],
      actions: ['write-local'], outputs: ['report'], checks: ['report'] });
    task.proposedWorkflow = structuredClone(task.workflow);
    task.proposedWorkflow.version = 2;
    const proposedWrite = task.proposedWorkflow.steps[2];
    if (proposedWrite.kind !== 'agent') throw new Error('Fixture error');
    proposedWrite.instructions = 'Revised instructions';
    task.currentStepId = 'write'; task.completedStepIds = ['research', 'findings'];
    const oldRef = { id: 'findings', version: 1, digest: 'a'.repeat(64),
      path: 'artifacts/findings.1.bin' };
    const currentRef = { id: 'findings', version: 2, digest: 'b'.repeat(64),
      path: 'artifacts/findings.2.bin' };
    task.artifacts = [oldRef, currentRef];
    const oldRun = { ...runningResearch().run, phase: 'ended' as const, endedAt: NOW,
      exitCode: 0, result: { kind: 'completed' as const, taskId: task.id,
        attemptId: RUN_ID, summary: 'Old research', artifacts: [oldRef],
        evidence: { findings: 'old' } } };
    const currentRunId = '33333333-3333-4333-8333-333333333333';
    task.runs = [oldRun, { ...oldRun, id: currentRunId, generation: 2,
      result: { ...oldRun.result, attemptId: currentRunId,
        summary: 'Current research', artifacts: [currentRef], evidence: { findings: 'current' } } }];
    task.reviews = [{ id: 'old-approval', kind: 'artifact', workflowVersion: 1,
      stepId: 'findings', artifacts: [oldRef], prompt: 'Review', answer: null, decision: 'approve' },
    { id: 'workflow-revision', kind: 'workflow', workflowVersion: 2,
      stepId: 'write', artifacts: [], prompt: 'Approve revision?', answer: null, decision: null }];
    const revised = reduceTask(task, { kind: 'human', command: { requestId: 'approve-v2',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'approve', reviewId: 'workflow-revision', artifactDigests: [] } } }, NOW);
    expect(revised.completedStepIds).toEqual(['research']);
    expect(revised.staleStepIds).toContain('findings');
    expect(revised.currentStepId).toBe('findings');
    expect(revised.status).toBe('waiting-for-human');
    expect(revised.reviews.at(-1)?.artifacts).toEqual([currentRef]);
    expect(eligibleStep(revised)).toBeNull();
    const reapproved = reduceTask(revised, { kind: 'human', command: { requestId: 'approve-current-findings',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'approve', reviewId: revised.reviews.at(-1)!.id,
        artifactDigests: [currentRef.digest] } } }, NOW);
    expect(reapproved.staleStepIds).not.toContain('findings');
    expect(hasCurrentApproval(reapproved, 'findings')).toBe(true);
    expect(eligibleStep(reapproved)?.id).toBe('write');
  });

  it('completes a terminal checkpoint after its revision review is reopened and approved', () => {
    const task = waitingTask(); task.workflow = workflowProposal();
    task.proposedWorkflow = { ...structuredClone(task.workflow), version: 2 };
    task.currentStepId = 'findings'; task.completedStepIds = ['research', 'findings'];
    const oldRef = { id: 'findings', version: 1, digest: 'a'.repeat(64),
      path: 'artifacts/findings.1.bin' };
    const currentRef = { id: 'findings', version: 2, digest: 'b'.repeat(64),
      path: 'artifacts/findings.2.bin' };
    task.artifacts = [oldRef, currentRef];
    recordCompletedResearch(task, [oldRef]);
    const currentRunId = '33333333-3333-4333-8333-333333333333';
    task.runs.push({ ...task.runs[0], id: currentRunId, generation: 2,
      result: { kind: 'completed', taskId: task.id, attemptId: currentRunId,
        summary: 'Current findings', artifacts: [currentRef], evidence: { findings: 'current' } } });
    task.reviews = [{ id: 'old-approval', kind: 'artifact', workflowVersion: 1,
      stepId: 'findings', artifacts: [oldRef], prompt: 'Review', answer: null, decision: 'approve' },
    { id: 'workflow-revision', kind: 'workflow', workflowVersion: 2,
      stepId: 'research', artifacts: [], prompt: 'Approve revision?', answer: null, decision: null }];
    const revised = reduceTask(task, { kind: 'human', command: { requestId: 'approve-v2-terminal',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'approve', reviewId: 'workflow-revision', artifactDigests: [] } } }, NOW);
    expect(revised.currentStepId).toBe('findings');
    const completed = reduceTask(revised, { kind: 'human', command: { requestId: 'approve-final-current',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'approve', reviewId: revised.reviews.at(-1)!.id,
        artifactDigests: [currentRef.digest] } } }, NOW);
    expect(completed.status).toBe('done');
    expect(completed.staleStepIds).not.toContain('findings');
  });

  it.each(['read', 'write-local', 'open-pr'] as const)(
    'does not dispatch %s work past a checkpoint whose approval is stale', (action) => {
      const task = draftTask(); task.status = 'queued'; task.workflow = workflowProposal();
      task.workflow.steps[1] = { kind: 'human', id: 'findings', title: 'Review findings',
        producerStepId: 'research', artifactIds: ['findings'], allowsStepId: 'next' };
      task.workflow.steps.push({ kind: 'agent', id: 'next', title: 'Next',
        role: 'implementer', instructions: 'Next', inputs: [], repositories: [],
        actions: [action], outputs: ['result'], checks: ['result'] });
      task.currentStepId = 'next'; task.completedStepIds = ['research', 'findings'];
      const oldRef = { id: 'findings', version: 1, digest: 'a'.repeat(64),
        path: 'artifacts/findings.1.bin' };
      const currentRef = { id: 'findings', version: 2, digest: 'b'.repeat(64),
        path: 'artifacts/findings.2.bin' };
      task.artifacts = [oldRef, currentRef];
      task.runs = [{ ...runningResearch().run, phase: 'ended', endedAt: NOW, exitCode: 0,
        result: { kind: 'completed', taskId: task.id, attemptId: RUN_ID,
          summary: 'Current findings', artifacts: [currentRef], evidence: { findings: 'current' } } }];
      task.reviews = [{ id: 'old-approval', kind: 'artifact', workflowVersion: 1,
        stepId: 'findings', artifacts: [oldRef], prompt: 'Review', answer: null, decision: 'approve' }];
      expect(eligibleStep(task)).toBeNull();
    });

  it('answers a question without approving the paused step', () => {
    const task = waitingTask();
    task.reviews[0] = { id: 'q', kind: 'question', workflowVersion: null,
      stepId: '$triage', artifacts: [], prompt: 'Which project?', answer: null, decision: null };
    task.proposedWorkflow = null;
    const next = reduceTask(task, { kind: 'human', command: {
      requestId: 'answer', taskId: task.id, expectedRevision: 1,
      action: { kind: 'answer', reviewId: 'q', text: 'Digital Sales' },
    } }, NOW);
    expect(next.reviews[0]).toMatchObject({ answer: 'Digital Sales', decision: 'answer' });
    expect(next.currentStepId).toBe('$triage');
    expect(next.completedStepIds).not.toContain('$triage');
    expect(eligibleStep(next)?.id).toBe('$triage');
  });

  it('supports repeated questions from the same brainstorming step', () => {
    const { task } = runningResearch();
    const first = reduceTask(task, { kind: 'finished', attemptId: RUN_ID,
      generation: 1, exitCode: 0, result: { kind: 'needs_human', taskId: task.id,
        attemptId: RUN_ID, summary: 'Need context', artifacts: [],
        question: 'Which audience?', checkpoint: 'Audience undecided' } }, NOW);
    const answered = reduceTask(first, { kind: 'human', command: { requestId: 'audience',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'answer', reviewId: first.reviews.at(-1)!.id, text: 'Internal' } } }, NOW);
    expect(eligibleStep(answered)?.id).toBe('research');
    answered.status = 'running'; answered.generation = 2;
    const secondRunId = '33333333-3333-4333-8333-333333333333';
    answered.runs.push({ ...task.runs[0], id: secondRunId, generation: 2, phase: 'running' });
    const second = reduceTask(answered, { kind: 'finished', attemptId: secondRunId,
      generation: 2, exitCode: 0, result: { kind: 'needs_human', taskId: task.id,
        attemptId: secondRunId, summary: 'Need channel', artifacts: [],
        question: 'Which channel?', checkpoint: 'Audience internal' } }, NOW);
    expect(second.reviews.map(review => review.prompt)).toEqual(['Which audience?', 'Which channel?']);
    expect(second.reviews[0].decision).toBe('answer');
    expect(second.reviews[1].decision).toBeNull();
    expect(eligibleStep(second)).toBeNull();
  });

  it('keeps a reordered or checkpoint-free agent proposal pending until approval', () => {
    const { task } = runningResearch();
    const proposed = structuredClone(task.workflow!);
    proposed.version = 2;
    proposed.steps = [{ kind: 'agent', id: 'write', title: 'Write', role: 'prd-writer',
      instructions: 'Write', inputs: [], repositories: [], actions: ['write-local'],
      outputs: ['report'], checks: ['report'] }, ...proposed.steps.filter(step => step.kind === 'agent')];
    const next = reduceTask(task, { kind: 'finished', attemptId: RUN_ID,
      generation: 1, exitCode: 0, result: { kind: 'propose_workflow_change', taskId: task.id,
        attemptId: RUN_ID, summary: 'Change order', artifacts: [], workflow: proposed,
        reason: 'Write first', title: task.title, taskType: task.type, projectId: task.projectId } }, NOW);
    expect(next.workflow?.version).toBe(1);
    expect(next.proposedWorkflow?.version).toBe(2);
    expect(next.reviews.at(-1)?.kind).toBe('workflow');
    expect(eligibleStep(next)).toBeNull();
  });

  it('keeps the task waiting while any other human decision remains pending', () => {
    const task = waitingTask();
    task.reviews.push({ id: 'second-question', kind: 'question', workflowVersion: null,
      stepId: '$triage', artifacts: [], prompt: 'Which project?', answer: null, decision: null });
    const next = reduceTask(task, { kind: 'human', command: { requestId: 'approve',
      taskId: task.id, expectedRevision: 1,
      action: { kind: 'approve', reviewId: 'workflow-review', artifactDigests: [] } } }, NOW);
    expect(next.status).toBe('waiting-for-human');
    expect(eligibleStep(next)).toBeNull();
  });

  it('rejects a later approval while an earlier decision is unresolved', () => {
    const task = waitingTask();
    task.reviews.unshift({ id: 'earlier', kind: 'question', workflowVersion: null,
      stepId: '$triage', artifacts: [], prompt: 'Which project?', answer: null, decision: null });
    expect(() => reduceTask(task, { kind: 'human', command: { requestId: 'out-of-order',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'approve', reviewId: 'workflow-review', artifactDigests: [] } } }, NOW))
      .toThrow(/earlier|pending/i);
  });

  it('rejects blank change feedback and stores trimmed feedback', () => {
    const task = waitingTask();
    expect(() => reduceTask(task, { kind: 'human', command: { requestId: 'blank',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'changes', reviewId: 'workflow-review', text: '   ' } } }, NOW))
      .toThrow(/feedback|empty/i);
    const changed = reduceTask(task, { kind: 'human', command: { requestId: 'trimmed',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'changes', reviewId: 'workflow-review', text: '  Revise scope  ' } } }, NOW);
    expect(changed.reviews[0].answer).toBe('Revise scope');
  });

  it('rejects approval when a reviewed artifact has a newer version', () => {
    const task = waitingTask(); task.workflow = workflowProposal(); task.proposedWorkflow = null;
    task.currentStepId = 'findings'; task.completedStepIds = ['research'];
    const oldRef = { id: 'findings', version: 1, digest: 'a'.repeat(64), path: 'artifacts/findings.1.bin' };
    const newRef = { id: 'findings', version: 2, digest: 'b'.repeat(64), path: 'artifacts/findings.2.bin' };
    task.artifacts = [oldRef, newRef];
    task.reviews[0] = { id: 'findings-review', kind: 'artifact', workflowVersion: 1,
      stepId: 'findings', artifacts: [oldRef], prompt: 'Review findings', answer: null, decision: null };
    expect(() => reduceTask(task, { kind: 'human', command: { requestId: 'approve-old',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'approve', reviewId: 'findings-review', artifactDigests: [oldRef.digest] } } }, NOW))
      .toThrow(/stale|version/i);
  });

  it('rejects approval carrying a different artifact digest', () => {
    const task = waitingTask(); task.workflow = workflowProposal(); task.proposedWorkflow = null;
    task.currentStepId = 'findings'; task.completedStepIds = ['research'];
    const ref = { id: 'findings', version: 1, digest: 'a'.repeat(64), path: 'artifacts/findings.1.bin' };
    task.artifacts = [ref];
    task.reviews[0] = { id: 'findings-review', kind: 'artifact', workflowVersion: 1,
      stepId: 'findings', artifacts: [ref], prompt: 'Review findings', answer: null, decision: null };
    expect(() => reduceTask(task, { kind: 'human', command: { requestId: 'wrong-digest',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'approve', reviewId: 'findings-review', artifactDigests: ['b'.repeat(64)] } } }, NOW))
      .toThrow(/digest/i);
  });

  it('cannot approve a checkpoint whose declared artifact is unavailable', () => {
    const task = waitingTask(); task.workflow = workflowProposal(); task.proposedWorkflow = null;
    task.currentStepId = 'findings'; task.completedStepIds = ['research'];
    task.reviews[0] = { id: 'findings-review', kind: 'artifact', workflowVersion: 1,
      stepId: 'findings', artifacts: [], prompt: 'Review findings', answer: null, decision: null };
    expect(() => reduceTask(task, { kind: 'human', command: { requestId: 'approve-missing',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'approve', reviewId: 'findings-review', artifactDigests: [] } } }, NOW))
      .toThrow(/artifact|missing|available/i);
  });

  it('keeps a stale producer marked until its replacement result is accepted', () => {
    const { task } = runningResearch();
    task.staleStepIds = ['research'];
    const completed = reduceTask(task, { kind: 'finished', attemptId: RUN_ID,
      generation: 1, exitCode: 0, result: { kind: 'completed', taskId: task.id,
        attemptId: RUN_ID, summary: 'Revised findings', artifacts: [],
        evidence: { findings: 'reverified' } } }, NOW);
    expect(completed.staleStepIds).not.toContain('research');
    expect(completed.completedStepIds).toContain('research');
  });

  it('requires a reconciliation note before retrying uncertain work', () => {
    const { task } = runningResearch();
    task.status = 'blocked'; task.blockedReason = 'Uncertain external effects';
    task.runs[0].phase = 'uncertain'; task.runs[0].endedAt = NOW;
    expect(() => reduceTask(task, { kind: 'human', command: { requestId: 'blank-retry',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'retry', text: '   ' } } }, NOW)).toThrow(/reconcil|note|empty/i);
    const retried = reduceTask(task, { kind: 'human', command: { requestId: 'retry-with-note',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'retry', text: '  Provider confirms no PR was created  ' } } }, NOW);
    expect(retried.blockedReason).toBeNull();
    expect(retried.status).toBe('queued');
    expect(retried.runs[0].reconciliationNote).toBe('Provider confirms no PR was created');
  });

  it('cancels queued tasks and leaves terminal tasks immutable', () => {
    const task = waitingTask(); task.status = 'queued'; task.reviews[0].decision = 'approve';
    const next = reduceTask(task, { kind: 'human', command: { requestId: 'cancel',
      taskId: task.id, expectedRevision: 1, action: { kind: 'cancel' } } }, NOW);
    expect(next.status).toBe('cancelled');
    expect(next.queuedAt).toBeNull();
    expect(eligibleStep(next)).toBeNull();
    expect(isTerminal(next.status)).toBe(true);
    expect(() => reduceTask(next, { kind: 'block', reason: 'late' }, NOW)).toThrow(/terminal/i);
  });

  it('returns changes to the producing agent step', () => {
    const task = waitingTask(); task.workflow = workflowProposal(); task.proposedWorkflow = null;
    task.currentStepId = 'findings'; task.completedStepIds = ['research'];
    task.reviews[0] = { id: 'findings-review', kind: 'artifact', workflowVersion: 1,
      stepId: 'findings', artifacts: [], prompt: 'Accept?', answer: null, decision: null };
    const next = reduceTask(task, { kind: 'human', command: { requestId: 'changes',
      taskId: task.id, expectedRevision: 1,
      action: { kind: 'changes', reviewId: 'findings-review', text: 'Revise' } } }, NOW);
    expect(next.currentStepId).toBe('research');
    expect(next.completedStepIds).not.toContain('research');
    expect(eligibleStep(next)?.id).toBe('research');
  });

  it('opens a new review on the next artifact version after requested changes', () => {
    const { task } = runningResearch();
    const firstRef = { id: 'findings', version: 1, digest: 'a'.repeat(64),
      path: 'artifacts/findings.1.bin' };
    const first = reduceTask(task, { kind: 'finished', attemptId: RUN_ID,
      generation: 1, exitCode: 0, result: { kind: 'completed', taskId: task.id,
        attemptId: RUN_ID, summary: 'First findings', artifacts: [firstRef],
        evidence: { findings: 'first' } } }, NOW);
    const changed = reduceTask(first, { kind: 'human', command: { requestId: 'revise',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'changes', reviewId: first.reviews.at(-1)!.id, text: 'Update findings' } } }, NOW);
    expect(changed.staleStepIds).toContain('research');
    changed.status = 'running'; changed.generation = 2;
    const nextRunId = '33333333-3333-4333-8333-333333333333';
    changed.runs.push({ ...task.runs[0], id: nextRunId, generation: 2, phase: 'running' });
    const secondRef = { id: 'findings', version: 2, digest: 'b'.repeat(64),
      path: 'artifacts/findings.2.bin' };
    const second = reduceTask(changed, { kind: 'finished', attemptId: nextRunId,
      generation: 2, exitCode: 0, result: { kind: 'completed', taskId: task.id,
        attemptId: nextRunId, summary: 'Revised findings', artifacts: [secondRef],
        evidence: { findings: 'revised' } } }, NOW);
    expect(second.reviews.at(-1)?.artifacts).toEqual([secondRef]);
    expect(second.reviews.at(-2)?.decision).toBe('changes');
    expect(second.staleStepIds).not.toContain('research');
  });

  it('does not reuse rejected artifact bytes when a producer rerun omits the file', () => {
    const { task } = runningResearch();
    const rejectedRef = { id: 'findings', version: 1, digest: 'a'.repeat(64),
      path: 'artifacts/findings.1.bin' };
    const first = reduceTask(task, { kind: 'finished', attemptId: RUN_ID,
      generation: 1, exitCode: 0, result: { kind: 'completed', taskId: task.id,
        attemptId: RUN_ID, summary: 'First findings', artifacts: [rejectedRef],
        evidence: { findings: 'first' } } }, NOW);
    const changed = reduceTask(first, { kind: 'human', command: { requestId: 'reject-content',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'changes', reviewId: first.reviews.at(-1)!.id, text: 'Replace findings' } } }, NOW);
    changed.status = 'running'; changed.generation = 2;
    const replacementRunId = '33333333-3333-4333-8333-333333333333';
    changed.runs.push({ ...task.runs[0], id: replacementRunId, generation: 2, phase: 'running' });
    const replacement = reduceTask(changed, { kind: 'finished', attemptId: replacementRunId,
      generation: 2, exitCode: 0, result: { kind: 'completed', taskId: task.id,
        attemptId: replacementRunId, summary: 'Evidence only', artifacts: [],
        evidence: { findings: 'revised' } } }, NOW);
    const review = replacement.reviews.at(-1)!;
    expect(review.artifacts).toEqual([]);
    expect(() => reduceTask(replacement, { kind: 'human', command: { requestId: 'approve-rejected',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'approve', reviewId: review.id, artifactDigests: [rejectedRef.digest] } } }, NOW))
      .toThrow(/digest|artifact/i);
    expect(() => reduceTask(replacement, { kind: 'human', command: { requestId: 'approve-empty',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'approve', reviewId: review.id, artifactDigests: [] } } }, NOW))
      .toThrow(/artifact|missing/i);
  });

  it('does not mistake another producer using the same artifact ID for a research revision', () => {
    const task = waitingTask(); task.workflow = workflowProposal(); task.proposedWorkflow = null;
    task.currentStepId = 'findings'; task.completedStepIds = ['research'];
    const researchRef = { id: 'findings', version: 1, digest: 'a'.repeat(64),
      path: 'artifacts/findings.1.bin' };
    const otherRef = { id: 'findings', version: 2, digest: 'b'.repeat(64),
      path: 'artifacts/findings.2.bin' };
    task.artifacts = [researchRef, otherRef];
    task.runs = [{ ...runningResearch().run, phase: 'ended', endedAt: NOW, exitCode: 0,
      result: { kind: 'completed', taskId: task.id, attemptId: RUN_ID,
        summary: 'Research', artifacts: [researchRef], evidence: { findings: 'checked' } } },
    { ...runningResearch().run, id: '33333333-3333-4333-8333-333333333333',
      stepId: 'other-producer', generation: 2, phase: 'ended', endedAt: NOW, exitCode: 0,
      result: { kind: 'completed', taskId: task.id,
        attemptId: '33333333-3333-4333-8333-333333333333',
        summary: 'Other work', artifacts: [otherRef], evidence: { findings: 'other' } } }];
    task.reviews[0] = { id: 'research-review', kind: 'artifact', workflowVersion: 1,
      stepId: 'findings', artifacts: [researchRef], prompt: 'Review research',
      answer: null, decision: null };
    const approved = reduceTask(task, { kind: 'human', command: { requestId: 'approve-research',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'approve', reviewId: 'research-review', artifactDigests: [researchRef.digest] } } }, NOW);
    expect(approved.status).toBe('done');
    expect(hasCurrentApproval(approved, 'findings')).toBe(true);
  });

  it('does not reuse an older completed run after the same producer proposes a revision', () => {
    const task = draftTask(); task.status = 'queued'; task.workflow = workflowProposal();
    task.currentStepId = 'findings'; task.completedStepIds = ['research', 'findings'];
    const oldRef = { id: 'findings', version: 1, digest: 'a'.repeat(64),
      path: 'artifacts/findings.1.bin' };
    const proposedRef = { id: 'findings', version: 2, digest: 'b'.repeat(64),
      path: 'artifacts/findings.2.bin' };
    task.artifacts = [oldRef, proposedRef];
    recordCompletedResearch(task, [oldRef]);
    const proposalRunId = '33333333-3333-4333-8333-333333333333';
    task.runs.push({ ...task.runs[0], id: proposalRunId, generation: 2,
      result: { kind: 'propose_workflow_change', taskId: task.id, attemptId: proposalRunId,
        summary: 'Revision', artifacts: [proposedRef], workflow: { ...workflowProposal(), version: 2 },
        reason: 'Revise', title: task.title, taskType: task.type, projectId: task.projectId } });
    task.reviews = [{ id: 'old-approval', kind: 'artifact', workflowVersion: 1,
      stepId: 'findings', artifacts: [oldRef], prompt: 'Review', answer: null, decision: 'approve' }];
    expect(hasCurrentApproval(task, 'findings')).toBe(false);
  });

  it('preserves PR evidence when rejecting after partial work', () => {
    const task = waitingTask(); task.workflow = workflowProposal(); task.proposedWorkflow = null;
    task.currentStepId = 'findings'; task.completedStepIds = ['research'];
    const pr = { id: 'pr', version: 1, digest: 'c'.repeat(64), path: 'artifacts/pr.1.bin' };
    task.artifacts = [pr];
    task.reviews[0] = { id: 'final-review', kind: 'artifact', workflowVersion: 1,
      stepId: 'findings', artifacts: [pr], prompt: 'Review PR', answer: null, decision: null };
    const rejected = reduceTask(task, { kind: 'human', command: { requestId: 'reject-pr',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'reject', reviewId: 'final-review', text: 'Do not proceed' } } }, NOW);
    expect(rejected.status).toBe('rejected');
    expect(rejected.artifacts).toEqual([pr]);
    expect(rejected.reviews[0].decision).toBe('reject');
  });

  it('invalidates downstream completion while allowing a stale producer to rerun', () => {
    const task = waitingTask(); task.workflow = workflowProposal(); task.proposedWorkflow = null;
    task.workflow.steps.push({ kind: 'agent', id: 'write', title: 'Write', role: 'prd-writer',
      instructions: 'Write', inputs: [], repositories: [], actions: ['write-local'],
      outputs: ['report'], checks: ['report'] });
    task.currentStepId = 'findings';
    task.completedStepIds = ['research', 'write']; task.staleStepIds = ['research'];
    task.reviews[0] = { id: 'findings-review', kind: 'artifact', workflowVersion: 1,
      stepId: 'findings', artifacts: [], prompt: 'Accept?', answer: null, decision: null };
    const next = reduceTask(task, { kind: 'human', command: { requestId: 'changes',
      taskId: task.id, expectedRevision: 1,
      action: { kind: 'changes', reviewId: 'findings-review', text: 'Revise' } } }, NOW);
    expect(eligibleStep(next)?.id).toBe('research');
    expect(next.completedStepIds).not.toContain('write');
    expect(next.staleStepIds).toContain('research');
    expect(next.staleStepIds).toContain('write');
  });

  it('finishes only after successful result and final review', () => {
    const { task } = runningResearch();
    const findings = { id: 'findings', version: 1, digest: 'f'.repeat(64),
      path: 'artifacts/findings.1.bin' };
    const completed = reduceTask(task, { kind: 'finished', attemptId: RUN_ID,
      generation: 1, exitCode: 0, result: { kind: 'completed', taskId: task.id,
        attemptId: RUN_ID, summary: 'Findings', artifacts: [findings], evidence: { findings: 'verified' } } }, NOW);
    expect(completed.status).toBe('waiting-for-human');
    expect(completed.currentStepId).toBe('findings');
    expect(completed.reviews.some(r => r.decision === null)).toBe(true);
    const review = completed.reviews.at(-1)!;
    const done = reduceTask(completed, { kind: 'human', command: { requestId: 'approve-final',
      taskId: task.id, expectedRevision: 1,
      action: { kind: 'approve', reviewId: review.id, artifactDigests: [findings.digest] } } }, NOW);
    expect(done.status).toBe('done');
    expect(done.queuedAt).toBeNull();
  });

  it('fails missing completion evidence despite zero exit', () => {
    const { task } = runningResearch();
    expect(() => reduceTask(task, { kind: 'finished', attemptId: RUN_ID,
      generation: 1, exitCode: 0, result: { kind: 'completed', taskId: task.id,
        attemptId: RUN_ID, summary: 'No findings', artifacts: [], evidence: {} } }, NOW)).toThrow(/checks|evidence/i);
  });

  it('ends a failed run before queueing a permitted retry', () => {
    const { task } = runningResearch();
    const next = reduceTask(task, { kind: 'run-failed', attemptId: RUN_ID,
      reason: 'Transient launch failure', retryAt: '2026-09-21T12:01:00Z',
      exitCode: 1, uncertainEffects: false }, NOW);
    expect(next.runs[0]).toMatchObject({ phase: 'ended', exitCode: 1,
      nextRetryAt: '2026-09-21T12:01:00Z' });
    expect(next.status).toBe('queued');
    expect(next.queuedAt).toBe(task.queuedAt);
  });

  it('keeps a running assignment valid when a review is inserted before later work', () => {
    const { task } = runningResearch();
    const original = task.workflow!;
    original.steps.splice(1, 0, { kind: 'agent', id: 'write', title: 'Write',
      role: 'prd-writer', instructions: 'Write the report', inputs: [], repositories: [],
      actions: ['write-local'], outputs: ['report'], checks: ['report'] });
    const inserted = reduceTask(task, { kind: 'human', command: { requestId: 'insert',
      taskId: task.id, expectedRevision: 1,
      action: { kind: 'insert-review', beforeStepId: 'write', title: 'Check scope' } } }, NOW);
    expect(inserted.workflow?.version).toBe(2);
    const completed = reduceTask(inserted, { kind: 'finished', attemptId: RUN_ID,
      generation: 1, exitCode: 0, result: { kind: 'completed', taskId: task.id,
        attemptId: RUN_ID, summary: 'Findings', artifacts: [], evidence: { findings: 'verified' } } }, NOW);
    expect(completed.currentStepId).toContain('review-');
    expect(completed.status).toBe('waiting-for-human');
    const approved = reduceTask(completed, { kind: 'human', command: { requestId: 'approve-inserted',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'approve', reviewId: completed.reviews.at(-1)!.id,
        artifactDigests: [] } } }, NOW);
    expect(eligibleStep(approved)?.id).toBe('write');
  });

  it('rejects a checkpoint inserted before the active running step', () => {
    const { task } = runningResearch();
    const command = { kind: 'human' as const, command: { requestId: 'insert-active',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'insert-review' as const, beforeStepId: 'research', title: 'Review first' } } };
    expect(() => reduceTask(task, command, NOW)).toThrow(/active|running|pause/i);
    expect(task.workflow?.version).toBe(1);
  });

  it('preserves a cancellation intent until the running process stops', () => {
    const { task } = runningResearch();
    const requested = reduceTask(task, { kind: 'human', command: { requestId: 'cancel',
      taskId: task.id, expectedRevision: 1, action: { kind: 'cancel' } } }, NOW);
    expect(requested.status).toBe('running');
    expect(requested.intent).toBe('cancel');
    expect(eligibleStep(requested)).toBeNull();
    const stopped = reduceTask(requested, { kind: 'stopped', attemptId: RUN_ID,
      uncertainEffects: false }, NOW);
    expect(stopped.status).toBe('cancelled');
  });

  it('requires an explicit Continue approval after a manual pause', () => {
    const task = draftTask();
    const paused = reduceTask(task, { kind: 'human', command: { requestId: 'pause-manual',
      taskId: task.id, expectedRevision: task.revision, action: { kind: 'pause' } } }, NOW);
    expect(paused.status).toBe('waiting-for-human');
    expect(paused.reviews.at(-1)?.kind).toBe('pause');
    expect(eligibleStep(paused)).toBeNull();
    const continued = reduceTask(paused, { kind: 'human', command: { requestId: 'continue',
      taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'approve', reviewId: paused.reviews.at(-1)!.id, artifactDigests: [] } } }, NOW);
    expect(eligibleStep(continued)?.id).toBe('$triage');
  });

  it('keeps PR evidence on cancellation after partial work', () => {
    const task = waitingTask();
    const pr = { id: 'pr', version: 1, digest: 'c'.repeat(64), path: 'artifacts/pr.1.bin' };
    task.artifacts = [pr];
    const cancelled = reduceTask(task, { kind: 'human', command: { requestId: 'cancel-with-pr',
      taskId: task.id, expectedRevision: task.revision, action: { kind: 'cancel' } } }, NOW);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.artifacts).toEqual([pr]);
  });

  it('settles a pending pause after an uncertain run failure confirms process exit', () => {
    const { task } = runningResearch();
    const requested = reduceTask(task, { kind: 'human', command: { requestId: 'pause-failure',
      taskId: task.id, expectedRevision: task.revision, action: { kind: 'pause' } } }, NOW);
    const failed = reduceTask(requested, { kind: 'run-failed', attemptId: RUN_ID,
      reason: 'Process registration failed', retryAt: null, exitCode: null,
      uncertainEffects: true }, NOW);
    expect(failed.intent).toBeNull();
    expect(failed.status).toBe('waiting-for-human');
    expect(failed.reviews.at(-1)?.kind).toBe('reconciliation');
    expect(eligibleStep(failed)).toBeNull();
  });

  it('settles a pending cancellation after a failed run confirms process exit', () => {
    const { task } = runningResearch();
    const requested = reduceTask(task, { kind: 'human', command: { requestId: 'cancel-failure',
      taskId: task.id, expectedRevision: task.revision, action: { kind: 'cancel' } } }, NOW);
    const failed = reduceTask(requested, { kind: 'run-failed', attemptId: RUN_ID,
      reason: 'Process registration failed', retryAt: null, exitCode: null,
      uncertainEffects: true }, NOW);
    expect(failed.intent).toBeNull();
    expect(failed.status).toBe('cancelled');
  });

  it('requires reconciliation after pausing a run with uncertain effects', () => {
    const { task } = runningResearch();
    const requested = reduceTask(task, { kind: 'human', command: { requestId: 'pause',
      taskId: task.id, expectedRevision: 1, action: { kind: 'pause' } } }, NOW);
    const stopped = reduceTask(requested, { kind: 'stopped', attemptId: RUN_ID,
      uncertainEffects: true }, NOW);
    expect(stopped.status).toBe('waiting-for-human');
    expect(stopped.reviews.at(-1)?.kind).toBe('reconciliation');
    expect(eligibleStep(stopped)).toBeNull();
    const review = stopped.reviews.at(-1)!;
    const answered = reduceTask(stopped, { kind: 'human', command: { requestId: 'reconciled',
      taskId: task.id, expectedRevision: 1,
      action: { kind: 'answer', reviewId: review.id, text: 'No external change remained' } } }, NOW);
    expect(eligibleStep(answered)?.id).toBe('research');
    expect(answered.runs[0].reconciliationNote).toBe('No external change remained');
  });

  it('blocks uncertain run failures without automatic retry', () => {
    const { task } = runningResearch();
    const next = reduceTask(task, { kind: 'run-failed', attemptId: RUN_ID,
      reason: 'Unknown external effect', retryAt: '2026-09-21T12:01:00Z',
      exitCode: null, uncertainEffects: true }, NOW);
    expect(next.runs[0].phase).toBe('uncertain');
    expect(next.runs[0].nextRetryAt).toBeNull();
    expect(next.status).toBe('blocked');
    expect(eligibleStep(next)).toBeNull();
  });

  it('rejects stale and nonzero process completions', () => {
    const { task } = runningResearch();
    const result = { kind: 'completed' as const, taskId: task.id, attemptId: RUN_ID,
      summary: 'Findings', artifacts: [], evidence: { findings: 'verified' } };
    expect(() => reduceTask(task, { kind: 'finished', attemptId: RUN_ID,
      generation: 0, exitCode: 0, result }, NOW)).toThrow(/stale|superseded/i);
    expect(() => reduceTask(task, { kind: 'finished', attemptId: RUN_ID,
      generation: 1, exitCode: 1, result }, NOW)).toThrow(/zero exit/i);
  });
});

it('preserves legacy event state shapes when replaying pre-confirmation records', () => {
  const { task, run } = runningResearch();
  const stopped = reduceTask(task, { kind: 'stopped', attemptId: run.id, uncertainEffects: true }, NOW);
  expect(stopped.runs[0]).not.toHaveProperty('processExitConfirmed');
  const failed = reduceTask(task, { kind: 'run-failed', attemptId: run.id, reason: 'Legacy failure',
    exitCode: null, retryAt: null, uncertainEffects: true }, NOW);
  expect(failed.runs[0]).not.toHaveProperty('processExitConfirmed');
  const question = reduceTask(task, { kind: 'finished', attemptId: run.id, generation: run.generation,
    exitCode: 0, result: { kind: 'needs_human', taskId: task.id, attemptId: run.id,
      summary: 'Legacy question', artifacts: [], question: 'Which?', checkpoint: 'Saved' } }, NOW);
  expect(question.reviews[0]).not.toHaveProperty('attemptId');
});
