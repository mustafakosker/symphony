import type { JiraPreparation, PreparationEvent, JiraSyncView, TargetOption } from './jira-preparation.js';
export type Status = 'triaging' | 'queued' | 'running' | 'waiting-for-human'
  | 'blocked' | 'done' | 'rejected' | 'cancelled';
export type Role = 'triage' | 'researcher' | 'prd-writer' | 'implementer' | 'reviewer';
export type ActionClass = 'read' | 'write-local' | 'open-pr' | 'merge' | 'deploy';
export type ArtifactRef = { id: string; version: number; digest: string; path: string };
export type RepoRef = { repository: string; rule: string; commit: string; selectedCommits: string[] };
export type AgentStep = {
  kind: 'agent'; id: string; title: string; role: Role; instructions: string;
  inputs: ArtifactRef[]; repositories: string[]; actions: ActionClass[];
  outputs: string[]; checks: string[];
};
export type HumanStep = {
  kind: 'human'; id: string; title: string; producerStepId: string;
  artifactIds: string[]; allowsStepId: string | null;
};
export type Workflow = {
  version: number; steps: Array<AgentStep | HumanStep>; completionChecks: string[];
};
export type Review = {
  id: string; kind: 'workflow' | 'artifact' | 'question' | 'pause' | 'reconciliation';
  workflowVersion: number | null; stepId: string; artifacts: ArtifactRef[];
  prompt: string; answer: string | null; attemptId?: string;
  decision: 'approve' | 'changes' | 'reject' | 'answer' | null;
};
export type ApprovalBinding = {
  reviewId: string; originalWorkflowVersion: number; workflowVersion: number;
  stepId: string; artifacts: ArtifactRef[];
};
export type Run = {
  id: string; stepId: string; workflowVersion: number | null;
  generation: number; phase: 'launch-intent' | 'running' | 'ended' | 'uncertain';
  pid: number | null; processStartedAt: string | null; runtimeVersion: string;
  inputRefs: ArtifactRef[]; repos: RepoRef[]; startedAt: string;
  endedAt: string | null; exitCode: number | null;
  retryCount: number; nextRetryAt: string | null; result: AgentResult | null;
  reconciliationNote?: string;
  processExitConfirmed?: boolean;
};
export type Task = {
  preparation?: JiraPreparation;
  schemaVersion: 1; id: string; revision: number; title: string; idea: string;
  type: string; projectId: string | null; source: string; status: Status;
  workflow: Workflow | null; proposedWorkflow: Workflow | null;
  currentStepId: string; completedStepIds: string[]; staleStepIds: string[];
  generation: number; intent: 'pause' | 'cancel' | null;
  reviews: Review[]; runs: Run[]; artifacts: ArtifactRef[];
  approvalBindings: ApprovalBinding[];
  blockedReason: string | null; queuedAt: string | null; createdAt: string; updatedAt: string;
};
export type AgentResult = {
  taskId: string; attemptId: string; summary: string; artifacts: ArtifactRef[];
} & (
  | { kind: 'completed'; evidence: Record<string, string> }
  | { kind: 'needs_human'; question: string; checkpoint: string }
  | { kind: 'propose_workflow_change'; workflow: Workflow; reason: string;
      title: string; taskType: string; projectId: string | null }
  | { kind: 'blocked'; reason: string }
  | { kind: 'failed'; reason: string; retryable: boolean }
);
export type HumanAction =
  | { kind: 'answer'; reviewId: string; text: string }
  | { kind: 'approve'; reviewId: string; artifactDigests: string[] }
  | { kind: 'changes'; reviewId: string; text: string }
  | { kind: 'reject'; reviewId: string; text: string }
  | { kind: 'pause' }
  | { kind: 'cancel' }
  | { kind: 'retry'; text: string }
  | { kind: 'insert-review'; beforeStepId: string; title: string };
export type Command = {
  requestId: string; taskId: string; expectedRevision: number; action: HumanAction;
};
export type DomainEvent =
  | PreparationEvent
  | { kind: 'human'; command: Command }
  | { kind: 'launch'; run: Run }
  | { kind: 'started'; attemptId: string; pid: number; processStartedAt: string }
  | { kind: 'finished'; attemptId: string; generation: number;
      exitCode: number; result: AgentResult; bindQuestionAttempt?: boolean }
  | { kind: 'stopped'; attemptId: string; uncertainEffects: boolean }
  | { kind: 'run-failed'; attemptId: string; reason: string;
      retryAt: string | null; exitCode: number | null; uncertainEffects: boolean; processExitConfirmed?: boolean }
  | { kind: 'block'; reason: string };
export type StoredEvent = {
  operationId: string; payloadDigest: string; revision: number; at: string;
  event: DomainEvent | { kind: 'created' }; state: Task;
};
export type Issue = { id: string; taskId: string | null; message: string };
export type WorkspaceView = { jira?: JiraSyncView & { targets: TargetOption[] }; tasks: Task[]; issues: Issue[]; coordinator: 'ready' | 'degraded' };
