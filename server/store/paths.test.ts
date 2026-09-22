import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confinedPath } from './paths.js';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'symphony-path-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it('rejects traversal, absolute paths, and symlinked components', async () => {
  await mkdir(join(root, 'safe'));
  await symlink('/tmp', join(root, 'safe', 'link'));
  for (const path of ['../outside', '/tmp/outside', 'safe/../outside', 'safe/link/outside']) {
    await expect(confinedPath(root, path)).rejects.toMatchObject({ code: 'invalid' });
  }
  expect(await confinedPath(root, 'safe/new/file')).toBe(join(await realpath(root), 'safe', 'new', 'file'));
});
it('rejects a symlinked store root', async () => {
  const link = `${root}-link`;
  await symlink(root, link);
  try { await expect(confinedPath(link, 'safe/file')).rejects.toMatchObject({ code: 'invalid' }); }
  finally { await rm(link); }
});
