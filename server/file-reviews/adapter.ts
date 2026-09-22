import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command, Issue, Task } from '../../shared/contracts.js';
import type { Store } from '../store/task-store.js';
import { makeRequest, renderDraft } from './document.js';
import { selectReview, type RequestRecord } from './model.js';
import { loadRecords, publishExclusive, readBounded, saveRecord, verifyMaterial } from './io.js';

export type FileReviewAdapter = { scan(nowMs: number): Promise<void>; issues(): Promise<Issue[]> };
export type FileReviewOptions = { workspaceRoot: string; localRoot: string; stableMs: number; store: Store; apply(command: Command): Promise<Task> };
function issue(key: string, category: string, message: string, taskId: string | null = null): Issue {
  return { id: `file-review-${createHash('sha256').update(`${category}:${key}`).digest('hex').slice(0, 16)}`, taskId, message };
}
function same(a: Uint8Array, b: Uint8Array): boolean { return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0; }
export function createFileReviews(options: FileReviewOptions): FileReviewAdapter {
  let queue = Promise.resolve(); let currentIssues: Issue[] = [];
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
  async function scan(): Promise<void> {
    const issues: Issue[] = [];
    const loaded = await loadRecords(options.localRoot);
    issues.push(...loaded.issues);
    const records = loaded.records;
    const known = new Set<string>();
    for (const record of records) {
      known.add(`${record.basename}.md`); known.add(`${record.basename}.ready.md`); known.add(`${record.basename}.receipt.md`);
      try { await reconcile(record, issues); }
      catch (error) { issues.push(issue(record.token, 'publication', `Review export failed: ${(error as Error).message}`, record.binding.taskId)); }
    }
    let filenames: string[] = [];
    try { filenames = await readdir(join(options.workspaceRoot, 'reviews')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.push(issue('reviews', 'directory', `Cannot inspect reviews: ${(error as Error).message}`)); }
    for (const name of filenames) {
      if (name === 'materials') continue;
      if (name.endsWith('.md') && !known.has(name)) issues.push(issue(name, 'unknown', `Unknown synced review file ${name}`));
    }
    if (!loaded.issues.length) {
      const view = await options.store.list();
      for (const task of view.tasks) {
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
  return { scan(_nowMs) { const result = queue.then(scan); queue = result.catch(() => undefined); return result; },
    async issues() { return structuredClone(currentIssues); } };
}
