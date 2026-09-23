import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseCommand, parseWorkflow } from '../../shared/validate.js';
import type { ArtifactRef, Command, Issue, Review, Task, Workflow } from '../../shared/contracts.js';

export type FileReviewKind = 'question' | 'workflow' | 'artifact';
export type Binding = { taskId: string; taskRevision: number; review: Review; workflow: Workflow | null };
export type Material = { ref: ArtifactRef; filename: string };
export type Snapshot = { base64: string; sha256: string };
export type Outcome = {
  status: 'Accepted' | 'Outdated' | 'Needs correction'; message: string;
  acceptedRevision: number | null;
};
export type RequestRecord = {
  schemaVersion: 1; token: string; basename: string; binding: Binding;
  prefix: string; initialResponse: string; materials: Material[];
  predecessor: string | null;
  phase: 'issued' | 'captured' | 'applying' | 'settled';
  publication: 'pending' | 'attempted' | 'published';
  snapshot: Snapshot | null; command: Command | null;
  outcome: Outcome | null; receiptPublished: boolean;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{64}$/i;
const supported = (review: Review): review is Review & { kind: FileReviewKind } =>
  review.kind === 'question' || review.kind === 'workflow' || review.kind === 'artifact';
const equal = (left: unknown, right: unknown) => isDeepStrictEqual(left, right);

function requiredObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function integer(value: unknown, field: string, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum) throw new Error(`${field} must be an integer`);
  return value as number;
}

function parseArtifact(value: unknown, field: string): ArtifactRef {
  const v = requiredObject(value, field);
  const valueDigest = text(v.digest, `${field}.digest`);
  if (!digest.test(valueDigest)) throw new Error(`${field}.digest must be SHA-256 hex`);
  return { id: text(v.id, `${field}.id`), version: integer(v.version, `${field}.version`, 1),
    digest: valueDigest, path: text(v.path, `${field}.path`) };
}

function parseReview(value: unknown, field: string): Review {
  const v = requiredObject(value, field);
  const kind = text(v.kind, `${field}.kind`);
  if (!['question', 'workflow', 'artifact', 'pause', 'reconciliation'].includes(kind)) throw new Error(`${field}.kind is invalid`);
  const decision = v.decision;
  if (!['approve', 'changes', 'reject', 'answer', null].includes(decision as string | null)) throw new Error(`${field}.decision is invalid`);
  if (v.workflowVersion !== null && (!Number.isInteger(v.workflowVersion) || (v.workflowVersion as number) < 1))
    throw new Error(`${field}.workflowVersion is invalid`);
  if (!Array.isArray(v.artifacts)) throw new Error(`${field}.artifacts must be an array`);
  if (v.answer !== null && typeof v.answer !== 'string') throw new Error(`${field}.answer is invalid`);
  if (v.attemptId !== undefined && typeof v.attemptId !== 'string') throw new Error(`${field}.attemptId is invalid`);
  return { id: text(v.id, `${field}.id`), kind: kind as Review['kind'],
    workflowVersion: v.workflowVersion as number | null, stepId: text(v.stepId, `${field}.stepId`),
    artifacts: v.artifacts.map((item, index) => parseArtifact(item, `${field}.artifacts[${index}]`)),
    prompt: text(v.prompt, `${field}.prompt`), answer: v.answer as string | null,
    ...(v.attemptId === undefined ? {} : { attemptId: v.attemptId as string }), decision: decision as Review['decision'] };
}

function expectedWorkflow(task: Task, review: Review): Workflow | null {
  if (review.kind === 'workflow') return task.proposedWorkflow;
  if (review.kind === 'artifact') return task.workflow;
  return null;
}

function validateBoundReview(task: Task, review: Review): void {
  if (task.status !== 'waiting-for-human') throw new Error('Task is not waiting for human review');
  if (!supported(review)) throw new Error(`Review ${review.id} is not supported by file reviews`);
  const index = task.reviews.findIndex(item => item.id === review.id);
  if (index < 0 || task.reviews[index].decision !== null) throw new Error(`Review ${review.id} is not pending`);
  if (task.reviews.slice(0, index).some(item => item.decision === null)) throw new Error('An earlier review is still pending');
  if (!equal(task.reviews[index], review)) throw new Error('Review does not match task snapshot');
  const workflow = expectedWorkflow(task, review);
  if (review.kind !== 'question' && (!workflow || review.workflowVersion !== workflow.version)) {
    throw new Error('Review workflow snapshot is missing or stale');
  }
}

export function selectReview(task: Task): Review | null {
  if (task.preparation) return null;
  const review = task.reviews.find(item => item.decision === null);
  return review && supported(review) ? review : null;
}

export function bindReview(task: Task, review: Review): Binding {
  validateBoundReview(task, review);
  return { taskId: task.id, taskRevision: task.revision, review: structuredClone(review),
    workflow: structuredClone(expectedWorkflow(task, review)) };
}

export function matchesBinding(task: Task, binding: Binding): boolean {
  try {
    if (task.id !== binding.taskId || task.revision !== binding.taskRevision) return false;
    validateBoundReview(task, binding.review);
    return equal(expectedWorkflow(task, binding.review), binding.workflow);
  } catch {
    return false;
  }
}

function parseBinding(value: unknown): Binding {
  const v = requiredObject(value, 'record.binding');
  const taskId = text(v.taskId, 'record.binding.taskId');
  if (!uuid.test(taskId)) throw new Error('record.binding.taskId must be a UUID');
  const review = parseReview(v.review, 'record.binding.review');
  if (!supported(review) || review.decision !== null) throw new Error('record.binding.review must be a supported pending review');
  const workflow = v.workflow === null ? null : parseWorkflow(v.workflow);
  if (review.kind === 'question' ? workflow !== null :
      !workflow || workflow.version !== review.workflowVersion) throw new Error('record.binding.workflow is inconsistent');
  return { taskId, taskRevision: integer(v.taskRevision, 'record.binding.taskRevision', 1), review, workflow };
}

function parseSnapshot(value: unknown): Snapshot {
  const v = requiredObject(value, 'record.snapshot');
  const sha256 = text(v.sha256, 'record.snapshot.sha256');
  if (!digest.test(sha256)) throw new Error('record.snapshot.sha256 must be SHA-256 hex');
  const base64 = text(v.base64, 'record.snapshot.base64');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || Buffer.from(base64, 'base64').toString('base64') !== base64)
    throw new Error('record.snapshot.base64 must be canonical base64');
  if (createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex') !== sha256.toLowerCase())
    throw new Error('record.snapshot.sha256 does not match base64');
  return { base64, sha256 };
}

function hasSupportedInitialAction(review: Review, response: string): boolean {
  const line = response.split('\n', 1)[0];
  return review.kind === 'question'
    ? /^action:[ \t]*answer[ \t]*$/.test(line)
    : /^action:[ \t]*(?:approve|reject)?[ \t]*$/.test(line);
}

export function parseRecord(value: unknown): RequestRecord {
  const v = requiredObject(value, 'record');
  if (v.schemaVersion !== 1) throw new Error('record.schemaVersion must be 1');
  const token = text(v.token, 'record.token');
  if (!uuid.test(token)) throw new Error('record.token must be a UUID');
  const basename = text(v.basename, 'record.basename');
  if (!new RegExp(`^[a-z0-9]+(?:-[a-z0-9]+)*-${token}$`, 'i').test(basename) || basename !== basename.toLowerCase())
    throw new Error('record.basename is invalid');
  const binding = parseBinding(v.binding);
  const prefix = text(v.prefix, 'record.prefix');
  const initialResponse = text(v.initialResponse, 'record.initialResponse');
  if (!prefix.endsWith('## Your response\n')) throw new Error('record.prefix must end at the response heading');
  if (!hasSupportedInitialAction(binding.review, initialResponse)) throw new Error('record.initialResponse has an unsupported action');
  const instructionHeading = prefix.lastIndexOf('## Instructions\n');
  if (instructionHeading < 0) throw new Error('record.prefix must include instructions');
  const instructions = prefix.slice(instructionHeading + '## Instructions\n'.length).split('\n');
  const actionInstructions = binding.review.kind === 'question'
    ? 'Only `action: answer` is allowed. An answer is required.'
    : 'Allowed actions: `action: approve` or `action: reject`.';
  if (instructions[2] !== actionInstructions) throw new Error('record instructions broaden supported actions');
  if (!Array.isArray(v.materials)) throw new Error('record.materials must be an array');
  const materials = v.materials.map((item, index) => {
    const material = requiredObject(item, `record.materials[${index}]`);
    return { ref: parseArtifact(material.ref, `record.materials[${index}].ref`), filename: text(material.filename, `record.materials[${index}].filename`) };
  });
  const expectedMaterials = binding.review.artifacts.map(ref => ({ ref, filename: `materials/${token}/${ref.id}.v${ref.version}.bin` }));
  if (!equal(materials, expectedMaterials)) throw new Error('record.materials do not match binding');
  const predecessor = v.predecessor === null ? null : text(v.predecessor, 'record.predecessor');
  if (predecessor !== null && !uuid.test(predecessor)) throw new Error('record.predecessor must be a UUID');
  const phase = v.phase;
  if (!['issued', 'captured', 'applying', 'settled'].includes(phase as string)) throw new Error('record.phase is invalid');
  const publication = v.publication;
  if (!['pending', 'attempted', 'published'].includes(publication as string)) throw new Error('record.publication is invalid');
  const snapshot = v.snapshot === null ? null : parseSnapshot(v.snapshot);
  const command = v.command === null ? null : parseCommand(v.command);
  const outcomeValue = v.outcome;
  let outcome: Outcome | null = null;
  if (outcomeValue !== null) {
    const o = requiredObject(outcomeValue, 'record.outcome');
    if (!['Accepted', 'Outdated', 'Needs correction'].includes(o.status as string)) throw new Error('record.outcome.status is invalid');
    outcome = { status: o.status as Outcome['status'], message: text(o.message, 'record.outcome.message'),
      acceptedRevision: o.acceptedRevision === null ? null : integer(o.acceptedRevision, 'record.outcome.acceptedRevision', 1) };
  }
  if (typeof v.receiptPublished !== 'boolean') throw new Error('record.receiptPublished must be boolean');
  if (command) {
    if (command.requestId !== token || command.taskId !== binding.taskId || command.expectedRevision !== binding.taskRevision ||
        !('reviewId' in command.action) || command.action.reviewId !== binding.review.id) throw new Error('record.command does not match binding');
    if (binding.review.kind === 'question' ? command.action.kind !== 'answer' : !['approve', 'reject'].includes(command.action.kind))
      throw new Error('record.command action is not supported by binding');
    if ((command.action.kind === 'answer' || command.action.kind === 'reject') && !command.action.text.trim())
      throw new Error('record.command response text is required');
    if (command.action.kind === 'approve' && !equal([...command.action.artifactDigests].sort(), binding.review.artifacts.map(ref => ref.digest).sort()))
      throw new Error('record.command artifact digests do not match binding');
  }
  if ((phase === 'issued' && (snapshot || command || outcome)) ||
      (phase === 'captured' && (!snapshot || command || outcome)) ||
      (phase === 'applying' && (!snapshot || !command || outcome)) ||
      (phase === 'settled' && (!snapshot || !outcome))) throw new Error('record phase invariants are invalid');
  if (v.receiptPublished && phase !== 'settled')
    throw new Error('record receipt publication is invalid');
  return { schemaVersion: 1, token, basename, binding, prefix, initialResponse, materials, predecessor,
    phase: phase as RequestRecord['phase'], publication: publication as RequestRecord['publication'], snapshot, command, outcome,
    receiptPublished: v.receiptPublished };
}

export type { ArtifactRef, Command, Issue, Review, Task, Workflow };
