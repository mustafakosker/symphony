import { describe, expect, it } from 'vitest';
import { draftTask, workflowProposal } from '../server/testing/fixtures.js';
import { parseAgentResult, parseCommand, parseTask, parseWorkflow } from './validate.js';

describe('untrusted contracts', () => {
  it('accepts valid task, workflow, command and agent result', () => {
    expect(parseTask(draftTask()).id).toBe(draftTask().id);
    expect(parseWorkflow(workflowProposal()).steps).toHaveLength(2);
    expect(parseCommand({ requestId: 'decision-1', taskId: draftTask().id,
      expectedRevision: 1, action: { kind: 'cancel' } }).action.kind).toBe('cancel');
    expect(parseAgentResult({ kind: 'completed', taskId: draftTask().id,
      attemptId: '22222222-2222-4222-8222-222222222222', summary: 'Done',
      artifacts: [], evidence: { findings: 'Report reviewed' } }).kind).toBe('completed');
  });

  it('rejects malformed workflow references', () => {
    const w = workflowProposal();
    w.steps[1] = { kind: 'human', id: 'findings', title: 'Review',
      producerStepId: 'missing', artifactIds: [], allowsStepId: null };
    expect(() => parseWorkflow(w)).toThrow(/producer/i);
  });

  it('requires a checkpoint producer to be an earlier agent', () => {
    const w = workflowProposal();
    w.steps.push({ kind: 'human', id: 'approval', title: 'Approve',
      producerStepId: 'findings', artifactIds: [], allowsStepId: null });
    expect(() => parseWorkflow(w)).toThrow(/producer/i);
  });

  it('requires human checkpoints to authorize exactly the immediate next step', () => {
    const skipped = workflowProposal();
    skipped.steps.push({ kind: 'agent', id: 'write', title: 'Write', role: 'prd-writer',
      instructions: 'Write', inputs: [], repositories: [], actions: ['write-local'],
      outputs: ['report'], checks: ['report'] });
    skipped.steps[1] = { kind: 'human', id: 'findings', title: 'Review findings',
      producerStepId: 'research', artifactIds: [], allowsStepId: null };
    expect(() => parseWorkflow(skipped)).toThrow(/allowsStepId/i);
    skipped.steps[1] = { kind: 'human', id: 'findings', title: 'Review findings',
      producerStepId: 'research', artifactIds: [], allowsStepId: 'write' };
    skipped.steps.push({ kind: 'human', id: 'final', title: 'Final review',
      producerStepId: 'write', artifactIds: [], allowsStepId: 'write' });
    expect(() => parseWorkflow(skipped)).toThrow(/allowsStepId/i);
    const jump = workflowProposal();
    jump.steps[1] = { kind: 'human', id: 'findings', title: 'Review findings',
      producerStepId: 'research', artifactIds: [], allowsStepId: 'final' };
    jump.steps.push({ kind: 'agent', id: 'write', title: 'Write', role: 'prd-writer',
      instructions: 'Write', inputs: [], repositories: [], actions: ['write-local'],
      outputs: ['report'], checks: ['report'] });
    jump.steps.push({ kind: 'human', id: 'final', title: 'Final review',
      producerStepId: 'write', artifactIds: [], allowsStepId: null });
    expect(() => parseWorkflow(jump)).toThrow(/allowsStepId/i);
  });

  it('accepts a checkpoint before the first agent when triage produced it', () => {
    const workflow = workflowProposal();
    workflow.steps.unshift({ kind: 'human', id: 'scope', title: 'Review scope',
      producerStepId: '$triage', artifactIds: [], allowsStepId: 'research' });
    expect(parseWorkflow(workflow).steps[0].id).toBe('scope');
  });

  it('rejects duplicate steps, invalid capabilities and empty checks', () => {
    const duplicate = workflowProposal();
    duplicate.steps[1].id = 'research';
    expect(() => parseWorkflow(duplicate)).toThrow(/steps.*id/i);
    const capability = workflowProposal() as unknown as { steps: Array<Record<string, unknown>> };
    capability.steps[0].actions = ['delete-everything'];
    expect(() => parseWorkflow(capability)).toThrow(/actions/i);
    const noChecks = workflowProposal();
    noChecks.completionChecks = [];
    expect(() => parseWorkflow(noChecks)).toThrow(/completionChecks/i);
  });

  it('rejects malformed nested task and unsafe filesystem IDs', () => {
    const task = draftTask();
    task.id = '../escape';
    expect(() => parseTask(task)).toThrow(/id/i);
    const nested = draftTask() as unknown as { runs: unknown[] };
    nested.runs = [{ id: 'x' }];
    expect(() => parseTask(nested)).toThrow(/runs\[0\]/i);
  });

  it('rejects an invalid command action and nonpositive revision', () => {
    const base = { requestId: 'request', taskId: draftTask().id, expectedRevision: 1 };
    expect(() => parseCommand({ ...base, action: { kind: 'approve', reviewId: 'x' } })).toThrow(/artifactDigests/i);
    expect(() => parseCommand({ ...base, expectedRevision: 0, action: { kind: 'cancel' } })).toThrow(/expectedRevision/i);
    expect(() => parseCommand({ ...base, action: { kind: 'approve', reviewId: 'x', artifactDigests: ['wrong'] } })).toThrow(/artifactDigests/i);
  });

  it('rejects malformed discriminated agent results', () => {
    const base = { taskId: draftTask().id, attemptId: '22222222-2222-4222-8222-222222222222', summary: 'x', artifacts: [] };
    expect(() => parseAgentResult({ ...base, kind: 'needs_human', question: 'Why?' })).toThrow(/checkpoint/i);
    expect(() => parseAgentResult({ ...base, kind: 'completed', evidence: [] })).toThrow(/evidence/i);
  });
});
