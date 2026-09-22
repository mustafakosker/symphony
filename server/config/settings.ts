import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, resolve, sep } from 'node:path';

export type Settings = {
  workspaceRoot: string; localRoot: string; codexBinary: string;
  port: number; concurrency: number; scanMs: number; stableMs: number;
  runTimeoutMs: number; stopGraceMs: number; outputLimitBytes: number;
  allowedOrigin: string; environmentKeys: string[]; verifiedProfilesPath: string | null;
};

const defaults = { port: 4317, concurrency: 1, scanMs: 2000, stableMs: 2000,
  runTimeoutMs: 30 * 60 * 1000, stopGraceMs: 5000, outputLimitBytes: 10 * 1024 * 1024,
  allowedOrigin: 'http://127.0.0.1:4317', environmentKeys: [] as string[], verifiedProfilesPath: null as string | null };

async function binaryPath(input: string): Promise<string> {
  const candidates = input.includes('/') ? [input] : (process.env.PATH ?? '').split(delimiter).map(dir => resolve(dir, input));
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate); await access(candidate, constants.X_OK);
      if (info.isFile()) return await realpath(candidate);
    } catch { /* Try next PATH directory. */ }
  }
  throw new Error(`Codex binary ${input} is unavailable or not executable`);
}

export async function loadSettings(path: string): Promise<Settings> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('settings.json must be an object');
  const input = raw as Record<string, unknown>;
  for (const field of Object.keys(input)) if (!['workspaceRoot', 'localRoot', 'codexBinary', ...Object.keys(defaults)].includes(field)) throw new Error(`Unknown settings field ${field}`);
  for (const field of ['workspaceRoot', 'localRoot', 'codexBinary']) if (typeof input[field] !== 'string' || !input[field]) throw new Error(`${field} is required`);
  const workspaceRoot = input.workspaceRoot as string, localRoot = input.localRoot as string;
  if (!isAbsolute(workspaceRoot) || !isAbsolute(localRoot)) throw new Error('workspaceRoot and localRoot must be absolute');
  const workspace = await realpath(workspaceRoot); const local = await realpath(localRoot);
  if (workspace === local || workspace.startsWith(local + sep) || local.startsWith(workspace + sep)) throw new Error('workspaceRoot and localRoot must be disjoint');
  const settings: Settings = { ...defaults, ...input, workspaceRoot: workspace, localRoot: local,
    codexBinary: await binaryPath(input.codexBinary as string) } as Settings;
  for (const field of ['port', 'concurrency', 'scanMs', 'stableMs', 'runTimeoutMs', 'stopGraceMs', 'outputLimitBytes'] as const) {
    if (!Number.isSafeInteger(settings[field]) || settings[field] <= 0 || (field === 'port' && settings[field] > 65535)) throw new Error(`${field} must be a positive integer`);
  }
  try {
    const origin = new URL(settings.allowedOrigin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== settings.allowedOrigin) throw new Error('invalid origin');
  } catch { throw new Error('allowedOrigin must be an exact HTTP origin'); }
  if (!Array.isArray(settings.environmentKeys) || settings.environmentKeys.some(key => typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) ||
      new Set(settings.environmentKeys).size !== settings.environmentKeys.length) throw new Error('environmentKeys must be unique environment variable names');
  if (settings.verifiedProfilesPath !== null && (typeof settings.verifiedProfilesPath !== 'string' ||
      !isAbsolute(settings.verifiedProfilesPath) || !settings.verifiedProfilesPath.startsWith(local + sep))) {
    throw new Error('verifiedProfilesPath must be inside localRoot, outside the synced task store');
  }
  return settings;
}
