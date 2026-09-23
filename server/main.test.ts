import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import type { Runner } from './codex/adapter.js';
import { createCodexRunner } from './codex/adapter.js';
import { loadSettings } from './config/settings.js';
import { openStore } from './store/task-store.js';
import { draftTask } from './testing/fixtures.js';
import { startApplication } from './main.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No ephemeral port');
  await new Promise<void>(done => server.close(() => done()));
  return address.port;
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'symphony-main-')); roots.push(root);
  const workspaceRoot = join(root, 'workspace'); const localRoot = join(root, 'local');
  await mkdir(join(workspaceRoot, 'projects'), { recursive: true });
  await mkdir(join(workspaceRoot, 'roles'), { recursive: true });
  await mkdir(localRoot);
  await writeFile(join(workspaceRoot, 'projects/projects.json'), '{"projects":[]}');
  await writeFile(join(workspaceRoot, 'roles/roles.json'), '{"roles":[]}');
  const configPath = join(root, 'symphony.config.json');
  const port = await unusedPort();
  await writeFile(configPath, JSON.stringify({ workspaceRoot, localRoot, codexBinary: process.execPath,
    port, scanMs: 50, stableMs: 1, stopGraceMs: 20, allowedOrigin: `http://127.0.0.1:${port}` }));
  const buildDir = join(root, 'dist'); await mkdir(join(buildDir, 'assets'), { recursive: true });
  await writeFile(join(buildDir, 'index.html'), '<h1>Ready</h1>');
  const settings = await loadSettings(configPath);
  const runner: Runner = createCodexRunner(settings, { executable: process.execPath,
    prefixArgs: [fileURLToPath(new URL('./testing/fake-cli.mjs', import.meta.url))] });
  return { root, localRoot, configPath, buildDir, runner };
}

it('serves health and built UI on loopback and releases lock on shutdown', async () => {
  const fixture = await setup();
  const app = await startApplication({ configPath: fixture.configPath, buildDir: fixture.buildDir,
    runner: fixture.runner, verifyCapabilities: async () => {} });
  try {
    expect(app.address).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(await (await fetch(app.address)).text()).toBe('<h1>Ready</h1>');
    expect(await (await fetch(`${app.address}/api/health`)).json()).toEqual({ status: 'ready', runtimeVersion: '0.fake.1' });
    await expect(readFile(join(fixture.localRoot, 'coordinator.lock/owner.json'), 'utf8')).resolves.toContain('pid');
  } finally { await app.close(); }
  await expect(readFile(join(fixture.localRoot, 'coordinator.lock/owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('wires phone opt-in to autosave-safe intake and publishes the successor through the running app', async () => {
  const fixture = await setup();
  const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
  await writeFile(fixture.configPath, JSON.stringify({ ...config, phoneDraftsEnabled: true }));
  const app = await startApplication({ configPath: fixture.configPath, buildDir: fixture.buildDir,
    runner: fixture.runner, verifyCapabilities: async () => {} });
  const draft = join(config.workspaceRoot, 'drafts/phone/New idea-001.md');
  const ideas = async () => {
    const view = await (await fetch(`${app.address}/api/workspace`)).json();
    return view.tasks.map((task: { idea: string }) => task.idea);
  };
  try {
    await expect.poll(async () => readFile(draft, 'utf8')).toBe('');
    await writeFile(draft, 'Phone idea');
    // Wait for multiple real scans without using a model assignment (the fixture has no roles).
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(await ideas()).toEqual([]);
    await rename(draft, draft.replace('.md', '.ready.md'));
    await expect.poll(ideas).toEqual(['Phone idea']);
    await expect.poll(async () => readFile(join(config.workspaceRoot, 'drafts/phone/New idea-002.md'), 'utf8')).toBe('');
  } finally { await app.close(); }
});

it('releases the host lock after a capability probe fails before dispatch', async () => {
  const fixture = await setup();
  await expect(startApplication({ configPath: fixture.configPath, buildDir: fixture.buildDir,
    runner: { ...fixture.runner, probe: async () => { throw new Error('unsupported CLI'); } },
    verifyCapabilities: async () => {} })).rejects.toThrow(/unsupported CLI/);
  await expect(readFile(join(fixture.localRoot, 'coordinator.lock/owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps the real capability gate closed without a deployment attestation', async () => {
  const fixture = await setup();
  await expect(startApplication({ configPath: fixture.configPath, buildDir: fixture.buildDir,
    runner: fixture.runner })).rejects.toThrow(/capability verification|No roles configured/i);
  await expect(readFile(join(fixture.localRoot, 'coordinator.lock/owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('closes HTTP and releases the lock after persisting an unconfirmed run', async () => {
  const fixture = await setup();
  const settings = await loadSettings(fixture.configPath);
  await writeFile(join(settings.workspaceRoot, 'roles/roles.json'), JSON.stringify({ roles: [{ role: 'triage',
    instructions: 'Classify', skills: [], cliProfile: 'triage', actions: ['read'] }] }));
  const store = await openStore(settings.workspaceRoot);
  const task = await store.create(draftTask(), 'create');
  const runner: Runner = { probe: async () => ({ version: 'fake' }),
    async start() { return { pid: 99999, processStartedAt: task.createdAt,
      completion: new Promise(() => {}), stop: () => new Promise<void>(() => {}), abandon() {} }; } };
  const app = await startApplication({ configPath: fixture.configPath, buildDir: fixture.buildDir,
    runner, verifyCapabilities: async () => {} });
  let phase: string | undefined;
  for (let i = 0; i < 100 && phase !== 'running'; i++) {
    const view = await (await fetch(`${app.address}/api/tasks/${task.id}`)).json();
    phase = view.runs[0]?.phase;
    if (phase !== 'running') await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(phase).toBe('running');
  await Promise.race([app.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('app close hung')), 2500))]);
  const reopened = await openStore(settings.workspaceRoot);
  expect((await reopened.get(task.id)).runs[0].phase).toBe('uncertain');
  await expect(readFile(join(fixture.localRoot, 'coordinator.lock/owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('bounds app close while process start is pending and fences a late handle', async () => {
  const fixture = await setup();
  const settings = await loadSettings(fixture.configPath);
  await writeFile(join(settings.workspaceRoot, 'roles/roles.json'), JSON.stringify({ roles: [{ role: 'triage',
    instructions: 'Classify', skills: [], cliProfile: 'triage', actions: ['read'] }] }));
  const store = await openStore(settings.workspaceRoot);
  const task = await store.create(draftTask(), 'create');
  let entered!: () => void; let release!: () => void; let stopped!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stopReached = new Promise<void>(resolve => { stopped = resolve; });
  let abandoned = 0;
  const runner: Runner = { probe: async () => ({ version: 'fake' }),
    async start() { entered(); await gate; return { pid: 99999, processStartedAt: task.createdAt,
      completion: new Promise(() => {}), stop: async () => { stopped(); }, abandon: () => { abandoned++; } }; } };
  const app = await startApplication({ configPath: fixture.configPath, buildDir: fixture.buildDir,
    runner, verifyCapabilities: async () => {} });
  try {
    await Promise.race([reached, new Promise((_, reject) => setTimeout(() => reject(new Error('start not reached')), 2500))]);
    await expect(Promise.race([app.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('app close hung')), 2500))]))
      .rejects.toThrow(/stoppable handle/);
    expect((await (await openStore(settings.workspaceRoot)).get(task.id)).runs[0].phase).toBe('uncertain');
    await expect(readFile(join(fixture.localRoot, 'coordinator.lock/owner.json'), 'utf8')).resolves.toContain('pid');
  } finally { release(); }
  await Promise.race([stopReached, new Promise((_, reject) => setTimeout(() => reject(new Error('late handle was not stopped')), 2500))]);
  for (let i = 0; i < 100 && abandoned === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(abandoned).toBe(1);
  expect((await (await openStore(settings.workspaceRoot)).get(task.id)).runs[0].result).toBeNull();
});

it('holds phone submissions for project resolution before advancing the phone template', async () => {
  const fixture = await setup();
  const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
  const projectsRoot = join(fixture.root, 'sources');
  await mkdir(projectsRoot);
  await writeFile(fixture.configPath, JSON.stringify({ ...config, phoneDraftsEnabled: true, projectsRoot }));
  const app = await startApplication({ configPath: fixture.configPath, buildDir: fixture.buildDir,
    runner: fixture.runner, verifyCapabilities: async () => {} });
  const draft = join(config.workspaceRoot, 'drafts/phone/New idea-001.md');
  try {
    await expect.poll(async () => readFile(draft, 'utf8')).toBe('');
    await writeFile(draft, '# [missing-project] Investigate\n\nPhone context');
    await rename(draft, draft.replace('.md', '.ready.md'));
    const pending = async () => (await fetch(`${app.address}/api/project-submissions`)).json();
    await expect.poll(async () => (await pending()).length, { timeout: 3000 }).toBe(1);
    const [submission] = await pending();
    expect(submission.preview.problems[0].code).toBe('unknown-target');
    expect((await (await fetch(`${app.address}/api/workspace`)).json()).tasks).toEqual([]);
    await expect(readFile(join(config.workspaceRoot, 'drafts/phone/New idea-002.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    const post = (path: string, value: unknown) => fetch(app.address + path, { method: 'POST',
      headers: { Origin: app.address, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const text = { title: 'Investigate', description: 'Phone context' }, choices = { excludedReferenceIds: [], ambiguities: {} };
    const preview = await (await post('/api/projects/resolve', { text, choices })).json();
    const response = await post(`/api/project-submissions/${submission.submissionId}/resolve`, {
      expectedRevision: submission.revision, requestId: 'resolve-phone', projectDraft: {
        text, choices, previewRevision: preview.revision, catalogRevision: preview.catalogRevision, selections: [] } });
    expect(response.status).toBe(202);
    await expect.poll(async () => (await (await fetch(`${app.address}/api/workspace`)).json()).tasks.length).toBe(1);
    await expect.poll(async () => readFile(join(config.workspaceRoot, 'drafts/phone/New idea-002.md'), 'utf8')).toBe('');
  } finally { await app.close(); }
});
