import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { Run } from '../../shared/contracts.js';
import { BoundaryError } from '../../shared/validate.js';

export type LogPage = { text: string; nextOffset: number; complete: boolean };
export type LogStream = 'stdout' | 'stderr';

export async function readRunLogFile(path: string, run: Run, offset: number, maxBytes: number): Promise<LogPage> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536)
    throw new BoundaryError('invalid', 'Invalid log request');
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (offset !== 0) throw new BoundaryError('invalid', 'Log offset exceeds size');
      return { text: '', nextOffset: 0, complete: run.phase === 'ended' || run.phase === 'uncertain' };
    }
    throw new BoundaryError('unavailable', 'Cannot open run log', { cause: error });
  }
  try {
    const info = await handle.stat();
    const pathInfo = await lstat(path);
    if (!info.isFile() || !pathInfo.isFile() || pathInfo.isSymbolicLink() || info.dev !== pathInfo.dev || info.ino !== pathInfo.ino)
      throw new BoundaryError('conflict', 'Run log path is unsafe');
    if (offset > info.size) throw new BoundaryError('invalid', 'Log offset exceeds size');
    const length = Math.min(maxBytes, info.size - offset);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, offset);
    if (bytesRead && offset > 0 && (bytes[0] & 0xc0) === 0x80)
      throw new BoundaryError('invalid', 'Log offset splits a UTF-8 character');
    let used = bytesRead;
    let text = '';
    while (used >= 0) {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)); break; }
      catch { used--; if (bytesRead - used > 3) throw new BoundaryError('conflict', 'Run log contains invalid UTF-8'); }
    }
    if (used < bytesRead && offset + bytesRead >= info.size && (run.phase === 'ended' || run.phase === 'uncertain'))
      throw new BoundaryError('conflict', 'Completed run log ends with invalid UTF-8');
    const nextOffset = offset + used;
    return { text, nextOffset, complete: nextOffset >= info.size && (run.phase === 'ended' || run.phase === 'uncertain') };
  } catch (error) {
    throw error instanceof BoundaryError ? error : new BoundaryError('unavailable', 'Cannot read run log', { cause: error });
  } finally { await handle.close(); }
}
