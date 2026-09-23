import { expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftTask } from '../testing/fixtures.js';
import { openStore } from './task-store.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

it('reads artifacts safely while a terminal transition moves the task directory', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'symphony-artifact-race-')));
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let release!: () => void, moved!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { moved = resolve; });
  let transition: Promise<unknown> | undefined;
  try {
    const store = await openStore(root), task = await store.create(draftTask(), 'create');
    const bytes = Buffer.from('Immutable evidence');
    const artifact = await store.publishArtifact(task.id, 'evidence', bytes);
    vi.mocked(rename).mockImplementation(async (from, to) => {
      await actual.rename(from, to);
      if (String(to) === join(root, 'cancelled', task.id)) { moved(); await gate; }
    });
    transition = store.apply(task.id, task.revision, 'cancel', { kind: 'human', command: {
      taskId: task.id, expectedRevision: task.revision, requestId: 'cancel', action: { kind: 'cancel' } } });
    await reached;
    const reading = expect(store.readArtifact(task.id, artifact)).resolves.toEqual(bytes);
    release();
    await transition;
    await reading;
  } finally {
    release();
    await transition?.catch(() => {});
    vi.mocked(rename).mockImplementation(actual.rename);
    await rm(root, { recursive: true, force: true });
  }
});
