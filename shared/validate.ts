import type {
  ActionClass, AgentResult, AgentStep, ApprovalBinding, ArtifactRef, Command, HumanAction,
  HumanStep, RepoRef, Review, Role, Run, Status, Task, Workflow,
} from './contracts.js';

export class BoundaryError extends Error {
  constructor(public readonly code: 'invalid' | 'missing' | 'conflict' | 'unavailable', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BoundaryError';
  }
}

type ObjectValue = Record<string, unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const token = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const statuses = ['triaging', 'queued', 'running', 'waiting-for-human', 'blocked', 'done', 'rejected', 'cancelled'] as const;
const roles = ['triage', 'researcher', 'prd-writer', 'implementer', 'reviewer'] as const;
const actions = ['read', 'write-local', 'open-pr', 'merge', 'deploy'] as const;

function object(value: unknown, field: string): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as ObjectValue;
}

function string(value: unknown, field: string, nonempty = true): string {
  if (typeof value !== 'string' || (nonempty && !value.trim())) throw new Error(`${field} must be a ${nonempty ? 'nonempty ' : ''}string`);
  return value;
}

function nullable<T>(value: unknown, field: string, parse: (v: unknown, f: string) => T): T | null {
  return value === null ? null : parse(value, field);
}

function integer(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error(`${field} must be a finite integer >= ${minimum}`);
  return value;
}

function choice<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${field} must be one of ${values.join(', ')}`);
  return value as T;
}

function array<T>(value: unknown, field: string, parse: (v: unknown, f: string) => T): T[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => parse(item, `${field}[${index}]`));
}

function unique(values: string[], field: string): string[] {
  if (new Set(values).size !== values.length) throw new Error(`${field} contains duplicate values`);
  return values;
}

function fsId(value: unknown, field: string): string {
  const id = string(value, field);
  if (!uuid.test(id)) throw new Error(`${field} must be a UUID`);
  return id;
}

function name(value: unknown, field: string): string {
  const id = string(value, field);
  if (!token.test(id) && id !== '$triage' && !/^\$resolve:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`${field} must be a safe identifier`);
  return id;
}

function timestamp(value: unknown, field: string): string {
  const date = string(value, field);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(date) || !Number.isFinite(Date.parse(date))) throw new Error(`${field} must be a UTC timestamp`);
  return date;
}

function artifact(value: unknown, field: string): ArtifactRef {
  const v = object(value, field);
  const path = string(v.path, `${field}.path`);
  if (path.startsWith('/') || path.startsWith('\\') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || /^[A-Za-z]:/.test(path)) throw new Error(`${field}.path must be a safe relative path`);
  const digest = string(v.digest, `${field}.digest`);
  if (!/^[0-9a-f]{64}$/i.test(digest)) throw new Error(`${field}.digest must be SHA-256 hex`);
  return { id: name(v.id, `${field}.id`), version: integer(v.version, `${field}.version`, 1), digest, path };
}

function repository(value: unknown, field: string): RepoRef {
  const v = object(value, field);
  return { repository: string(v.repository, `${field}.repository`), rule: string(v.rule, `${field}.rule`),
    commit: string(v.commit, `${field}.commit`), selectedCommits: array(v.selectedCommits, `${field}.selectedCommits`, string) };
}

export function parseWorkflow(value: unknown): Workflow {
  const v = object(value, 'workflow');
  const version = integer(v.version, 'workflow.version', 1);
  const seen = new Set<string>();
  const seenAgents = new Set<string>();
  const steps = array(v.steps, 'workflow.steps', (raw, field): AgentStep | HumanStep => {
    const step = object(raw, field);
    const id = name(step.id, `${field}.id`);
    if (id === '$triage' || id.startsWith('$resolve:')) throw new Error(`${field}.id reserves internal coordinator IDs`);
    if (seen.has(id)) throw new Error(`${field}.id duplicates ${id}`);
    const title = string(step.title, `${field}.title`);
    const kind = choice(step.kind, `${field}.kind`, ['agent', 'human'] as const);
    if (kind === 'agent') {
      const checks = unique(array(step.checks, `${field}.checks`, string), `${field}.checks`);
      if (!checks.length) throw new Error(`${field}.checks must not be empty`);
      const agent: AgentStep = { kind, id, title,
        role: choice(step.role, `${field}.role`, roles) as Role,
        instructions: string(step.instructions, `${field}.instructions`),
        inputs: array(step.inputs, `${field}.inputs`, artifact),
        repositories: unique(array(step.repositories, `${field}.repositories`, string), `${field}.repositories`),
        actions: unique(array(step.actions, `${field}.actions`, (x, f) => choice(x, f, actions)), `${field}.actions`) as ActionClass[],
        outputs: unique(array(step.outputs, `${field}.outputs`, name), `${field}.outputs`), checks };
      seen.add(id);
      seenAgents.add(id);
      return agent;
    }
    const producerStepId = name(step.producerStepId, `${field}.producerStepId`);
    if (producerStepId === '$triage' && seenAgents.size > 0) throw new Error(`${field}.producerStepId may use $triage only before the first agent`);
    if (producerStepId !== '$triage' && !seenAgents.has(producerStepId)) throw new Error(`${field}.producerStepId must refer to an earlier agent step`);
    const human: HumanStep = { kind, id, title, producerStepId,
      artifactIds: unique(array(step.artifactIds, `${field}.artifactIds`, name), `${field}.artifactIds`),
      allowsStepId: nullable(step.allowsStepId, `${field}.allowsStepId`, name) };
    seen.add(id);
    return human;
  });
  if (!steps.length || !steps.some(step => step.kind === 'agent')) throw new Error('workflow.steps must contain an agent');
  if (steps[0].kind === 'human' && steps[0].producerStepId !== '$triage') throw new Error('workflow.steps[0].producerStepId must be $triage');
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.kind === 'human' && step.allowsStepId !== (steps[i + 1]?.id ?? null)) {
      throw new Error(`workflow.steps[${i}].allowsStepId must name the immediate next step, or null at the end`);
    }
  }
  const completionChecks = unique(array(v.completionChecks, 'workflow.completionChecks', string), 'workflow.completionChecks');
  if (!completionChecks.length) throw new Error('workflow.completionChecks must not be empty');
  return { version, steps, completionChecks };
}

function review(value: unknown, field: string): Review {
  const v = object(value, field);
  return { id: name(v.id, `${field}.id`), kind: choice(v.kind, `${field}.kind`, ['workflow', 'artifact', 'question', 'pause', 'reconciliation'] as const),
    workflowVersion: nullable(v.workflowVersion, `${field}.workflowVersion`, (x, f) => integer(x, f, 1)),
    stepId: name(v.stepId, `${field}.stepId`), artifacts: array(v.artifacts, `${field}.artifacts`, artifact),
    ...(v.attemptId === undefined ? {} : { attemptId: fsId(v.attemptId, `${field}.attemptId`) }),
    prompt: string(v.prompt, `${field}.prompt`), answer: nullable(v.answer, `${field}.answer`, string),
    decision: nullable(v.decision, `${field}.decision`, (x, f) => choice(x, f, ['approve', 'changes', 'reject', 'answer'] as const)) };
}

function approvalBinding(value: unknown, field: string): ApprovalBinding {
  const v = object(value, field);
  return { reviewId: name(v.reviewId, `${field}.reviewId`),
    originalWorkflowVersion: integer(v.originalWorkflowVersion, `${field}.originalWorkflowVersion`, 1),
    workflowVersion: integer(v.workflowVersion, `${field}.workflowVersion`, 1),
    stepId: name(v.stepId, `${field}.stepId`),
    artifacts: array(v.artifacts, `${field}.artifacts`, artifact) };
}

function run(value: unknown, field: string): Run {
  const v = object(value, field);
  if (v.processExitConfirmed !== undefined && typeof v.processExitConfirmed !== 'boolean') throw new Error(`${field}.processExitConfirmed must be boolean`);
  return { id: fsId(v.id, `${field}.id`), stepId: name(v.stepId, `${field}.stepId`),
    workflowVersion: nullable(v.workflowVersion, `${field}.workflowVersion`, (x, f) => integer(x, f, 1)),
    generation: integer(v.generation, `${field}.generation`),
    phase: choice(v.phase, `${field}.phase`, ['launch-intent', 'running', 'ended', 'uncertain'] as const),
    pid: nullable(v.pid, `${field}.pid`, (x, f) => integer(x, f, 1)),
    processStartedAt: nullable(v.processStartedAt, `${field}.processStartedAt`, timestamp),
    runtimeVersion: string(v.runtimeVersion, `${field}.runtimeVersion`),
    inputRefs: array(v.inputRefs, `${field}.inputRefs`, artifact), repos: array(v.repos, `${field}.repos`, repository),
    startedAt: timestamp(v.startedAt, `${field}.startedAt`), endedAt: nullable(v.endedAt, `${field}.endedAt`, timestamp),
    exitCode: nullable(v.exitCode, `${field}.exitCode`, (x, f) => integer(x, f, -2147483648)),
    retryCount: integer(v.retryCount, `${field}.retryCount`),
    nextRetryAt: nullable(v.nextRetryAt, `${field}.nextRetryAt`, timestamp),
    result: nullable(v.result, `${field}.result`, parseAgentResult),
    ...(v.processExitConfirmed === undefined ? {} : { processExitConfirmed: v.processExitConfirmed as boolean }),
    ...(v.reconciliationNote === undefined ? {} : { reconciliationNote: string(v.reconciliationNote, `${field}.reconciliationNote`) }) };
}

export function parseTask(value: unknown): Task {
  const v = object(value, 'task');
  if (v.schemaVersion !== 1) throw new Error('task.schemaVersion must be 1');
  const task: Task = { schemaVersion: 1, id: fsId(v.id, 'task.id'),
    revision: integer(v.revision, 'task.revision', 1), title: string(v.title, 'task.title'),
    idea: string(v.idea, 'task.idea'), type: string(v.type, 'task.type'),
    projectId: nullable(v.projectId, 'task.projectId', name), source: string(v.source, 'task.source'),
    status: choice(v.status, 'task.status', statuses) as Status,
    workflow: nullable(v.workflow, 'task.workflow', parseWorkflow),
    proposedWorkflow: nullable(v.proposedWorkflow, 'task.proposedWorkflow', parseWorkflow),
    currentStepId: name(v.currentStepId, 'task.currentStepId'),
    completedStepIds: unique(array(v.completedStepIds, 'task.completedStepIds', name), 'task.completedStepIds'),
    staleStepIds: unique(array(v.staleStepIds, 'task.staleStepIds', name), 'task.staleStepIds'),
    generation: integer(v.generation, 'task.generation'),
    intent: nullable(v.intent, 'task.intent', (x, f) => choice(x, f, ['pause', 'cancel'] as const)),
    reviews: array(v.reviews, 'task.reviews', review), runs: array(v.runs, 'task.runs', run),
    artifacts: array(v.artifacts, 'task.artifacts', artifact),
    approvalBindings: array(v.approvalBindings ?? [], 'task.approvalBindings', approvalBinding),
    blockedReason: nullable(v.blockedReason, 'task.blockedReason', string),
    queuedAt: nullable(v.queuedAt, 'task.queuedAt', timestamp),
    createdAt: timestamp(v.createdAt, 'task.createdAt'), updatedAt: timestamp(v.updatedAt, 'task.updatedAt') };
  unique(task.reviews.map(item => item.id), 'task.reviews.id');
  unique(task.approvalBindings.map(item => `${item.reviewId}:${item.workflowVersion}`), 'task.approvalBindings');
  unique(task.runs.map(item => item.id), 'task.runs.id');
  if (task.workflow && task.proposedWorkflow && task.proposedWorkflow.version <= task.workflow.version) throw new Error('task.proposedWorkflow.version must exceed approved workflow');
  return task;
}

function humanAction(value: unknown): HumanAction {
  const v = object(value, 'command.action');
  const kind = choice(v.kind, 'command.action.kind', ['answer', 'approve', 'changes', 'reject', 'pause', 'cancel', 'retry', 'insert-review'] as const);
  switch (kind) {
    case 'answer': return { kind, reviewId: name(v.reviewId, 'command.action.reviewId'), text: string(v.text, 'command.action.text') };
    case 'approve': return { kind, reviewId: name(v.reviewId, 'command.action.reviewId'),
      artifactDigests: unique(array(v.artifactDigests, 'command.action.artifactDigests', (x, f) => {
        const digest = string(x, f);
        if (!/^[0-9a-f]{64}$/i.test(digest)) throw new Error(`${f} must be SHA-256 hex`);
        return digest;
      }), 'command.action.artifactDigests') };
    case 'changes':
    case 'reject': return { kind, reviewId: name(v.reviewId, 'command.action.reviewId'), text: string(v.text, 'command.action.text') };
    case 'pause':
    case 'cancel': return { kind };
    case 'retry': return { kind, text: string(v.text, 'command.action.text') };
    case 'insert-review': return { kind, beforeStepId: name(v.beforeStepId, 'command.action.beforeStepId'), title: string(v.title, 'command.action.title') };
  }
}

export function parseCommand(value: unknown): Command {
  const v = object(value, 'command');
  return { requestId: name(v.requestId, 'command.requestId'), taskId: fsId(v.taskId, 'command.taskId'),
    expectedRevision: integer(v.expectedRevision, 'command.expectedRevision', 1), action: humanAction(v.action) };
}

export function parseAgentResult(value: unknown): AgentResult {
  const v = object(value, 'result');
  const base = { taskId: fsId(v.taskId, 'result.taskId'), attemptId: fsId(v.attemptId, 'result.attemptId'),
    summary: string(v.summary, 'result.summary'), artifacts: array(v.artifacts, 'result.artifacts', artifact) };
  const kind = choice(v.kind, 'result.kind', ['completed', 'needs_human', 'propose_workflow_change', 'blocked', 'failed'] as const);
  switch (kind) {
    case 'completed': {
      const evidence = object(v.evidence, 'result.evidence');
      return { ...base, kind, evidence: Object.fromEntries(Object.entries(evidence).map(([key, val]) =>
        [name(key, 'result.evidence key'), string(val, `result.evidence.${key}`)])) };
    }
    case 'needs_human': return { ...base, kind, question: string(v.question, 'result.question'), checkpoint: string(v.checkpoint, 'result.checkpoint') };
    case 'propose_workflow_change': return { ...base, kind, workflow: parseWorkflow(v.workflow),
      reason: string(v.reason, 'result.reason'), title: string(v.title, 'result.title'),
      taskType: string(v.taskType, 'result.taskType'), projectId: nullable(v.projectId, 'result.projectId', name) };
    case 'blocked': return { ...base, kind, reason: string(v.reason, 'result.reason') };
    case 'failed': {
      if (typeof v.retryable !== 'boolean') throw new Error('result.retryable must be boolean');
      return { ...base, kind, reason: string(v.reason, 'result.reason'), retryable: v.retryable };
    }
  }
}
