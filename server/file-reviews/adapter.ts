import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BoundaryError } from '../../shared/validate.js';
import type { Command, Issue, Task } from '../../shared/contracts.js';
import type { Store } from '../store/task-store.js';
import { makeRequest, parseResponse, renderDraft, renderReceipt } from './document.js';
import { matchesBinding, selectReview, type RequestRecord } from './model.js';
import * as fileIo from './io.js';

export type FileReviewIo = {
  loadRecords: typeof fileIo.loadRecords;
  publishExclusive: typeof fileIo.publishExclusive;
  readBounded: typeof fileIo.readBounded;
  saveRecord: typeof fileIo.saveRecord;
  verifyMaterial: typeof fileIo.verifyMaterial;
};

export type FileReviewAdapter = { scan(nowMs: number): Promise<void>; issues(): Promise<Issue[]> };
export type FileReviewOptions = { workspaceRoot: string; localRoot: string; stableMs: number; store: Store; apply(command: Command): Promise<Task>; io?: Partial<FileReviewIo> };
function issue(key: string, category: string, message: string, taskId: string | null = null): Issue {
  return { id: `file-review-${createHash('sha256').update(`${category}:${key}`).digest('hex').slice(0, 16)}`, taskId, message };
}
function same(a: Uint8Array, b: Uint8Array): boolean { return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0; }
export function createFileReviews(options: FileReviewOptions): FileReviewAdapter {
  let queue = Promise.resolve(); let currentIssues: Issue[] = [];
  const { loadRecords, publishExclusive, readBounded, saveRecord, verifyMaterial } = {
    loadRecords: options.io?.loadRecords ?? fileIo.loadRecords,
    publishExclusive: options.io?.publishExclusive ?? fileIo.publishExclusive,
    readBounded: options.io?.readBounded ?? fileIo.readBounded,
    saveRecord: options.io?.saveRecord ?? fileIo.saveRecord,
    verifyMaterial: options.io?.verifyMaterial ?? fileIo.verifyMaterial,
  };
  const observations = new Map<string, { sha256: string; firstSeenMs: number }>();
  async function settle(record: RequestRecord, status: 'Accepted' | 'Outdated' | 'Needs correction', message: string,
    acceptedRevision: number | null = null): Promise<RequestRecord> {
    const next: RequestRecord = { ...record, phase: 'settled', outcome: { status, message, acceptedRevision } };
    await saveRecord(options.localRoot, next);
    return next;
  }
  async function submission(record: RequestRecord, nowMs: number): Promise<void> {
    const ready = `reviews/${record.basename}.ready.md`;
    if (record.phase === 'issued') {
      let bytes: Buffer | null;
      try { bytes = await readBounded(options.workspaceRoot, ready); }
      catch (error) { observations.delete(record.token); throw error; }
      if (!bytes) { observations.delete(record.token); return; }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const prior = observations.get(record.token);
      if (!prior || prior.sha256 !== sha256 || nowMs < prior.firstSeenMs) {
        observations.set(record.token, { sha256, firstSeenMs: nowMs }); return;
      }
      if (nowMs - prior.firstSeenMs < options.stableMs) return;
      observations.delete(record.token);
      record = { ...record, phase: 'captured', snapshot: { base64: bytes.toString('base64'), sha256 } };
      await saveRecord(options.localRoot, record);
    }
    if (record.phase === 'captured') {
      let command: Command;
      try { command = parseResponse(record, Buffer.from(record.snapshot!.base64, 'base64')); }
      catch (error) { record = await settle(record, 'Needs correction', (error as Error).message); command = undefined as never; }
      if (record.phase === 'captured') {
        let task: Task;
        try { task = await options.store.get(record.binding.taskId); }
        catch (error) {
          if (!(error instanceof BoundaryError) || error.code !== 'missing') throw error;
          record = await settle(record, 'Outdated', 'The task no longer exists'); task = undefined as never;
        }
        if (record.phase === 'captured' && !matchesBinding(task!, record.binding))
          record = await settle(record, 'Outdated', 'The reviewed task or work has changed');
        if (record.phase === 'captured' && command!.action.kind === 'approve') {
          for (const material of record.materials) {
            if (!await verifyMaterial(options.workspaceRoot, `reviews/${material.filename}`, material.ref.digest)) {
              record = await settle(record, 'Needs correction', 'Reviewed artifact material is missing or changed'); break;
            }
          }
        }
        if (record.phase === 'captured') {
          record = { ...record, phase: 'applying', command: command! };
          await saveRecord(options.localRoot, record);
        }
      }
    }
    if (record.phase === 'applying') {
      try {
        const accepted = await options.apply(record.command!);
        record = await settle(record, 'Accepted', 'Review response accepted', accepted.revision);
      } catch (error) {
        if (error instanceof BoundaryError && error.code === 'conflict')
          record = await settle(record, 'Outdated', error.message);
        else if (error instanceof BoundaryError && error.code === 'invalid') {
          // Invalid is safe to settle only when a current revision proves no command was committed.
          const current = await options.store.get(record.binding.taskId);
          if (current.revision === record.binding.taskRevision)
            record = await settle(record, 'Needs correction', error.message);
          else throw error;
        } else throw error;
      }
    }
    if (record.phase === 'settled' && !record.receiptPublished) {
      const receipt = `reviews/${record.basename}.receipt.md`;
      try { await publishExclusive(options.workspaceRoot, receipt, Buffer.from(renderReceipt(record))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await readBounded(options.workspaceRoot, receipt);
        if (!existing || !same(existing, Buffer.from(renderReceipt(record)))) throw error;
      }
      await saveRecord(options.localRoot, { ...record, receiptPublished: true });
    }
  }
  async function reconcile(record: RequestRecord, issues: Issue[]): Promise<void> {
    const draft = `reviews/${record.basename}.md`;
    const ready = `reviews/${record.basename}.ready.md`;
    if (record.publication === 'published') return;
    if (record.publication === 'attempted') {
      const draftBytes = await readBounded(options.workspaceRoot, draft);
      const readyBytes = await readBounded(options.workspaceRoot, ready);
      if (draftBytes) {
        if (!same(draftBytes, Buffer.from(renderDraft(record)))) {
          issues.push(issue(record.token, 'changed-draft', 'Issued review draft differs from its generated contents; preserved user edits', record.binding.taskId));
          return;
        }
      } else if (!readyBytes) {
        issues.push(issue(record.token, 'ambiguous-publication', 'Review publication outcome is ambiguous; inspect synced files before retrying', record.binding.taskId));
        return;
      }
      await saveRecord(options.localRoot, { ...record, publication: 'published' });
      return;
    }
    await saveRecord(options.localRoot, { ...record, publication: 'attempted' });
    try { await publishExclusive(options.workspaceRoot, draft, Buffer.from(renderDraft(record))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readBounded(options.workspaceRoot, draft);
      if (!existing || !same(existing, Buffer.from(renderDraft(record)))) throw error;
    }
    await saveRecord(options.localRoot, { ...record, publication: 'published' });
  }
  async function scan(nowMs: number): Promise<void> {
    const issues: Issue[] = [];
    const loaded = await loadRecords(options.localRoot);
    issues.push(...loaded.issues);
    const records = loaded.records;
    const known = new Set<string>();
    const successors = new Map<string, RequestRecord[]>();
    for (const record of records) if (record.predecessor) successors.set(record.predecessor, [...(successors.get(record.predecessor) ?? []), record]);
    for (const [predecessor, entries] of successors) if (entries.length > 1) issues.push(issue(predecessor, 'duplicate-successor', 'Multiple correction records refer to one retired request'));
    for (const record of records) {
      known.add(`${record.basename}.md`); known.add(`${record.basename}.ready.md`); known.add(`${record.basename}.receipt.md`);
      try { await reconcile(record, issues); }
      catch (error) { issues.push(issue(record.token, 'publication', `Review export failed: ${(error as Error).message}`, record.binding.taskId)); }
      try { await submission(record, nowMs); }
      catch (error) { issues.push(issue(record.token, 'submission', `Review submission will retry: ${(error as Error).message}`, record.binding.taskId)); }
      const current = (await loadRecords(options.localRoot)).records.find(item => item.token === record.token);
      if (!current) continue;
      if (current.phase === 'settled' && current.snapshot) {
        try {
          const readyBytes = await readBounded(options.workspaceRoot, `reviews/${current.basename}.ready.md`);
          if (readyBytes && createHash('sha256').update(readyBytes).digest('hex') !== current.snapshot.sha256)
            issues.push(issue(current.token, 'changed-ready', 'Consumed review file changed after capture; original snapshot and receipt preserved', current.binding.taskId));
        } catch (error) { issues.push(issue(current.token, 'ready-inspection', `Cannot inspect consumed review file: ${(error as Error).message}`, current.binding.taskId)); }
      }
      if (current.phase === 'settled' && current.outcome?.status === 'Needs correction' && !successors.has(current.token) && !loaded.issues.length) {
        try {
          const task = await options.store.get(current.binding.taskId);
          const review = selectReview(task);
          if (!review || review.id !== current.binding.review.id || task.revision !== current.binding.taskRevision) continue;
          const bytes = Buffer.from(current.snapshot!.base64, 'base64');
          let response: string | undefined;
          try {
            const submitted = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n');
            if (submitted.startsWith(current.prefix)) response = submitted.slice(current.prefix.length);
          } catch { /* Unsafe response text is not carried into a correction. */ }
          const successor = makeRequest(task, review, randomUUID(), current.token, response);
          await saveRecord(options.localRoot, successor);
          successors.set(current.token, [successor]); records.push(successor);
          await reconcile(successor, issues);
        } catch (error) { issues.push(issue(current.token, 'correction', `Cannot issue correction: ${(error as Error).message}`, current.binding.taskId)); }
      }
    }
    let filenames: string[] = [];
    try { filenames = await readdir(join(options.workspaceRoot, 'reviews')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.push(issue('reviews', 'directory', `Cannot inspect reviews: ${(error as Error).message}`)); }
    for (const name of filenames) {
      if (name === 'materials') continue;
      if (name.endsWith('.md') && !known.has(name)) issues.push(issue(name, 'unknown', `Unknown synced review file ${name}`));
    }
    if (!loaded.issues.length) {
      const latestRecords = (await loadRecords(options.localRoot)).records;
      const unresolvedTasks = new Set(latestRecords.filter(record => record.phase === 'captured' || record.phase === 'applying')
        .map(record => record.binding.taskId));
      const view = await options.store.list();
      for (const task of view.tasks) {
        if (unresolvedTasks.has(task.id)) continue;
        const review = selectReview(task);
        if (!review) continue;
        if (records.some(record => record.binding.taskId === task.id && record.binding.review.id === review.id &&
            record.binding.taskRevision === task.revision)) continue;
        if (records.some(record => record.binding.taskId === task.id && record.binding.review.id === review.id && record.phase !== 'settled')) continue;
        try {
          const record = makeRequest(task, review, randomUUID());
          for (const material of record.materials) {
            const bytes = await options.store.readArtifact(task.id, material.ref);
            if (createHash('sha256').update(bytes).digest('hex') !== material.ref.digest) throw new Error('Artifact digest mismatch');
            try { await publishExclusive(options.workspaceRoot, `reviews/${material.filename}`, bytes); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
              if (!await verifyMaterial(options.workspaceRoot, `reviews/${material.filename}`, material.ref.digest))
                throw new Error('Existing material differs from approved artifact');
            }
          }
          await saveRecord(options.localRoot, record);
          await reconcile(record, issues);
          records.push(record);
        } catch (error) { issues.push(issue(task.id, 'export', `Cannot export review: ${(error as Error).message}`, task.id)); }
      }
    }
    currentIssues = issues;
  }
  return { scan(nowMs) { const result = queue.then(() => scan(nowMs)); queue = result.catch(() => undefined); return result; },
    async issues() { return structuredClone(currentIssues); } };
}
