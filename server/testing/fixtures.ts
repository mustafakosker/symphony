import type { Task, Workflow } from '../../shared/contracts.js';
import type { Assignment, Exit, Runner } from '../codex/adapter.js';

const TASK_ID = '11111111-1111-4111-8111-111111111111';

export function workflowProposal(): Workflow {
  return {
    version: 1,
    steps: [
      {
        kind: 'agent', id: 'research', title: 'Research', role: 'researcher',
        instructions: 'Investigate the idea', inputs: [], repositories: [],
        actions: ['read'], outputs: ['findings'], checks: ['findings'],
      },
      {
        kind: 'human', id: 'findings', title: 'Review findings',
        producerStepId: 'research', artifactIds: ['findings'], allowsStepId: null,
      },
    ],
    completionChecks: ['findings'],
  };
}

export function draftTask(): Task {
  return {
    schemaVersion: 1, id: TASK_ID, revision: 1, title: 'Draft', idea: '# Idea',
    type: 'unknown', projectId: null, source: 'drafts/idea.md', status: 'triaging',
    workflow: null, proposedWorkflow: null, currentStepId: '$triage',
    completedStepIds: [], staleStepIds: [], generation: 0, intent: null,
    reviews: [], runs: [], artifacts: [], approvalBindings: [], blockedReason: null,
    queuedAt: '2026-09-21T11:00:00Z', createdAt: '2026-09-21T11:00:00Z',
    updatedAt: '2026-09-21T11:00:00Z',
  };
}

export function waitingTask(): Task {
  const task = draftTask();
  task.status = 'waiting-for-human';
  task.proposedWorkflow = workflowProposal();
  task.reviews = [{
    id: 'workflow-review', kind: 'workflow', workflowVersion: 1,
    stepId: '$triage', artifacts: [], prompt: 'Approve proposed workflow?',
    answer: null, decision: null,
  }];
  return task;
}

export function controlledRunner(): { runner: Runner; starts: Assignment[]; finish(attemptId: string, exit: Exit): void } {
  const starts: Assignment[] = [];
  const pending = new Map<string, (exit: Exit) => void>();
  let pid = 1000;
  return {
    starts,
    runner: {
      async probe() { return { version: 'test-runtime' }; },
      async start(assignment) {
        starts.push(assignment);
        let settle!: (exit: Exit) => void;
        const completion = new Promise<Exit>(resolve => { settle = resolve; });
        pending.set(assignment.run.id, settle);
        return { pid: ++pid, processStartedAt: '2026-09-21T12:00:00Z', completion,
          async stop() { settle({ code: null, signal: 'SIGTERM', result: null, error: 'Stopped' }); } };
      },
    },
    finish(attemptId, exit) {
      const settle = pending.get(attemptId);
      if (!settle) throw new Error(`Unknown controlled attempt ${attemptId}`);
      pending.delete(attemptId);
      settle(exit);
    },
  };
}
