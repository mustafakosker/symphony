import { expect, it } from 'vitest';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createFileReviews } from './adapter.js';
import { draftFile, fileReviewFixture, submitFile } from './testing.js';
import { loadRecords } from './io.js';
import { waitingTask } from '../testing/fixtures.js';

it('does not apply an old file after a UI decision', async () => {
  const task = waitingTask(); const f = await fileReviewFixture(task);
  try {
    await f.adapter.scan(0);
    const ready = await submitFile(await draftFile(f.workspaceRoot), 'action: reject\n\nWrong scope.');
    await f.store.apply(task.id, 1, 'ui-approval', { kind: 'human', command: {
      requestId: 'ui-approval', taskId: task.id, expectedRevision: 1,
      action: { kind: 'approve', reviewId: task.reviews[0].id, artifactDigests: [] },
    } });
    await f.adapter.scan(1); await f.adapter.scan(2002);
    expect((await f.store.get(task.id)).reviews[0].decision).toBe('approve');
    expect(await readFile(ready.replace('.ready.md', '.receipt.md'), 'utf8')).toContain('Outdated');
  } finally { await f.dispose(); }
});

it('keeps the first accepted snapshot when consumed ready bytes change', async () => {
  const f = await fileReviewFixture();
  try {
    await f.adapter.scan(0);
    const ready = await submitFile(await draftFile(f.workspaceRoot), 'action: reject\n\nFirst');
    await f.adapter.scan(1); await f.adapter.scan(2);
    const receipt = await readFile(ready.replace('.ready.md', '.receipt.md'), 'utf8');
    await writeFile(ready, (await readFile(ready, 'utf8')).replace('First', 'Second'));
    await f.adapter.scan(3);
    expect((await f.store.get(waitingTask().id)).reviews[0].answer).toBe('First');
    expect(await readFile(ready.replace('.ready.md', '.receipt.md'), 'utf8')).toBe(receipt);
    expect((await f.adapter.issues()).some(i => i.message.includes('changed'))).toBe(true);
  } finally { await f.dispose(); }
});

it('creates one durable correction and accepts only the new token', async () => {
  const f = await fileReviewFixture();
  try {
    await f.adapter.scan(0);
    const ready = await submitFile(await draftFile(f.workspaceRoot), 'action: reject\n\n');
    const original = await readFile(ready);
    await f.adapter.scan(1); await f.adapter.scan(2);
    await f.adapter.scan(3);
    const restarted = await f.restart(); await restarted.scan(4);
    const records = (await loadRecords(f.localRoot)).records;
    expect(records).toHaveLength(2);
    expect(records.filter(r => r.predecessor === records.find(x => x.predecessor === null)?.token)).toHaveLength(1);
    expect((await f.store.get(waitingTask().id)).revision).toBe(1);
    expect(await readFile(ready)).toEqual(original);
    const correction = await draftFile(f.workspaceRoot);
    expect(correction).not.toBe(ready.replace('.ready.md', '.md'));
    await submitFile(correction, 'action: reject\n\nCorrected reason');
    await restarted.scan(5); await restarted.scan(6);
    expect((await restarted.store.get(waitingTask().id)).reviews[0].answer).toBe('Corrected reason');
  } finally { await f.dispose(); }
});

it('recovers a command committed before the apply callback loses its result', async () => {
  const f = await fileReviewFixture();
  try {
    await f.adapter.scan(0);
    const ready = await submitFile(await draftFile(f.workspaceRoot), 'action: reject\n\nPersisted');
    const { applyHumanCommand } = await import('../coordinator/reviews.js');
    const current = f.store;
    let lost = false;
    const adapter = createFileReviews({ workspaceRoot: f.workspaceRoot, localRoot: f.localRoot, stableMs: 0, store: current,
      apply: async command => {
        const result = await applyHumanCommand(current, { tick: async () => {}, shutdown: async () => {}, stopTask: async () => {} } as never, command);
        if (!lost) { lost = true; throw new Error('lost after commit'); }
        return result;
      } });
    await adapter.scan(1); await adapter.scan(2);
    expect((await f.store.get(waitingTask().id)).revision).toBe(2);
    const restarted = await f.restart(); await restarted.scan(3);
    expect((await restarted.store.get(waitingTask().id)).revision).toBe(2);
    expect((await restarted.store.get(waitingTask().id)).reviews[0].answer).toBe('Persisted');
    expect(await readFile(ready.replace('.ready.md', '.receipt.md'), 'utf8')).toContain('Accepted');
  } finally { await f.dispose(); }
});

it('lets the first file decision win over a later UI command', async () => {
  const task = waitingTask(); const f = await fileReviewFixture(task);
  try {
    await f.adapter.scan(0);
    await submitFile(await draftFile(f.workspaceRoot), 'action: reject\n\nFile wins');
    await f.adapter.scan(1); await f.adapter.scan(2);
    await expect(f.store.apply(task.id, 1, 'late-ui', { kind: 'human', command: {
      requestId: 'late-ui', taskId: task.id, expectedRevision: 1,
      action: { kind: 'approve', reviewId: task.reviews[0].id, artifactDigests: [] },
    } })).rejects.toThrow();
    expect((await f.store.get(task.id)).reviews[0].decision).toBe('reject');
  } finally { await f.dispose(); }
});

it('recovers a captured snapshot even when the ready file changes before restart', async () => {
  const f = await fileReviewFixture();
  try {
    await f.adapter.scan(0);
    const ready = await submitFile(await draftFile(f.workspaceRoot), 'action: reject\n\nCaptured');
    const { saveRecord } = await import('./io.js');
    let fail = true;
    const adapter = createFileReviews({ workspaceRoot: f.workspaceRoot, localRoot: f.localRoot, stableMs: 0, store: f.store,
      apply: async () => { throw new Error('must not dispatch'); },
      io: { saveRecord: async (root, record) => {
        if (record.phase === 'applying' && fail) { fail = false; throw new Error('before command persistence'); }
        await saveRecord(root, record);
      } } });
    await adapter.scan(1); await adapter.scan(2);
    expect((await f.store.get(waitingTask().id)).revision).toBe(1);
    expect((await loadRecords(f.localRoot)).records[0].phase).toBe('captured');
    await writeFile(ready, (await readFile(ready, 'utf8')).replace('Captured', 'Later'));
    const restarted = await f.restart(); await restarted.scan(3);
    expect((await restarted.store.get(waitingTask().id)).reviews[0].answer).toBe('Captured');
  } finally { await f.dispose(); }
});

it('retries receipt publication without applying the settled command again', async () => {
  const f = await fileReviewFixture();
  try {
    await f.adapter.scan(0);
    const ready = await submitFile(await draftFile(f.workspaceRoot), 'action: reject\n\nAccepted once');
    const { publishExclusive } = await import('./io.js');
    let fail = true;
    const adapter = createFileReviews({ workspaceRoot: f.workspaceRoot, localRoot: f.localRoot, stableMs: 0, store: f.store,
      apply: async command => {
        const { applyHumanCommand } = await import('../coordinator/reviews.js');
        return applyHumanCommand(f.store, { tick: async () => {}, shutdown: async () => {}, stopTask: async () => {} } as never, command);
      },
      io: { publishExclusive: async (root, path, bytes) => {
        if (path.endsWith('.receipt.md') && fail) { fail = false; throw new Error('receipt unavailable'); }
        await publishExclusive(root, path, bytes);
      } } });
    await adapter.scan(1); await adapter.scan(2);
    expect((await f.store.get(waitingTask().id)).revision).toBe(2);
    expect((await loadRecords(f.localRoot)).records[0].receiptPublished).toBe(false);
    const restarted = await f.restart(); await restarted.scan(3);
    expect((await restarted.store.get(waitingTask().id)).revision).toBe(2);
    expect((await restarted.store.get(waitingTask().id)).reviews[0].answer).toBe('Accepted once');
    expect(await readFile(ready.replace('.ready.md', '.receipt.md'), 'utf8')).toContain('Accepted');
  } finally { await f.dispose(); }
});

it('does not carry edited immutable question text into a correction answer', async () => {
  const task = waitingTask(); task.proposedWorkflow = null;
  task.reviews = [{ id: 'question-review', kind: 'question', workflowVersion: null, stepId: '$triage', artifacts: [],
    prompt: 'Which version?', answer: null, decision: null }];
  const f = await fileReviewFixture(task);
  try {
    await f.adapter.scan(0);
    const draft = await draftFile(f.workspaceRoot);
    await writeFile(draft, (await readFile(draft, 'utf8')).replace('Which version?', 'Changed question?'));
    await rename(draft, draft.replace(/\.md$/, '.ready.md'));
    await f.adapter.scan(1); await f.adapter.scan(2);
    const correction = await draftFile(f.workspaceRoot);
    const text = await readFile(correction, 'utf8');
    expect(text).toContain('Which version?');
    expect(text).not.toContain('Changed question?');
    expect((await f.store.get(task.id)).revision).toBe(1);
  } finally { await f.dispose(); }
});

it('preserves a conflicting receipt and keeps publication pending', async () => {
  const f = await fileReviewFixture();
  try {
    await f.adapter.scan(0);
    const ready = await submitFile(await draftFile(f.workspaceRoot), 'action: reject\n\nOne');
    const receipt = ready.replace('.ready.md', '.receipt.md');
    await writeFile(receipt, 'different receipt');
    await f.adapter.scan(1); await f.adapter.scan(2);
    expect(await readFile(receipt, 'utf8')).toBe('different receipt');
    expect((await loadRecords(f.localRoot)).records[0].receiptPublished).toBe(false);
    expect((await f.adapter.issues()).some(i => i.message.includes('retry'))).toBe(true);
    expect((await f.store.get(waitingTask().id)).revision).toBe(2);
  } finally { await f.dispose(); }
});

for (const phase of ['captured', 'applying', 'settled'] as const) {
  for (const timing of ['before', 'after'] as const) {
    it(`recovers ${timing} ${phase} journal persistence`, async () => {
      const f = await fileReviewFixture();
      try {
        await f.adapter.scan(0);
        const ready = await submitFile(await draftFile(f.workspaceRoot), 'action: reject\n\nStable snapshot');
        const original = await readFile(ready);
        const { saveRecord } = await import('./io.js');
        const { applyHumanCommand } = await import('../coordinator/reviews.js');
        let injected = false; let applyCalls = 0;
        const coordinator = { tick: async () => {}, shutdown: async () => {}, stopTask: async () => {} } as never;
        const adapter = createFileReviews({ workspaceRoot: f.workspaceRoot, localRoot: f.localRoot, stableMs: 0, store: f.store,
          apply: command => { applyCalls++; return applyHumanCommand(f.store, coordinator, command); },
          io: { saveRecord: async (root, record) => {
            if (record.phase === phase && !injected) {
              injected = true;
              if (timing === 'after') await saveRecord(root, record);
              throw new Error(`injected ${timing} ${phase}`);
            }
            await saveRecord(root, record);
          } } });
        await adapter.scan(1); await adapter.scan(2);
        expect(injected).toBe(true);
        const durable = (await loadRecords(f.localRoot)).records[0];
        const expectedPhase = timing === 'after' ? phase : phase === 'captured' ? 'issued' : phase === 'applying' ? 'captured' : 'applying';
        expect(durable.phase).toBe(expectedPhase);
        expect((await f.store.get(waitingTask().id)).revision).toBe(phase === 'settled' ? 2 : 1);
        expect(applyCalls).toBe(phase === 'settled' ? 1 : 0);
        if (durable.snapshot) expect(Buffer.from(durable.snapshot.base64, 'base64')).toEqual(original);
        if (durable.command) {
          expect(durable.command.requestId).toBe(durable.token);
          expect(durable.command.expectedRevision).toBe(1);
        }
        await writeFile(ready, (await readFile(ready, 'utf8')).replace('Stable snapshot', 'Later bytes'));
        const restarted = await f.restart();
        let replayCalls = 0;
        const recovering = createFileReviews({ workspaceRoot: f.workspaceRoot, localRoot: f.localRoot, stableMs: 0,
          store: restarted.store, apply: command => {
            replayCalls++; return applyHumanCommand(restarted.store, coordinator, command);
          } });
        await recovering.scan(3); await recovering.scan(4);
        const finalRecord = (await loadRecords(f.localRoot)).records[0];
        expect(finalRecord.phase).toBe('settled');
        expect(finalRecord.command?.requestId).toBe(durable.token);
        if (durable.snapshot) expect(finalRecord.snapshot).toEqual(durable.snapshot);
        if (durable.command) expect(finalRecord.command).toEqual(durable.command);
        expect(replayCalls).toBe(phase === 'settled' && timing === 'after' ? 0 : 1);
        expect((await restarted.store.get(waitingTask().id)).revision).toBe(2);
        expect((await restarted.store.get(waitingTask().id)).reviews[0].answer)
          .toBe(durable.snapshot ? 'Stable snapshot' : 'Later bytes');
        expect(await readFile(ready.replace('.ready.md', '.receipt.md'), 'utf8')).toContain('Accepted');
      } finally { await f.dispose(); }
    });
  }
}

it('recovers a receipt created before its publication flag was persisted', async () => {
  const f = await fileReviewFixture();
  try {
    await f.adapter.scan(0);
    const ready = await submitFile(await draftFile(f.workspaceRoot), 'action: reject\n\nOnce');
    const { saveRecord } = await import('./io.js');
    const { applyHumanCommand } = await import('../coordinator/reviews.js');
    let injected = false;
    const adapter = createFileReviews({ workspaceRoot: f.workspaceRoot, localRoot: f.localRoot, stableMs: 0, store: f.store,
      apply: command => applyHumanCommand(f.store,
        { tick: async () => {}, shutdown: async () => {}, stopTask: async () => {} } as never, command),
      io: { saveRecord: async (root, record) => {
        if (record.receiptPublished && !injected) { injected = true; throw new Error('flag unavailable'); }
        await saveRecord(root, record);
      } } });
    await adapter.scan(1); await adapter.scan(2);
    expect(injected).toBe(true);
    expect((await loadRecords(f.localRoot)).records[0].receiptPublished).toBe(false);
    const original = await readFile(ready.replace('.ready.md', '.receipt.md'));
    const restarted = await f.restart(); await restarted.scan(3);
    expect(await readFile(ready.replace('.ready.md', '.receipt.md'))).toEqual(original);
    expect((await loadRecords(f.localRoot)).records[0].receiptPublished).toBe(true);
    expect((await restarted.store.get(waitingTask().id)).revision).toBe(2);
    expect((await restarted.store.get(waitingTask().id)).reviews[0].answer).toBe('Once');
  } finally { await f.dispose(); }
});

it('does not process delayed old-token copies after correction', async () => {
  const f = await fileReviewFixture();
  try {
    await f.adapter.scan(0);
    const oldReady = await submitFile(await draftFile(f.workspaceRoot), 'action: reject\n\n');
    await f.adapter.scan(1); await f.adapter.scan(2);
    const correction = await draftFile(f.workspaceRoot);
    await submitFile(correction, 'action: reject\n\nNew reason');
    await f.adapter.scan(3); await f.adapter.scan(4);
    await writeFile(oldReady, (await readFile(oldReady, 'utf8')).replace('action: reject', 'action: approve'));
    await f.adapter.scan(5);
    expect((await f.store.get(waitingTask().id)).revision).toBe(2);
    expect((await f.store.get(waitingTask().id)).reviews[0].answer).toBe('New reason');
    expect((await f.adapter.issues()).some(i => i.message.includes('changed'))).toBe(true);
  } finally { await f.dispose(); }
});

it('reports duplicate ready copies without applying them', async () => {
  const f = await fileReviewFixture();
  try {
    await f.adapter.scan(0);
    const draft = await draftFile(f.workspaceRoot);
    const bytes = await readFile(draft);
    await writeFile(draft.replace('.md', ' (conflict).ready.md'), bytes);
    await f.adapter.scan(1); await f.adapter.scan(2);
    expect((await f.store.get(waitingTask().id)).revision).toBe(1);
    expect((await f.adapter.issues()).some(i => i.message.includes('Unknown synced review file'))).toBe(true);
  } finally { await f.dispose(); }
});

it('recovers an applying request before exporting a later actionable review', async () => {
  const task = waitingTask(); task.proposedWorkflow = null;
  task.reviews = [
    { id: 'first-question', kind: 'question', workflowVersion: null, stepId: '$triage', artifacts: [], prompt: 'First?', answer: null, decision: null },
    { id: 'second-question', kind: 'question', workflowVersion: null, stepId: '$triage', artifacts: [], prompt: 'Second?', answer: null, decision: null },
  ];
  const f = await fileReviewFixture(task);
  try {
    await f.adapter.scan(0);
    await submitFile(await draftFile(f.workspaceRoot), 'action: answer\n\nFirst answer');
    const { applyHumanCommand } = await import('../coordinator/reviews.js');
    let loseResult = true;
    const adapter = createFileReviews({ workspaceRoot: f.workspaceRoot, localRoot: f.localRoot, stableMs: 0, store: f.store,
      apply: async command => {
        const result = await applyHumanCommand(f.store,
          { tick: async () => {}, shutdown: async () => {}, stopTask: async () => {} } as never, command);
        if (loseResult) { loseResult = false; throw new Error('lost after commit'); }
        return result;
      } });
    await adapter.scan(1); await adapter.scan(2);
    expect((await loadRecords(f.localRoot)).records).toHaveLength(1);
    expect((await loadRecords(f.localRoot)).records[0].phase).toBe('applying');
    await expect(draftFile(f.workspaceRoot)).rejects.toThrow('Expected one draft, got 0');
    const restarted = await f.restart(); await restarted.scan(3);
    expect((await restarted.store.get(task.id)).revision).toBe(2);
    expect((await restarted.store.get(task.id)).reviews[0].answer).toBe('First answer');
    expect((await loadRecords(f.localRoot)).records).toHaveLength(2);
    expect(await readFile(await draftFile(f.workspaceRoot), 'utf8')).toContain('Second?');
  } finally { await f.dispose(); }
});
