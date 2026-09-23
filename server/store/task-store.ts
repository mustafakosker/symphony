import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactRef, DomainEvent, Issue, StoredEvent, Task, Workflow, WorkspaceView } from '../../shared/contracts.js';
import { BoundaryError, parseTask, parseWorkflow } from '../../shared/validate.js';
import { isTerminal, reduceTask, TransitionConflict } from '../domain/workflow.js';
import * as atomic from './atomic.js';
import { confinedPath } from './paths.js';
import { readRunLogFile } from './run-log.js';

const folders = ['active', 'done', 'rejected', 'cancelled'] as const;
const atomicTempName = /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Folder = typeof folders[number];
type Entry = { task: Task; folder: Folder; operations: Map<string, StoredEvent>; unavailable: boolean };
type CreationIntent = { operationId: string; payloadDigest: string; task: Task };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function byteDigest(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function json(value: unknown): string { return `${JSON.stringify(value)}\n`; }
function validId(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function safeName(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value); }
function terminalFolder(task: Task): Folder {
  if (task.status === 'done' || task.status === 'rejected' || task.status === 'cancelled') return task.status;
  return 'active';
}
function eventName(revision: number, operationId: string): string {
  return `${String(revision).padStart(10, '0')}-${createHash('sha256').update(operationId).digest('hex')}.json`;
}
function io(error: unknown, message: string): BoundaryError {
  return error instanceof BoundaryError ? error : new BoundaryError('unavailable', message, { cause: error });
}
function clone<T>(value: T): T { return structuredClone(value); }

export type Store = {
  create(task: Task, operationId: string): Promise<Task>;
  get(taskId: string): Promise<Task>;
  list(): Promise<WorkspaceView>;
  apply(taskId: string, expectedRevision: number, operationId: string, event: DomainEvent): Promise<Task>;
  recover(): Promise<Issue[]>;
  publishArtifact(taskId: string, artifactId: string, bytes: Uint8Array): Promise<ArtifactRef>;
  readArtifact(taskId: string, ref: ArtifactRef): Promise<Uint8Array>;
  readRunLog(taskId: string, runId: string, offset: number, maxBytes: number, stream?: 'stdout' | 'stderr'): Promise<{ text: string; nextOffset: number; complete: boolean }>;
  publishWorkflow(taskId: string, workflow: Workflow): Promise<void>;
  publishRunFiles(taskId: string, attemptId: string, files: Record<string, Uint8Array>): Promise<void>;
};

class FolderStore implements Store {
  private entries = new Map<string, Entry>();
  private issues: Issue[] = [];
  private queues = new Map<string, Promise<void>>();
  constructor(private readonly root: string) {}

  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(id) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(action);
    const barrier = result.then(() => undefined, () => undefined);
    this.queues.set(id, barrier);
    void barrier.then(() => { if (this.queues.get(id) === barrier) this.queues.delete(id); });
    return result;
  }

  private entry(id: string): Entry {
    if (!validId(id)) throw new BoundaryError('invalid', 'Task ID must be a UUID');
    if (this.issues.some(issue => issue.taskId === id)) throw new BoundaryError('conflict', `Task ${id} has a storage conflict`);
    const found = this.entries.get(id);
    if (!found) throw new BoundaryError('missing', `Task ${id} does not exist`);
    if (found.unavailable) throw new BoundaryError('unavailable', `Task ${id} is unavailable after a storage write failure`);
    return found;
  }

  private async taskPath(id: string, folder: Folder, child: string): Promise<string> {
    return confinedPath(this.root, `${folder}/${id}/${child}`);
  }

  private async readCreationIntent(id: string | null, stage?: string): Promise<CreationIntent> {
    const path = stage ? await confinedPath(this.root, `.creating/${stage}/intent.json`) : await this.taskPath(id!, 'active', 'intent.json');
    let raw: CreationIntent;
    try { raw = JSON.parse(await readFile(path, 'utf8')) as CreationIntent; }
    catch (error) { throw new BoundaryError('conflict', 'Uncommitted task has no valid creation intent', { cause: error }); }
    let task: Task;
    try { task = parseTask(raw.task); }
    catch (error) { throw new BoundaryError('conflict', 'Creation intent has invalid task content', { cause: error }); }
    if ((id !== null && task.id !== id) || !validId(task.id) || task.revision !== 1 || isTerminal(task.status) || typeof raw.operationId !== 'string' || !raw.operationId ||
        raw.payloadDigest !== digest(task)) throw new BoundaryError('conflict', 'Creation intent does not bind task, content and operation');
    return { operationId: raw.operationId, payloadDigest: raw.payloadDigest, task };
  }

  private async materializeCreation(intent: CreationIntent): Promise<StoredEvent> {
    const { task, operationId } = intent;
    const dir = await confinedPath(this.root, `active/${task.id}`);
    const allowed = new Set(['intent.json', 'events', 'workflows', 'reviews', 'runs', 'artifacts', 'idea.md', 'task.json']);
    for (const name of await readdir(dir)) {
      if (!allowed.has(name) && !name.startsWith('.tmp-')) throw new BoundaryError('conflict', 'Uncommitted task contains unrelated files');
    }
    for (const child of ['events', 'workflows', 'reviews', 'runs', 'artifacts']) {
      const path = await this.taskPath(task.id, 'active', child);
      try { await mkdir(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BoundaryError('conflict', 'Uncommitted task has an invalid store directory');
    }
    const stored: StoredEvent = { operationId, payloadDigest: intent.payloadDigest, revision: 1,
      at: task.createdAt, event: { kind: 'created' }, state: task };
    await this.immutable(await this.taskPath(task.id, 'active', 'idea.md'), task.idea);
    await this.publishWorkflowVersions(task.id, 'active', task);
    await this.publishDerivedRecords(task.id, 'active', task);
    for (const ref of task.artifacts) await this.verifyArtifact(task.id, 'active', ref);
    await this.immutable(await this.taskPath(task.id, 'active', `events/${eventName(1, operationId)}`), json(stored));
    await this.immutable(await this.taskPath(task.id, 'active', 'task.json'), json(task));
    return stored;
  }

  private async verifyArtifact(id: string, folder: Folder, ref: ArtifactRef): Promise<void> {
    if (!safeName(ref.id) || ref.path !== `artifacts/${ref.id}.${ref.version}.bin`) {
      throw new BoundaryError('invalid', 'Artifact reference path does not match its identity');
    }
    let bytes: Buffer;
    try { bytes = await readFile(await this.taskPath(id, folder, ref.path)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new BoundaryError('missing', 'Referenced artifact is missing');
      throw io(error, 'Cannot read referenced artifact');
    }
    if (byteDigest(bytes) !== ref.digest) throw new BoundaryError('conflict', 'Referenced artifact digest differs from stored bytes');
  }

  private async publishWorkflowVersions(id: string, folder: Folder, task: Task): Promise<void> {
    for (const workflow of [task.workflow, task.proposedWorkflow]) {
      if (workflow) await this.immutable(await this.taskPath(id, folder, `workflows/${workflow.version}.json`), json(workflow));
    }
  }

  private async publishDerivedRecords(id: string, folder: Folder, task: Task): Promise<void> {
    const revision = String(task.revision).padStart(10, '0');
    await this.immutable(await this.taskPath(id, folder, `reviews/${revision}.json`), json(task.reviews));
    for (const run of task.runs) {
      await mkdir(await this.taskPath(id, folder, `runs/${run.id}`), { recursive: true });
      await this.immutable(await this.taskPath(id, folder, `runs/${run.id}/record-${revision}.json`), json(run));
    }
  }

  private async requireRunFile(id: string, folder: Folder, attemptId: string, name: 'input.json' | 'result.json', expected?: unknown): Promise<void> {
    let bytes: Buffer;
    try { bytes = await readFile(await this.taskPath(id, folder, `runs/${attemptId}/${name}`)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new BoundaryError('missing', `Run ${name} must be published before its event`);
      throw io(error, `Cannot read run ${name}`);
    }
    if (expected !== undefined) {
      let actual: unknown;
      try { actual = JSON.parse(bytes.toString('utf8')); }
      catch (error) { throw new BoundaryError('invalid', `Run ${name} is not JSON`, { cause: error }); }
      if (canonical(actual) !== canonical(expected)) throw new BoundaryError('conflict', `Run ${name} differs from the event`);
    }
  }

  private async moveTerminal(id: string, entry: Entry): Promise<void> {
    const destination = terminalFolder(entry.task);
    if (destination === entry.folder) return;
    const source = await confinedPath(this.root, `${entry.folder}/${id}`);
    const target = await confinedPath(this.root, `${destination}/${id}`);
    try { await lstat(target); throw new BoundaryError('conflict', `Terminal destination already exists for ${id}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(source, target);
    entry.folder = destination;
  }

  async create(input: Task, operationId: string): Promise<Task> {
    let task: Task;
    try { task = parseTask(input); }
    catch (error) { throw new BoundaryError('invalid', 'Invalid task', { cause: error }); }
    if (!operationId) throw new BoundaryError('invalid', 'Operation ID is required');
    return this.serial(task.id, async () => {
      const existing = this.entries.get(task.id);
      if (existing) {
        const prior = existing.operations.get(operationId);
        if (prior && prior.event.kind === 'created' && prior.payloadDigest === digest(task)) return clone(prior.state);
        throw new BoundaryError('conflict', `Task ${task.id} already exists`);
      }
      if (task.revision !== 1 || isTerminal(task.status)) throw new BoundaryError('invalid', 'New task must be active at revision 1');
      const dir = await confinedPath(this.root, `active/${task.id}`);
      const stage = await confinedPath(this.root, `.creating/${randomUUID()}`);
      const intent: CreationIntent = { operationId, payloadDigest: digest(task), task };
      try {
        await mkdir(stage);
        await atomic.writeAtomic(join(stage, 'intent.json'), json(intent));
        try { await lstat(dir); throw new BoundaryError('conflict', `Task ${task.id} already exists`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await rename(stage, dir);
      } catch (error) { throw io(error, 'Cannot stage new task'); }
      const entry: Entry = { task, folder: 'active', operations: new Map(), unavailable: false };
      this.entries.set(task.id, entry);
      try {
        const stored = await this.materializeCreation(intent);
        entry.operations.set(operationId, stored);
        return clone(task);
      } catch (error) { entry.unavailable = true; throw io(error, 'Cannot publish new task'); }
    });
  }

  async get(taskId: string): Promise<Task> { return clone(this.entry(taskId).task); }

  async list(): Promise<WorkspaceView> {
    const unavailable: Issue[] = [...this.entries.entries()].filter(([, entry]) => entry.unavailable)
      .map(([id]) => ({ id: `store-unavailable-${id}`, taskId: id, message: 'Task storage write failed; restart recovery is required' }));
    return { tasks: [...this.entries.entries()].filter(([id, entry]) => !entry.unavailable && !this.issues.some(issue => issue.taskId === id))
      .map(([, entry]) => clone(entry.task)), issues: clone([...this.issues, ...unavailable]), coordinator: this.issues.length || unavailable.length ? 'degraded' : 'ready' };
  }

  async apply(id: string, expectedRevision: number, operationId: string, event: DomainEvent): Promise<Task> {
    if (!operationId) throw new BoundaryError('invalid', 'Operation ID is required');
    return this.serial(id, async () => {
      const entry = this.entry(id);
      const payloadDigest = digest(event);
      const prior = entry.operations.get(operationId);
      if (prior) {
        if (prior.payloadDigest !== payloadDigest) throw new BoundaryError('conflict', 'Operation ID was used with a different payload');
        return clone(prior.state);
      }
      if (entry.task.revision !== expectedRevision) throw new BoundaryError('conflict', 'Task revision has changed');
      let next: Task;
      try { next = parseTask({ ...reduceTask(entry.task, event, new Date().toISOString()), revision: expectedRevision + 1 }); }
      catch (error) { throw new BoundaryError(error instanceof TransitionConflict ? 'conflict' : 'invalid',
        error instanceof TransitionConflict ? error.message : 'Invalid task transition', { cause: error }); }
      const stored: StoredEvent = { operationId, payloadDigest, revision: next.revision, at: next.updatedAt, event: clone(event), state: next };
      if (event.kind === 'launch') {
        await this.requireRunFile(id, entry.folder, event.run.id, 'input.json');
        for (const ref of event.run.inputRefs) await this.verifyArtifact(id, entry.folder, ref);
      }
      if (event.kind === 'finished') {
        for (const ref of event.result.artifacts) await this.verifyArtifact(id, entry.folder, ref);
        await this.requireRunFile(id, entry.folder, event.attemptId, 'result.json', event.result);
      }
      if (event.kind === 'human' && event.command.action.kind === 'approve') {
        const reviewId = event.command.action.reviewId;
        const review = entry.task.reviews.find(item => item.id === reviewId);
        if (review) for (const ref of review.artifacts) await this.verifyArtifact(id, entry.folder, ref);
      }
      try {
        await this.publishWorkflowVersions(id, entry.folder, next);
        await this.publishDerivedRecords(id, entry.folder, next);
        const path = await this.taskPath(id, entry.folder, `events/${eventName(next.revision, operationId)}`);
        try { await lstat(path); throw new BoundaryError('conflict', 'Event revision already exists'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await atomic.writeAtomic(path, json(stored));
        entry.operations.set(operationId, stored);
        entry.task = next;
        await atomic.writeAtomic(await this.taskPath(id, entry.folder, 'task.json'), json(next));
        await this.moveTerminal(id, entry);
        return clone(next);
      } catch (error) { entry.unavailable = true; throw io(error, 'Cannot publish task transition'); }
    });
  }

  private async immutable(path: string, bytes: Uint8Array | string): Promise<void> {
    try {
      const existing = await readFile(path);
      const proposed = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes);
      if (existing.equals(proposed)) return;
      throw new BoundaryError('conflict', 'Immutable file already has different content');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await atomic.writeAtomic(path, bytes);
  }

  async publishArtifact(id: string, artifactId: string, bytes: Uint8Array): Promise<ArtifactRef> {
    if (!safeName(artifactId) || !bytes || !(bytes instanceof Uint8Array)) throw new BoundaryError('invalid', 'Invalid artifact');
    return this.serial(id, async () => {
      const entry = this.entry(id);
      if (isTerminal(entry.task.status)) throw new BoundaryError('conflict', 'Terminal task is immutable');
      try {
        const dir = await this.taskPath(id, entry.folder, 'artifacts');
        const names = await readdir(dir);
        const prefix = `${artifactId}.`;
        const versions = names.map(name => name.startsWith(prefix) && name.endsWith('.bin') ? name.slice(prefix.length, -4) : '')
          .filter(version => /^\d+$/.test(version)).map(Number);
        const version = Math.max(0, ...versions) + 1;
        const relative = `artifacts/${artifactId}.${version}.bin`;
        await this.immutable(await this.taskPath(id, entry.folder, relative), bytes);
        return { id: artifactId, version, digest: byteDigest(bytes), path: relative };
      } catch (error) { if (error instanceof BoundaryError && error.code !== 'unavailable') throw error; entry.unavailable = true; throw io(error, 'Cannot publish artifact'); }
    });
  }

  async readArtifact(id: string, ref: ArtifactRef): Promise<Uint8Array> {
    return this.serial(id, async () => {
      const entry = this.entry(id);
      await this.verifyArtifact(id, entry.folder, ref);
      const bytes = await readFile(await this.taskPath(id, entry.folder, ref.path));
      if (byteDigest(bytes) !== ref.digest) throw new BoundaryError('conflict', 'Referenced artifact changed during read');
      return bytes;
    });
  }

  async readRunLog(id: string, runId: string, offset: number, maxBytes: number, stream: 'stdout' | 'stderr' = 'stdout'): Promise<{ text: string; nextOffset: number; complete: boolean }> {
    const entry = this.entry(id);
    if (!validId(runId) || !['stdout', 'stderr'].includes(stream))
      throw new BoundaryError('invalid', 'Invalid log request');
    const run = entry.task.runs.find(item => item.id === runId);
    if (!run) throw new BoundaryError('missing', 'Run does not exist');
    const path = await this.taskPath(id, entry.folder, `runs/${runId}/${stream}.log`);
    return readRunLogFile(path, run, offset, maxBytes);
  }

  async publishWorkflow(id: string, workflow: Workflow): Promise<void> {
    let parsed: Workflow;
    try { parsed = parseWorkflow(workflow); }
    catch (error) { throw new BoundaryError('invalid', 'Invalid workflow', { cause: error }); }
    return this.serial(id, async () => {
      const entry = this.entry(id);
      if (isTerminal(entry.task.status)) throw new BoundaryError('conflict', 'Terminal task is immutable');
      try { await this.immutable(await this.taskPath(id, entry.folder, `workflows/${parsed.version}.json`), json(parsed)); }
      catch (error) { if (error instanceof BoundaryError && error.code !== 'unavailable') throw error; entry.unavailable = true; throw io(error, 'Cannot publish workflow'); }
    });
  }

  async publishRunFiles(id: string, attemptId: string, files: Record<string, Uint8Array>): Promise<void> {
    if (!validId(attemptId) || Object.entries(files).some(([name, bytes]) =>
      !['input.json', 'stdout.log', 'stderr.log', 'result.json', 'process.json'].includes(name) || !(bytes instanceof Uint8Array))) {
      throw new BoundaryError('invalid', 'Invalid run file name or contents');
    }
    return this.serial(id, async () => {
      const entry = this.entry(id);
      if (isTerminal(entry.task.status)) throw new BoundaryError('conflict', 'Terminal task is immutable');
      try {
        const dir = await this.taskPath(id, entry.folder, `runs/${attemptId}`);
        await mkdir(dir, { recursive: true });
        for (const [name, bytes] of Object.entries(files)) await this.immutable(await this.taskPath(id, entry.folder, `runs/${attemptId}/${name}`), bytes);
      } catch (error) { if (error instanceof BoundaryError && error.code !== 'unavailable') throw error; entry.unavailable = true; throw io(error, 'Cannot publish run files'); }
    });
  }

  async recover(): Promise<Issue[]> {
    this.entries.clear();
    this.issues = [];
    const seen = new Set<string>();
    const moved = new Set<string>();
    const staging = await confinedPath(this.root, '.creating');
    for (const item of await readdir(staging, { withFileTypes: true })) {
      if (!validId(item.name) || !item.isDirectory() || item.isSymbolicLink()) {
        this.issues.push({ id: `creation-stage-${item.name}`, taskId: null, message: 'Invalid creation staging directory' });
        continue;
      }
      let taskId: string | null = null;
      try {
        const stagePath = await confinedPath(this.root, `.creating/${item.name}`);
        const staged = await readdir(stagePath, { withFileTypes: true });
        if (staged.every(file => file.isFile() && atomicTempName.test(file.name))) {
          for (const file of staged) await unlink(await confinedPath(this.root, `.creating/${item.name}/${file.name}`));
          await rmdir(stagePath);
          continue;
        }
        const intent = await this.readCreationIntent(null, item.name);
        taskId = intent.task.id;
        const target = await confinedPath(this.root, `active/${taskId}`);
        try { await lstat(target); throw new BoundaryError('conflict', 'Staged creation collides with an existing task directory'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await rename(stagePath, target);
      } catch (error) {
        this.issues.push({ id: `creation-stage-${item.name}`, taskId,
          message: `Cannot resume staged creation: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    for (const folder of folders) {
      const base = await confinedPath(this.root, folder);
      for (const item of await readdir(base, { withFileTypes: true })) {
        if (item.name.startsWith('.tmp-')) continue;
        const id = item.name;
        const issue = (message: string) => this.issues.push({ id: `store-${folder}-${id}`, taskId: validId(id) ? id : null, message });
        if (!validId(id) || !item.isDirectory() || item.isSymbolicLink()) { issue('Invalid or symlinked task directory'); continue; }
        if (seen.has(id)) {
          if (moved.has(id) && this.entries.get(id)?.folder === folder) continue;
          issue('Duplicate task ID across lifecycle folders'); this.entries.delete(id); continue;
        }
        seen.add(id);
        try {
          const eventDir = await this.taskPath(id, folder, 'events');
          let names: string[];
          try { names = (await readdir(eventDir)).filter(name => !name.startsWith('.tmp-')).sort(); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; names = []; }
          if (!names.length && folder === 'active') {
            const intent = await this.readCreationIntent(id);
            await this.materializeCreation(intent);
            names = (await readdir(eventDir)).filter(name => !name.startsWith('.tmp-')).sort();
          }
          if (!names.length) throw new Error('Task has no committed events');
          let state: Task | null = null;
          const operations = new Map<string, StoredEvent>();
          for (let index = 0; index < names.length; index++) {
            const name = names[index];
            const path = await this.taskPath(id, folder, `events/${name}`);
            const raw = JSON.parse(await readFile(path, 'utf8')) as StoredEvent;
            if (!raw || typeof raw.operationId !== 'string' || !raw.operationId || raw.revision !== index + 1 ||
                name !== eventName(raw.revision, raw.operationId) || operations.has(raw.operationId) ||
                typeof raw.at !== 'string' || typeof raw.payloadDigest !== 'string') throw new Error('Event sequence or operation identity is invalid');
            const parsed = parseTask(raw.state);
            if (parsed.id !== id || parsed.revision !== raw.revision) throw new Error('Event state binding is invalid');
            if (index === 0) {
              if (raw.event?.kind !== 'created' || raw.payloadDigest !== digest(parsed)) throw new Error('Creation event is invalid');
            } else {
              if (!state || raw.event.kind === 'created' || raw.payloadDigest !== digest(raw.event)) throw new Error('Event payload is invalid');
              if (raw.event.kind === 'launch') await this.requireRunFile(id, folder, raw.event.run.id, 'input.json');
              if (raw.event.kind === 'finished') await this.requireRunFile(id, folder, raw.event.attemptId, 'result.json', raw.event.result);
              const replay = parseTask({ ...reduceTask(state, raw.event, raw.at), revision: raw.revision });
              if (canonical(replay) !== canonical(parsed)) throw new Error('Event resulting state differs from replay');
            }
            state = parsed;
            operations.set(raw.operationId, raw);
          }
          if (!state) throw new Error('Task has no state');
          if (folder === 'active') {
            const intentPath = await this.taskPath(id, folder, 'intent.json');
            try {
              await lstat(intentPath);
              const intent = await this.readCreationIntent(id);
              const first = operations.values().next().value as StoredEvent;
              if (first.operationId !== intent.operationId || first.payloadDigest !== intent.payloadDigest) throw new Error('Creation intent differs from committed event');
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
          const idea = await readFile(await this.taskPath(id, folder, 'idea.md'));
          if (!idea.equals(Buffer.from(state.idea, 'utf8'))) throw new Error('Original idea differs from task record');
          for (const record of operations.values()) {
            await this.publishDerivedRecords(id, folder, record.state);
            for (const ref of record.state.artifacts) await this.verifyArtifact(id, folder, ref);
            for (const ref of record.state.runs.flatMap(run => run.inputRefs)) await this.verifyArtifact(id, folder, ref);
            for (const workflow of [record.state.workflow, record.state.proposedWorkflow]) {
              if (workflow) {
                const published = parseWorkflow(JSON.parse(await readFile(await this.taskPath(id, folder, `workflows/${workflow.version}.json`), 'utf8')));
                if (canonical(published) !== canonical(workflow)) throw new Error('Workflow file differs from committed event');
              }
            }
          }
          const snapshotPath = await this.taskPath(id, folder, 'task.json');
          let snapshot: Task | null = null;
          try { snapshot = parseTask(JSON.parse(await readFile(snapshotPath, 'utf8'))); }
          catch { /* Committed events are authoritative. */ }
          if (snapshot && (snapshot.id !== id || snapshot.revision > state.revision ||
              snapshot.revision === state.revision && canonical(snapshot) !== canonical(state))) throw new Error('Snapshot conflicts with committed events');
          if (!snapshot || snapshot.revision < state.revision) await atomic.writeAtomic(snapshotPath, json(state));
          const entry: Entry = { task: state, folder, operations, unavailable: false };
          this.entries.set(id, entry);
          await this.moveTerminal(id, entry);
          if (entry.folder !== folder) moved.add(id);
        } catch (error) { issue(`Cannot recover task: ${error instanceof Error ? error.message : String(error)}`); this.entries.delete(id); }
      }
    }
    return clone(this.issues);
  }
}

export async function openStore(root: string): Promise<Store> {
  await mkdir(root, { recursive: true });
  for (const folder of [...folders, '.creating']) {
    const path = await confinedPath(root, folder);
    try { await mkdir(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw io(error, 'Cannot create store folders'); }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BoundaryError('invalid', 'Store folder is not a real directory');
  }
  const store = new FolderStore(root);
  await store.recover();
  return store;
}
