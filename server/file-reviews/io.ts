import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BoundaryError } from '../../shared/validate.js';
import { confinedPath } from '../store/paths.js';
import { writeAtomic } from '../store/atomic.js';
import { parseRecord, type RequestRecord } from './model.js';
import type { Issue } from '../../shared/contracts.js';

const LIMIT = 1024 * 1024;
function boundary(error: unknown): BoundaryError {
  if (error instanceof BoundaryError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  return new BoundaryError(code === 'ELOOP' || code === 'EISDIR' ? 'invalid' : 'unavailable', `File review IO failed: ${code ?? 'unknown'}`, { cause: error });
}
async function ensureDirectory(root: string, relative: string): Promise<void> {
  let current = '';
  for (const part of relative.split('/')) {
    current = current ? `${current}/${part}` : part;
    const path = await confinedPath(root, current);
    try { await mkdir(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw boundary(error); }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BoundaryError('invalid', 'Review directory is not a regular directory');
  }
}
async function openSafe(root: string, relative: string): Promise<{ path: string; handle: Awaited<ReturnType<typeof open>> } | null> {
  const path = await confinedPath(root, relative);
  try { return { path, handle: await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw boundary(error); }
}
function stable(before: import('node:fs').Stats, after: import('node:fs').Stats, pathStat: import('node:fs').Stats): void {
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      after.dev !== pathStat.dev || after.ino !== pathStat.ino || after.size !== pathStat.size ||
      after.mtimeMs !== pathStat.mtimeMs || after.ctimeMs !== pathStat.ctimeMs)
    throw new BoundaryError('unavailable', 'Review file changed while reading');
}
async function readStable(root: string, relative: string, limit: number, afterOpen?: () => Promise<void>): Promise<Buffer | null> {
  const opened = await openSafe(root, relative);
  if (!opened) return null;
  const { path, handle } = opened;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) throw new BoundaryError('invalid', `Review file must be regular and at most ${limit} bytes`);
    if (afterOpen) await afterOpen();
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await handle.read(bytes, count, bytes.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (count > limit) throw new BoundaryError('invalid', 'Review file exceeds size limit');
    const after = await handle.stat();
    const pathStat = await lstat(path);
    stable(before, after, pathStat);
    if (after.size !== count) throw new BoundaryError('unavailable', 'Review file changed while reading');
    return bytes.subarray(0, count);
  } catch (error) { throw boundary(error); }
  finally { await handle.close(); }
}
export async function readBounded(root: string, relative: string, afterOpen?: () => Promise<void>): Promise<Buffer | null> {
  return readStable(root, relative, LIMIT, afterOpen);
}
/** Receipt output includes metadata and fences beyond the bounded input; never read more than the expected output. */
export async function readReceipt(root: string, relative: string, expectedBytes: number): Promise<Buffer | null> {
  return readStable(root, relative, expectedBytes);
}
/** Verifies material bytes without applying the 1 MiB response intake limit. */
export async function verifyMaterial(root: string, relative: string, expectedDigest: string): Promise<boolean> {
  const opened = await openSafe(root, relative);
  if (!opened) return false;
  const { path, handle } = opened;
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new BoundaryError('invalid', 'Review material is not a regular file');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let count = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, count);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead)); count += bytesRead;
    }
    const after = await handle.stat();
    stable(before, after, await lstat(path));
    if (after.size !== count) throw new BoundaryError('unavailable', 'Review material changed while reading');
    return hash.digest('hex') === expectedDigest.toLowerCase();
  } catch (error) { throw boundary(error); }
  finally { await handle.close(); }
}
export async function publishExclusive(root: string, relative: string, bytes: Uint8Array): Promise<void> {
  let handle;
  try {
    const parent = relative.slice(0, relative.lastIndexOf('/'));
    if (parent) await ensureDirectory(root, parent);
    const path = await confinedPath(root, relative);
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = undefined;
    try { const dir = await open(dirname(path), 'r'); try { await dir.sync(); } finally { await dir.close(); } }
    catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error;
    throw boundary(error);
  } finally { await handle?.close(); }
}
export async function saveRecord(localRoot: string, record: RequestRecord): Promise<void> {
  const valid = parseRecord(record);
  await ensureDirectory(localRoot, 'file-reviews/requests');
  const path = await confinedPath(localRoot, `file-reviews/requests/${valid.token}.json`);
  await writeAtomic(path, `${JSON.stringify(valid)}\n`);
}
export async function loadRecords(localRoot: string): Promise<{ records: RequestRecord[]; issues: Issue[] }> {
  const records: RequestRecord[] = []; const issues: Issue[] = [];
  let names: string[];
  try { names = await readdir(await confinedPath(localRoot, 'file-reviews/requests')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records, issues }; throw boundary(error); }
  for (const name of names.sort()) {
    try {
      if (!/^[0-9a-f-]+\.json$/.test(name)) throw new Error('Unexpected journal file');
      const bytes = await readStable(localRoot, `file-reviews/requests/${name}`, 8 * LIMIT);
      if (!bytes) throw new Error('Journal entry disappeared');
      const record = parseRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      if (`${record.token}.json` !== name) throw new Error('Journal token does not match filename');
      records.push(record);
    } catch (error) {
      issues.push({ id: `file-review-journal-${createHash('sha256').update(name).digest('hex').slice(0, 16)}`, taskId: null,
        message: `Invalid file review journal ${name}: ${(error as Error).message}` });
    }
  }
  return { records, issues };
}
