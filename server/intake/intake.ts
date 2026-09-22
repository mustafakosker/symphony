import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename } from 'node:path';
import type { Issue, Task } from '../../shared/contracts.js';
import { BoundaryError } from '../../shared/validate.js';
import { writeAtomic } from '../store/atomic.js';
import { confinedPath } from '../store/paths.js';
import { isPhoneReady, preparePhoneDraft } from './phone-drafts.js';
import type { Store } from '../store/task-store.js';

const MAX_BYTES = 1024 * 1024;
type Observation = { digest: string; size: number; at: number };
type Receipt = {
  filename: string; key: string; digest: string; bytes: string; taskId: string;
  operationId: string; phase: 'claimed' | 'materialized'; task: Task; holdingName?: string; receivedName?: string;
};
type Submission = { requestId: string; digest: string; submissionId: string; filename: string; bytes: string };
export type Intake = {
  scan(nowMs: number): Promise<void>;
  submit(markdown: string, requestId: string): Promise<{ submissionId: string }>;
  issues(): Promise<Issue[]>;
};
function hash(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
function lookupKey(filename: string): string {
  const normalized = filename.normalize('NFC');
  return process.platform === 'darwin' || process.platform === 'win32' ? normalized.toLocaleLowerCase('und') : normalized;
}
function issueId(name: string, reason: string): string { return `intake-${hash(`${name}:${reason}`).slice(0, 20)}`; }
function safeFilename(name: string): boolean { return isPhoneReady(name) || (name.endsWith('.md') && !name.startsWith('.') && !name.includes('/') && !name.includes('\\') && basename(name) === name); }
function decode(bytes: Buffer): string { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
function makeTask(id: string, filename: string, idea: string, nowMs: number): Task {
  const at = new Date(nowMs).toISOString();
  return {
    schemaVersion: 1, id, revision: 1, title: filename.slice(0, -3), idea,
    type: 'unknown', projectId: null, source: `drafts/${filename}`, status: 'triaging',
    workflow: null, proposedWorkflow: null, currentStepId: '$triage',
    completedStepIds: [], staleStepIds: [], generation: 0, intent: null,
    reviews: [], runs: [], artifacts: [], approvalBindings: [], blockedReason: null,
    queuedAt: at, createdAt: at, updatedAt: at,
  };
}

type IntakeIo = { rename?: typeof rename; open?: typeof open };
export function createIntake(root: string, store: Store, stableMs: number, io: IntakeIo = {},
  options: { phoneDraftsEnabled?: boolean } = {}): Intake {
  if (!Number.isFinite(stableMs) || stableMs < 0) throw new BoundaryError('invalid', 'Invalid stability interval');
  const observations = new Map<string, Observation>();
  const foundIssues = new Map<string, Issue>();
  let pending: Promise<void> = Promise.resolve();
  const addIssue = (name: string, reason: string, taskId: string | null = null) => {
    const id = issueId(name, reason);
    foundIssues.set(id, { id, taskId, message: `${name}: ${reason}` });
  };
  const path = (relative: string) => confinedPath(root, relative);
  async function ensureDirs(): Promise<void> {
    for (const dir of ['drafts', '.intake', '.intake/receipts', '.intake/conflicts', '.intake/holding', '.intake/received', '.intake/submissions']) {
      const target = await path(dir);
      await mkdir(target, { recursive: true });
      const stat = await lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BoundaryError('invalid', `Invalid intake directory ${dir}`);
    }
  }
  async function readRegular(relative: string, label: string): Promise<Buffer | null> {
    if (typeof constants.O_NOFOLLOW !== 'number') throw new BoundaryError('unavailable', 'No-follow file open is unavailable');
    let source: string;
    try { source = await path(relative); }
    catch (error) {
      if (error instanceof BoundaryError && error.code === 'invalid') { addIssue(label, 'symbolic link source is not allowed'); return null; }
      throw error;
    }
    let handle;
    try { handle = await (io.open ?? open)(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      if (code === 'ELOOP' || code === 'EMLINK') { addIssue(label, 'symbolic link source is not allowed'); return null; }
      if (code === 'EINVAL' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') throw new BoundaryError('unavailable', 'No-follow file open is unavailable', { cause: error });
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return null;
      if (stat.size > MAX_BYTES) { addIssue(label, 'draft exceeds 1 MiB'); return null; }
      const bounded = Buffer.allocUnsafe(MAX_BYTES + 1);
      let length = 0;
      while (length < bounded.length) {
        const read = await handle.read(bounded, length, bounded.length - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length > MAX_BYTES) { addIssue(label, 'draft exceeds 1 MiB'); return null; }
      return bounded.subarray(0, length);
    } finally { await handle.close(); }
  }
  const currentBytes = (filename: string) => readRegular(`drafts/${filename}`, filename);
  async function readReceipt(key: string): Promise<Receipt | null> {
    const target = await path(`.intake/receipts/${hash(key)}.json`);
    try {
      const receipt = JSON.parse(await readFile(target, 'utf8')) as Receipt;
      if (receipt.key !== key || !safeFilename(receipt.filename) || lookupKey(receipt.filename) !== key ||
          hash(Buffer.from(receipt.bytes, 'base64')) !== receipt.digest || receipt.task.id !== receipt.taskId ||
          receipt.task.idea !== decode(Buffer.from(receipt.bytes, 'base64')) ||
          (receipt.holdingName !== undefined && !new RegExp(`^${hash(key)}-[0-9a-f-]{36}\\.md$`).test(receipt.holdingName)) ||
          (receipt.receivedName !== undefined && !new RegExp(`^${hash(key)}-[0-9a-f-]{36}\\.md$`).test(receipt.receivedName)) ||
          !['claimed', 'materialized'].includes(receipt.phase)) throw new Error('receipt binding failed');
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      addIssue(key, 'invalid pickup receipt');
      throw new BoundaryError('conflict', 'Invalid pickup receipt', { cause: error });
    }
  }
  async function preserveConflict(receipt: Receipt, filename: string, bytes: Buffer): Promise<void> {
    const digest = hash(bytes);
    const name = `${hash(receipt.key).slice(0, 16)}-${digest}.md`;
    const target = await path(`.intake/conflicts/${name}`);
    try {
      const prior = await readFile(target);
      if (!prior.equals(bytes)) throw new BoundaryError('conflict', 'Conflict archive differs from source');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeAtomic(target, bytes);
    }
    await writeAtomic(await path(`.intake/conflicts/${name}.json`), JSON.stringify({
      filename, taskId: receipt.taskId, digest, archive: name,
    }));
    addIssue(filename, 'source changed after claim; preserved intake conflict', receipt.taskId);
  }
  async function saveReceipt(receipt: Receipt): Promise<void> {
    await writeAtomic(await path(`.intake/receipts/${hash(receipt.key)}.json`), JSON.stringify(receipt));
  }
  async function inspectHolding(receipt: Receipt): Promise<void> {
    if (!receipt.holdingName) return;
    const heldPath = await path(`.intake/holding/${receipt.holdingName}`);
    let held;
    try { held = await lstat(heldPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!held) {
      if (receipt.receivedName) {
        try { await lstat(await path(`.intake/received/${receipt.receivedName}`)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; delete receipt.receivedName; }
      }
      delete receipt.holdingName;
      await saveReceipt(receipt);
      return;
    }
    if (!held.isFile() || held.isSymbolicLink()) {
      addIssue(receipt.filename, 'claimed source conflict: invalid held file', receipt.taskId);
      return;
    }
    receipt.receivedName = receipt.holdingName;
    await saveReceipt(receipt);
    await (io.rename ?? rename)(heldPath, await path(`.intake/received/${receipt.receivedName}`));
    delete receipt.holdingName;
    await saveReceipt(receipt);
  }
  async function inspectReceived(receipt: Receipt): Promise<void> {
    if (!receipt.receivedName) return;
    const receivedPath = await path(`.intake/received/${receipt.receivedName}`);
    let stat;
    try { stat = await lstat(receivedPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        addIssue(receipt.filename, 'claimed source conflict: received archive is missing', receipt.taskId);
        return;
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      addIssue(receipt.filename, 'claimed source conflict: received archive is invalid', receipt.taskId);
      return;
    }
    if (stat.size > MAX_BYTES) {
      addIssue(receipt.filename, 'claimed source conflict: received file exceeds 1 MiB', receipt.taskId);
      return;
    }
    const bytes = await readRegular(`.intake/received/${receipt.receivedName}`, receipt.filename);
    if (!bytes) {
      addIssue(receipt.filename, 'claimed source conflict: received file cannot be inspected', receipt.taskId);
      return;
    }
    if (hash(bytes) !== receipt.digest) await preserveConflict(receipt, receipt.filename, bytes);
  }
  async function finishReceipt(receipt: Receipt): Promise<void> {
    try {
      await store.create(receipt.task, receipt.operationId);
    } catch (error) {
      addIssue(receipt.filename, `pickup pending: ${error instanceof Error ? error.message : String(error)}`, receipt.taskId);
      return;
    }
    if (receipt.phase !== 'materialized') {
      receipt.phase = 'materialized';
      await saveReceipt(receipt);
    }
    if (receipt.holdingName) await inspectHolding(receipt);
    if (receipt.receivedName) { await inspectReceived(receipt); return; }
    const bytes = await currentBytes(receipt.filename);
    if (bytes === null) return;
    if (hash(bytes) !== receipt.digest) { await preserveConflict(receipt, receipt.filename, bytes); return; }
    receipt.holdingName = `${hash(receipt.key)}-${randomUUID()}.md`;
    await saveReceipt(receipt);
    try { await (io.rename ?? rename)(await path(`drafts/${receipt.filename}`), await path(`.intake/holding/${receipt.holdingName}`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    await inspectHolding(receipt);
    await inspectReceived(receipt);
  }
  async function scanOne(filename: string, nowMs: number): Promise<void> {
    if (!safeFilename(filename)) return;
    const key = lookupKey(filename);
    const receipt = await readReceipt(key);
    if (receipt) {
      const bytes = await currentBytes(filename);
      if (bytes && hash(bytes) !== receipt.digest) await preserveConflict(receipt, filename, bytes);
      await finishReceipt(receipt);
      return;
    }
    const bytes = await currentBytes(filename);
    if (!bytes) { if (isPhoneReady(filename)) observations.delete(key); return; }
    const digest = hash(bytes);
    const prior = observations.get(key);
    if (!prior || prior.digest !== digest || prior.size !== bytes.length || nowMs - prior.at < stableMs) {
      if (!prior || prior.digest !== digest || prior.size !== bytes.length) observations.set(key, { digest, size: bytes.length, at: nowMs });
      return;
    }
    let idea: string;
    try { idea = decode(bytes); }
    catch { addIssue(filename, 'invalid UTF-8 draft'); return; }
    if (!idea.trim()) { addIssue(filename, 'blank draft'); return; }
    const again = await currentBytes(filename);
    if (!again || !again.equals(bytes)) { observations.delete(key); return; }
    const taskId = randomUUID();
    const receiptNew: Receipt = { filename, key, digest, bytes: bytes.toString('base64'), taskId,
      operationId: `intake:${taskId}`, phase: 'claimed', task: makeTask(taskId, filename, idea, nowMs) };
    await writeAtomic(await path(`.intake/receipts/${hash(key)}.json`), JSON.stringify(receiptNew));
    observations.delete(key);
    await finishReceipt(receiptNew);
  }
  async function scanInternal(nowMs: number): Promise<void> {
    await ensureDirs();
    for (const [id, issue] of foundIssues) {
      if (issue.message.startsWith('phone drafts:') ||
          /^phone\/New idea-\d+\.ready\.md: (blank draft|invalid UTF-8 draft|draft exceeds 1 MiB|pickup pending:)/.test(issue.message)) {
        foundIssues.delete(id);
      }
    }
    let hasPhoneHistory = false;
    for (const entry of await readdir(await path('.intake/conflicts'), { withFileTypes: true })) {
      if (!entry.name.endsWith('.md')) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) { addIssue(entry.name, 'invalid intake conflict archive'); continue; }
      try {
        const metadata = JSON.parse(await readFile(await path(`.intake/conflicts/${entry.name}.json`), 'utf8')) as {
          filename: string; taskId: string; digest: string; archive: string;
        };
        const archived = await readRegular(`.intake/conflicts/${entry.name}`, entry.name);
        if (!archived || metadata.archive !== entry.name || metadata.digest !== hash(archived) || !safeFilename(metadata.filename)) {
          throw new Error('conflict metadata does not match archive');
        }
        addIssue(metadata.filename, 'source changed after claim; preserved intake conflict', metadata.taskId);
      } catch { addIssue(entry.name, 'preserved intake conflict missing valid metadata'); }
    }
    for (const entry of await readdir(await path('.intake/submissions'), { withFileTypes: true })) {
      if (!entry.name.endsWith('.json') || !entry.isFile() || entry.isSymbolicLink()) continue;
      try {
        const record = JSON.parse(await readFile(await path(`.intake/submissions/${entry.name}`), 'utf8')) as Submission;
        if (entry.name !== `${hash(record.requestId)}.json` || record.filename !== `${record.submissionId}.md` ||
            hash(Buffer.from(record.bytes, 'base64')) !== record.digest) throw new Error('submission binding failed');
        await ensurePublished(record);
      } catch { addIssue(entry.name, 'invalid submission receipt or publication'); }
    }
    // Receipts are replayed even when the source disappeared after a crash.
    for (const entry of await readdir(await path('.intake/receipts'), { withFileTypes: true })) {
      if (!entry.name.endsWith('.json') || !entry.isFile() || entry.isSymbolicLink()) continue;
      try {
        const raw = JSON.parse(await readFile(await path(`.intake/receipts/${entry.name}`), 'utf8')) as Receipt;
        if (isPhoneReady(raw.filename)) hasPhoneHistory = true;
        const receipt = await readReceipt(raw.key);
        if (receipt) await finishReceipt(receipt);
      } catch { addIssue(entry.name, 'invalid pickup receipt'); }
    }
    for (const entry of await readdir(await path('.intake/holding'), { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) addIssue(entry.name, 'invalid held intake file');
      else if (!entry.name.endsWith('.md')) addIssue(entry.name, 'unrecognized held intake file');
      else {
        const receiptName = entry.name.slice(0, 64);
        try {
          const raw = JSON.parse(await readFile(await path(`.intake/receipts/${receiptName}.json`), 'utf8')) as Receipt;
          if (raw.holdingName !== entry.name || hash(raw.key) !== receiptName) throw new Error('unbound held file');
        } catch { addIssue(entry.name, 'orphan held intake file requires recovery'); }
      }
    }
    for (const entry of await readdir(await path('.intake/received'), { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) { addIssue(entry.name, 'invalid received intake file'); continue; }
      const receiptName = entry.name.slice(0, 64);
      try {
        const raw = JSON.parse(await readFile(await path(`.intake/receipts/${receiptName}.json`), 'utf8')) as Receipt;
        if (raw.receivedName !== entry.name || hash(raw.key) !== receiptName) throw new Error('unbound received file');
      } catch { addIssue(entry.name, 'orphan received intake file requires recovery'); }
    }
    const filenames = (await readdir(await path('drafts'))).sort();
    const groups = new Map<string, string[]>();
    for (const filename of filenames) {
      if (!safeFilename(filename)) continue;
      const key = lookupKey(filename);
      groups.set(key, [...(groups.get(key) ?? []), filename]);
    }
    const collisions = new Set<string>();
    for (const [key, names] of groups) {
      if (names.length < 2) continue;
      const digests = new Set<string>();
      for (const name of names) {
        const bytes = await currentBytes(name);
        if (bytes) digests.add(hash(bytes));
      }
      if (digests.size > 1) {
        collisions.add(key);
        for (const name of names) addIssue(name, 'normalized filename conflict with different bytes');
      }
    }
    for (const filename of filenames) if (!collisions.has(lookupKey(filename))) await scanOne(filename, nowMs);
    if (options.phoneDraftsEnabled) {
      try {
        const accepted = async (name: string) => {
          const receipt = await readReceipt(lookupKey(name));
          return receipt?.phase === 'materialized' && !!receipt.receivedName && !receipt.holdingName;
        };
        const current = await preparePhoneDraft(root, accepted, hasPhoneHistory, io.open);
        const names = await readdir(await path('drafts/phone'));
        const present = new Set(names.map(name => lookupKey(`phone/${name}`)));
        for (const key of observations.keys()) {
          if (key.startsWith('phone/') && !present.has(key)) observations.delete(key);
        }
        for (const name of names) {
          const filename = `phone/${name}`;
          if (!isPhoneReady(filename)) continue;
          if (filename === current || await readReceipt(lookupKey(filename))) await scanOne(filename, nowMs);
          else addIssue('phone drafts', `${name} is not an issued draft; use the current numbered template`);
        }
        await preparePhoneDraft(root, accepted, hasPhoneHistory, io.open);
      } catch (error) {
        for (const key of observations.keys()) if (key.startsWith('phone/')) observations.delete(key);
        addIssue('phone drafts', error instanceof Error ? error.message : String(error));
      }
    }
  }
  async function ensurePublished(record: Submission): Promise<void> {
    const target = await path(`drafts/${record.filename}`);
    const bytes = Buffer.from(record.bytes, 'base64');
    const existing = await readRegular(`drafts/${record.filename}`, record.filename);
    if (existing) {
      if (!existing.equals(bytes)) throw new BoundaryError('conflict', 'Published submission differs from receipt');
      return;
    }
    if (!(await readReceipt(lookupKey(record.filename)))) await writeAtomic(target, bytes);
  }
  async function submitInternal(markdown: string, requestId: string): Promise<{ submissionId: string }> {
    await ensureDirs();
    if (!requestId || typeof requestId !== 'string') throw new BoundaryError('invalid', 'Request ID is required');
    const bytes = Buffer.from(markdown, 'utf8');
    if (!bytes.length || bytes.length > MAX_BYTES || !markdown.trim()) throw new BoundaryError('invalid', 'Submission must be nonblank and at most 1 MiB');
    const key = hash(requestId);
    const target = await path(`.intake/submissions/${key}.json`);
    const digest = hash(bytes);
    try {
      const prior = JSON.parse(await readFile(target, 'utf8')) as Submission;
      if (prior.requestId !== requestId || prior.digest !== digest || hash(Buffer.from(prior.bytes, 'base64')) !== digest) {
        throw new BoundaryError('conflict', 'Request ID has different content');
      }
      await ensurePublished(prior);
      return { submissionId: prior.submissionId };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const submissionId = randomUUID();
    const filename = `${submissionId}.md`;
    const record: Submission = { requestId, digest, submissionId, filename, bytes: bytes.toString('base64') };
    await writeAtomic(target, JSON.stringify(record));
    await ensurePublished(record);
    return { submissionId };
  }
  return {
    scan(nowMs) {
      const run = pending.catch(() => undefined).then(() => scanInternal(nowMs));
      pending = run;
      return run;
    },
    submit(markdown, requestId) {
      const run = pending.catch(() => undefined).then(() => submitInternal(markdown, requestId));
      pending = run.then(() => undefined);
      return run;
    },
    async issues() { return [...foundIssues.values()]; },
  };
}
