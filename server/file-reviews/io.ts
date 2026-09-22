import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile } from 'node:fs/promises';
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
export async function readBounded(root: string, relative: string): Promise<Buffer | null> {
  let handle;
  try {
    const path = await confinedPath(root, relative);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.size > LIMIT) throw new BoundaryError('invalid', 'Review file must be regular and at most 1 MiB');
    const bytes = Buffer.alloc(LIMIT + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await handle.read(bytes, count, bytes.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (count > LIMIT) throw new BoundaryError('invalid', 'Review file exceeds 1 MiB');
    const after = await handle.stat();
    const pathStat = await lstat(path);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.size !== count ||
      after.dev !== pathStat.dev || after.ino !== pathStat.ino || after.size !== pathStat.size || after.mtimeMs !== pathStat.mtimeMs)
      throw new BoundaryError('unavailable', 'Review file changed while reading');
    return bytes.subarray(0, count);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw boundary(error);
  } finally { await handle?.close(); }
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
      const path = await confinedPath(localRoot, `file-reviews/requests/${name}`);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Journal entry is not a regular file');
      const record = parseRecord(JSON.parse(await readFile(path, 'utf8')));
      if (`${record.token}.json` !== name) throw new Error('Journal token does not match filename');
      records.push(record);
    } catch (error) {
      issues.push({ id: `file-review-journal-${createHash('sha256').update(name).digest('hex').slice(0, 16)}`, taskId: null,
        message: `Invalid file review journal ${name}: ${(error as Error).message}` });
    }
  }
  return { records, issues };
}
