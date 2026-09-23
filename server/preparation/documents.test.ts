import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/task-store';
import { jiraTask } from './testing';
import { createDocumentService, validateDocument } from './documents';
import { createPreparationOperations } from './operations';
let root: string, store: Store;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'jira-documents-')); store = await openStore(root); await store.create(jiraTask(), 'create'); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it.each(['../plan.md','a\\b.md','plan.html','plan.md\u0000'])('rejects unsafe filename %j', filename => {
  expect(() => validateDocument(filename, Buffer.from('text'))).toThrow();
});
it('validates size and encoding without changing bytes', () => {
  const bytes = Buffer.from('\uFEFF# Café\r\n');
  expect(validateDocument('café.MD', bytes).size).toBe(bytes.length);
  expect(bytes.toString()).toBe('\uFEFF# Café\r\n');
  for (const invalid of [Buffer.alloc(0), Buffer.from(' \n'), Buffer.from([0xc3,0x28]), Buffer.alloc(1024*1024+1,97)])
    expect(() => validateDocument('plan.txt', invalid)).toThrow();
  expect(validateDocument('plan.txt', Buffer.alloc(1024*1024,97)).size).toBe(1024*1024);
});
it('replays after restart and preserves historical versions on replacement/removal', async () => {
  let service = createDocumentService(store, createPreparationOperations(store));
  const command = { taskId: jiraTask().id, requestId: 'upload', expectedRevision: 1, role: 'design' as const, filename: 'café.md' };
  const bytes = Buffer.from('\uFEFF# Café\r\n');
  let task = await service.upload(command, bytes);
  const first = task.preparation!.documents.design!;
  expect(await store.readArtifact(task.id, first.ref)).toEqual(bytes);
  store = await openStore(root); service = createDocumentService(store, createPreparationOperations(store));
  task = await service.upload(command, bytes); expect(task.revision).toBe(2); expect(task.artifacts).toHaveLength(1);
  await expect(service.upload(command, Buffer.from('changed'))).rejects.toThrow();
  task = await service.upload({ ...command, requestId: 'replace', expectedRevision: task.revision }, Buffer.from('replacement'));
  expect(task.preparation!.documents.design!.ref.version).toBe(2);
  task = await service.remove({ taskId: task.id, requestId: 'remove', expectedRevision: task.revision, action: { kind: 'remove-document', role: 'design' } });
  expect(task.preparation!.documents.design).toBeNull(); expect(task.artifacts).toHaveLength(2);
  expect(await store.readArtifact(task.id, first.ref)).toEqual(bytes);
});
it('does not select an upload if selection commit fails or a cancellation wins', async () => {
  const service = createDocumentService(store, createPreparationOperations(store));
  const command = { taskId: jiraTask().id, requestId: 'upload', expectedRevision: 1, role: 'design' as const, filename: 'design.md' };
  const apply = store.apply.bind(store); store.apply = async () => { throw new Error('Before event commit'); };
  await expect(service.upload(command, Buffer.from('Design'))).rejects.toThrow();
  expect((await store.get(command.taskId)).preparation!.documents.design).toBeNull();
  expect((await store.get(command.taskId)).artifacts).toHaveLength(0);
  store.apply = apply;
  await store.apply(command.taskId, 1, 'cancel', { kind: 'preparation', inputDigest: 'a'.repeat(64), change: { kind: 'cancel' } });
  await expect(service.upload(command, Buffer.from('Design'))).rejects.toThrow();
});
