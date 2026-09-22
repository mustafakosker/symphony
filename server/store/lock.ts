import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BoundaryError } from '../../shared/validate.js';

type Owner = { pid: number; token: string; startedAt: string };

export async function acquireHostLock(localRoot: string): Promise<() => Promise<void>> {
  await mkdir(localRoot, { recursive: true });
  const base = await realpath(localRoot);
  const lock = join(base, 'coordinator.lock');
  const reclaim = join(base, 'coordinator.reclaim.lock');
  const owner: Owner = { pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() };
  try { await mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new BoundaryError('unavailable', 'Cannot acquire host lock', { cause: error });
    try { await mkdir(reclaim); }
    catch (guardError) {
      if ((guardError as NodeJS.ErrnoException).code === 'EEXIST') throw new BoundaryError('conflict', 'Another owner is reclaiming the host lock');
      throw new BoundaryError('unavailable', 'Cannot acquire host reclaim guard', { cause: guardError });
    }
    try {
      // Every contender must inspect the owner only after acquiring this exclusive guard.
      let prior: Owner;
      try { prior = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as Owner; }
      catch { throw new BoundaryError('conflict', 'Existing host lock has uncertain owner'); }
      if (!Number.isSafeInteger(prior.pid) || prior.pid < 1 || typeof prior.token !== 'string' || !prior.token || typeof prior.startedAt !== 'string') {
        throw new BoundaryError('conflict', 'Existing host lock has uncertain owner');
      }
      try { process.kill(prior.pid, 0); throw new BoundaryError('conflict', 'Coordinator host lock is owned by a live process'); }
      catch (probe) {
        if (probe instanceof BoundaryError) throw probe;
        if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw new BoundaryError('conflict', 'Coordinator host lock owner is uncertain');
      }
      await rm(lock, { recursive: true, force: true });
      try { await mkdir(lock); }
      catch (claimError) {
        if ((claimError as NodeJS.ErrnoException).code === 'EEXIST') throw new BoundaryError('conflict', 'Host lock was claimed during reclamation');
        throw new BoundaryError('unavailable', 'Cannot claim reclaimed host lock', { cause: claimError });
      }
      try { await writeFile(join(lock, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
      catch (writeError) { await rm(lock, { recursive: true, force: true }); throw new BoundaryError('unavailable', 'Cannot write host lock owner', { cause: writeError }); }
    } finally {
      await rm(reclaim, { recursive: true, force: true });
    }
    return async () => releaseOwnedLock(lock, owner);
  }
  try { await writeFile(join(lock, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
  catch (error) { await rm(lock, { recursive: true, force: true }); throw new BoundaryError('unavailable', 'Cannot write host lock owner', { cause: error }); }
  return async () => releaseOwnedLock(lock, owner);
}

async function releaseOwnedLock(lock: string, owner: Owner): Promise<void> {
  let current: Owner;
  try { current = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as Owner; }
  catch { throw new BoundaryError('conflict', 'Host lock owner changed before release'); }
  if (current.token !== owner.token || current.pid !== owner.pid) throw new BoundaryError('conflict', 'Host lock owner changed before release');
  await rm(lock, { recursive: true });
}
