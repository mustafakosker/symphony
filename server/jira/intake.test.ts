import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../store/task-store';
import { createJiraIntake, jiraTaskId } from './intake';
import { jiraIssue } from '../preparation/testing';
import type { JiraBatch } from './adapter';
import type { Registry } from '../config/registry';
const registry: Registry = { roles: [], projects: [{ id: 'app', names: ['App'], repositories: [
  { id: 'web', localPath: null, mcpProfile: 'read', baseRef: 'main', defaultRef: 'main' }] }] };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jira-intake-')); roots.push(root);
  const localRoot = join(root, 'local'); await mkdir(localRoot);
  const store = await openStore(join(root, 'workspace'));
  let batch: JiraBatch = { complete: true, issues: [jiraIssue()] }; let failed = false; let calls = 0;
  const options = { store, localRoot, registry, config: { mode: 'mock' as const, connectionId: 'demo', fixturesPath: '/unused', projectMappings: { APP: 'app' } },
    adapter: { async listAssignedOpen() { calls++; if (failed) throw new Error('Offline'); return batch; } } };
  return { store, options, intake: createJiraIntake(options), set: (value: JiraBatch) => { batch = value; }, fail: () => { failed = true; }, calls: () => calls };
}
it('keeps stable identities distinct across connections', () => {
  expect(jiraTaskId('demo', '10001')).toBe(jiraTaskId('demo', '10001'));
  expect(jiraTaskId('another', '10001')).not.toBe(jiraTaskId('demo', '10001'));
});
it('refreshes A/B/A source snapshots without replacing saved documents or original brief', async () => {
  const f = await fixture(); const now = new Date('2026-09-23T12:00:00Z');
  await f.intake.sync(now); await f.intake.sync(now);
  let task = (await f.store.list()).tasks[0];
  expect(task.preparation!.target).toEqual({ projectId: 'app', repositoryId: 'web', branch: 'main' });
  const ref = await f.store.publishArtifact(task.id, 'jira-design', Buffer.from('Design'));
  await f.store.apply(task.id, task.revision, 'upload', { kind: 'preparation', inputDigest: 'a'.repeat(64),
    change: { kind: 'document', role: 'design', document: { role: 'design', filename: 'design.md', size: 6, ref } } });
  for (const description of ['changed', 'Improve search latency.']) {
    f.set({ complete: true, issues: [jiraIssue({ description, key: 'NEW-1' })] });
    await f.intake.sync(now);
    task = (await f.store.list()).tasks[0];
    expect(task.preparation!.source.description).toBe(description);
    expect(task.preparation!.documents.design!.ref).toEqual(ref);
    expect(task.idea).toContain('Improve search latency.');
  }
  expect((await f.store.list()).tasks).toHaveLength(1);
});
it('marks absence only after a complete successful snapshot and retains last success across restart', async () => {
  const f = await fixture(); await f.intake.sync(new Date('2026-09-23T12:00:00Z'));
  f.set({ complete: false, issues: [] }); await f.intake.sync(new Date('2026-09-23T12:01:00Z'));
  expect((await f.store.list()).tasks[0].preparation!.matchesQuery).toBe(true);
  const restarted = createJiraIntake(f.options);
  await restarted.sync(new Date('2026-09-23T12:02:00Z'));
  expect(restarted.view().lastSuccessAt).toBe('2026-09-23T12:00:00.000Z');
  f.set({ complete: true, issues: [] }); await restarted.sync(new Date('2026-09-23T12:03:00Z'));
  expect((await f.store.list()).tasks[0].preparation!.matchesQuery).toBe(false);
  f.fail(); await restarted.sync(new Date('2026-09-23T12:04:00Z'));
  expect(restarted.view().error).toContain('Offline');
  expect(restarted.view().lastSuccessAt).toBe('2026-09-23T12:03:00.000Z');
});
it('coalesces refresh and waits 60 seconds between automatic attempts', async () => {
  const f = await fixture();
  await Promise.all([f.intake.sync(new Date(0)), f.intake.sync(new Date(0))]);
  expect(f.calls()).toBe(1);
  await f.intake.tick(new Date(59000)); expect(f.calls()).toBe(1);
  await f.intake.tick(new Date(60000)); expect(f.calls()).toBe(2);
});
it('validates the complete batch before mutation and does not reimport cancelled issues', async () => {
  const f = await fixture(); f.set({ complete: true, issues: [jiraIssue(), jiraIssue()] });
  await f.intake.sync(new Date()); expect((await f.store.list()).tasks).toHaveLength(0);
  expect(f.intake.view().error).toBeTruthy();
  f.set({ complete: true, issues: [jiraIssue()] }); await f.intake.sync(new Date());
  const task = (await f.store.list()).tasks[0];
  await f.store.apply(task.id, task.revision, 'cancel', { kind: 'preparation', inputDigest: 'a'.repeat(64), change: { kind: 'cancel' } });
  await f.intake.sync(new Date()); expect((await f.store.list()).tasks).toHaveLength(1);
  expect((await f.store.get(task.id)).status).toBe('cancelled');
});
it('retries a partially applied batch without duplicates and requires selection for ambiguous mappings', async () => {
  const f = await fixture();
  f.options.registry.projects[0].repositories.push({ id: 'api', localPath: null, mcpProfile: 'read', baseRef: 'develop', defaultRef: 'main' });
  f.set({ complete: true, issues: [jiraIssue(), jiraIssue({ issueId: '10002', key: 'APP-2' })] });
  const create = f.store.create.bind(f.store); let calls = 0;
  f.store.create = async (task, op) => { if (++calls === 2) throw new Error('Temporary write failure'); return create(task, op); };
  await f.intake.sync(new Date()); expect((await f.store.list()).tasks).toHaveLength(1);
  expect(f.intake.view().lastSuccessAt).toBeNull();
  f.store.create = create;
  await f.intake.sync(new Date());
  expect((await f.store.list()).tasks).toHaveLength(2);
  expect((await f.store.list()).tasks.every(t => t.preparation!.target === null)).toBe(true);
});
