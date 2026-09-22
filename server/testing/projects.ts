import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile, lstat, readlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
export async function createProjectFixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'symphony-project-')));
  const root = join(base, 'sources'), local = join(base, 'local'), workspace = join(base, 'workspace');
  await Promise.all([root, local, workspace].map(path => mkdir(path)));
  return { base, root, local, workspace, configPath: join(base, 'config.json'),
    dispose: () => rm(base, { recursive: true, force: true }) };
}
export function git(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'user.name=Symphony Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', ...args],
      { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['pipe','pipe','pipe'] });
    let output = '', error = '';
    child.stdout.on('data', data => output += data); child.stderr.on('data', data => error += data);
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(output.trimEnd()) : reject(new Error(error)));
    child.stdin.end(input);
  });
}
export async function createRepository(root: string, name: string, files: Record<string, string>) {
  const path = join(root, name); await mkdir(path, { recursive: true });
  await git(path, ['init', '-b', 'main']);
  for (const [file, bytes] of Object.entries(files)) { await mkdir(dirname(join(path, file)), { recursive: true }); await writeFile(join(path, file), bytes); }
  await git(path, ['add', '.']); await git(path, ['commit', '--allow-empty', '-m', 'Fixture']);
  return { path, commit: await git(path, ['rev-parse', 'HEAD']) };
}
export async function treeDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(relative: string): Promise<void> {
    const path = join(root, relative), info = await lstat(path);
    hash.update(JSON.stringify([relative, info.mode]));
    if (info.isSymbolicLink()) hash.update(await readlink(path));
    else if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(relative, name));
    else hash.update(await readFile(path));
  }
  await visit(''); return hash.digest('hex');
}
export function projectContextFixture(): import('../../shared/projects.js').ProjectContext {
 const snapshot: import('../../shared/projects.js').SnapshotRef={projectId:'project',repositoryId:'project',commit:'a'.repeat(40),objectFormat:'sha1',manifestDigest:'b'.repeat(64),snapshotId:'c'.repeat(64)};
 return {version:1,generation:'g1',resolutionRevision:'d'.repeat(64),targetId:'project',referenceIds:[],projects:[{
  projectId:'project',repositoryId:'project',name:'Project',ref:'main',snapshot,brief:{version:1,digest:'e'.repeat(64),author:'human',source:snapshot,
   report:{format:'source-report-v1',text:'Project context',citations:[]},createdAt:'2026-09-22T10:00:00Z'}}]};
}
