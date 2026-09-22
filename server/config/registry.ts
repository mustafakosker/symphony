import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import type { ActionClass, Role } from '../../shared/contracts.js';

export type Repository = { id: string; localPath: string | null; mcpProfile: string | null; baseRef: string; defaultRef: string };
export type Project = { id: string; names: string[]; repositories: Repository[] };
export type RoleConfig = { role: Role; instructions: string; skills: string[]; cliProfile: string; actions: ActionClass[] };
export type Registry = { projects: Project[]; roles: RoleConfig[] };

const roles: Role[] = ['triage', 'researcher', 'prd-writer', 'implementer', 'reviewer'];
const actions: ActionClass[] = ['read', 'write-local', 'open-pr', 'merge', 'deploy'];
const key = (value: string) => value.trim().normalize('NFC').toLocaleLowerCase('en');
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};
const keys = (value: Record<string, unknown>, allowed: string[], label: string) => {
  for (const field of Object.keys(value)) if (!allowed.includes(field)) throw new Error(`${label}: unknown field ${field}`);
};
const nonempty = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
};
const identifier = (value: unknown, label: string): string => {
  const name = nonempty(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) throw new Error(`${label} must be a safe identifier`);
  return name;
};
const profile = (value: unknown, label: string): string => {
  const name = nonempty(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || name.includes('..')) throw new Error(`${label} must be a profile name without path traversal`);
  return name;
};
const array = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
};
const unique = (items: string[], label: string) => {
  if (new Set(items).size !== items.length) throw new Error(`duplicate ${label}`);
};

export function matchProjects(registry: Registry, name: string): Project[] {
  const needle = key(name);
  return registry.projects.filter(project => project.names.some(alias => key(alias) === needle));
}

export async function loadRegistry(workspaceRoot: string): Promise<Registry> {
  if (!isAbsolute(workspaceRoot)) throw new Error('workspaceRoot must be absolute');
  const projectDocument = object(JSON.parse(await readFile(join(workspaceRoot, 'projects/projects.json'), 'utf8')), 'projects.json');
  const roleDocument = object(JSON.parse(await readFile(join(workspaceRoot, 'roles/roles.json'), 'utf8')), 'roles.json');
  keys(projectDocument, ['projects'], 'projects.json'); keys(roleDocument, ['roles'], 'roles.json');
  const projects = array(projectDocument.projects, 'projects').map((raw, index): Project => {
    const item = object(raw, `projects[${index}]`);
    keys(item, ['id', 'names', 'repositories'], `projects[${index}]`);
    const id = identifier(item.id, 'project id');
    const names = array(item.names, `${id}.names`).map(value => nonempty(value, `${id} alias`));
    if (!names.length) throw new Error(`${id} needs a name`);
    unique(names.map(key), `${id} alias`);
    const repositories = array(item.repositories, `${id}.repositories`).map((rawRepo): Repository => {
      const repo = object(rawRepo, `${id} repository`);
      keys(repo, ['id', 'localPath', 'mcpProfile', 'baseRef', 'defaultRef'], `${id} repository`);
      const repoId = identifier(repo.id, 'repository id');
      const localPath = repo.localPath === null ? null : nonempty(repo.localPath, `${repoId}.localPath`);
      if (localPath !== null && !isAbsolute(localPath)) throw new Error(`${repoId}.localPath must be absolute`);
      const mcpProfile = repo.mcpProfile === null ? null : profile(repo.mcpProfile, `${repoId}.mcpProfile`);
      if (!localPath && !mcpProfile) throw new Error(`${repoId} needs localPath or mcpProfile`);
      return { id: repoId, localPath, mcpProfile,
        baseRef: nonempty(repo.baseRef, `${repoId}.baseRef`), defaultRef: nonempty(repo.defaultRef, `${repoId}.defaultRef`) };
    });
    unique(repositories.map(repo => repo.id), 'repository');
    return { id, names, repositories };
  });
  unique(projects.map(project => project.id), 'project');
  const roleConfigs = array(roleDocument.roles, 'roles').map((raw, index): RoleConfig => {
    const item = object(raw, `roles[${index}]`);
    keys(item, ['role', 'instructions', 'skills', 'cliProfile', 'actions'], `roles[${index}]`);
    if (!roles.includes(item.role as Role)) throw new Error(`unknown role ${String(item.role)}`);
    const role = item.role as Role;
    const skills = array(item.skills, `${role}.skills`).map(value => {
      const skillPath = nonempty(value, `${role} skill`);
      if (!isAbsolute(skillPath) || basename(skillPath) !== 'SKILL.md')
        throw new Error(`${role} skill must be an absolute approved SKILL.md path`);
      return skillPath;
    });
    const configuredActions = array(item.actions, `${role}.actions`).map(value => {
      if (!actions.includes(value as ActionClass)) throw new Error(`${role}: unknown action ${String(value)}`);
      return value as ActionClass;
    });
    unique(skills, `${role} skill`); unique(configuredActions, `${role} action`);
    return { role, instructions: nonempty(item.instructions, `${role}.instructions`), skills,
      cliProfile: profile(item.cliProfile, `${role}.cliProfile`), actions: configuredActions };
  });
  unique(roleConfigs.map(role => role.role), 'role');
  return { projects, roles: roleConfigs };
}
