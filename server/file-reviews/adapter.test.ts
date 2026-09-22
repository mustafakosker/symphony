import { describe, expect, it } from 'vitest';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createFileReviews } from './adapter.js';
import { draftFile, fileReviewFixture } from './testing.js';

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
  } finally { await fixture.dispose(); }
});
