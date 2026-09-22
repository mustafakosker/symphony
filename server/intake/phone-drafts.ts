import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import { BoundaryError } from '../../shared/validate.js';
import { writeAtomic } from '../store/atomic.js';
import { confinedPath } from '../store/paths.js';

type State = { number: number; publication: 'pending' | 'attempted' | 'published' };
export const isPhoneReady = (name: string): boolean => /^phone\/New idea-(?:\d{3}|[1-9]\d{3,})\.ready\.md$/.test(name);

/** Publish once per issued number. A disappearing file may be a rename still syncing. */
export async function preparePhoneDraft(root: string, accepted: (name: string) => Promise<boolean>,
  hasHistory: boolean, openFile: typeof open = open): Promise<string> {
  const folder = await confinedPath(root, 'drafts/phone');
  await mkdir(folder, { recursive: true });
  const directory = await lstat(folder);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid phone drafts directory');
  const journal = await confinedPath(root, '.intake/phone.json');
  let state: State;
  try {
    state = JSON.parse(await readFile(journal, 'utf8')) as State;
    if (!state || !Number.isSafeInteger(state.number) || state.number < 1 || state.number >= Number.MAX_SAFE_INTEGER ||
        !['pending', 'attempted', 'published'].includes(state.publication)) throw new Error('Invalid phone draft journal');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (hasHistory || (await readdir(folder)).length) {
      throw new Error('Phone draft journal is missing; restore its matching backup before continuing');
    }
    state = { number: 1, publication: 'pending' };
    await writeAtomic(journal, JSON.stringify(state));
  }
  const name = () => `phone/New idea-${String(state.number).padStart(3, '0')}`;
  if (await accepted(`${name()}.ready.md`)) {
    state = { number: state.number + 1, publication: 'pending' };
    await writeAtomic(journal, JSON.stringify(state));
  }
  const ready = `${name()}.ready.md`;
  const draft = `${name()}.md`;
  const exists = async (relative: string) => {
    try {
      const info = await lstat(await confinedPath(root, `drafts/${relative}`));
      if (!info.isFile() || info.isSymbolicLink()) throw new BoundaryError('invalid', 'Phone draft must be a regular file');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  // Check the ready name first: the user might have renamed before this write completed.
  if (await exists(ready) || await exists(draft)) {
    if (state.publication !== 'published') {
      state.publication = 'published';
      await writeAtomic(journal, JSON.stringify(state));
    }
    return ready;
  }
  if (state.publication !== 'pending') {
    throw new Error('Phone draft is missing or still syncing; waiting for its draft or ready filename');
  }
  state.publication = 'attempted';
  await writeAtomic(journal, JSON.stringify(state));
  // Exclusive creation protects an unfinished file arriving between the checks and the open.
  try {
    const handle = await openFile(await confinedPath(root, `drafts/${draft}`), 'wx', 0o600);
    try { await handle.sync(); } finally { await handle.close(); }
    const parent = await open(folder, 'r');
    try { await parent.sync(); }
    catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    } finally { await parent.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await exists(draft);
  }
  state.publication = 'published';
  await writeAtomic(journal, JSON.stringify(state));
  return ready;
}
