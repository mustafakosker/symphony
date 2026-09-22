import { open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function writeAtomic(path: string, bytes: string | Uint8Array): Promise<void> {
  const temp = join(dirname(path), `.tmp-${randomUUID()}`);
  let created = false;
  try {
    const handle = await open(temp, 'wx', 0o600);
    created = true;
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, path);
    try {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); }
      finally { await directory.close(); }
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  } finally {
    if (created) await rm(temp, { force: true });
  }
}
