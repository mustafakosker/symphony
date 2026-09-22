import type { SnapshotAccess } from './snapshot-access.js';
import type { AgentResult, AgentStep, Run, Task } from '../../shared/contracts.js';
import type { Settings } from '../config/settings.js';
import type { RoleConfig } from '../config/registry.js';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { buildPrompt } from './prompt.js';
import { parseAgentResult, writeResultSchema } from './result-schema.js';
import { stopProcessTree } from './process-control.js';
import { sandboxFor, verifyAssignmentProfile } from './capability.js';
import { validateDeclaredArtifacts } from './artifacts.js';
import { validateRepositoryAccess, type RepositoryAccess } from './repository-access.js';

export type Assignment = { task: Task; step: AgentStep; run: Run; role: RoleConfig;
  cwd: string; outputDir: string; schemaPath: string; repositoryAccess?: RepositoryAccess[]; snapshotAccess?: SnapshotAccess[];
  materials: Array<{ kind: 'artifact' | 'skill'; name: string; text: string }> };
export type Exit = { code: number | null; signal: string | null; result: AgentResult | null; error: string | null };
export type Running = { pid: number; processStartedAt: string; completion: Promise<Exit>; stop(): Promise<void>;
  abandon?(): void };
export type Runner = { probe(): Promise<{ version: string }>; start(assignment: Assignment, onLine: (line: string) => void): Promise<Running> };
export type LaunchOverride = { executable: string; prefixArgs: string[] };

function allowedEnvironment(settings: Settings): NodeJS.ProcessEnv {
  const keys = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'CODEX_HOME', ...settings.environmentKeys];
  return Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
}

function execute(executable: string, args: string[], environment: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ['ignore','pipe','pipe'], env: environment });
    const chunks: Buffer[] = []; let total = 0; let error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Codex capability probe timed out: ${args.join(' ')}`)); }, 5000);
    child.stdout.on('data', (chunk: Buffer) => { total += chunk.length; if (total > 65536) child.kill(); else chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString('utf8').slice(0, 4096); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (total > 65536 || code !== 0) reject(new Error(`Codex capability probe failed (${code}): ${error}`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function requiredHelp(root: string, exec: string): void {
  if (!root.includes('--ask-for-approval') || !root.includes('--profile') || !root.includes('--sandbox') ||
      !exec.includes('--json') || !exec.includes('--output-schema') ||
      !exec.includes('--output-last-message') || !exec.includes('--cd') || !exec.includes('--add-dir')) {
    throw new Error('Codex CLI lacks required noninteractive exec, profile, sandbox, JSONL, schema, final-output or cwd capability');
  }
}

function inside(path: string, root: string): boolean { return path === root || path.startsWith(root + sep); }

function validateMaterials(assignment: Assignment): void {
  const expected = [
    ...assignment.role.skills.map(name => `skill:${name}`),
    ...assignment.run.inputRefs.map(ref => `artifact:${ref.id}@${ref.version}`),
  ];
  const actual = assignment.materials.map(item => `${item.kind}:${item.name}`);
  if (new Set(actual).size !== actual.length || actual.length !== expected.length ||
      !expected.every(item => actual.includes(item)) ||
      assignment.materials.some(item => typeof item.text !== 'string') ||
      Buffer.byteLength(JSON.stringify(assignment.materials)) > 1024 * 1024) {
    throw new Error('Staged skill/artifact materials are missing, unexpected or oversized');
  }
}

export function createCodexRunner(settings: Settings, launchOverride?: LaunchOverride): Runner {
  const executable = launchOverride?.executable ?? settings.codexBinary;
  const prefix = launchOverride?.prefixArgs ?? [];
  const environment = allowedEnvironment(settings);
  let probed: Promise<{ version: string }> | null = null;
  const probe = () => probed ??= (async () => {
    if (process.platform === 'win32')
      throw new Error('Windows process-tree termination requires a verified host test before execution');
    const [versionOutput, rootHelp, execHelp] = await Promise.all([
      execute(executable, [...prefix, '--version'], environment),
      execute(executable, [...prefix, '--help'], environment),
      execute(executable, [...prefix, 'exec', '--help'], environment),
    ]);
    requiredHelp(rootHelp, execHelp);
    const match = versionOutput.trim().match(/^codex-cli\s+(\S+)$/);
    if (!match) throw new Error('Codex CLI returned an unrecognized version');
    return { version: match[1] };
  })();
  return { probe, async start(assignment, onLine) {
    const { version } = await probe();
    if (assignment.step.role !== assignment.role.role ||
        !assignment.step.actions.every(action => assignment.role.actions.includes(action)))
      throw new Error('Assignment exceeds role actions');
    validateMaterials(assignment);
    await validateRepositoryAccess(assignment, settings.localRoot);
    const { sandbox, cliProfile } = launchOverride ? { sandbox: sandboxFor(assignment), cliProfile: assignment.role.cliProfile }
      : await verifyAssignmentProfile(settings, assignment, version);
    const localRoot = await realpath(settings.localRoot);
    const cwd = await realpath(assignment.cwd);
    const outputDir = await realpath(assignment.outputDir);
    const schemaParent = await realpath(dirname(assignment.schemaPath));
    if (![cwd, outputDir, schemaParent].every(path => inside(path, localRoot)) ||
        !isAbsolute(assignment.schemaPath) || basename(assignment.schemaPath) === '.')
      throw new Error('Assignment paths must stay inside localRoot');
    const prompt = buildPrompt({ ...assignment, role: { ...assignment.role, cliProfile } });
    await writeResultSchema(assignment.schemaPath);
    const finalPath = join(outputDir, `${assignment.run.id}.final.json`);
    await rm(finalPath, { force: true });
    const logPaths = { stdout: join(outputDir, 'stdout.log'), stderr: join(outputDir, 'stderr.log') };
    const logFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    const stdoutLog = await open(logPaths.stdout, logFlags, 0o600);
    let stderrLog: FileHandle;
    try { stderrLog = await open(logPaths.stderr, logFlags, 0o600); }
    catch (error) { await stdoutLog.close(); throw error; }
    const logs = { stdout: stdoutLog, stderr: stderrLog };
    const args = [...prefix, '-a','never','-p',cliProfile,'exec',
      '-s',sandbox,'--skip-git-repo-check','--json','--output-schema',assignment.schemaPath,
      '--output-last-message',finalPath,'-C',cwd,
      ...(sandbox === 'workspace-write' ? [...new Set([...(assignment.repositoryAccess ?? []).flatMap(item => item.checkoutPath ? [item.checkoutPath] : []), outputDir])]
        .filter(path => path !== cwd).flatMap(path => ['--add-dir', path]) : []), '-'];
    const child = spawn(executable, args, { shell: false, cwd, stdio: ['pipe','pipe','pipe'],
      detached: process.platform !== 'win32', env: environment });
    let byteCount = 0; let stopReason: string | null = null; let writeChain: Promise<void> = Promise.resolve();
    let logWriteFailure: string | null = null;
    let termination: Promise<void> | null = null;
    let terminationError: Error | null = null;
    const terminationAbort = new AbortController();
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    const partial = { stdout: '', stderr: '' };
    const writeLine = (line: string, source: 'stdout' | 'stderr') => {
      try { onLine((source === 'stderr' ? '[stderr] ' : '') + line.slice(-4096)); } catch { /* UI callback cannot break execution. */ }
    };
    const stopWith = (reason: string) => {
      if (stopReason) return;
      stopReason = reason;
      if (child.pid) termination = stopProcessTree(child.pid, settings.stopGraceMs, terminationAbort.signal).catch(error => {
        terminationError = error instanceof Error ? error : new Error(String(error));
        stopReason = `${reason}; process-tree termination failed: ${String(error)}`;
      });
    };
    const ingest = (chunk: Buffer, source: 'stdout' | 'stderr') => {
      const remaining = Math.max(0, settings.outputLimitBytes - byteCount);
      const accepted = chunk.subarray(0, remaining); byteCount += chunk.length;
      if (accepted.length) {
        writeChain = writeChain.then(() => logWriteFailure ? undefined : logs[source].writeFile(accepted))
          .catch(error => { logWriteFailure = `Log write failed: ${String(error)}`; stopWith(logWriteFailure); });
        partial[source] += decoders[source].decode(accepted, { stream: true });
        const lines = partial[source].split('\n'); partial[source] = lines.pop() ?? '';
        for (const line of lines) writeLine(line.replace(/\r$/, ''), source);
      }
      if (chunk.length > remaining) stopWith('Process output limit exceeded');
    };
    child.stdout.on('data', (chunk: Buffer) => ingest(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => ingest(chunk, 'stderr'));
    const timer = setTimeout(() => stopWith('Process timeout exceeded'), settings.runTimeoutMs);
    const completion: Promise<Exit> = new Promise(resolve => {
      let spawnError: Error | null = null;
      child.on('error', error => { spawnError = error; });
      child.on('close', async (code, signal) => {
        clearTimeout(timer);
        if (termination) await termination;
        for (const source of ['stdout','stderr'] as const) {
          partial[source] += decoders[source].decode();
          if (partial[source]) writeLine(partial[source], source);
        }
        await writeChain;
        // A queued write can fail after close begins and start termination here.
        if (termination) await termination;
        for (const source of ['stdout','stderr'] as const) {
          try {
            const [handleInfo, pathInfo] = await Promise.all([logs[source].stat(), lstat(logPaths[source])]);
            if (!pathInfo.isFile() || pathInfo.isSymbolicLink() ||
                handleInfo.dev !== pathInfo.dev || handleInfo.ino !== pathInfo.ino)
              stopReason ??= `Log path was replaced: ${source}`;
          } catch (cause) { stopReason ??= `Log path verification failed: ${String(cause)}`; }
          try { await logs[source].close(); } catch (cause) { stopReason ??= `Log close failed: ${String(cause)}`; }
        }
        let result: AgentResult | null = null; let error = stopReason ?? (spawnError ? String(spawnError) : null);
        if (!error && code !== 0) error = `Codex exited with code ${code} and signal ${signal}`;
        if (!error) {
          try {
            const info = await lstat(finalPath);
            if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('Final output is unsafe or oversized');
            result = parseAgentResult(JSON.parse(await readFile(finalPath, 'utf8')));
            if (result.taskId !== assignment.task.id || result.attemptId !== assignment.run.id)
              throw new Error('Final result task/attempt association mismatch');
            if (assignment.step.role === 'triage' && result.kind === 'completed')
              throw new Error('Triage cannot complete the whole task');
            await validateDeclaredArtifacts(result, outputDir);
          } catch (cause) { error = `Invalid or absent final result: ${String(cause)}`; result = null; }
        }
        resolve({ code, signal, result, error });
      });
    });
    child.stdin.on('error', () => { /* Close is reported through completion. */ });
    child.stdin.end(prompt);
    if (!child.pid) { await Promise.allSettled([stdoutLog.close(), stderrLog.close()]); throw new Error('Codex process failed to spawn'); }
    return { pid: child.pid, processStartedAt: new Date().toISOString(), completion,
      stop: async () => {
        stopWith('Process stopped');
        if (termination) await termination;
        if (terminationError) throw terminationError;
        await completion;
      },
      abandon: () => {
        terminationAbort.abort(new Error('Termination verification abandoned after durable uncertainty'));
        clearTimeout(timer);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        void writeChain.then(async () => { await Promise.allSettled([stdoutLog.close(), stderrLog.close()]); });
      } };
  } };
}
