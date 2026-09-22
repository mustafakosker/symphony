import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { verifyProfile, verifyConfiguredProfiles } from './capability.js';
import { createCodexRunner, type Assignment } from './adapter.js';
import type { Settings } from '../config/settings.js';
import { draftTask } from '../testing/fixtures.js';

const roots: string[] = []; const oldHome = process.env.CODEX_HOME;
afterEach(async () => {
  if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'symphony-capability-')); roots.push(root);
  const codexHome = join(root, 'codex-home'); await mkdir(codexHome);
  const workspaceRoot = join(root, 'synced');
  await mkdir(join(workspaceRoot, 'roles'), { recursive: true });
  await mkdir(join(workspaceRoot, 'projects'), { recursive: true });
  process.env.CODEX_HOME = codexHome;
  const base = join(codexHome, 'config.toml'); const profile = join(codexHome, 'researcher.config.toml');
  const roles = join(workspaceRoot, 'roles', 'roles.json'); const projects = join(workspaceRoot, 'projects', 'projects.json');
  await writeFile(base, 'approval_policy = "never"\n');
  await writeFile(profile, 'sandbox_mode = "read-only"\n');
  await writeFile(roles, '{"roles":[]}'); await writeFile(projects, '{"projects":[]}');
  const hash = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
  const manifestPath = join(root, 'verified.json');
  const entry = { role: 'researcher', profile: 'researcher', cliVersion: '0.fake.1',
    sandbox: 'read-only', actions: ['read'], environmentKeys: [],
    coveredFiles: [base, profile, roles, projects].map(path => ({ path, sha256: '' })),
    checks: ['task-store-write-denied', 'repository-write-denied', 'merge-deploy-tool-denied'] };
  for (const file of entry.coveredFiles) file.sha256 = await hash(file.path);
  const writeManifest = () => writeFile(manifestPath, JSON.stringify({ profiles: [entry] }));
  await writeManifest();
  const settings: Settings = { workspaceRoot, localRoot: await realpath(root),
    codexBinary: process.execPath, port: 4317, concurrency: 1, scanMs: 2000, stableMs: 2000,
    runTimeoutMs: 1000, stopGraceMs: 100, outputLimitBytes: 1000,
    allowedOrigin: 'http://127.0.0.1:4317', environmentKeys: [], verifiedProfilesPath: manifestPath, fileReviewsEnabled: false, phoneDraftsEnabled: false };
  const task = draftTask();
  const assignment: Assignment = { task, cwd: root, outputDir: root, schemaPath: join(root, 'schema.json'), materials: [],
    step: { kind: 'agent', id: 'research', title: 'Research', role: 'researcher', instructions: '',
      inputs: [], repositories: [], actions: ['read'], outputs: [], checks: [] },
    role: { role: 'researcher', instructions: '', skills: [], cliProfile: 'researcher', actions: ['read'] },
    run: { id: 'attempt', stepId: 'research', workflowVersion: 1, generation: 0,
      phase: 'launch-intent', pid: null, processStartedAt: null, runtimeVersion: '0.fake.1',
      inputRefs: [], repos: [], startedAt: task.createdAt, endedAt: null, exitCode: null,
      retryCount: 0, nextRetryAt: null, result: null } };
  return { settings, assignment, entry, writeManifest, profile };
}

it('requires a deployment verification record before model launch', async () => {
  const { settings, assignment } = await setup(); settings.verifiedProfilesPath = null;
  await expect(verifyProfile(settings, assignment, '0.fake.1')).rejects.toThrow(/verifiedProfilesPath/);
});

it('checks configured roles before startup without fabricating an assignment', async () => {
  const { settings, assignment, profile } = await setup();
  await expect(verifyConfiguredProfiles(settings, [assignment.role], '0.fake.1')).resolves.toBeUndefined();
  await writeFile(profile, 'sandbox_mode = "danger-full-access"\n');
  await expect(verifyConfiguredProfiles(settings, [assignment.role], '0.fake.1')).rejects.toThrow(/stale/);
});

it('accepts only a current attestation bound to the role config, CLI and checked files', async () => {
  const { settings, assignment, profile } = await setup();
  expect(await verifyProfile(settings, assignment, '0.fake.1')).toBe('read-only');
  await expect(verifyProfile(settings, assignment, '0.new')).rejects.toThrow(/mismatch/);
  await writeFile(profile, 'sandbox_mode = "danger-full-access"\n');
  await expect(verifyProfile(settings, assignment, '0.fake.1')).rejects.toThrow(/stale/);
});

it('blocks a read step when its profile can merge or deploy', async () => {
  const { settings, assignment, entry, writeManifest } = await setup();
  assignment.role.actions.push('merge'); entry.actions.push('merge');
  await writeManifest();
  await expect(verifyProfile(settings, assignment, '0.fake.1')).rejects.toThrow(/merge|deploy/i);
});

it('rejects duplicate manifest actions, environment names and check labels', async () => {
  const { settings, assignment, entry, writeManifest } = await setup();
  entry.actions = ['read', 'read']; assignment.role.actions = ['read', 'read']; assignment.step.actions = ['read', 'read'];
  await writeManifest();
  await expect(verifyProfile(settings, assignment, '0.fake.1')).rejects.toThrow(/duplicate/i);
  entry.actions = ['read']; assignment.role.actions = ['read']; assignment.step.actions = ['read'];
  settings.environmentKeys = ['TOOL_A', 'TOOL_B']; entry.environmentKeys = ['TOOL_A', 'TOOL_A'];
  await writeManifest();
  await expect(verifyProfile(settings, assignment, '0.fake.1')).rejects.toThrow(/duplicate|environment/i);
  settings.environmentKeys = []; entry.environmentKeys = []; entry.checks.push('task-store-write-denied');
  await writeManifest();
  await expect(verifyProfile(settings, assignment, '0.fake.1')).rejects.toThrow(/duplicate/i);
});


it('requires exact selected repository scope in the deployment attestation', async () => {
  const { settings, assignment, entry, writeManifest } = await setup();
  assignment.step.repositories = ['remote'];
  assignment.repositoryAccess = [{ repository: 'remote', rule: 'main', commit: null, selectedCommits: [],
    localPath: null, checkoutPath: null, mcpProfile: 'approved-connection' }];
  await expect(verifyProfile(settings, assignment, '0.fake.1')).rejects.toThrow(/repository scope/i);
  Object.assign(entry, { repositories: [{ repository: 'remote', localPath: null, mcpProfile: 'approved-connection' }] });
  entry.checks.push('repository-scope-verified'); await writeManifest();
  expect(await verifyProfile(settings, assignment, '0.fake.1')).toBe('read-only');
  assignment.repositoryAccess[0].mcpProfile = 'different-connection';
  await expect(verifyProfile(settings, assignment, '0.fake.1')).rejects.toThrow(/repository scope/i);
  assignment.step.repositories = []; assignment.repositoryAccess = [];
  await expect(verifyProfile(settings, assignment, '0.fake.1')).rejects.toThrow(/repository scope/i);
});

it('selects isolated CLI profiles for different exact repository scopes under one role', async () => {
  const { settings, assignment, entry } = await setup();
  const profiles = [];
  for (const repository of ['alpha', 'beta']) {
    const executionProfile = `researcher-${repository}`;
    const path = join(process.env.CODEX_HOME!, `${executionProfile}.config.toml`);
    await writeFile(path, `# isolated ${repository}\n`);
    profiles.push({ ...entry, executionProfile,
      repositories: [{ repository, localPath: null, mcpProfile: `${repository}-connection` }],
      checks: [...entry.checks, 'repository-scope-verified'],
      coveredFiles: [...entry.coveredFiles, { path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }] });
  }
  await writeFile(settings.verifiedProfilesPath!, JSON.stringify({ profiles }));
  await expect(verifyConfiguredProfiles(settings, [assignment.role], '0.fake.1')).resolves.toBeUndefined();
  for (const repository of ['beta', 'alpha']) {
    assignment.step.repositories = [repository];
    assignment.repositoryAccess = [{ repository, rule: 'main', commit: 'a'.repeat(40), selectedCommits: ['a'.repeat(40)],
      localPath: null, checkoutPath: null, mcpProfile: `${repository}-connection` }];
    await expect(verifyProfile(settings, assignment, '0.fake.1')).resolves.toBe('read-only');
  }
});


it('passes the selected attested execution profile to the CLI before any work', async () => {
  const { settings, assignment, entry } = await setup();
  const repository = 'beta'; const executionProfile = 'researcher-beta';
  const policy = join(process.env.CODEX_HOME!, `${executionProfile}.config.toml`);
  await writeFile(policy, '# isolated beta');
  Object.assign(entry, { executionProfile, repositories: [{ repository, localPath: null, mcpProfile: 'beta-connection' }] });
  entry.checks.push('repository-scope-verified');
  entry.coveredFiles.push({ path: policy, sha256: createHash('sha256').update(await readFile(policy)).digest('hex') });
  await writeFile(settings.verifiedProfilesPath!, JSON.stringify({ profiles: [entry] }));
  const ref = { repository, rule: 'main', commit: 'a'.repeat(40), selectedCommits: ['a'.repeat(40)] };
  assignment.step.repositories = [repository]; assignment.run.repos = [ref];
  assignment.repositoryAccess = [{ ...ref, localPath: null, checkoutPath: null, mcpProfile: 'beta-connection' }];
  settings.codexBinary = join(settings.localRoot, 'fake-cli');
  await writeFile(settings.codexBinary, `#!${process.execPath}\nimport ${JSON.stringify(resolve('server/testing/fake-cli.mjs'))};\n`, { mode: 0o700 });
  await writeFile(join(assignment.cwd, 'scenario.json'), JSON.stringify({ mode: 'success', taskId: assignment.task.id, attemptId: assignment.run.id }));
  const runner = createCodexRunner(settings);
  const exit = await (await runner.start(assignment, () => {})).completion;
  expect(exit.error).toBeNull();
  const args = JSON.parse(await readFile(join(assignment.cwd, 'captured-args.json'), 'utf8')) as string[];
  expect(args[args.indexOf('-p') + 1]).toBe(executionProfile);
  expect(await readFile(join(assignment.cwd, 'captured-prompt.txt'), 'utf8')).toContain('Profile: researcher-beta');
});
