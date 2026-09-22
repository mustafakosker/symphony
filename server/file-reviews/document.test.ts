import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { waitingTask, workflowProposal } from '../testing/fixtures.js';
import { bindReview, matchesBinding, parseRecord, selectReview } from './model.js';
import { makeRequest, parseResponse, renderDraft, renderReceipt } from './document.js';

function questionTask() {
  const task = waitingTask();
  task.proposedWorkflow = null;
  task.reviews = [{ id: 'question-1', kind: 'question', workflowVersion: null,
    stepId: '$triage', artifacts: [], attemptId: 'run-1',
    prompt: 'Which Java version?', answer: null, decision: null }];
  return task;
}

describe('file review documents', () => {
  it('maps a CRLF answer to the issued task and revision', () => {
    const task = questionTask();
    const token = '33333333-3333-4333-8333-333333333333';
    const record = makeRequest(task, task.reviews[0], token);
    const bytes = Buffer.from((record.prefix + 'action: answer\n\nJava 17.\n').replace(/\n/g, '\r\n'));
    expect(parseResponse(record, bytes)).toEqual({ requestId: token,
      taskId: task.id, expectedRevision: 1,
      action: { kind: 'answer', reviewId: 'question-1', text: 'Java 17.' } });
  });

  it.each(['approve', 'reject', 'retry', 'cancel', 'changes'])('rejects %s on a question', action => {
    const task = questionTask();
    const record = makeRequest(task, task.reviews[0], crypto.randomUUID());
    expect(() => parseResponse(record, Buffer.from(record.prefix + `action: ${action}\n\nReason`))).toThrow();
  });

  it('does not silently accept conditional approval', () => {
    const task = waitingTask();
    const record = makeRequest(task, task.reviews[0], crypto.randomUUID());
    expect(() => parseResponse(record, Buffer.from(record.prefix + 'action: approve\n\nOnly if tests pass.'))).toThrow();
  });

  it.each([
    ['empty answer', 'action: answer\n\n'],
    ['blank action', 'action: \n\n'],
    ['second action', 'action: answer\n\naction: approve'],
  ])('rejects a question with %s', (_name, response) => {
    const task = questionTask();
    const record = makeRequest(task, task.reviews[0], crypto.randomUUID());
    expect(() => parseResponse(record, Buffer.from(record.prefix + response))).toThrow();
  });

  it('requires a rejection reason and preserves artifact digests', () => {
    const task = waitingTask(); task.workflow = workflowProposal(); task.proposedWorkflow = null;
    task.reviews[0] = { ...task.reviews[0], kind: 'artifact', stepId: 'findings',
      artifacts: [{ id: 'findings', version: 2, digest: 'a'.repeat(64), path: 'findings.md' }] };
    const record = makeRequest(task, task.reviews[0], crypto.randomUUID());
    expect(() => parseResponse(record, Buffer.from(record.prefix + 'action: reject\n\n'))).toThrow();
    expect(parseResponse(record, Buffer.from(record.prefix + 'action: approve\n\n'))).toEqual({
      requestId: record.token, taskId: task.id, expectedRevision: 1,
      action: { kind: 'approve', reviewId: 'workflow-review', artifactDigests: ['a'.repeat(64)] },
    });
  });

  it('rejects mutable prefix edits, invalid UTF-8, a BOM, and oversized input', () => {
    const task = questionTask(); const record = makeRequest(task, task.reviews[0], crypto.randomUUID());
    expect(() => parseResponse(record, Buffer.from(record.prefix.replace('Java', 'Kotlin') + 'action: answer\n\n17'))).toThrow();
    expect(() => parseResponse(record, Buffer.from([0xff]))).toThrow();
    expect(() => parseResponse(record, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(record.prefix + 'action: answer\n\n17')]))).toThrow();
    expect(() => parseResponse(record, Buffer.alloc(1024 * 1024 + 1))).toThrow();
  });

  it('rejects edits to an approval scope before translating its response', () => {
    const task = waitingTask(); const record = makeRequest(task, task.reviews[0], crypto.randomUUID());
    const edited = record.prefix.replace('Scope: read', 'Scope: deploy');
    expect(() => parseResponse(record, Buffer.from(edited + 'action: approve\n\n'))).toThrow();
  });

  it('keeps response headings editable and makes safe fences', () => {
    const task = questionTask(); task.title = 'Hello — WORLD!!!';
    task.reviews[0].prompt = '## Question\n```\nWhich?';
    const record = makeRequest(task, task.reviews[0], crypto.randomUUID());
    expect(record.basename).toMatch(/^hello-world-[0-9a-f-]{36}$/);
    expect(parseResponse(record, Buffer.from(record.prefix + 'action: answer\n\n## Your response\n```answer```'))).toMatchObject({ action: { text: '## Your response\n```answer```' } });
    expect(renderDraft(record)).toBe(record.prefix + record.initialResponse);
    expect(renderReceipt({ ...record, phase: 'settled', publication: 'published', snapshot: { base64: Buffer.from('x').toString('base64'), sha256: 'b'.repeat(64) }, outcome: { status: 'Needs correction', message: 'Bad input', acceptedRevision: null } })).toContain('Needs correction');
  });

  it('binds only the first supported pending review and detects stale task data', () => {
    const task = waitingTask();
    task.reviews.unshift({ id: 'pause-first', kind: 'pause', workflowVersion: 1, stepId: '$triage', artifacts: [], prompt: 'Pause?', answer: null, decision: null });
    expect(selectReview(task)).toBeNull();
    task.reviews.shift();
    const binding = bindReview(task, task.reviews[0]);
    expect(matchesBinding(task, binding)).toBe(true);
    task.revision++;
    expect(matchesBinding(task, binding)).toBe(false);
  });

  it('rejects unsupported reviews and malformed durable records', () => {
    const task = waitingTask();
    for (const kind of ['pause', 'reconciliation'] as const) {
      task.reviews[0] = { ...task.reviews[0], kind };
      expect(() => makeRequest(task, task.reviews[0], crypto.randomUUID())).toThrow();
    }
    expect(() => parseRecord({ schemaVersion: 1 })).toThrow();
  });

  it('parses only durable records whose captured command remains bound', () => {
    const task = questionTask(); const record = makeRequest(task, task.reviews[0], crypto.randomUUID());
    const bytes = Buffer.from(record.prefix + 'action: answer\n\nJava 17.');
    const captured = { ...record, phase: 'applying' as const,
      snapshot: { base64: bytes.toString('base64'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, command: parseResponse(record, bytes) };
    expect(parseRecord(captured)).toMatchObject({ phase: 'applying', command: captured.command });
    expect(() => parseRecord({ ...captured, command: { ...captured.command, requestId: crypto.randomUUID() } })).toThrow();
  });

  it('preserves an active-workflow question binding with its workflow version', () => {
    const task = questionTask(); task.workflow = workflowProposal(); task.reviews[0].workflowVersion = 1;
    const record = makeRequest(task, task.reviews[0], crypto.randomUUID());
    expect(record.binding).toMatchObject({ review: { workflowVersion: 1 }, workflow: null });
  });

  it('rejects empty stored answer and rejection commands', () => {
    const task = questionTask(); const record = makeRequest(task, task.reviews[0], crypto.randomUUID());
    const bytes = Buffer.from(record.prefix + 'action: answer\n\nJava 17.');
    const applying = { ...record, phase: 'applying' as const,
      snapshot: { base64: bytes.toString('base64'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, command: parseResponse(record, bytes) };
    expect(() => parseRecord({ ...applying, command: { ...applying.command, action: { kind: 'answer', reviewId: 'question-1', text: ' ' } } })).toThrow();
    const approvalTask = waitingTask(); const approval = makeRequest(approvalTask, approvalTask.reviews[0], crypto.randomUUID());
    const rejected = { ...approval, phase: 'applying' as const, snapshot: applying.snapshot,
      command: { requestId: approval.token, taskId: approvalTask.id, expectedRevision: 1,
        action: { kind: 'reject' as const, reviewId: 'workflow-review', text: '' } } };
    expect(() => parseRecord(rejected)).toThrow();
  });

  it('keeps draft publication independent from receipt publication and fixes material names', () => {
    const task = waitingTask(); task.workflow = workflowProposal(); task.proposedWorkflow = null;
    task.reviews[0] = { ...task.reviews[0], kind: 'artifact', stepId: 'findings',
      artifacts: [{ id: 'findings', version: 2, digest: 'a'.repeat(64), path: '../untrusted.md' }] };
    const record = makeRequest(task, task.reviews[0], crypto.randomUUID());
    expect(record.materials[0].filename).toBe(`materials/${record.token}/findings.v2.bin`);
    expect(parseRecord({ ...record, publication: 'published' })).toMatchObject({ phase: 'issued', receiptPublished: false });
  });

  it('rejects records whose generated instructions advertise unsupported actions', () => {
    const task = questionTask(); const record = makeRequest(task, task.reviews[0], crypto.randomUUID());
    expect(() => parseRecord({ ...record, prefix: record.prefix.replace('Only `action: answer` is allowed.',
      'Allowed actions: `action: answer` or `action: retry`.') })).toThrow();
    expect(parseRecord({ ...record, initialResponse: 'action: answer\n\n' })).toMatchObject({ phase: 'issued' });
  });

  it('resets an unsupported carried action while preserving its response body', () => {
    const task = questionTask();
    const record = makeRequest(task, task.reviews[0], crypto.randomUUID(), null, 'action: retry\n\nKeep this invalid body.');
    expect(record.initialResponse).toBe('action: answer\n\nKeep this invalid body.');
    expect(() => parseRecord({ ...record, initialResponse: 'action: retry\n\nKeep this invalid body.' })).toThrow();
  });
});
