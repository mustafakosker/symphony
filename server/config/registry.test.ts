import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadRegistry, matchProjects, type Registry } from './registry.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('returns all matching projects for clarification', () => {
  const registry: Registry = { roles: [], projects: [
    { id: 'one', names: ['Sales'], repositories: [] },
    { id: 'two', names: ['Sales'], repositories: [] },
  ] };
  expect(matchProjects(registry, 'sales').map(project => project.id)).toEqual(['one', 'two']);
});

it('loads explicit repository and role capability configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'symphony-registry-')); roots.push(root);
  await mkdir(join(root, 'projects')); await mkdir(join(root, 'roles'));
  await writeFile(join(root, 'projects/projects.json'), JSON.stringify({ projects: [
    { id: 'sales', names: ['Digital Sales', 'Sales'], repositories: [
      { id: 'web', localPath: '/tmp/example-web', mcpProfile: null, baseRef: 'main', defaultRef: 'latest-tag' },
    ] },
  ] }));
  await writeFile(join(root, 'roles/roles.json'), JSON.stringify({ roles: [
    { role: 'researcher', instructions: 'Read project evidence', skills: [], cliProfile: 'read-only', actions: ['read'] },
  ] }));
  const registry = await loadRegistry(root);
  expect(registry.projects[0].repositories[0].defaultRef).toBe('latest-tag');
  expect(registry.roles[0].actions).toEqual(['read']);
  expect(matchProjects(registry, ' digital SALES ').map(project => project.id)).toEqual(['sales']);
});

it('rejects omitted role profile and duplicate repository identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'symphony-registry-')); roots.push(root);
  await mkdir(join(root, 'projects')); await mkdir(join(root, 'roles'));
  await writeFile(join(root, 'projects/projects.json'), JSON.stringify({ projects: [
    { id: 'sales', names: ['Sales'], repositories: [
      { id: 'web', localPath: '/tmp/a', mcpProfile: null, baseRef: 'main', defaultRef: 'main' },
      { id: 'web', localPath: '/tmp/b', mcpProfile: null, baseRef: 'main', defaultRef: 'main' },
    ] },
  ] }));
  await writeFile(join(root, 'roles/roles.json'), JSON.stringify({ roles: [
    { role: 'researcher', instructions: 'Read', skills: [], actions: ['read'] },
  ] }));
  await expect(loadRegistry(root)).rejects.toThrow(/duplicate repository|cliProfile/i);
});
