import { afterEach, expect, it } from 'vitest';
import { mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createProjectFixture, createRepository, git, treeDigest } from '../testing/projects.js';
import { scanRoot, validateSource } from './discovery.js';
import type { RootSetting } from '../../shared/projects.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup() { const f = await createProjectFixture(); cleanups.push(f.dispose); return { ...f,
 setting: { projectsRoot: f.root, generation: 'g1', revision: 'r1', state: 'ready', message: null } as RootSetting }; }
it('discovers direct repositories without reading nested projects or mutating source metadata', async () => {
 const f = await setup(); const repo = await createRepository(f.root, 'shop', { 'README.md': 'Shop\n' });
 await createRepository(join(f.root, 'group'), 'nested', { 'README.md': 'Nested\n' });
 await symlink(repo.path, join(f.root, 'link')); await mkdir(join(f.root, 'empty'));
 await git(join(f.root, 'empty'), ['init','-b','main']);
 const before = await treeDigest(f.root); const scan = await scanRoot(f.setting, { timeoutMs: 5000 });
 expect(scan.entries.filter(e => !e.error).map(e => e.name)).toEqual(['shop']);
 expect(scan.entries.find(e => e.name === 'empty')).toMatchObject({ canonicalPath: join(f.root,'empty'), observedCommit: null });
 expect(scan.entries.find(e => e.name === 'link')?.error).toMatch(/link/i);
 expect(await treeDigest(f.root)).toBe(before);
});
it('rejects enclosing repositories, bare repositories, linked worktrees and external object alternates', async () => {
 const f = await setup(); await git(f.root, ['init','-b','main']); await mkdir(join(f.root,'plain'));
 const repo = await createRepository(f.root,'real',{ 'a': 'A' });
 await git(f.root,['init','--bare','bare']); await git(repo.path,['worktree','add','--detach',join(f.root,'worktree')]);
 await writeFile(join(repo.path,'.git/objects/info/alternates'),'/outside/objects\n');
 const scan = await scanRoot(f.setting,{ timeoutMs: 5000 });
 expect(scan.entries.filter(e => !e.error)).toEqual([]);
 expect(scan.entries.find(e => e.name === 'real')?.error).toMatch(/alternat/i);
});
it('rejects Git metadata symlinks and revalidates replaced source directories', async () => {
 const f = await setup(); const repo = await createRepository(f.root,'shop',{ a:'A' });
 await rm(join(repo.path,'.git/objects'),{ recursive:true }); await symlink(f.local,join(repo.path,'.git/objects'));
 await expect(validateSource(f.root,repo.path)).rejects.toThrow(/link/i);
 await rm(repo.path,{ recursive:true }); await symlink(f.local,repo.path);
 await expect(validateSource(f.root,repo.path)).rejects.toThrow();
});
it('distinguishes a missing root from a valid empty root', async () => {
 const f = await setup(); expect((await scanRoot(f.setting,{ timeoutMs:5000 })).entries).toEqual([]);
 await rm(f.root,{ recursive:true }); await expect(scanRoot(f.setting,{ timeoutMs:5000 })).rejects.toThrow();
});
