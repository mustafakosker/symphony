import { verifySnapshotProfile } from './snapshot-capability.js';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { Settings } from '../config/settings.js';
import type { RoleConfig } from '../config/registry.js';
import type { ActionClass } from '../../shared/contracts.js';
import type { Assignment } from './adapter.js';

export type SandboxMode = 'read-only' | 'workspace-write';
type FileDigest = { path: string; sha256: string };
type VerifiedProfile = { role: string; profile: string; executionProfile?: string; cliVersion: string; sandbox: SandboxMode;
  repositories?: Array<{ repository: string; localPath: string | null; mcpProfile: string | null }>;
  actions: string[]; environmentKeys: string[]; coveredFiles: FileDigest[]; checks: string[] };

export function sandboxFor(assignment: Assignment): SandboxMode {
  return sandboxForActions(assignment.step.actions);
}
const sandboxForActions = (actions: ActionClass[]): SandboxMode => actions.every(action => action === 'read') ? 'read-only' : 'workspace-write';

const same = (a: string[], b: string[]) => a.length === b.length &&
  new Set(a).size === a.length && new Set(b).size === b.length && a.every(item => b.includes(item));
const within = (path: string, parent: string) => path === parent || path.startsWith(parent + sep);

export async function verifyProfile(settings: Settings, assignment: Assignment, version: string): Promise<SandboxMode> {
  return (await verifyAssignmentProfile(settings, assignment, version)).sandbox;
}

const scopeKey = (item: { repository: string; localPath: string | null; mcpProfile: string | null }) =>
  JSON.stringify([item.repository, item.localPath, item.mcpProfile]);

export async function verifyAssignmentProfile(settings: Settings, assignment: Assignment, version: string): Promise<{ sandbox: SandboxMode; cliProfile: string }> {
  if (assignment.task.schemaVersion === 2) return verifySnapshotProfile(settings, assignment, version);
  if (new Set(assignment.role.actions).size !== assignment.role.actions.length ||
      new Set(assignment.step.actions).size !== assignment.step.actions.length)
    throw new Error('Duplicate capability actions');
  if (!assignment.step.actions.every(action => assignment.role.actions.includes(action)) ||
      !same(assignment.step.actions, assignment.role.actions))
    throw new Error('Profile actions exceed this step; use an isolated role/profile before merge or deploy');
  const profiles = await readProfiles(settings);
  const scope = (assignment.repositoryAccess ?? []).map(({ repository, localPath, mcpProfile }) => ({ repository, localPath, mcpProfile }));
  if (scope.length !== assignment.step.repositories.length ||
      !assignment.step.repositories.every(id => scope.some(item => item.repository === id)))
    throw new Error('Capability verification repository scope does not match the selected assignment');
  const matches = profiles.filter(profile => profile.role === assignment.role.role && profile.profile === assignment.role.cliProfile &&
    Array.isArray(profile.repositories ?? []) && same(scope.map(scopeKey), (profile.repositories ?? []).map(scopeKey)));
  if (matches.length !== 1) throw new Error('Capability verification repository scope requires exactly one matching isolated profile');
  const profile = matches[0];
  const sandbox = await verifyRoleProfile(settings, assignment.role, version, profile);
  return { sandbox, cliProfile: profile.executionProfile ?? profile.profile };
}

export async function verifyConfiguredProfiles(settings: Settings, roles: RoleConfig[], version: string): Promise<void> {
  if (!roles.length) throw new Error('No roles configured for capability verification');
  const profiles = await readProfiles(settings);
  for (const role of roles) {
    const matching = profiles.filter(profile => profile.role === role.role && profile.profile === role.cliProfile);
    if (!matching.length) throw new Error(`Capability verification missing profile for ${role.role}`);
    const scopes = new Set<string>(); const names = new Set<string>();
    for (const profile of matching) {
      await verifyRoleProfile(settings, role, version, profile);
      const scope = JSON.stringify((profile.repositories ?? []).map(scopeKey).sort());
      const name = profile.executionProfile ?? profile.profile;
      if (scopes.has(scope) || names.has(name)) throw new Error('Duplicate repository scope or isolated CLI profile');
      scopes.add(scope); names.add(name);
    }
  }
}

async function readProfiles(settings: Settings): Promise<VerifiedProfile[]> {
  if (!settings.verifiedProfilesPath) throw new Error('Capability verification required: set verifiedProfilesPath after deployment sentinel/tool-denial probes');
  const manifestPath = await realpath(settings.verifiedProfilesPath);
  if (!within(manifestPath, settings.localRoot)) throw new Error('Capability verification file escaped localRoot');
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { profiles?: unknown }).profiles))
    throw new Error('Invalid capability verification manifest');
  const profiles = (parsed as { profiles: VerifiedProfile[] }).profiles;
  if (profiles.some(profile => !profile || typeof profile !== 'object')) throw new Error('Invalid capability profile');
  return profiles;
}

async function verifyRoleProfile(settings: Settings, role: RoleConfig, version: string, profile: VerifiedProfile): Promise<SandboxMode> {
  if ([profile.actions, profile.environmentKeys, profile.checks].some(items =>
      Array.isArray(items) && new Set(items).size !== items.length))
    throw new Error('Duplicate capability actions, environment names or check labels');
  const sandbox = sandboxForActions(role.actions);
  if (profile.cliVersion !== version || profile.sandbox !== sandbox ||
      !Array.isArray(profile.actions) || !same(profile.actions, role.actions) ||
      !Array.isArray(profile.environmentKeys) || !same(profile.environmentKeys, settings.environmentKeys)) {
    throw new Error('Capability verification mismatch for role, CLI version, sandbox, actions or environment');
  }
  const scopes = profile.repositories ?? [];
  if (!Array.isArray(scopes) || scopes.some(item => !item || typeof item.repository !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(item.repository) ||
      !((typeof item.localPath === 'string' && item.localPath.startsWith('/') && item.mcpProfile === null) ||
        (item.localPath === null && typeof item.mcpProfile === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(item.mcpProfile)))) ||
      new Set(scopes.map(item => item.repository)).size !== scopes.length)
    throw new Error('Invalid capability repository scope');
  const executionProfile = profile.executionProfile ?? profile.profile;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(executionProfile) || executionProfile.includes('..'))
    throw new Error('Invalid isolated CLI profile name');
  const requiredChecks = ['task-store-write-denied'];
  if (scopes.length) requiredChecks.push('repository-scope-verified');
  if (sandbox === 'read-only') requiredChecks.push('repository-write-denied');
  if (!profile.actions.includes('merge') && !profile.actions.includes('deploy')) requiredChecks.push('merge-deploy-tool-denied');
  else requiredChecks.push('merge-deploy-scope-verified');
  if (!Array.isArray(profile.checks) || !requiredChecks.every(check => profile.checks.includes(check)))
    throw new Error(`Capability verification missing deployment checks: ${requiredChecks.join(', ')}`);
  const codexHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex');
  const expectedFiles = [join(codexHome, 'config.toml'), join(codexHome, `${role.cliProfile}.config.toml`), join(codexHome, `${executionProfile}.config.toml`),
    join(settings.workspaceRoot, 'roles', 'roles.json'), join(settings.workspaceRoot, 'projects', 'projects.json'),
    ...role.skills];
  if (!Array.isArray(profile.coveredFiles) || !expectedFiles.every(path => profile.coveredFiles.some(file => file.path === path)))
    throw new Error('Capability verification must cover base/role, registry and selected skill files');
  for (const file of profile.coveredFiles) {
    if (!file || typeof file.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256))
      throw new Error('Invalid capability file digest');
    const actual = createHash('sha256').update(await readFile(file.path)).digest('hex');
    if (actual !== file.sha256) throw new Error(`Capability verification stale for ${file.path}`);
  }
  return sandbox;
}
