import { describe, expect, it } from 'vitest';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createFileReviews } from './adapter.js';
import { draftFile, fileReviewFixture } from './testing.js';
import { waitingTask } from '../testing/fixtures.js';
import { submitFile } from './testing.js';

it('resets observation when ready bytes change, including equal length changes', async () => {
  const f = await fileReviewFixture();
  try {
    await f.adapter.scan(0);
    const ready = await submitFile(await draftFile(f.workspaceRoot), 'action: reject\n\nbad');
    await f.adapter.scan(1);
    await writeFile(ready, (await readFile(ready, 'utf8')).replace('bad', 'new'));
    await f.adapter.scan(2);
    expect((await f.store.get(waitingTask().id)).revision).toBe(1);
    await f.adapter.scan(3);
    expect((await f.store.get(waitingTask().id)).reviews[0].answer).toBe('new');
  } finally { await f.dispose(); }
});

it('accepts CRLF responses and preserves rejection text', async () => {
  const f = await fileReviewFixture();
  try {
    await f.adapter.scan(0);
    const ready = await submitFile(await draftFile(f.workspaceRoot), 'action: reject\n\nNeeds more evidence.');
    await writeFile(ready, (await readFile(ready, 'utf8')).replace(/\n/g, '\r\n'));
    await f.adapter.scan(1); await f.adapter.scan(2);
    const task = await f.store.get(waitingTask().id);
    expect(task.reviews[0].decision).toBe('reject');
    expect(task.reviews[0].answer).toBe('Needs more evidence.');
  } finally { await f.dispose(); }
});

it('keeps unsupported actions pending and publishes a correction receipt', async () => {
  const f = await fileReviewFixture();
  try {
    await f.adapter.scan(0);
    const ready = await submitFile(await draftFile(f.workspaceRoot), 'action: pause\n\nWait.');
    await f.adapter.scan(1); await f.adapter.scan(2);
    expect((await f.store.get(waitingTask().id)).revision).toBe(1);
    expect(await readFile(ready.replace('.ready.md', '.receipt.md'), 'utf8')).toContain('Needs correction');
  } finally { await f.dispose(); }
});

it('does not approve when reviewed material is missing', async () => {
  const { createHash } = await import('node:crypto');
  const { join } = await import('node:path');
  const { unlink } = await import('node:fs/promises');
  const task = waitingTask();
  task.proposedWorkflow = null;
  task.workflow = (await import('../testing/fixtures.js')).workflowProposal();
  const bytes = Buffer.from('reviewed material');
  const ref = { id: 'findings', version: 1, digest: createHash('sha256').update(bytes).digest('hex'), path: 'artifacts/findings.1.bin' };
  task.reviews = [{ id: 'artifact-review', kind: 'artifact', workflowVersion: 1, stepId: 'findings', artifacts: [ref],
    prompt: 'Approve findings?', answer: null, decision: null }];
  const f = await fileReviewFixture(task);
  try {
    await f.store.publishArtifact(task.id, 'findings', bytes);
    await f.adapter.scan(0);
    const { loadRecords } = await import('./io.js');
    const record = (await loadRecords(f.localRoot)).records[0];
    await unlink(join(f.workspaceRoot, 'reviews', record.materials[0].filename));
    const ready = await submitFile(await draftFile(f.workspaceRoot), 'action: approve\n\n');
    await f.adapter.scan(1); await f.adapter.scan(2);
    expect((await f.store.get(task.id)).revision).toBe(1);
    expect(await readFile(ready.replace('.ready.md', '.receipt.md'), 'utf8')).toContain('Needs correction');
  } finally { await f.dispose(); }
});

it('does not approve when reviewed material bytes are tampered', async () => {
  const { createHash } = await import('node:crypto');
  const { join } = await import('node:path');
  const task = waitingTask();
  task.proposedWorkflow = null;
  task.workflow = (await import('../testing/fixtures.js')).workflowProposal();
  const bytes = Buffer.from('reviewed material');
  const ref = { id: 'findings', version: 1, digest: createHash('sha256').update(bytes).digest('hex'), path: 'artifacts/findings.1.bin' };
  task.reviews = [{ id: 'artifact-review', kind: 'artifact', workflowVersion: 1, stepId: 'findings', artifacts: [ref],
    prompt: 'Approve findings?', answer: null, decision: null }];
  const f = await fileReviewFixture(task);
  try {
    await f.store.publishArtifact(task.id, 'findings', bytes);
    await f.adapter.scan(0);
    const { loadRecords } = await import('./io.js');
    const record = (await loadRecords(f.localRoot)).records[0];
    await writeFile(join(f.workspaceRoot, 'reviews', record.materials[0].filename), Buffer.from('tampered material'));
    const ready = await submitFile(await draftFile(f.workspaceRoot), 'action: approve\n\n');
    await f.adapter.scan(1); await f.adapter.scan(2);
    const current = await f.store.get(task.id);
    expect(current.revision).toBe(1);
    expect(current.reviews[0].decision).toBeNull();
    expect(await readFile(ready.replace('.ready.md', '.receipt.md'), 'utf8')).toContain('Reviewed artifact material is missing or changed');
    expect((await loadRecords(f.localRoot)).records[0].outcome?.status).toBe('Needs correction');
  } finally { await f.dispose(); }
});

it('resets the observation after a ready file disappears', async () => {
  const f = await fileReviewFixture();
  try {
    await f.adapter.scan(0);
    const ready = await submitFile(await draftFile(f.workspaceRoot), 'action: reject\n\nMissing scope');
    await f.adapter.scan(1);
    const absent = `${ready}.absent`;
    await rename(ready, absent);
    await f.adapter.scan(2);
    await rename(absent, ready);
    await f.adapter.scan(3);
    expect((await f.store.get(waitingTask().id)).revision).toBe(1);
    await f.adapter.scan(4);
    expect((await f.store.get(waitingTask().id)).revision).toBe(2);
  } finally { await f.dispose(); }
});

it('persists exact question answer text', async () => {
  const task = waitingTask();
  task.proposedWorkflow = null;
  task.reviews = [{ id: 'question-review', kind: 'question', workflowVersion: null, stepId: '$triage', artifacts: [],
    prompt: 'Which version?', answer: null, decision: null }];
  const f = await fileReviewFixture(task);
  try {
    await f.adapter.scan(0);
    await submitFile(await draftFile(f.workspaceRoot), 'action: answer\n\nVersion 17 is in use.');
    await f.adapter.scan(1); await f.adapter.scan(2);
    const result = await f.store.get(task.id);
    expect(result.reviews[0].answer).toBe('Version 17 is in use.');
    expect(result.reviews[0].decision).toBe('answer');
  } finally { await f.dispose(); }
});

it('replays an applying command after its store commit without a fresh revision check', async () => {
  const { loadRecords, saveRecord } = await import('./io.js');
  const { parseResponse } = await import('./document.js');
  const { createHash } = await import('node:crypto');
  const f = await fileReviewFixture();
  try {
    await f.adapter.scan(0);
    const ready = await submitFile(await draftFile(f.workspaceRoot), 'action: reject\n\nNeeds revision');
    const record = (await loadRecords(f.localRoot)).records[0];
    const bytes = await readFile(ready);
    const command = parseResponse(record, bytes);
    await saveRecord(f.localRoot, { ...record, phase: 'applying',
      snapshot: { base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }, command });
    await f.store.apply(taskId(), command.expectedRevision, command.requestId, { kind: 'human', command });
    const restarted = await f.restart();
    await restarted.scan(1);
    expect((await f.store.get(taskId())).revision).toBe(2);
    expect(await readFile(ready.replace('.ready.md', '.receipt.md'), 'utf8')).toContain('Accepted');
  } finally { await f.dispose(); }
});

function taskId(): string { return waitingTask().id; }

it('ignores autosaves until rename and two stable observations', async () => {
  const f = await fileReviewFixture(waitingTask());
  try {
    await f.adapter.scan(0);
    const draft = await draftFile(f.workspaceRoot);
    await writeFile(draft, (await readFile(draft, 'utf8')).replace('action: \n', 'action: approve\n'));
    await f.adapter.scan(4000);
    expect((await f.store.get(waitingTask().id)).revision).toBe(1);
    const ready = draft.replace(/\.md$/, '.ready.md');
    await rename(draft, ready);
    await f.adapter.scan(5000);
    expect((await f.store.get(waitingTask().id)).revision).toBe(1);
    await f.adapter.scan(7001);
    expect((await f.store.get(waitingTask().id)).reviews[0].decision).toBe('approve');
    expect(await readFile(ready.replace('.ready.md', '.receipt.md'), 'utf8')).toContain('Accepted');
  } finally { await f.dispose(); }
});

describe('file review export', () => {
  it('exports once and preserves edits across scans and restart', async () => {
    const fixture = await fileReviewFixture();
    try {
      await fixture.adapter.scan(0);
      const draft = await draftFile(fixture.workspaceRoot);
      await writeFile(draft, 'user edit');
      await fixture.adapter.scan(1);
      expect(await readFile(draft, 'utf8')).toBe('user edit');
      const restarted = await fixture.restart();
      await restarted.scan(2);
      expect(await readFile(draft, 'utf8')).toBe('user edit');
      await rename(draft, draft.replace(/\.md$/, '.ready.md'));
      await restarted.scan(3);
      await expect(draftFile(fixture.workspaceRoot)).rejects.toThrow('Expected one draft, got 0');
    } finally { await fixture.dispose(); }
  });
});

it('does not recreate an attempted draft whose publication outcome is ambiguous', async () => {
  const fixture = await fileReviewFixture();
  try {
    await fixture.adapter.scan(0);
    const draft = await draftFile(fixture.workspaceRoot);
    const ready = draft.replace(/\.md$/, '.ready.md');
    await rename(draft, ready);
    const { loadRecords, saveRecord } = await import('./io.js');
    const record = (await loadRecords(fixture.localRoot)).records[0];
    await saveRecord(fixture.localRoot, { ...record, publication: 'attempted' });
    const restarted = await fixture.restart();
    await restarted.scan(1);
    await expect(draftFile(fixture.workspaceRoot)).rejects.toThrow();
    expect(await restarted.issues()).toEqual([]);
    await rename(ready, `${ready}.elsewhere`);
    await saveRecord(fixture.localRoot, { ...record, publication: 'attempted' });
    await restarted.scan(2);
    expect((await restarted.issues()).some(i => i.message.includes('ambiguous'))).toBe(true);
    await expect(draftFile(fixture.workspaceRoot)).rejects.toThrow();
  } finally { await fixture.dispose(); }
});

it('suspends exports when a local journal is corrupt', async () => {
  const fixture = await fileReviewFixture();
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await mkdir(join(fixture.localRoot, 'file-reviews', 'requests'), { recursive: true });
    await writeFile(join(fixture.localRoot, 'file-reviews', 'requests', 'bad.json'), '{bad');
    await fixture.adapter.scan(0);
    expect((await fixture.adapter.issues()).some(i => i.message.includes('journal'))).toBe(true);
    await expect(draftFile(fixture.workspaceRoot)).rejects.toThrow();
  } finally { await fixture.dispose(); }
});

it('exports exact versioned artifact material from the store', async () => {
  const { waitingTask } = await import('../testing/fixtures.js');
  const { createHash } = await import('node:crypto');
  const { join } = await import('node:path');
  const bytes = Buffer.from('approved artifact bytes');
  const task = waitingTask();
  task.proposedWorkflow = null;
  task.workflow = (await import('../testing/fixtures.js')).workflowProposal();
  const ref = { id: 'findings', version: 1, digest: createHash('sha256').update(bytes).digest('hex'), path: 'artifacts/findings.1.bin' };
  task.reviews = [{ id: 'artifact-review', kind: 'artifact', workflowVersion: 1, stepId: 'findings', artifacts: [ref],
    prompt: 'Approve findings?', answer: null, decision: null }];
  const fixture = await fileReviewFixture(task);
  try {
    expect(await fixture.store.publishArtifact(task.id, 'findings', bytes)).toEqual(ref);
    await fixture.adapter.scan(0);
    const { loadRecords } = await import('./io.js');
    const record = (await loadRecords(fixture.localRoot)).records[0];
    const material = join(fixture.workspaceRoot, 'reviews', record.materials[0].filename);
    expect(await readFile(material)).toEqual(bytes);
    expect((await readFile(await draftFile(fixture.workspaceRoot), 'utf8'))).toContain(record.materials[0].filename);
    await fixture.store.apply(task.id, task.revision, 'reject-artifact', { kind: 'human', command: {
      requestId: 'reject-artifact', taskId: task.id, expectedRevision: task.revision,
      action: { kind: 'reject', reviewId: 'artifact-review', text: 'Needs work' } } });
    expect((await fixture.store.get(task.id)).status).toBe('rejected');
    expect(await readFile(material)).toEqual(bytes);
  } finally { await fixture.dispose(); }
});

it('ignores unsupported reviews and reports orphaned synced Markdown', async () => {
  const { waitingTask } = await import('../testing/fixtures.js');
  const { join } = await import('node:path');
  const { mkdir } = await import('node:fs/promises');
  for (const kind of ['pause', 'reconciliation'] as const) {
    const task = waitingTask();
    task.reviews[0].kind = kind;
    const fixture = await fileReviewFixture(task);
    try {
      await mkdir(join(fixture.workspaceRoot, 'reviews'));
      await writeFile(join(fixture.workspaceRoot, 'reviews', 'orphan.ready.md'), 'action: approve');
      await fixture.adapter.scan(0);
      expect((await fixture.adapter.issues()).some(i => i.message.includes('Unknown synced review file orphan.ready.md'))).toBe(true);
      await expect(draftFile(fixture.workspaceRoot)).rejects.toThrow();
    } finally { await fixture.dispose(); }
  }
});

it('loads a valid journal containing a 1 MiB snapshot and rejects symlinked journal entries', async () => {
  const { loadRecords, saveRecord } = await import('./io.js');
  const { createHash } = await import('node:crypto');
  const { join } = await import('node:path');
  const { symlink, unlink } = await import('node:fs/promises');
  const fixture = await fileReviewFixture();
  try {
    await fixture.adapter.scan(0);
    const record = (await loadRecords(fixture.localRoot)).records[0];
    const bytes = Buffer.alloc(1024 * 1024, 42);
    await saveRecord(fixture.localRoot, { ...record, phase: 'captured',
      snapshot: { base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') } });
    expect((await loadRecords(fixture.localRoot)).records).toHaveLength(1);
    const journal = join(fixture.localRoot, 'file-reviews', 'requests', `${record.token}.json`);
    const target = join(fixture.root, 'saved-journal.json');
    await rename(journal, target);
    await symlink(target, journal);
    const loaded = await loadRecords(fixture.localRoot);
    expect(loaded.records).toHaveLength(0);
    expect(loaded.issues).toHaveLength(1);
    await unlink(journal);
  } finally { await fixture.dispose(); }
});
