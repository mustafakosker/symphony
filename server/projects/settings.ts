import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import type { RootSetting } from '../../shared/projects.js';
import type { Settings } from '../config/settings.js';
import { BoundaryError } from '../../shared/validate.js';
import { confinedPath } from '../store/paths.js';
import { writeAtomic } from '../store/atomic.js';
export type ProjectSettingsService = {
 read(): Promise<RootSetting>;
 save(input: { projectsRoot: string | null; expectedRevision: string; requestId: string }): Promise<RootSetting>;
};
const digest = (input: string) => createHash('sha256').update(input).digest('hex');
const within = (path: string, root: string) => path === root || path.startsWith(root + sep);
type Intent = { before: string; after: string; bytes: string; root: string | null; generation: string;
 requestId: string; inputDigest: string };
type State = { root: string | null; generation: string; intent: Intent | null;
 requests: Record<string, { digest: string; result: RootSetting }> };
export async function openProjectSettings(configPath: string, settings: Settings): Promise<ProjectSettingsService> {
 const directory = await confinedPath(settings.localRoot, 'projects/settings'); await mkdir(directory, { recursive: true });
 const statePath = await confinedPath(settings.localRoot, 'projects/settings/state.json');
 const serialize = (value: unknown) => `${JSON.stringify(value)}\n`;
 let queue: Promise<unknown> = Promise.resolve();
 function serial<T>(action: () => Promise<T>): Promise<T> { const result = queue.catch(() => {}).then(action); queue = result; return result; }
 async function document() {
  const bytes = await readFile(configPath, 'utf8'), value = JSON.parse(bytes);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BoundaryError('invalid', 'Invalid host configuration');
  if (value.projectsRoot !== undefined && value.projectsRoot !== null && (typeof value.projectsRoot !== 'string' || !isAbsolute(value.projectsRoot)))
   throw new BoundaryError('invalid', 'projectsRoot must be null or an absolute path');
  return { bytes, value, revision: digest(bytes) };
 }
 async function validRoot(input: string | null): Promise<string | null> {
  if (input === null) return null;
  if (typeof input !== 'string' || !isAbsolute(input)) throw new BoundaryError('invalid', 'Projects root must be an absolute path');
  const root = await realpath(input);
  if (!(await stat(root)).isDirectory()) throw new BoundaryError('invalid', 'Projects root is not a directory');
  await access(root, constants.R_OK | constants.X_OK);
  if ([settings.workspaceRoot, settings.localRoot].some(path => within(path, root) || within(root, path)) || within(await realpath(configPath), root))
   throw new BoundaryError('invalid', 'Projects root overlaps Symphony writable storage');
  return root;
 }
 async function result(state: State, revision: string): Promise<RootSetting> {
  if (state.root === null) return { projectsRoot: null, revision, generation: state.generation, state: 'unset', message: null };
  try {
   if (await validRoot(state.root) !== state.root) throw new Error('Projects root was redirected; save its new canonical path');
   return { projectsRoot: state.root, revision, generation: state.generation, state: 'ready', message: null };
  } catch (error) { return { projectsRoot: state.root, revision, generation: state.generation, state: 'unavailable', message: error instanceof Error ? error.message : 'Projects root unavailable' }; }
 }
 async function load(): Promise<{ state: State; doc: Awaited<ReturnType<typeof document>> }> {
  let doc = await document(), state: State;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) {
   if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
   state = { root: doc.value.projectsRoot ?? null, generation: randomUUID(), intent: null, requests: {} };
   await writeAtomic(statePath, serialize(state));
  }
  if (state.intent) {
   const intent = state.intent;
   if (doc.revision !== intent.before && doc.revision !== intent.after) throw new BoundaryError('conflict', 'Host configuration changed during projects root save');
   if (doc.revision === intent.before) { await writeAtomic(configPath, intent.bytes); doc = await document(); }
   state.root = intent.root; state.generation = intent.generation; state.intent = null;
   state.requests[intent.requestId] = { digest: intent.inputDigest, result: await result(state, doc.revision) };
   await writeAtomic(statePath, serialize(state));
  }
  if ((doc.value.projectsRoot ?? null) !== state.root) {
   state.root = doc.value.projectsRoot ?? null; state.generation = randomUUID();
   await writeAtomic(statePath, serialize(state));
  }
  return { state, doc };
 }
 return {
  read: () => serial(async () => { const { state, doc } = await load(); return result(state, doc.revision); }),
  save: input => serial(async () => {
   if (!input.requestId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.requestId)) throw new BoundaryError('invalid', 'Invalid request ID');
   const { state, doc } = await load(), inputDigest = digest(JSON.stringify([input.projectsRoot, input.expectedRevision]));
   const prior = Object.hasOwn(state.requests, input.requestId) ? state.requests[input.requestId] : undefined;
   if (prior) {
    if (prior.digest !== inputDigest) throw new BoundaryError('conflict', 'Request ID already used with different settings');
    return prior.result;
   }
   if (input.expectedRevision !== doc.revision) throw new BoundaryError('conflict', 'Host settings changed; reload before saving');
   const root = await validRoot(input.projectsRoot), bytes = `${JSON.stringify({ ...doc.value, projectsRoot: root }, null, 2)}\n`;
   const intent: Intent = { before: doc.revision, after: digest(bytes), bytes, root,
    generation: root === state.root ? state.generation : randomUUID(), requestId: input.requestId, inputDigest };
   state.intent = intent; await writeAtomic(statePath, serialize(state));
   await writeAtomic(configPath, bytes);
   const recovered = await load(); return result(recovered.state, recovered.doc.revision);
  }),
 };
}
