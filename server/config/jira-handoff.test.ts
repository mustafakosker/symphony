import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadJiraHandoffConfig } from './jira-handoff';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });
it('loads opt-in mock configuration and rejects unknown mapped projects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jira-config-')); roots.push(root);
  const path = join(root, 'jira.json');
  const value = { mode: 'mock', connectionId: 'demo', fixturesPath: join(root, 'issues.json'), projectMappings: {} };
  await writeFile(path, JSON.stringify(value));
  expect(await loadJiraHandoffConfig(path, { projects: [], roles: [] })).toEqual(value);
  await writeFile(path, JSON.stringify({ ...value, projectMappings: { APP: 'missing' } }));
  await expect(loadJiraHandoffConfig(path, { projects: [], roles: [] })).rejects.toThrow();
});
