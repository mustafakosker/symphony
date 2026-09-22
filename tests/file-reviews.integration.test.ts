import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startApplication, type Application } from '../server/main.js';
import { loadSettings } from '../server/config/settings.js';
import { createCodexRunner } from '../server/codex/adapter.js';
import { openStore } from '../server/store/task-store.js';
import { waitingTask } from '../server/testing/fixtures.js';
import { makeRequest, renderDraft } from '../server/file-reviews/document.js';
import type { Task } from '../shared/contracts.js';

const roots: string[] = [];
const apps: Application[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>(done => server.close(() => done()));
  return address.port;
}
async function setup(enabled: boolean, beforeStart?: (workspaceRoot: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'symphony-file-reviews-app-')); roots.push(root);
  const workspaceRoot = join(root, 'workspace'); const localRoot = join(root, 'local');
  await Promise.all([mkdir(join(workspaceRoot, 'projects'), { recursive: true }),
    mkdir(join(workspaceRoot, 'roles'), { recursive: true }), mkdir(localRoot)]);
  await writeFile(join(workspaceRoot, 'projects/projects.json'), '{"projects":[]}');
  await writeFile(join(workspaceRoot, 'roles/roles.json'), JSON.stringify({ roles: [
    { role: 'triage', instructions: 'Fixture triage', skills: [], cliProfile: 'triage', actions: ['read'] },
    { role: 'researcher', instructions: 'Fixture research', skills: [], cliProfile: 'researcher', actions: ['read'] },
  ] }));
  await beforeStart?.(workspaceRoot);
  const port = await unusedPort(); const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ workspaceRoot, localRoot, codexBinary: process.execPath,
    port, allowedOrigin: `http://127.0.0.1:${port}`, scanMs: 25, stableMs: 1, stopGraceMs: 100,
    fileReviewsEnabled: enabled }));
  const settings = await loadSettings(configPath);
  const runner = createCodexRunner(settings, { executable: process.execPath,
    prefixArgs: [resolve('server/testing/lifecycle-cli.mjs')] });
  const buildDir = join(root, 'build'); await mkdir(join(buildDir, 'assets'), { recursive: true });
  await writeFile(join(buildDir, 'index.html'), '<h1>Fixture</h1>');
  const app = await startApplication({ configPath, buildDir, runner, verifyCapabilities: async () => {} });
  apps.push(app);
  return { workspaceRoot, localRoot, app };
}
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read(); if (check(value)) return value;
    await new Promise(done => setTimeout(done, 25));
  }
  throw new Error('Timed out waiting for file review');
}
async function workspace(app: Application): Promise<{ tasks: Task[]; issues: { message: string }[] }> {
  return await (await fetch(`${app.address}/api/workspace`)).json();
}

it('accepts a renamed workflow approval and continues to the next review', async () => {
  const { workspaceRoot, app } = await setup(true);
  await mkdir(join(workspaceRoot, 'drafts'));
  await writeFile(join(workspaceRoot, 'drafts', 'idea.md'), '# File review idea\n');
  const task = await until(async () => (await workspace(app)).tasks[0],
    task => Boolean(task?.reviews.some(review => review.kind === 'workflow' && review.decision === null)));
  const draft = await until(() => readdir(join(workspaceRoot, 'reviews')).catch(() => [] as string[]),
    names => names.some(name => name.endsWith('.md') && !name.endsWith('.receipt.md')));
  const name = draft.find(item => item.endsWith('.md') && !item.endsWith('.receipt.md'))!;
  const path = join(workspaceRoot, 'reviews', name);
  const text = await readFile(path, 'utf8');
  expect(text).toContain('## Workflow scope');
  await writeFile(path, text.replace('action: \n', 'action: approve\n'));
  await rename(path, join(workspaceRoot, 'reviews', name.replace(/\.md$/, '.ready.md')));
  const continued = await until(async () => (await workspace(app)).tasks.find(item => item.id === task.id)!,
    item => item.reviews.some(review => review.kind === 'artifact' && review.decision === null));
  expect(continued.runs.some(run => run.stepId === 'research')).toBe(true);
  const receipt = await readFile(join(workspaceRoot, 'reviews', name.replace(/\.md$/, '.receipt.md')), 'utf8');
  expect(receipt).toContain('Accepted');
});

it('leaves ready files inert when disabled and reports unknown files when enabled', async () => {
  const pending = waitingTask();
  const disabled = await setup(false, async workspaceRoot => {
    const store = await openStore(workspaceRoot);
    await store.create(pending, 'seed-waiting');
    const request = makeRequest(pending, pending.reviews[0], crypto.randomUUID());
    await mkdir(join(workspaceRoot, 'reviews'));
    await writeFile(join(workspaceRoot, 'reviews', `${request.basename}.ready.md`),
      renderDraft(request).replace('action: \n', 'action: approve\n'));
  });
  await new Promise(done => setTimeout(done, 100));
  const unchanged = (await workspace(disabled.app)).tasks.find(task => task.id === pending.id)!;
  expect(unchanged).toMatchObject({ revision: pending.revision, status: 'waiting-for-human' });
  expect(unchanged.reviews[0].decision).toBeNull();
  await expect(readdir(join(disabled.localRoot, 'file-reviews'))).rejects.toMatchObject({ code: 'ENOENT' });
  const enabled = await setup(true, async workspaceRoot => {
    await mkdir(join(workspaceRoot, 'reviews'));
    await writeFile(join(workspaceRoot, 'reviews', 'stray.ready.md'), 'action: approve\n');
  });
  const view = await until(() => workspace(enabled.app), result => result.issues.some(issue => issue.message.includes('stray.ready.md')));
  expect(view.tasks).toHaveLength(0);
});
