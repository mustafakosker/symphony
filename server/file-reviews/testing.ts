import { mkdtemp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../../shared/contracts.js';
import { applyHumanCommand } from '../coordinator/reviews.js';
import { openStore, type Store } from '../store/task-store.js';
import { waitingTask } from '../testing/fixtures.js';
import { createFileReviews } from './adapter.js';

export async function fileReviewFixture(task: Task = waitingTask(), overrides: Partial<Store> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'file-review-'));
  const workspaceRoot = join(root, 'workspace'); const localRoot = join(root, 'local');
  await mkdir(workspaceRoot); await mkdir(localRoot);
  const realStore = await openStore(localRoot);
  await realStore.create(task, 'fixture-created');
  const store: Store = { ...realStore, ...Object.fromEntries((Object.keys(realStore) as (keyof Store)[]).map(key => [key, realStore[key]])),
    ...Object.fromEntries((Object.getOwnPropertyNames(Object.getPrototypeOf(realStore)) as (keyof Store)[])
      .filter(key => key !== 'constructor').map(key => [key, (realStore[key] as Function).bind(realStore)])), ...overrides } as Store;
  const coordinator = { async tick() {}, async shutdown() {}, async stopTask() {} };
  const make = (current: Store) => createFileReviews({ workspaceRoot, localRoot, stableMs: 0, store: current,
    apply: command => applyHumanCommand(current, coordinator as never, command) });
  return { root, workspaceRoot, localRoot, store, adapter: make(store),
    async restart() { return make(await openStore(localRoot)); },
    async dispose() { await rm(root, { recursive: true, force: true }); } };
}
export async function draftFile(workspaceRoot: string): Promise<string> {
  const files = (await readdir(join(workspaceRoot, 'reviews')))
    .filter(name => name.endsWith('.md') && !name.endsWith('.ready.md') && !name.endsWith('.receipt.md'));
  if (files.length !== 1) throw new Error(`Expected one draft, got ${files.length}`);
  return join(workspaceRoot, 'reviews', files[0]);
}
export async function submitFile(path: string, response: string): Promise<string> {
  const document = await readFile(path, 'utf8');
  const marker = '## Your response\n';
  const offset = document.lastIndexOf(marker);
  if (offset < 0) throw new Error('Fixture response marker missing');
  await writeFile(path, document.slice(0, offset + marker.length) + response);
  const ready = path.replace(/\.md$/, '.ready.md');
  await rename(path, ready);
  return ready;
}
