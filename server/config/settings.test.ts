import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadSettings } from './settings.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('applies safe defaults to disjoint roots and an executable CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'symphony-settings-')); roots.push(root);
  const workspaceRoot = join(root, 'synced'); const localRoot = join(root, 'local'); const codexBinary = join(root, 'codex');
  await mkdir(workspaceRoot); await mkdir(localRoot); await writeFile(codexBinary, '#!/bin/sh\n'); await chmod(codexBinary, 0o755);
  const path = join(root, 'settings.json'); await writeFile(path, JSON.stringify({ workspaceRoot, localRoot, codexBinary }));
  const settings = await loadSettings(path);
  expect(settings).toMatchObject({ port: 4317, concurrency: 1, scanMs: 2000, stableMs: 2000,
    runTimeoutMs: 1_800_000, stopGraceMs: 5000, outputLimitBytes: 10_485_760,
    allowedOrigin: 'http://127.0.0.1:4317', environmentKeys: [], fileReviewsEnabled: false, phoneDraftsEnabled: false });
});

it('accepts only a boolean phone draft setting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'symphony-settings-')); roots.push(root);
  const workspaceRoot = join(root, 'synced'); const localRoot = join(root, 'local'); const codexBinary = process.execPath;
  await mkdir(workspaceRoot); await mkdir(localRoot);
  const path = join(root, 'settings.json');
  for (const phoneDraftsEnabled of [true, false]) {
    await writeFile(path, JSON.stringify({ workspaceRoot, localRoot, codexBinary, phoneDraftsEnabled }));
    expect((await loadSettings(path)).phoneDraftsEnabled).toBe(phoneDraftsEnabled);
  }
  for (const phoneDraftsEnabled of ['true', 1, null, [], {}]) {
    await writeFile(path, JSON.stringify({ workspaceRoot, localRoot, codexBinary, phoneDraftsEnabled }));
    await expect(loadSettings(path)).rejects.toThrow(/phoneDraftsEnabled/);
  }
});

it('accepts only an explicit boolean file review opt-in', async () => {
  const root = await mkdtemp(join(tmpdir(), 'symphony-settings-')); roots.push(root);
  const workspaceRoot = join(root, 'synced'); const localRoot = join(root, 'local'); const codexBinary = join(root, 'codex');
  await mkdir(workspaceRoot); await mkdir(localRoot); await writeFile(codexBinary, '#!/bin/sh\n'); await chmod(codexBinary, 0o755);
  const path = join(root, 'settings.json');
  for (const enabled of [false, true]) {
    await writeFile(path, JSON.stringify({ workspaceRoot, localRoot, codexBinary, fileReviewsEnabled: enabled }));
    expect((await loadSettings(path)).fileReviewsEnabled).toBe(enabled);
  }
  for (const fileReviewsEnabled of ['true', 1, null, [], {}]) {
    await writeFile(path, JSON.stringify({ workspaceRoot, localRoot, codexBinary, fileReviewsEnabled }));
    await expect(loadSettings(path)).rejects.toThrow(/fileReviewsEnabled/);
  }
});

it('rejects nested roots and missing binary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'symphony-settings-')); roots.push(root);
  const workspaceRoot = join(root, 'synced'); await mkdir(workspaceRoot); await mkdir(join(workspaceRoot, 'local'));
  const path = join(root, 'settings.json');
  await writeFile(path, JSON.stringify({ workspaceRoot, localRoot: join(workspaceRoot, 'local'), codexBinary: '/missing/codex' }));
  await expect(loadSettings(path)).rejects.toThrow(/disjoint|binary/i);
});

it('reports an unavailable Codex binary after root validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'symphony-settings-')); roots.push(root);
  const workspaceRoot = join(root, 'synced'); const localRoot = join(root, 'local');
  await mkdir(workspaceRoot); await mkdir(localRoot);
  const path = join(root, 'settings.json');
  await writeFile(path, JSON.stringify({ workspaceRoot, localRoot, codexBinary: join(root, 'missing-codex') }));
  await expect(loadSettings(path)).rejects.toThrow(/Codex binary/);
});

it('rejects allowedOrigin values containing a URL path, query or fragment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'symphony-settings-')); roots.push(root);
  const workspaceRoot = join(root, 'synced'); const localRoot = join(root, 'local'); const codexBinary = join(root, 'codex');
  await mkdir(workspaceRoot); await mkdir(localRoot); await writeFile(codexBinary, '#!/bin/sh\n'); await chmod(codexBinary, 0o755);
  const path = join(root, 'settings.json');
  for (const allowedOrigin of ['http://127.0.0.1:4317/path', 'http://127.0.0.1:4317?x=1', 'http://127.0.0.1:4317#x']) {
    await writeFile(path, JSON.stringify({ workspaceRoot, localRoot, codexBinary, allowedOrigin }));
    await expect(loadSettings(path)).rejects.toThrow(/allowedOrigin/);
  }
});
