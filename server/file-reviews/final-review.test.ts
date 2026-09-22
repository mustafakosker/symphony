import { createHash } from 'node:crypto';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createFileReviews, type FileReviewIo } from './adapter.js';
import { loadRecords, publishExclusive, readBounded, readReceipt, saveRecord } from './io.js';
import { parseResponse, renderReceipt } from './document.js';
import { draftFile, fileReviewFixture, submitFile } from './testing.js';
import { waitingTask, workflowProposal } from '../testing/fixtures.js';
import { applyHumanCommand } from '../coordinator/reviews.js';

const coordinator = { tick: async () => {}, shutdown: async () => {}, stopTask: async () => {} } as never;
function adapter(f: Awaited<ReturnType<typeof fileReviewFixture>>, io: Partial<FileReviewIo>) {
  return createFileReviews({ workspaceRoot: f.workspaceRoot, localRoot: f.localRoot, stableMs: 0, store: f.store,
    apply: command => applyHumanCommand(f.store, coordinator, command), io });
}
function question() {
  const task = waitingTask(); task.proposedWorkflow = null;
  task.reviews = [{ id: 'question', kind: 'question', workflowVersion: null, stepId: '$triage', artifacts: [],
    prompt: 'Answer?', answer: null, decision: null }];
  return task;
}
const materialBytes = Buffer.from('reviewed material');
async function artifactFixture() {
  const task = waitingTask(); task.proposedWorkflow = null; task.workflow = workflowProposal();
  task.status = 'running'; task.reviews = []; task.currentStepId = 'research'; task.generation = 1;
  const runId = '22222222-2222-4222-8222-222222222222';
  task.runs = [{ id: runId, stepId: 'research', workflowVersion: 1, generation: 1,
    phase: 'running', pid: 42, processStartedAt: task.createdAt, runtimeVersion: 'test',
    inputRefs: [], repos: [], startedAt: task.createdAt, endedAt: null,
    exitCode: null, retryCount: 0, nextRetryAt: null, result: null }];
  const f = await fileReviewFixture(task);
  try {
    const ref = await f.store.publishArtifact(task.id, 'findings', materialBytes);
    const result = { kind: 'completed' as const, taskId: task.id, attemptId: runId, summary: 'Research accepted',
      artifacts: [ref], evidence: { findings: 'checked' } };
    await f.store.publishRunFiles(task.id, runId, { 'result.json': Buffer.from(JSON.stringify(result)) });
    await f.store.apply(task.id, 1, 'finish-research', { kind: 'finished', attemptId: runId, generation: 1, exitCode: 0, result });
    return f;
  } catch (error) { await f.dispose(); throw error; }
}

it.each(['conditional feedback', 'missing material', 'tampered material'])('accepts artifact correction after %s', async reason => {
  const f = await artifactFixture(); const task = await f.store.get(waitingTask().id);
  try {
    await f.adapter.scan(0);
    const original = (await loadRecords(f.localRoot)).records[0];
    const material = join(f.workspaceRoot, 'reviews', original.materials[0].filename);
    if (reason === 'missing material') await rm(material);
    if (reason === 'tampered material') await writeFile(material, 'changed');
    await submitFile(await draftFile(f.workspaceRoot), `action: approve\n\n${reason === 'conditional feedback' ? 'Only if checked.' : ''}`);
    await f.adapter.scan(1); await f.adapter.scan(2);
    const successor = (await loadRecords(f.localRoot)).records.find(record => record.predecessor === original.token)!;
    expect(await readFile(join(f.workspaceRoot, 'reviews', successor.materials[0].filename))).toEqual(materialBytes);
    await submitFile(await draftFile(f.workspaceRoot), 'action: approve\n\n');
    await f.adapter.scan(3); await f.adapter.scan(4);
    expect((await f.store.get(task.id)).reviews[0].decision).toBe('approve');
    expect((await loadRecords(f.localRoot)).records).toHaveLength(2);
  } finally { await f.dispose(); }
});

it.each([['initial', 'before'], ['initial', 'after'], ['correction', 'before'], ['correction', 'after']])(
  'recovers the same %s identity when material publication fails %s its write', async (kind, timing) => {
  const f = await artifactFixture(); const task = await f.store.get(waitingTask().id);
  try {
    if (kind === 'correction') {
      await f.adapter.scan(0);
      await submitFile(await draftFile(f.workspaceRoot), 'action: approve\n\nOnly if checked.');
    }
    let persistedBeforeCopy = false;
    const broken = adapter(f, { publishExclusive: async (root, path, bytes) => {
      if (path.startsWith('reviews/materials/')) {
        const token = path.split('/')[2];
        persistedBeforeCopy = (await loadRecords(f.localRoot)).records.some(record => record.token === token);
        if (timing === 'before') throw new Error('material publication unavailable');
        try { await publishExclusive(root, path, bytes); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        throw new Error('lost material publication result');
      }
      await publishExclusive(root, path, bytes);
    } });
    await broken.scan(1); await broken.scan(2);
    expect(persistedBeforeCopy).toBe(true);
    const records = (await loadRecords(f.localRoot)).records;
    const pending = records.find(record => record.publication === 'pending')!;
    expect(pending).toBeDefined();
    await expect(readFile(join(f.workspaceRoot, 'reviews', `${pending.basename}.md`))).rejects.toMatchObject({ code: 'ENOENT' });
    const restarted = await f.restart(); await restarted.scan(3);
    expect((await loadRecords(f.localRoot)).records.map(record => record.token).sort()).toEqual(records.map(record => record.token).sort());
    expect(await readFile(join(f.workspaceRoot, 'reviews', pending.materials[0].filename))).toEqual(materialBytes);
    await submitFile(await draftFile(f.workspaceRoot), 'action: approve\n\n');
    await restarted.scan(4); await restarted.scan(5);
    expect((await restarted.store.get(task.id)).reviews[0].decision).toBe('approve');
  } finally { await f.dispose(); }
});

it('reconciles a receipt for maximum-size input after restart without widening intake', async () => {
  const task = question(); const f = await fileReviewFixture(task);
  try {
    await f.adapter.scan(0);
    const issued = (await loadRecords(f.localRoot)).records[0];
    const responsePrefix = 'action: answer\n\n';
    const answer = 'a'.repeat(1024 * 1024 - Buffer.byteLength(issued.prefix + responsePrefix));
    const ready = await submitFile(await draftFile(f.workspaceRoot), responsePrefix + answer);
    expect((await readFile(ready)).length).toBe(1024 * 1024);
    const broken = adapter(f, { saveRecord: async (root, record) => {
      if (record.receiptPublished) throw new Error('receipt flag unavailable');
      await saveRecord(root, record);
    } });
    await broken.scan(1); await broken.scan(2);
    const receipt = await readFile(ready.replace('.ready.md', '.receipt.md'));
    expect(receipt.length).toBeGreaterThan(1024 * 1024);
    expect((await loadRecords(f.localRoot)).records[0].receiptPublished).toBe(false);
    const restarted = await f.restart(); await restarted.scan(3);
    expect((await loadRecords(f.localRoot)).records[0].receiptPublished).toBe(true);
    expect(await readFile(ready.replace('.ready.md', '.receipt.md'))).toEqual(receipt);
    expect((await restarted.store.get(task.id))).toMatchObject({ revision: 2, reviews: [{ answer }] });
    await writeFile(ready, Buffer.alloc(1024 * 1024 + 1));
    await expect(readBounded(f.workspaceRoot, `reviews/${issued.basename}.ready.md`)).rejects.toThrow('1048576');
    expect(await restarted.issues()).toEqual([]);
  } finally { await f.dispose(); }
});

it('renders supported input with 150000 backtick runs using a fence longer than every run', async () => {
  const task = question(); const f = await fileReviewFixture(task);
  try {
    await f.adapter.scan(0);
    const record = (await loadRecords(f.localRoot)).records[0];
    const text = record.prefix + 'action: answer\n\n' + '` '.repeat(150000) + '``````';
    const bytes = Buffer.from(text);
    expect(bytes.length).toBeLessThan(1024 * 1024);
    expect(parseResponse(record, bytes).action.kind).toBe('answer');
    const receipt = renderReceipt({ ...record, phase: 'settled', snapshot: { base64: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex') }, outcome: { status: 'Accepted', message: 'Accepted', acceptedRevision: 2 } });
    expect(receipt.split('## Processed response\n')[1]).toBe('```````\n' + text + '\n```````\n');
  } finally { await f.dispose(); }
});

it.each(['file', 'symlink'])('reports %s journal infrastructure failure and recovers', async kind => {
  const f = await fileReviewFixture();
  try {
    const path = join(f.localRoot, 'file-reviews');
    if (kind === 'file') await writeFile(path, 'blocked');
    else await symlink(f.workspaceRoot, path);
    await expect(f.adapter.scan(0)).resolves.toBeUndefined();
    const issues = await f.adapter.issues();
    expect(issues).toHaveLength(1); expect(issues[0].message).toContain('journal unavailable');
    await f.adapter.scan(1); expect(await f.adapter.issues()).toEqual(issues);
    expect((await f.store.get(waitingTask().id)).revision).toBe(1);
    await rm(path); await f.adapter.scan(2);
    expect(await f.adapter.issues()).toEqual([]);
    expect(await draftFile(f.workspaceRoot)).toBeTruthy();
  } finally { await f.dispose(); }
});

it.each([2, 3])('reports journal reload failure at load %s without consuming observed ready bytes', async failedLoad => {
  const f = await fileReviewFixture();
  try {
    await f.adapter.scan(0);
    await submitFile(await draftFile(f.workspaceRoot), 'action: reject\n\nReason');
    let count = 0;
    const broken = adapter(f, { loadRecords: async root => {
      if (++count === failedLoad) throw new Error('journal unreadable');
      return loadRecords(root);
    } });
    await expect(broken.scan(1)).resolves.toBeUndefined();
    expect((await broken.issues())[0].message).toContain('journal unavailable');
    expect((await f.store.get(waitingTask().id)).revision).toBe(1);
    await broken.scan(2);
    expect((await f.store.get(waitingTask().id)).revision).toBe(1);
    await broken.scan(3);
    expect((await f.store.get(waitingTask().id)).revision).toBe(2);
    expect(await broken.issues()).toEqual([]);
  } finally { await f.dispose(); }
});


it('suspends file decisions on journal write failure and retries the durable request after recovery', async () => {
  const f = await fileReviewFixture();
  try {
    await f.adapter.scan(0);
    await submitFile(await draftFile(f.workspaceRoot), 'action: reject\n\nSaved answer');
    const broken = adapter(f, { saveRecord: async () => { throw new Error('disk unavailable'); } });
    await broken.scan(1); await expect(broken.scan(2)).resolves.toBeUndefined();
    expect((await broken.issues())[0].message).toContain('journal unavailable');
    expect((await loadRecords(f.localRoot)).records[0].phase).toBe('issued');
    expect((await f.store.get(waitingTask().id)).revision).toBe(1);
    const restarted = await f.restart(); await restarted.scan(3); await restarted.scan(4);
    expect((await restarted.store.get(waitingTask().id)).reviews[0].answer).toBe('Saved answer');
    expect(await restarted.issues()).toEqual([]);
  } finally { await f.dispose(); }
});

it('bounds receipt reconciliation by expected output and rejects symlinks and directories', async () => {
  const f = await fileReviewFixture();
  try {
    const expected = Buffer.alloc(1024 * 1024 + 300, 97);
    await publishExclusive(f.workspaceRoot, 'reviews/receipt.md', expected);
    expect(await readReceipt(f.workspaceRoot, 'reviews/receipt.md', expected.length)).toEqual(expected);
    await expect(readReceipt(f.workspaceRoot, 'reviews/receipt.md', expected.length - 1)).rejects.toMatchObject({ code: 'invalid' });
    await symlink('receipt.md', join(f.workspaceRoot, 'reviews', 'link.md'));
    await expect(readReceipt(f.workspaceRoot, 'reviews/link.md', expected.length)).rejects.toMatchObject({ code: 'invalid' });
    await expect(readReceipt(f.workspaceRoot, 'reviews', expected.length)).rejects.toMatchObject({ code: 'invalid' });
  } finally { await f.dispose(); }
});
