import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireHostLock } from './lock.js';
const readGate = vi.hoisted(() => ({ hook: null as null | ((path: unknown) => Promise<void>) }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    const value = await actual.readFile(...args);
    await readGate.hook?.(args[0]);
    return value;
  } };
});
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'symphony-lock-')); });
afterEach(async () => { readGate.hook = null; await rm(root, { recursive: true, force: true }); });
it('admits only one local owner and releases its own lock', async () => {
  const release = await acquireHostLock(root);
  await expect(acquireHostLock(root)).rejects.toMatchObject({ code: 'conflict' });
  await release();
  const second = await acquireHostLock(root);
  await second();
});
it('blocks an uncertain owner instead of stealing its lock', async () => {
  await mkdir(join(root, 'coordinator.lock'));
  await expect(acquireHostLock(root)).rejects.toMatchObject({ code: 'conflict' });
});
it('reclaims a lock whose process is proven dead', async () => {
  await mkdir(join(root, 'coordinator.lock'));
  await writeFile(join(root, 'coordinator.lock', 'owner.json'), JSON.stringify({ pid: 2147483647, token: 'old', startedAt: '2026-09-20T00:00:00Z' }));
  const release = await acquireHostLock(root);
  await release();
});
it('does not let a delayed stale contender remove a newly acquired owner', async () => {
  await mkdir(join(root, 'coordinator.lock'));
  await writeFile(join(root, 'coordinator.lock', 'owner.json'), JSON.stringify({ pid: 2147483647, token: 'old', startedAt: '2026-09-20T00:00:00Z' }));
  let firstRead!: () => void;
  let releaseFirst!: () => void;
  const firstSeen = new Promise<void>(resolve => { firstRead = resolve; });
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let reads = 0;
  readGate.hook = async path => {
    if (String(path).endsWith('owner.json')) {
      reads++;
      if (reads === 1) { firstRead(); await firstGate; }
    }
  };
  const first = acquireHostLock(root);
  await firstSeen;
  const second = acquireHostLock(root);
  const secondResult = await second.then(value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason }));
  releaseFirst();
  const results = [await first.then(value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason })), secondResult];
  const owners = results.filter((result): result is PromiseFulfilledResult<() => Promise<void>> => result.status === 'fulfilled');
  expect(owners).toHaveLength(1);
  await owners[0].value();
});
