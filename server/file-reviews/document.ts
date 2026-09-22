import { parseCommand } from '../../shared/validate.js';
import type { Command, Review, Task, Workflow } from '../../shared/contracts.js';
import { bindReview, type Material, type RequestRecord } from './model.js';

const MAX_BYTES = 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function slug(title: string): string {
  const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (normalized.slice(0, 48).replace(/-+$/g, '') || 'task');
}

function safeFence(text: string): string {
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  return '`'.repeat(length);
}

function workflowScope(workflow: Workflow | null): string {
  if (!workflow) return '';
  const steps = workflow.steps.map(step => step.kind === 'agent'
    ? `- Agent **${step.id}** — ${step.title}\n  Scope: ${step.actions.join(', ') || 'none'}; repositories: ${step.repositories.join(', ') || 'none'}.\n  Outputs: ${step.outputs.join(', ') || 'none'}.\n  Checks: ${step.checks.join(', ') || 'none'}.`
    : `- Human **${step.id}** — ${step.title}\n  Reviews output from **${step.producerStepId}**; approval allows: ${step.allowsStepId ?? 'completion'}.`);
  return `\n## Workflow scope\n${steps.join('\n')}\n\n## Immutable workflow snapshot\n${safeFence(JSON.stringify(workflow, null, 2))}json\n${JSON.stringify(workflow, null, 2)}\n${safeFence(JSON.stringify(workflow, null, 2))}\n`;
}

function materialsFor(review: Review, token: string): Material[] {
  return review.artifacts.map(ref => ({ ref: structuredClone(ref), filename: `materials/${token}/${ref.id}.v${ref.version}.bin` }));
}

function initialResponse(review: Review, response?: string): string {
  const fallback = review.kind === 'question' ? 'action: answer' : 'action: ';
  if (response === undefined) return `${fallback}\n\n`;
  const [line, ...bodyLines] = response.split('\n');
  const supported = review.kind === 'question'
    ? /^action:[ \t]*answer[ \t]*$/.test(line)
    : /^action:[ \t]*(?:approve|reject)?[ \t]*$/.test(line);
  if (supported) return response;
  return `${fallback}\n${bodyLines.length ? bodyLines.join('\n') : '\n'}`;
}

function prefix(task: Task, review: Review, basename: string, materials: Material[], workflow: Workflow | null): string {
  const lines = [`# ${task.title}`, ''];
  if (review.kind === 'question') {
    lines.push('## Question', review.prompt, '', '## Instructions',
      'Write your answer below. Save and close this file, then rename it',
      `to ${basename}.ready.md to submit. Do not edit after submitting.`,
      'Only `action: answer` is allowed. An answer is required.');
  } else {
    const checkpoint = workflow?.steps.find(step => step.id === review.stepId);
    const completes = review.kind === 'artifact' && checkpoint?.kind === 'human' && checkpoint.allowsStepId === null;
    lines.push(`## ${review.kind === 'workflow' ? 'Workflow approval' : 'Artifact approval'}`, review.prompt, '', '## Instructions',
      'Choose exactly one action below. Save and close this file, then rename it',
      `to ${basename}.ready.md to submit. Do not edit after submitting.`,
      'Allowed actions: `action: approve` or `action: reject`.',
      'Approval must have no response text. Rejection requires a reason.',
      completes ? 'Approval completes this task.' : 'Approval continues the reviewed work.');
  }
  if (review.kind !== 'question') lines.push(workflowScope(workflow));
  if (materials.length) {
    lines.push('## Reviewed materials');
    for (const material of materials) lines.push(`- [${material.ref.path}](${material.filename}) — version ${material.ref.version}, SHA-256 ${material.ref.digest}`);
  }
  lines.push('', '## Your response', '');
  return lines.join('\n');
}

export function makeRequest(task: Task, review: Review, token: string,
  predecessor: string | null = null, response?: string): RequestRecord {
  if (!uuid.test(token)) throw new Error('File review token must be a UUID');
  if (predecessor !== null && !uuid.test(predecessor)) throw new Error('File review predecessor must be a UUID');
  const binding = bindReview(task, review);
  const basename = `${slug(task.title)}-${token.toLowerCase()}`;
  const materials = materialsFor(binding.review, token);
  const immutablePrefix = prefix(task, binding.review, basename, materials, binding.workflow);
  const initial = initialResponse(binding.review, response);
  if (Buffer.byteLength(immutablePrefix + initial, 'utf8') > MAX_BYTES)
    throw new Error('Review document exceeds 1 MiB; use the UI to respond');
  return { schemaVersion: 1, token, basename, binding, prefix: immutablePrefix, initialResponse: initial, materials, predecessor,
    phase: 'issued', publication: 'pending', snapshot: null, command: null, outcome: null, receiptPublished: false };
}

export function parseResponse(record: RequestRecord, bytes: Uint8Array): Command {
  if (bytes.byteLength > MAX_BYTES) throw new Error('Review text changed or file exceeds 1 MiB');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r\n/g, '\n');
  if (!text.startsWith(record.prefix)) throw new Error('Review text changed or file exceeds 1 MiB');
  const response = text.slice(record.prefix.length);
  const [line, ...bodyLines] = response.split('\n');
  const match = /^action:[ \t]*(answer|approve|reject)[ \t]*$/.exec(line);
  if (!match || bodyLines.some(value => /^action:/.test(value))) throw new Error('Provide exactly one supported action line');
  const body = bodyLines.join('\n').trim();
  const review = record.binding.review;
  let action: Command['action'];
  if (review.kind === 'question') {
    if (match[1] !== 'answer') throw new Error('Questions require an answer');
    if (!body) throw new Error('Provide an answer');
    action = { kind: 'answer', reviewId: review.id, text: body };
  } else {
    if (match[1] === 'answer') throw new Error('Approvals require approve or reject');
    if (match[1] === 'approve') {
      if (body) throw new Error('Approval cannot include feedback; reject with a reason instead');
      action = { kind: 'approve', reviewId: review.id, artifactDigests: review.artifacts.map(ref => ref.digest) };
    } else {
      if (!body) throw new Error('Rejection requires a reason');
      action = { kind: 'reject', reviewId: review.id, text: body };
    }
  }
  return parseCommand({ requestId: record.token, taskId: record.binding.taskId,
    expectedRevision: record.binding.taskRevision, action });
}

export function renderDraft(record: RequestRecord): string {
  return record.prefix + record.initialResponse;
}

export function renderReceipt(record: RequestRecord): string {
  if (!record.outcome || !record.snapshot) throw new Error('Cannot render a receipt before capture and outcome');
  const response = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(Buffer.from(record.snapshot.base64, 'base64'));
  const fence = safeFence(response);
  return [`# Review receipt: ${record.outcome.status}`, '', record.outcome.message, '',
    `- Request token: ${record.token}`, `- Source filename: ${record.basename}.ready.md`,
    `- Snapshot SHA-256: ${record.snapshot.sha256}`,
    record.outcome.acceptedRevision === null ? '- Accepted revision: none' : `- Accepted revision: ${record.outcome.acceptedRevision}`,
    '', '## Processed response', fence, response, fence, ''].join('\n');
}
