import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/task-store';
import { jiraTask } from './testing';
import { createDraftService } from './drafts';
import { createPreparationOperations } from './operations';
import type { PreparationAction } from '../../shared/jira-preparation';
let root: string, store: Store;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'jira-drafts-')); store = await openStore(root); await store.create(jiraTask(), 'create'); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const registry = { roles: [], projects: [{ id: 'app', names: ['App'], repositories: [{ id: 'web', localPath: null, mcpProfile: 'mock', baseRef: 'main', defaultRef: 'main' }] }] };
it('saves exact user text and repeated preparation never regenerates it', async () => {
  const drafts = createDraftService(store, registry, createPreparationOperations(store));
  const command = (kind: PreparationAction, expectedRevision: number, requestId: string) => ({ taskId: jiraTask().id, expectedRevision, requestId, action: kind });
  let task = await drafts.prepare(command({ kind: 'prepare' }, 1, 'prepare'));
  expect((await drafts.detail(task.id)).promptText).toContain('APP-1');
  const save = command({ kind: 'save', promptText: ' Exact\n\nuser text.\r\n', target: { projectId: 'app', repositoryId: 'web', branch: 'feature/x' } }, task.revision, 'save');
  task = await drafts.save(save);
  const artifactCount = task.artifacts.length;
  task = await drafts.prepare(command({ kind: 'prepare' }, task.revision, 'prepare-again'));
  expect(task.artifacts).toHaveLength(artifactCount);
  expect((await drafts.detail(task.id)).promptText).toBe(' Exact\n\nuser text.\r\n');
  expect((await drafts.save(save)).revision).toBe(task.revision);
  await expect(drafts.save({ ...save, action: { kind: 'save', promptText: 'changed', target: null } })).rejects.toThrow();
});
it('saves blank drafts but rejects unknown repositories and stale edits', async () => {
  const drafts = createDraftService(store, registry, createPreparationOperations(store));
  const command = { taskId: jiraTask().id, expectedRevision: 1, requestId: 'save', action: { kind: 'save' as const, promptText: '', target: null } };
  const saved = await drafts.save(command);
  expect(saved.preparation!.prompt!.nonblank).toBe(false);
  expect((await drafts.detail(saved.id)).promptText).toBe('');
  await expect(drafts.save({ ...command, requestId: 'stale' })).rejects.toThrow();
  await expect(drafts.save({ ...command, requestId: 'target', expectedRevision: saved.revision, action: {
    kind: 'save', promptText: 'x', target: { projectId: 'app', repositoryId: 'missing', branch: 'main' } } })).rejects.toThrow();
});
