import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import type { RepoRef } from '../../shared/contracts.js';
import type { Repository } from '../config/registry.js';

async function git(repositoryPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repositoryPath, ...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`git ${args[0]} failed: ${error.trim() || code}`)));
  });
}

function safeRef(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes('..') || value.endsWith('/') || value.endsWith('.')) {
    throw new Error(`Unsafe repository rule/ref ${value}`);
  }
}
function source(repository: Repository): string {
  if (!repository.localPath) throw new Error(`Repository ${repository.id} has no local checkout for rule resolution`);
  return repository.localPath;
}
async function commit(path: string, ref: string): Promise<string> {
  safeRef(ref);
  return git(path, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

export async function resolveLocalRef(repository: Repository, rule: string): Promise<RepoRef> {
  const path = source(repository);
  const base = await commit(path, repository.baseRef).catch(() => { throw new Error(`Repository ${repository.id} baseRef ${repository.baseRef} unavailable`); });
  let head: string; let selectedCommits: string[];
  if (rule === 'latest-tag') {
    const tags = (await git(path, ['tag', '--list'])).split('\n').filter(Boolean);
    const candidates: Array<{ name: string; sha: string; time: number }> = [];
    for (const name of tags) {
      let sha: string;
      try { sha = await git(path, ['rev-parse', '--verify', `refs/tags/${name}^{commit}`]); }
      catch { continue; }
      try { await git(path, ['merge-base', '--is-ancestor', sha, base]); } catch { continue; }
      const time = Number(await git(path, ['show', '-s', '--format=%ct', sha]));
      candidates.push({ name, sha, time });
    }
    candidates.sort((a, b) => b.time - a.time || a.name.localeCompare(b.name, 'en'));
    if (!candidates.length) throw new Error(`Repository ${repository.id} rule ${rule} has no reachable tags`);
    head = candidates[0].sha; selectedCommits = [head];
  } else if (rule.startsWith('recent:')) {
    const countText = rule.slice(7);
    const count = Number(countText);
    if (!/^[1-9][0-9]*$/.test(countText) || !Number.isSafeInteger(count) || count > 1000) throw new Error(`Repository ${repository.id} invalid rule ${rule}`);
    selectedCommits = (await git(path, ['log', `-n${count}`, '--format=%H', base])).split('\n').filter(Boolean);
    if (!selectedCommits.length) throw new Error(`Repository ${repository.id} rule ${rule} has no commits`);
    head = base;
  } else {
    try { head = await commit(path, rule); } catch { throw new Error(`Repository ${repository.id} rule ${rule} unavailable`); }
    selectedCommits = [head];
  }
  return { repository: repository.id, rule, commit: head, selectedCommits };
}

type Ownership = { taskId: string; repository: string; source: string; rule: string; commit: string; selectedCommits: string[]; target: string; lastSeenCommit: string };
function safeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) throw new Error(`${label} must be a safe identifier`);
}
async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export async function prepareCheckout(localRoot: string, taskId: string, repository: Repository, ref: RepoRef): Promise<string> {
  safeId(taskId, 'taskId'); safeId(repository.id, 'repository id');
  if (!isAbsolute(localRoot)) throw new Error('localRoot must be absolute');
  const repositoryPath = await realpath(source(repository)); const hostRoot = await realpath(localRoot);
  if (hostRoot === repositoryPath || hostRoot.startsWith(repositoryPath + sep) || repositoryPath.startsWith(hostRoot + sep)) {
    throw new Error('localRoot and source repository must be disjoint');
  }
  if (ref.repository !== repository.id || !/^[0-9a-f]{40}$/.test(ref.commit) ||
      !ref.selectedCommits.length || ref.selectedCommits.some(sha => !/^[0-9a-f]{40}$/.test(sha))) throw new Error('Invalid repository revision record');
  const folder = join(hostRoot, 'tasks', taskId, 'repositories');
  const target = join(folder, repository.id);
  const record = join(folder, `${repository.id}.json`);
  await mkdir(folder, { recursive: true });
  if (await realpath(folder) !== folder) throw new Error(`Task work directory escapes localRoot through a symlink`);
  const branch = `symphony/${taskId}/${repository.id}`;
  const desired: Ownership = { taskId, repository: repository.id, source: repositoryPath, rule: ref.rule,
    commit: ref.commit, selectedCommits: ref.selectedCommits, target, lastSeenCommit: ref.commit };
  if (await exists(record)) {
    const saved = JSON.parse(await readFile(record, 'utf8')) as Ownership;
    const { lastSeenCommit, ...identity } = saved;
    const { lastSeenCommit: _original, ...expectedIdentity } = desired;
    let currentCommit: string | null = null;
    try {
      if (await exists(target) && await realpath(target) === target &&
          await git(target, ['rev-parse', '--abbrev-ref', 'HEAD']) === branch) {
        currentCommit = await git(target, ['rev-parse', '--verify', 'HEAD']);
        if (/^[0-9a-f]{40}$/.test(lastSeenCommit)) {
          await git(target, ['merge-base', '--is-ancestor', ref.commit, currentCommit]);
          await git(target, ['merge-base', '--is-ancestor', lastSeenCommit, currentCommit]);
        } else currentCommit = null;
      }
    } catch { currentCommit = null; }
    if (JSON.stringify(identity) !== JSON.stringify(expectedIdentity) || !currentCommit) {
      throw new Error(`Worktree ownership or revision conflict for ${taskId}/${repository.id}`);
    }
    if (currentCommit !== lastSeenCommit) {
      const temp = `${record}.tmp`;
      await writeFile(temp, JSON.stringify({ ...saved, lastSeenCommit: currentCommit }) + '\n');
      await rename(temp, record);
    }
    return target;
  }
  if (await exists(target)) throw new Error(`Unrecorded worktree ownership conflict for ${taskId}/${repository.id}`);
  await commit(repositoryPath, ref.commit);
  await git(repositoryPath, ['worktree', 'add', '-b', branch, target, ref.commit]);
  await writeFile(record, JSON.stringify(desired) + '\n', { flag: 'wx' });
  return target;
}
