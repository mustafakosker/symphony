import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { prepareCheckout, resolveLocalRef } from './workspace.js';
import type { Repository } from '../config/registry.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function git(path: string, ...args: string[]): string { return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim(); }
function datedCommit(path: string, message: string, date: string): void {
  execFileSync('git', ['-C', path, 'commit', '--allow-empty', '-m', message], {
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, encoding: 'utf8',
  });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'symphony-git-')); roots.push(root);
  const source = join(root, 'source'); const local = join(root, 'local'); await mkdir(source); await mkdir(local);
  git(source, 'init', '-q'); git(source, 'config', 'user.email', 'test@example.invalid'); git(source, 'config', 'user.name', 'Test');
  datedCommit(source, 'one', '2024-01-01T00:00:00Z'); const first = git(source, 'rev-parse', 'HEAD'); git(source, 'tag', 'v1');
  datedCommit(source, 'two', '2024-01-02T00:00:00Z'); const second = git(source, 'rev-parse', 'HEAD'); git(source, 'tag', 'v2');
  const repository: Repository = { id: 'web', localPath: source, mcpProfile: null, baseRef: 'HEAD', defaultRef: 'latest-tag' };
  return { source, local, first, second, repository };
}

it('records exact SHAs for latest tag and recent commits', async () => {
  const { repository, first, second } = await fixture();
  expect(await resolveLocalRef(repository, 'latest-tag')).toEqual({ repository: 'web', rule: 'latest-tag', commit: second, selectedCommits: [second] });
  expect(await resolveLocalRef(repository, 'recent:2')).toEqual({ repository: 'web', rule: 'recent:2', commit: second, selectedCommits: [second, first] });
  expect(await resolveLocalRef(repository, 'v1')).toEqual({ repository: 'web', rule: 'v1', commit: first, selectedCommits: [first] });
});

it('uses separate task worktrees and preserves the source checkout', async () => {
  const { source, local, repository, second } = await fixture();
  const ref = await resolveLocalRef(repository, 'HEAD');
  const one = await prepareCheckout(local, 'task-one', repository, ref);
  const two = await prepareCheckout(local, 'task-two', repository, ref);
  expect(one).not.toBe(two);
  expect(git(one, 'rev-parse', 'HEAD')).toBe(second);
  expect(git(two, 'rev-parse', 'HEAD')).toBe(second);
  expect(git(source, 'rev-parse', 'HEAD')).toBe(second);
  expect(await prepareCheckout(local, 'task-one', repository, ref)).toBe(one);
  expect(JSON.parse(await readFile(join(local, 'tasks/task-one/repositories/web.json'), 'utf8')).commit).toBe(second);
});

it('rejects unsafe refs and conflicting worktree ownership', async () => {
  const { local, repository, first, second } = await fixture();
  await expect(resolveLocalRef(repository, '--all')).rejects.toThrow(/--all/);
  await expect(resolveLocalRef(repository, 'missing-ref')).rejects.toThrow(/missing-ref/);
  const current = await resolveLocalRef(repository, 'HEAD');
  await prepareCheckout(local, 'task-one', repository, current);
  await expect(prepareCheckout(local, 'task-one', repository, { ...current, commit: first, selectedCommits: [first] })).rejects.toThrow(/revision|ownership|record/i);
  expect(current.commit).toBe(second);
});

it('does not follow a symlinked task directory outside localRoot', async () => {
  const { local, repository } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'symphony-outside-')); roots.push(outside);
  await mkdir(join(local, 'tasks'));
  await symlink(outside, join(local, 'tasks', 'task-one'));
  const ref = await resolveLocalRef(repository, 'HEAD');
  await expect(prepareCheckout(local, 'task-one', repository, ref)).rejects.toThrow(/outside|symlink|localRoot/i);
});

it('reuses an owned worktree after task commits and dirty edits but rejects a later reset', async () => {
  const { local, repository } = await fixture();
  const ref = await resolveLocalRef(repository, 'HEAD');
  const target = await prepareCheckout(local, 'task-one', repository, ref);
  await writeFile(join(target, 'change.txt'), 'committed\n');
  git(target, 'add', 'change.txt'); git(target, 'commit', '-m', 'task work');
  const taskCommit = git(target, 'rev-parse', 'HEAD');
  expect(taskCommit).not.toBe(ref.commit);
  await writeFile(join(target, 'change.txt'), 'dirty\n');
  expect(await prepareCheckout(local, 'task-one', repository, ref)).toBe(target);
  git(target, 'reset', '--hard', ref.commit);
  await expect(prepareCheckout(local, 'task-one', repository, ref)).rejects.toThrow(/revision|ownership|reset/i);
});

it('assigns different branches when two repository IDs share a source', async () => {
  const { local, repository } = await fixture();
  const first = await resolveLocalRef(repository, 'HEAD');
  const other = { ...repository, id: 'api' };
  const second = await resolveLocalRef(other, 'HEAD');
  const webPath = await prepareCheckout(local, 'task-one', repository, first);
  const apiPath = await prepareCheckout(local, 'task-one', other, second);
  expect(webPath).not.toBe(apiPath);
  expect(git(webPath, 'rev-parse', '--abbrev-ref', 'HEAD')).not.toBe(git(apiPath, 'rev-parse', '--abbrev-ref', 'HEAD'));
  expect(await prepareCheckout(local, 'task-one', other, second)).toBe(apiPath);
});

it('skips non-commit and unusual tags while selecting a reachable commit tag', async () => {
  const { source, repository, second } = await fixture();
  const blob = execFileSync('git', ['-C', source, 'hash-object', '-w', '--stdin'], { input: 'blob', encoding: 'utf8' }).trim();
  git(source, 'tag', 'blob-tag', blob);
  git(source, 'tag', 'release@2026', second);
  expect(await resolveLocalRef(repository, 'latest-tag')).toMatchObject({ commit: second, selectedCommits: [second] });
});
