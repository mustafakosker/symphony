# Native Codex Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native, read-only Codex terminal sessions for brainstorming against committed Symphony code, with resumable conversations and reviewed Markdown task handoff.

**Architecture:** A focused session manager owns snapshots, durable records, isolated Codex processes, terminal state, and controller connections. React renders the actual Codex CLI through xterm.js; Node bridges a sandboxed `node-pty` process over a guarded local WebSocket. The existing coordinator and task intake retain their current responsibilities.

**Tech Stack:** Existing React/TypeScript/Vite and Node HTTP server; macOS host sandbox; `node-pty`; xterm.js browser/headless terminals and fit/serialize addons; `ws`; Vitest and Testing Library.

**Spec:** [Approved native Codex terminal design](../specs/2026-09-22-codex-terminal-design.md).

## Global Constraints

- The project is fixed to Symphony at `/Users/mustafakosker/projects/symphony`, and sessions are read-only.
- The initial supported host is this local macOS deployment.
- Use Codex's supported `--no-alt-screen` option on launch and resume.
- Do not start an idea discussion or model turn until the user types an idea.
- Start at most four live interactive sessions.
- Limit preparation to 100,000 entries, 1 GiB of total regular-file content, and 64 MiB per regular file.
- Preparation has a two-minute deadline and bounded diagnostics.
- A connection ticket expires after 30 seconds, is tied to the session/generation, and is consumed once.
- Enforce a 16 KiB input-frame limit, 1 MiB/s input rate, and integer resize bounds of 20-400 columns and 5-200 rows.
- Retain at most 5,000 scrollback lines and a 10 MiB serialized-state cap per live session; bound the catch-up queue to 1 MiB.
- Session switching and browser refresh must not restart a process; server restart does not automatically resume it.
- Ordinary task submission remains Markdown through `/api/drafts`; no task schema or connected-project binding is introduced.
- Verify the real host boundary before enabling live sessions. A failed probe must not cause an unrestricted fallback.
- Use the repository's pinned Node `22.23.2` and existing lockfile; keep `.symphony-local/` intact.
- Planning approval is not execution approval. Create an isolated worktree at execution time and preserve existing untracked `.DS_Store` files.

## Review Focus

1. A resume request arrives after an earlier launch completed or a PID was reused: it must not spawn a duplicate or kill an unrelated process. Tasks 3 and 5 pin this behavior.
2. Browser refresh, controller takeover, and delayed resize/output overlap: old-generation messages must not reach the new controller or change its screen. Tasks 4, 6, and 7 pin this behavior.
3. A Git tree contains a case-folding collision, symlink, or source `.codex` configuration: preparation must not overwrite a file, follow a link, or load executable project configuration. Tasks 1 and 2 pin this behavior.
4. Huge terminal control sequences or HTML-looking output arrive while the browser is slow: memory stays bounded and output cannot write the clipboard or become executable HTML. Tasks 4 and 7 pin this behavior.
5. A user edits a task draft while its first submission response is lost: retry must preserve the edited draft and cannot create a duplicate for the original bytes. Task 8 pins this behavior.

---

## Execution order and prerequisite

This is one user flow with shared session identity, lifecycle, and permission boundaries, so keep one plan. Execute Tasks 1-9 in order. Task 1 is a go/no-go gate: a native Codex session must work inside the required host sandbox before terminal feature work proceeds. Do not reinterpret a failed host probe as permission to use only a prompt or a CLI read-only flag. If compatibility cannot be established without changing the approved design, report the exact failure and return to design review.

Use the normal red/green cycle for the behavioral tests below. Test examples show the decisive assertion; add the imports and fixtures explicitly described in the same task. Helpers listed in an Interfaces block are deliverables of that task, not assumed existing APIs. Fake processes may be injected only through tests/preview dependencies, never environment flags that bypass production checks.

Candidate dependency versions were read from the configured npm registry during planning, but were not installed or tested: `node-pty@1.1.0`, `@xterm/xterm@6.0.0`, `@xterm/headless@6.0.0`, `@xterm/addon-fit@0.11.0`, `@xterm/addon-serialize@0.14.0`, `ws@8.21.3`, and `@types/ws@8.18.1`. Install the exact versions in their owning tasks. If the registry blocks them or package type/runtime compatibility fails, select and document a compatible exact set without deleting the lockfile or changing the registry.

## File map

| Area | Files and responsibility |
| --- | --- |
| Host launch | `server/codex-sessions/paths.ts`, `policy.ts`, `runtime.ts`, `history.ts`, `launcher.ts`, `supervisor.ts`, `probe.ts`: validated directories, confinement, isolated auth/configuration, supported history lookup, gated process creation, and evidence. |
| Source | `server/codex-sessions/snapshot.ts`: committed Git object materialization and manifest verification. |
| Persistence | `shared/codex-sessions.ts`, `server/codex-sessions/store.ts`: public contracts and private durable records/receipts. |
| Terminal state | `server/codex-sessions/screen.ts`, `protocol.ts`: ordered ANSI state, replay, wire validation, and limits. |
| Lifecycle | `server/codex-sessions/manager.ts`, `testing.ts`: orchestration plus test-only fake dependencies. |
| HTTP | `server/http/codex-sessions.ts`, `server/codex-sessions/tickets.ts`: routes, tickets, upgrades, access checks. |
| Browser | `src/codex/api.ts`, `useCodexSessions.ts`, `TerminalPane.tsx`, `CodexWorkspace.tsx`, `handoff.ts`: transport, terminal, session controls, selected-text conversion. |
| Existing integration | `server/main.ts`, `src/App.tsx`, workspace shell/sidebar/navigation, `NewTaskDialog.tsx`, `vite.config.ts`, `package.json`, lockfile, and terminal CSS. |
| Verification/docs | Adjacent unit tests, `tests/codex-terminal.host.test.ts`, `tests/codex-terminal.integration.test.ts`, fake preview, operations guide, and a verification record. |

Keep new modules focused; extracting private parsing/serialization helpers inside this directory is allowed if a module becomes difficult to review. Do not reorganize the coordinator or its noninteractive runner.

### Task 1: Prove and implement the isolated native launcher

**Files:** Create `server/codex-sessions/{paths,policy,runtime,history,launcher,supervisor,probe}.ts`, `server/codex-sessions/{paths,policy,history,launcher}.test.ts`, `server/testing/terminal-child.mjs`, `tests/codex-terminal.host.test.ts`. Modify `package.json`, `package-lock.json`, and `tsconfig.server.json` only if an emitted helper needs an explicit include; TypeScript files under `server/` are already included.

**Interfaces:**

```ts
// paths.ts; all paths are absolute, canonical and server-owned.
export type SessionPaths = {
  root: string; metadata: string; snapshot: string; cwd: string;
  runtime: string; codexHome: string; temp: string;
};
export function prepareSessionPaths(localRoot: string, id: string): Promise<SessionPaths>;
// policy.ts / probe.ts
export type HostEvidence = {
  schemaVersion: 1; cliVersion: string; cliDigest: string;
  policyDigest: string; configDigest: string; scopeDigest: string;
  launcherDigest: string; hostIdentity: string;
  verifiedAt: string; checks: string[];
};
export function buildSandboxProfile(paths: SessionPaths): string;
export function verifyTerminalHost(input: {
  binary: string; paths: SessionPaths; coordinatorPort: number;
}): Promise<HostEvidence>;
// runtime.ts: no credentials/configuration are returned to the UI.
export function prepareCodexRuntime(input: {
  paths: SessionPaths; authSourceHome: string; sourceCommit: string;
}): Promise<{ configDigest: string }>;
// history.ts: called only while the interactive process is stopped.
export type NativeHistory =
  | { kind: 'none' }
  | { kind: 'one'; threadId: string }
  | { kind: 'ambiguous' }
  | { kind: 'unavailable'; reason: string };
export function inspectNativeHistory(input: {
  binary: string; paths: SessionPaths; evidence: HostEvidence;
}): Promise<NativeHistory>;
// launcher.ts
export type ProcessIdentity = { pid: number; startedAt: string; nonce: string };
export type TerminalExit = { code: number | null; signal: number | null };
export type LaunchInput = {
  binary: string; paths: SessionPaths; generation: number;
  resumeThreadId: string | null; evidence: HostEvidence; graceMs: number;
};
export type OwnedTerminal = {
  identity: ProcessIdentity;
  activate(): Promise<void>;
  write(text: string): void;
  resize(cols: number, rows: number): void;
  pause(): void; resumeOutput(): void;
  onData(listener: (text: string) => void): () => void;
  completion: Promise<TerminalExit>;
  stop(): Promise<void>;
};
export type TerminalLauncher = {
  launch(input: LaunchInput): Promise<OwnedTerminal>;
  reconcile(identity: ProcessIdentity): Promise<'absent' | 'stopped' | 'uncertain'>;
};
```

- [ ] **Step 1: Add exact PTY dependency and behavioral fixtures.** Run `npm install --save-exact node-pty@1.1.0`. Create a test-only child program that selects a mode from arguments: echo stdin, write a named sentinel, spawn a sentinel-writing child, connect to a specified localhost/Unix listener, or remain alive while ignoring SIGTERM. It must have no reference to real repositories. Create test paths under `mkdtemp` and remove them only after processes are verified stopped.

- [ ] **Step 2: Write policy/path tests and run them red.** Parameterize write-denial tests over source, snapshot, metadata, another session, task store, and personal configuration. Check that a writable runtime nested beneath a denied source directory grants only that child exception. Add canonical-path/symlink rejection and a malicious `.codex` config fixture whose hook would create a sentinel if loaded.

```ts
it.each(['source', 'snapshot', 'metadata', 'otherSession', 'taskStore', 'personal'])
  ('denies a child write to %s', async (target) => {
    const outcome = await fixture.runProbe({ kind: 'child-write', target });
    expect(outcome.exitCode).not.toBe(0);
    expect(await fixture.readSentinel(target)).toBe('unchanged');
  });
it('permits only session runtime persistence', async () => {
  expect((await fixture.runProbe({ kind: 'write', target: 'runtime' })).exitCode).toBe(0);
  expect(await fixture.readSentinel('runtime')).toBe('written');
});
```

Define `fixture.runProbe({kind, target})` in this host-test file using `spawn('/usr/bin/sandbox-exec', ['-f', policyPath, process.execPath, fixtureProgram, kind, sentinelPath])`; return `{exitCode, stderr}` with stderr capped at 4 KiB. `readSentinel` reads only the fixture's predefined target map. Tests run only when `SYMPHONY_TERMINAL_HOST_TEST=1`; ordinary policy-generation/path tests always run. Run `npm test -- --run server/codex-sessions/paths.test.ts server/codex-sessions/policy.test.ts` and confirm missing implementation failures.

- [ ] **Step 3: Implement validated paths and the host policy.** Make all directories owner-only, reject symlink components with `lstat`/`realpath`, keep `metadata`, `snapshot`, and `cwd` outside the process-writable `runtime`/`temp`, and use fixed session UUIDs. Generate an SBPL profile that denies writes globally except the exact runtime/temp and necessary PTY device paths. Deny coordinator/other loopback TCP and unrelated Unix socket access, and deny IPC to ambient execution daemons. Allow only session-owned private IPC plus the OS services proven necessary for Codex authentication/TLS. Pass path parameters as argument-array values, never splice unescaped paths into SBPL source. Preserve those denials when resolving host-specific policy errors.

The launch argument construction must be explicit:

```ts
const codexArgs = input.resumeThreadId
  ? ['resume', input.resumeThreadId, '--no-alt-screen', '-s', 'read-only', '-a', 'never', '-C', input.paths.cwd]
  : ['--no-alt-screen', '-s', 'read-only', '-a', 'never', '-C', input.paths.cwd];
const env = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: input.paths.runtime,
  CODEX_HOME: input.paths.codexHome,
  TMPDIR: input.paths.temp,
  TERM: 'xterm-256color',
  LANG: 'en_US.UTF-8',
};
```

These are child-environment object fields, not reassignment of the agent shell's `HOME` or `CODEX_HOME`. The resume ID comes only from validated native metadata in this session's dedicated home, never from the browser. Reject IDs containing whitespace, path separators, control characters, or a leading hyphen. Verify native resume before relying on that constraint.

- [ ] **Step 4: Implement runtime configuration and evidence.** Use a fresh minimal Codex configuration with `sandbox_mode = "read-only"`, `approval_policy = "never"`, `cli_auth_credentials_store = "file"`, `features.apps = false`, and `developer_instructions` containing the exact snapshot path and commit. Use a dedicated project-root marker in the neutral working directory to stop ancestor project configuration discovery; mark the source/snapshot untrusted in `projects` and load no plugin/MCP/hook definitions. Verify these documented settings against the installed CLI with strict config checking. For supported file login storage, copy only `auth.json` privately into the session home using no-follow reads and owner-only creation; never log its content or copy personal configuration. Unsupported keychain-only storage yields an unavailable authentication reason. Hash the binary, immutable effective configuration, launcher/supervisor, policy with resolved parameters, and source/snapshot/runtime scope. Evidence names each successful denial/allowed-runtime probe and is stored in trusted metadata. Recompute these bindings before every launch.

Add a bounded supported history adapter, not a rollout-file parser. While the terminal is stopped, run a short-lived `codex app-server --stdio` inside the same host policy and isolated home. Initialize it, then issue `thread/list` with `sourceKinds: ['cli']`, exact `cwd`, and `limit: 2`; list active and archived history separately. Record only validated IDs, not previews or conversation contents. One unarchived root and no conflicting root means `one`; zero roots means `none`; multiple roots or archived-only history means `ambiguous`. Unsupported methods, malformed responses, or a five-second timeout mean `unavailable`, never `none`. Close the helper in every path. This uses documented metadata queries while the user interface remains the native terminal; app-server compatibility is part of this task's host gate.

```ts
const initialize = { id: 1, method: 'initialize', params: {
  clientInfo: { name: 'symphony_history', title: 'Symphony history lookup', version: '0.1.0' },
} };
const initialized = { method: 'initialized' };
const list = { id: 2, method: 'thread/list', params: {
  sourceKinds: ['cli'], cwd: paths.cwd, limit: 2, archived: false,
} };
```

Write table-driven `history.test.ts` cases for zero, one, two, archived, malformed, unsupported, and timed-out responses. Also test a stale recorded thread ID: it must not silently select another conversation. The short-lived metadata helper cannot launch a turn or attach to an ambient shared daemon.

- [ ] **Step 5: Implement ownership-gated PTY startup.** Spawn a small Node supervisor inside the sandbox, with fixed argv identifying session/generation/nonce. It waits up to five seconds for a trusted activation file in metadata, then launches Codex with inherited PTY descriptors and no shell. `launch()` returns its OS-observed PID/start identity before activation; the manager must persist that identity before `activate()` atomically writes the nonce. If activation never arrives, the supervisor exits without launching Codex. Its exit and signal handlers stop its descendant group. Verify whether the PTY creates a process group suitable for existing `stopProcessTree` before reusing that utility; do not assume `node-pty.kill()` kills descendants.

```ts
it('does not launch Codex before ownership is durable', async () => {
  const terminal = await launcher.launch(input);
  expect(await fixture.childWasStarted()).toBe(false);
  await terminal.activate();
  await fixture.waitForChildStart();
  await terminal.stop();
  expect(await fixture.groupIsAlive(terminal.identity)).toBe(false);
});
```

Extend the host fixture with `childWasStarted`, `waitForChildStart`, and `groupIsAlive`, backed by a sentinel, a bounded event/poll deadline, and OS PID/start/group inspection. Test activation timeout, failed evidence, exits during initialization, SIGTERM-resistant descendants, and PID identity mismatch. Reconciliation must return `uncertain` without sending a signal when identity cannot be proven.

- [ ] **Step 6: Run the real prerequisite and record its result.** Run the always-on launcher tests, then `SYMPHONY_TERMINAL_HOST_TEST=1 npm test -- --run tests/codex-terminal.host.test.ts`. Against disposable code, start the real installed Codex interactively in the wrapper, verify it waits for input, then send a small read-only idea prompt, test write-denial paths including changed CLI permissions/direct shell commands, stop, and resume the same conversation. Check coordinator mutation and unrelated-daemon access are denied. No real source edits are needed. Capture only redacted pass/fail evidence. If native sandbox nesting, authentication, or session-local resume cannot work, stop this plan before Task 2 and report the precise design blocker.

- [ ] **Step 7: Verify and commit the launcher.** Run `npm run build:server` and the focused tests above. Stage only Task 1 files and commit `feat: add verified read-only Codex terminal launcher`.

### Task 2: Materialize and verify committed Symphony snapshots

**Files:** Create `server/codex-sessions/snapshot.ts`, `snapshot.test.ts`. Consume `paths.ts` from Task 1. No modification to `server/repos/workspace.ts` is needed; its existing checkout function creates writable worktrees.

**Interfaces:**

```ts
export const SYMPHONY_SOURCE = '/Users/mustafakosker/projects/symphony';
export type SnapshotEntry = {
  path: string; mode: string; objectId: string;
  kind: 'file' | 'symlink' | 'submodule'; size: number; digest: string | null;
};
export type SnapshotBinding = {
  commit: string; root: string; manifestPath: string; digest: string;
  unsupported: Array<{ path: string; kind: 'symlink' | 'submodule' | 'lfs' }>;
};
export type SnapshotService = {
  resolveHead(): Promise<string>;
  materialize(commit: string, paths: SessionPaths): Promise<SnapshotBinding>;
  verify(binding: SnapshotBinding): Promise<void>;
};
export function createSnapshotService(source?: { testOnlyPath: string }): SnapshotService;
```

- [ ] **Step 1: Write committed-byte and hostile-tree tests.** Build a disposable Git repository with `git init`, local test author settings, and one committed `app.txt`; then modify it and add an untracked file. Define `source` as a service for that fixture, `paths` through Task 1, and register cleanup after all processes stop.

```ts
it('materializes the captured commit after HEAD and working files change', async () => {
  const commit = await source.resolveHead();
  await writeFile(join(repo, 'app.txt'), 'new working content');
  await writeFile(join(repo, 'untracked.txt'), 'excluded');
  const binding = await source.materialize(commit, paths);
  expect(await readFile(join(binding.root, 'app.txt'), 'utf8')).toBe('committed');
  await expect(readFile(join(binding.root, 'untracked.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(source.verify(binding)).resolves.toBeUndefined();
});
```

Use `git update-index --cacheinfo`/`mktree` for fixtures the host filesystem cannot safely represent: symlinks, submodules, case-folded path collisions, and invalid tree paths. Table-test each against an expected inert entry or visible rejection. Test `.gitattributes` export-ignore/export-subst does not alter regular bytes; LFS pointers stay literal; changed snapshot bytes fail verification. Run `npm test -- --run server/codex-sessions/snapshot.test.ts` and confirm red.

- [ ] **Step 2: Implement bounded Git object reads.** Use fixed argv and NUL-delimited tree enumeration; parse names as bytes before validating UTF-8 and canonical relative paths. Reject absolute paths, dot segments, NULs, normalization/case-fold collisions on this host, and any destination resolved outside the owned directory. Never execute checkout filters.

```ts
const gitPrefix = ['--no-optional-locks', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-C', sourcePath];
const treeArgs = [...gitPrefix, 'ls-tree', '-rz', '-l', commit];
const objectArgs = [...gitPrefix, 'cat-file', '--batch'];
```

Use bounded streaming reads for blobs and a 120,000 ms abort deadline; count file bytes before writing. Write into an owned staging directory, use create-only/no-follow file opens, and atomically publish a manifest and complete snapshot only after every regular file succeeds. Verify the completed manifest by recomputing digests, not by trusting the serialized digest field. The source path is injected only in tests, never read from HTTP/config.

- [ ] **Step 3: Pin limits and source preservation.** Tests exercise the exact limits using small injectable test limits on the private materializer, then assert the production exported constants are `100000`, `1024**3`, `64*1024**2`, and `120000`. On each failure preserve a clear unavailable reason and exclude staging data from launch. Compare source refs, index bytes, committed/dirty sentinel bytes, and untracked files before/after; reading metadata timestamps is not a write check.

- [ ] **Step 4: Run focused tests and commit.** Run the snapshot test and `npm run build:server`. Commit `feat: capture immutable Symphony context for Codex sessions` with only this task's files.

### Task 3: Define contracts and durable, idempotent session records

**Files:** Create `shared/codex-sessions.ts`, `server/codex-sessions/store.ts`, `store.test.ts`. Reuse `server/store/atomic.ts` without changing its callers.

**Interfaces:** The public and private types below are the common contracts used by later tasks.

```ts
// shared/codex-sessions.ts: no runtime paths, PIDs or credentials in public types.
export type SessionState = 'preparing' | 'running' | 'stopped' | 'interrupted' | 'unavailable';
export type SessionSummary = {
  id: string; revision: number; label: string; state: SessionState;
  commit: string | null; generation: number; createdAt: string; updatedAt: string;
  reason: string | null; hasHistory: boolean;
};
export type SessionList = {
  readiness: { ready: boolean; reason: string | null };
  sessions: SessionSummary[];
};
export type SessionCommand = { requestId: string; expectedRevision: number };
// store.ts
export type SessionRecord = Omit<SessionSummary, 'commit'> & {
  schemaVersion: 1; commit: string; paths: SessionPaths; binding: SnapshotBinding | null;
  nativeThreadId: string | null;
  process: ProcessIdentity | null; launchPending: boolean;
  operations: Record<string, {
    kind: 'create' | 'resume' | 'stop'; inputDigest: string;
    phase: 'pending' | 'done'; result: SessionSummary | null;
  }>;
};
export type SessionStore = {
  list(): Promise<{ records: SessionRecord[]; unavailable: Array<{ id: string; reason: string }> }>;
  get(id: string): Promise<SessionRecord>;
  create(requestId: string, commit: string, paths: SessionPaths): Promise<SessionRecord>;
  update(id: string, revision: number, change: (record: SessionRecord) => SessionRecord): Promise<SessionRecord>;
};
export function openSessionStore(localRoot: string): Promise<SessionStore>;
export function summarizeSession(record: SessionRecord): SessionSummary;
```

- [ ] **Step 1: Write creation/replay tests.** Require UUID creation request IDs and use that UUID as the session ID, eliminating a second request-to-session index. Serialize creation under the existing single-host ownership model. The manager checks for an existing creation before resolving a new HEAD; a retry reuses the durable commit even if a later argument differs.

```ts
it('retains the original context through replay and reopening', async () => {
  const first = await store.create(requestId, commitA, paths);
  const reopened = await openSessionStore(localRoot);
  const replay = await reopened.create(requestId, commitB, paths);
  expect(replay.id).toBe(first.id);
  expect(replay.commit).toBe(commitA);
});
it('rejects an update based on a stale revision', async () => {
  const first = await store.create(requestId, commitA, paths);
  await store.update(first.id, first.revision, row => ({ ...row, state: 'stopped' }));
  await expect(store.update(first.id, first.revision, row => row)).rejects.toMatchObject({ code: 'conflict' });
});
```

Define test IDs with `randomUUID`, commits as valid object IDs from the Task 2 fixture, and paths from Task 1. Run `npm test -- --run server/codex-sessions/store.test.ts` and confirm red.

- [ ] **Step 2: Implement atomic records and validation.** Store trusted JSON beneath `paths.metadata`, outside the process-writable area. `create` writes revision 1 and a pending create operation; `update` clones/validates the full record, increments revision and timestamp itself, and calls `writeAtomic`. Validate UUIDs, schema, enum values, object IDs, digests, finite positive revisions, canonical owned paths and immutable creation/context fields on read and write. Reject symlink/nonregular metadata. `list` separates valid records from unavailable IDs/reasons; never manufacture a valid private record from corrupt bytes. The manager renders unavailable summaries with `commit: null`, an unknown-history explanation, and disabled start/resume controls, without hiding other sessions.

```ts
const next = {
  ...change(structuredClone(current)),
  revision: current.revision + 1,
  updatedAt: new Date().toISOString(),
};
```

Use a per-session promise chain so concurrent updates compare against the same authoritative latest record. Keep operation receipts in the record; old accepted stop/resume request IDs return their saved result instead of operating on a newer generation. Reject reuse of one request ID with a different operation/payload digest.

- [ ] **Step 3: Exercise crash boundaries and redaction.** Inject a write failure before atomic rename, reopen, and assert the prior complete record survives. Inject a corrupt/symlink record and assert only that session becomes unavailable. Assert `summarizeSession` returns exactly the public keys above. Add receipts for old-generation stop requests and assert replay cannot modify a later-generation record.

- [ ] **Step 4: Verify and commit.** Run store tests, prior snapshot tests, and `npm run build:server`. Commit `feat: persist Codex session identity and operation receipts`.

### Task 4: Build bounded terminal state and typed wire messages

**Files:** Create `server/codex-sessions/{screen,protocol}.ts` and their tests; extend `shared/codex-sessions.ts`. Modify the dependency manifests.

**Interfaces:**

```ts
// shared/codex-sessions.ts
export type TerminalClientMessage =
  | { type: 'input'; generation: number; text: string }
  | { type: 'resize'; generation: number; cols: number; rows: number };
export type TerminalServerMessage =
  | { type: 'snapshot'; generation: number; seq: number; cols: number; rows: number; data: string }
  | { type: 'output'; generation: number; seq: number; data: string }
  | { type: 'resized'; generation: number; seq: number; cols: number; rows: number }
  | { type: 'closed'; generation: number; reason: string };
// screen.ts
export type TerminalScreen = {
  append(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  attach(send: (message: TerminalServerMessage) => void): Promise<() => void>;
  dispose(): void;
};
export function createTerminalScreen(generation: number, onResponse?: (text: string) => void): TerminalScreen;
// protocol.ts
export function parseTerminalMessage(raw: string): TerminalClientMessage;
export function assertDimensions(cols: number, rows: number): void;
export function createInputBudget(now: () => number): { accept(bytes: number): boolean };
```

- [ ] **Step 1: Add compatible terminal state dependencies.** Run `npm install --save-exact @xterm/xterm@6.0.0 @xterm/headless@6.0.0 @xterm/addon-fit@0.11.0 @xterm/addon-serialize@0.14.0`. Verify the installed declarations permit serialization of a headless terminal; resolve type/runtime incompatibility before continuing.

- [ ] **Step 2: Write cursor/replay and validation tests, then run red.** In the screen tests, render the serialized snapshot into another headless terminal and compare visible lines and cursor positions, rather than asserting the exact escape bytes. All `write()` operations must await callbacks.

```ts
it('restores a rewritten screen without replaying stale text', async () => {
  const screen = createTerminalScreen(3);
  await screen.append('old\rnew\u001b[K');
  const frames: TerminalServerMessage[] = [];
  const detach = await screen.attach(frame => frames.push(frame));
  expect(frames[0]).toMatchObject({ type: 'snapshot', generation: 3 });
  await screen.append('\r\nnext');
  expect(frames[1]).toMatchObject({ type: 'output', seq: 2 });
  detach(); screen.dispose();
});
it.each([[19, 24], [401, 24], [80, 4], [80, 201], [80.5, 24]])
  ('rejects dimensions %s by %s', (cols, rows) => {
    expect(() => assertDimensions(cols, rows)).toThrow();
  });
```

Run `npm test -- --run server/codex-sessions/screen.test.ts server/codex-sessions/protocol.test.ts`. Add a fake monotonic clock for exact rate-window tests, unknown-field rejection, malformed UTF-8/JSON, oversized input, and invalid generations.

- [ ] **Step 3: Implement one ordered terminal-state queue.** Configure headless xterm with 80 columns, 24 rows, 5,000 scrollback lines and the required addon API flag. Serialize append, resize, and attach on one chain. Increment sequence after each committed append/resize; snapshot includes the current sequence. Add the listener and send the snapshot in the same queued operation so future frames cannot jump ahead of it.

```ts
await new Promise<void>(resolve => terminal.write(data, resolve));
sequence += 1;
const frame: TerminalServerMessage = { type: 'output', generation, seq: sequence, data };
```

Use xterm's public scrollback/serialization options to discard oldest history if serialized state exceeds 10 MiB; preserve the current visible screen. Check the limit after each queued write without retaining a second unbounded raw transcript. Bound pending PTY ingestion to 1 MiB using launcher pause/resume, and stop with a visible error if one pathological screen/control sequence cannot fit even with no scrollback. Normal long conversations must continue after old history is trimmed. Block OSC 52 and unsolicited title/link side effects in both terminal instances.

The headless terminal is the sole authority for terminal query responses, including when no browser is attached. Connect its `onData` device-response events to `onResponse`; the manager wires that callback to the owned PTY. Browser rendering must suppress duplicate device-status/attribute/color-query replies without dropping human typing or paste. Add this decisive detached-session case:

```ts
it('answers a terminal position query once without a browser', async () => {
  const replies: string[] = [];
  const screen = createTerminalScreen(1, reply => replies.push(reply));
  await screen.append('\u001b[6n');
  expect(replies).toHaveLength(1);
  expect(replies[0]).toMatch(/^\u001b\[\d+;\d+R$/);
  const detach = await screen.attach(() => {});
  expect(replies).toHaveLength(1);
  detach(); screen.dispose();
});
```

- [ ] **Step 4: Exercise ordering and hostile output.** Test alternate-screen entry/exit, cursor rewrites, resize during a queued append, split Unicode received from the fake child, more than 5,000 lines, combining characters, large OSC/DCS sequences, and disposal with pending callbacks. Verify a snapshot plus later frames matches the authoritative screen and that callbacks from a disposed generation are ignored.

- [ ] **Step 5: Verify and commit.** Run focused tests and both TypeScript builds. Commit `feat: add bounded terminal replay and session wire protocol`.

### Task 5: Orchestrate session lifecycle and recovery

**Files:** Create `server/codex-sessions/manager.ts`, `manager.test.ts`, `recovery.test.ts`, and `testing.ts`; exclude `server/codex-sessions/testing.ts` from the server build, matching the existing file-review test helper pattern.

**Interfaces:**

```ts
export type TerminalPeer = {
  send(message: TerminalServerMessage): void;
  close(code: number, reason: string): void;
};
export type Controller = {
  receive(message: TerminalClientMessage): Promise<void>;
  detach(): void;
};
export type SessionManager = {
  list(): Promise<SessionList>;
  create(requestId: string): Promise<SessionSummary>;
  resume(id: string, command: SessionCommand): Promise<SessionSummary>;
  stop(id: string, command: SessionCommand): Promise<SessionSummary>;
  connect(id: string, generation: number, takeControl: boolean, peer: TerminalPeer): Promise<Controller>;
  recover(): Promise<void>;
  shutdown(): Promise<void>;
};
export type ManagerDependencies = {
  store: SessionStore; snapshots: SnapshotService; launcher: TerminalLauncher;
  localRoot: string; binary: string; graceMs: number;
  prepareRuntime(paths: SessionPaths, commit: string): Promise<void>;
  verifyHost(paths: SessionPaths): Promise<HostEvidence>;
  inspectHistory(paths: SessionPaths, evidence: HostEvidence): Promise<NativeHistory>;
};
export function createSessionManager(deps: ManagerDependencies): SessionManager;
```

- [ ] **Step 1: Add a controlled fake launcher and lifecycle tests.** `testing.ts` exports `createControlledLauncher(): { launcher: TerminalLauncher; launched: Array<{input: LaunchInput; terminal: OwnedTerminal}>; exit(index: number): void; releaseLaunch(): void }`. Its fake terminal records input/resize calls, activation, and stop without a real process; provide a promise gate for late launch completion. Build manager tests with a real temporary store, real disposable source service, and that fake launcher. `prepareRuntime`/`verifyHost` are test-only injected functions.

```ts
it('deduplicates concurrent creation and preserves the captured commit', async () => {
  const [a, b] = await Promise.all([manager.create(requestId), manager.create(requestId)]);
  expect(a.id).toBe(b.id);
  expect(controlled.launched).toHaveLength(1);
  expect(a.commit).toBe(b.commit);
});
it('does not stop the process when the browser detaches', async () => {
  const session = await manager.create(requestId);
  const connection = await manager.connect(session.id, session.generation, false, peer);
  connection.detach();
  expect((await manager.list()).sessions[0].state).toBe('running');
});
```

Define `peer` with `vi.fn()` send/close callbacks. Run `npm test -- --run server/codex-sessions/manager.test.ts server/codex-sessions/recovery.test.ts` and confirm red.

- [ ] **Step 2: Implement serialized launch and four-slot reservation.** Check durable creation receipts before resolving HEAD. Reserve an interactive slot before asynchronous preparation; release it in every failure/exit path. Persist the commit, materialize/verify snapshot, prepare runtime, verify host, then persist launch intent and increment generation. Launch behind the Task 1 activation gate, persist identity, subscribe to output/exit, and activate. Persist Running only after activation succeeds. Concurrent operations on one session are serialized; a global reservation set prevents five starts racing past the cap.

```ts
const owned = await deps.launcher.launch(launchInput);
record = await deps.store.update(record.id, record.revision, row => ({
  ...row, process: owned.identity, launchPending: true,
}));
await owned.activate();
```

If activation or persistence fails, stop the owned process and record the error; never lose the handle through an exception path. Fence a late launcher result if shutdown or a newer generation occurred while it was pending. Retain pending/done operation receipts and immutable input digests so replays cannot affect later generations.

- [ ] **Step 3: Implement controllers and stop/resume.** `connect` rejects non-running/stale generations. Attach a screen snapshot before enabling input. An explicit takeover disposes the old controller and closes its socket before the replacement accepts messages. Every input/resize rechecks the controller identity and generation; resize updates both PTY and screen in order. `stop` revokes control, verifies process identity, stops the full tree, inspects native history after exit, persists the native ID/history state, and releases its slot. Resume verifies the same snapshot/policy and rechecks that ID before passing it as `resumeThreadId`; `none` permits a fresh conversation only when the session has never recorded history. Missing previously recorded history, ambiguous history, or a lookup error is unavailable, never a replacement conversation. Apply the same metadata lookup after a natural Codex exit and after crash reconciliation. It must not delay process termination if history inspection fails.

- [ ] **Step 4: Implement crash reconciliation and complete shutdown.** On recovery, never restart Codex automatically. Reconcile recorded identities: absent/stopped becomes interrupted; uncertain stays unavailable. Recover pending operations to stable receipts or visible uncertainty. Shutdown rejects new work, revokes controllers, aborts preparations, fences late handles, and attempts all process cleanup with `Promise.allSettled`; aggregate failures after every cleanup was attempted. Uncertain processes remain recorded for next startup.

- [ ] **Step 5: Pin lifecycle races and commit.** Tests cover failure at each launch boundary, fifth concurrent start, stale requests, old stop replay after resume, takeover during output, actual exit before subscription, shutdown during preparation/launch, identity mismatch without killing, and corrupt one-session state while others remain usable. Run these plus Tasks 1-4 tests and `npm run build:server`. Commit `feat: manage Codex terminal sessions and recovery`.

### Task 6: Add HTTP/WebSocket access and application lifecycle integration

**Files:** Create `server/http/codex-sessions.ts`, `codex-sessions.test.ts`, `server/codex-sessions/tickets.ts`, `tickets.test.ts`. Modify `server/main.ts`, `server/main.test.ts`, `vite.config.ts`, and dependency manifests.

**Interfaces:**

```ts
// shared/codex-sessions.ts
export type ConnectionGrant = { ticket: string; generation: number; expiresAt: number };
// tickets.ts
export type TicketBinding = { sessionId: string; generation: number; takeControl: boolean };
export function createTicketStore(now: () => number): {
  issue(binding: TicketBinding): ConnectionGrant;
  consume(ticket: string, sessionId: string): TicketBinding;
  clear(): void;
};
// server/http/codex-sessions.ts
export function createCodexSessionHttp(input: {
  manager: SessionManager; allowedOrigin: string; listenerHost: string;
}): {
  handle: import('node:http').RequestListener;
  upgrade(request: import('node:http').IncomingMessage,
    socket: import('node:stream').Duplex, head: Buffer): void;
  close(): Promise<void>;
};
```

- [ ] **Step 1: Install exact transport dependencies and write ticket tests.** Run `npm install --save-exact ws@8.21.3` and `npm install --save-dev --save-exact @types/ws@8.18.1`. Use 32 random bytes encoded as base64url for tickets and store only a SHA-256 lookup key, expiry, and binding. Consume once after matching the session and before attaching. Bound outstanding unconsumed grants to 64 per session; prune expired grants.

```ts
it('expires tickets and rejects reuse and wrong sessions', () => {
  let now = 0;
  const tickets = createTicketStore(() => now);
  const grant = tickets.issue({ sessionId: id, generation: 1, takeControl: false });
  expect(() => tickets.consume(grant.ticket, otherId)).toThrow();
  expect(tickets.consume(grant.ticket, id).generation).toBe(1);
  expect(() => tickets.consume(grant.ticket, id)).toThrow();
  const expired = tickets.issue({ sessionId: id, generation: 1, takeControl: false });
  now = 30000;
  expect(() => tickets.consume(expired.ticket, id)).toThrow();
});
```

Run the ticket and HTTP tests red before implementing routes.

- [ ] **Step 2: Implement the exact spec routes.** Use `/api/codex/sessions`, `/resume`, `/stop`, `/connection`, and `/terminal` as specified. Bound JSON at the existing 1 MiB ceiling, require exact request keys/UUIDs/revisions, and map `BoundaryError` to the current API status conventions. Creation returns `201`; replay returns the same session without relaunch; mutations return `200`; connection tickets return `201`; a live-session limit/conflict returns `409`. Return only public summaries and bounded reasons.

```ts
const websocket = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
```

Require the exact Origin for all session mutations and upgrades, reject `Sec-Fetch-Site: cross-site`, and allow only the bound listener host or the configured development-origin host. Reject multiple/invalid Host headers, URLs with credentials, queries containing tickets, and unsupported subprotocols. Browser connections offer `['symphony-terminal-v1', 'ticket.' + grant.ticket]`; validate and consume the ticket, then negotiate only `symphony-terminal-v1`. Do not echo the ticket as the selected protocol or log it. A successful attach rechecks authoritative generation even if the grant was issued before a restart.

- [ ] **Step 3: Add transport backpressure and adversarial tests.** Use the protocol parser and rate budget before forwarding data to the manager. A text WebSocket frame may be at most 16 KiB encoded, including JSON. Reject binary frames. Send the initial bounded snapshot separately and queue subsequent frames until its send callback; that catch-up queue has the 1 MiB ceiling. Thereafter use `socket.bufferedAmount` plus unsent output bytes to close a slow peer when catch-up exceeds 1 MiB. Socket close detaches only that controller. Heartbeats detect dead browsers and release their controller lease without stopping Codex.

```ts
it.each(['https://other.example', 'null', undefined])
  ('rejects terminal upgrades from origin %s', async origin => {
    expect(await attemptUpgrade({ origin, ticket: validTicket })).toBe(403);
    expect(manager.connect).not.toHaveBeenCalled();
  });
```

Define `attemptUpgrade` in the HTTP test using Node `http.request` with upgrade headers and capture the response status, and provide a spy manager implementing the Task 5 interface. Add wrong-host, expired/reused-ticket, wrong-session/generation, takeover, old-controller input, rate, resize, and slow-peer cases.

- [ ] **Step 4: Integrate startup, shutdown, and Vite.** Construct the terminal manager behind its own error boundary after existing core startup. A missing native addon or failed host check creates an unavailable session service; it must not degrade an otherwise healthy coordinator. Add test-only manager injection to `startApplication`, with no production bypass. Route `/api/codex/` before the ordinary API; register `upgrade` separately. Set the Vite `/api` proxy's `ws: true`. Shutdown must invoke both coordinator and terminal cleanup, then close all WebSockets/HTTP connections and release ownership only when safe.

- [ ] **Step 5: Verify failure isolation and commit.** Extend `server/main.test.ts` with injected terminal startup failure, terminal cleanup failure, and a connected WebSocket during close; existing health/task routes stay valid and close is bounded. Run `npm test -- --run server/http/codex-sessions.test.ts server/codex-sessions/tickets.test.ts server/main.test.ts` and `npm run build`. Commit `feat: expose guarded Codex terminal session endpoints`.

### Task 7: Implement the browser client and reconnecting native terminal

**Files:** Create `src/codex/api.ts`, `api.test.ts`, `useCodexSessions.ts`, `useCodexSessions.test.tsx`, `TerminalPane.tsx`, `TerminalPane.test.tsx`, `terminal-controls.ts`, `terminal-controls.test.ts`, `src/styles/codex.css`.

**Interfaces:**

```ts
export type CodexApi = {
  list(signal?: AbortSignal): Promise<SessionList>;
  create(requestId: string): Promise<SessionSummary>;
  resume(id: string, command: SessionCommand): Promise<SessionSummary>;
  stop(id: string, command: SessionCommand): Promise<SessionSummary>;
  connection(id: string, takeControl: boolean): Promise<ConnectionGrant>;
};
export const codexApi: CodexApi;
export function useCodexSessions(api?: CodexApi): {
  view: SessionList | null; error: string | null; busy: boolean;
  refresh(): Promise<void>; create(): Promise<SessionSummary>;
  resume(session: SessionSummary): Promise<void>; stop(session: SessionSummary): Promise<void>;
};
export type TerminalPaneHandle = { getSelection(): string; focus(): void };
export type TerminalPaneProps = {
  session: SessionSummary; api: CodexApi;
  onTakeoverRequired(): void; takeControl: boolean;
};
```

- [ ] **Step 1: Write fetch/retry and terminal lifecycle tests.** Mirror the existing API error handling style. In `TerminalPane.test.tsx`, mock xterm and WebSocket boundaries with recorded `write`, `resize`, `dispose`, and sent frames; keep actual rendering checks for Task 9. Test that delayed grants for a previous session never open a socket and that unmount cancels grant requests/reconnect timers.

```ts
it('does not replay typed input after disconnection', async () => {
  const view = render(<TerminalPane ref={terminalRef} session={session} api={api}
    onTakeoverRequired={vi.fn()} takeControl={false} />);
  await websocketFixture.deliverSnapshot();
  websocketFixture.disconnect();
  xtermFixture.type('do not replay');
  await websocketFixture.deliverSnapshot();
  expect(websocketFixture.sentInput()).toEqual([]);
  view.unmount();
});
```

Define `websocketFixture` in this test with controlled open/message/close events and a log of frames; `deliverSnapshot` sends the exact Task 4 snapshot type after a fulfilled Task 6 grant. Define `xtermFixture` with captured `onData` listeners and a `type()` method that calls them. Use `createRef<TerminalPaneHandle>()` for `terminalRef`. Run all new client tests red.

- [ ] **Step 2: Implement API and polling without hidden launches.** Session polling uses abort controllers and monotonically increasing response IDs, preserving errors from rejected mutations. Reuse a pending request ID for identical create/resume/stop retries, and replace it when operation input changes. A list, render, mount, refresh, or reconnect never calls create/resume. Poll every two seconds while the Codex view is visible; preserve session processes when the view unmounts.

- [ ] **Step 3: Implement terminal connection and screen reset.** Create xterm once per mounted session/generation, load FitAddon, disable input until the snapshot has been written, and attach a resize observer. Use `screenReaderMode`, block OSC 52, omit link addons, and render status through React text. Form the socket URL from `window.location` with `ws:`/`wss:` and no ticket in the URL.

In `terminal-controls.ts`, export `suppressDeviceReplies(terminal: Terminal): () => void`. Register browser-only CSI handlers for device status/attributes (`n`, `?n`, `c`, `>c`) and the supported OSC/DCS query handlers, returning true for queries so only the backend answers them. Do not suppress `onData` wholesale during rendering: that would lose concurrent user typing. Return a disposer for every handler. Add tests proving a native device query generates no browser input while adjacent key and paste input still passes through; the real browser check must confirm complete query coverage for this Codex version.

```ts
const socket = new WebSocket(url, ['symphony-terminal-v1', `ticket.${grant.ticket}`]);
terminal.parser.registerOscHandler(52, () => true);
terminal.onData(text => {
  if (connected && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'input', generation: session.generation, text }));
  }
});
```

Split large pastes into frames that remain below the encoded 16 KiB ceiling at Unicode code-point boundaries; throttle to the server budget. Never replay an unsent paste after a disconnect. On a snapshot, reset the local terminal, apply its dimensions, write serialized data, then accept only frames for the same generation with consecutive sequence numbers. On a gap, reconnect for a new snapshot. After restoring server dimensions, report the currently visible fitted size. Fit only visible, nonzero containers; clamp dimensions to approved bounds.

- [ ] **Step 4: Implement reconnect and control contention.** Use reconnect delays of 250, 500, 1000, 2000, then 5000 ms, capped at 5000 ms, with a fresh ticket each time. Stop reconnecting after an explicit already-controlled response, session exit, takeover close, or unmount. Display Take control through the parent callback. A new generation causes a complete socket/terminal-state reset. Dispose sockets, parser handlers, observers, and event subscriptions on cleanup, including React StrictMode mount/unmount cycles.

- [ ] **Step 5: Verify and commit.** Tests cover stale grant resolution, output gaps, old-generation frames, narrow/hidden resize, takeover, large multibyte paste, hostile HTML/OSC output, selection access, and no duplicate launch under StrictMode. Run focused client tests and `npm run build`. Commit `feat: render and reconnect native Codex terminal sessions`.

### Task 8: Add workspace navigation, session controls, and draft handoff

**Files:** Create `src/codex/CodexWorkspace.tsx`, `CodexWorkspace.test.tsx`, `handoff.ts`, `handoff.test.ts`. Modify `src/App.tsx`, `src/App.test.tsx`, `src/components/{WorkspaceShell,WorkspaceSidebar,NewTaskDialog}.tsx`, `NewTaskDialog.test.tsx`, `src/tasks/navigation.ts`, `navigation.test.ts`, and `src/styles/codex.css`.

**Interfaces:**

```ts
export type CodexHandoff = { sessionId: string; commit: string; selectedText: string };
export function buildCodexDraft(input: CodexHandoff): string;
export type CodexWorkspaceProps = {
  selectedSessionId: string | null;
  onSelectSession(id: string): void;
  onCreateTask(input: CodexHandoff): void;
};
// Add to NewTaskDialog Props; read only when opening a new dialog session.
type InitialDraft = { title: string; brief: string };
// initialDraft?: InitialDraft
```

- [ ] **Step 1: Write navigation and draft tests.** Extend navigation with `screen: 'list' | 'detail' | 'codex'` and `selectedSessionId: string | null`; preserve existing `selectedId` as task identity. Add `open-codex` and `select-codex-session` events. Old preference JSON defaults safely. Search/back/filter/submitted still route to the task list as appropriate, without discarding the remembered Codex session.

```ts
it('builds a fully visible editable brief with source provenance', () => {
  const commit = 'a'.repeat(40);
  expect(buildCodexDraft({ sessionId: id, commit, selectedText: '# Idea\n\nImprove search.' }))
    .toBe(`# Idea\n\nImprove search.\n\n---\nSource context: Symphony at commit ${commit}.`);
});
it('rejects empty selection instead of guessing from terminal history', () => {
  expect(() => buildCodexDraft({ sessionId: id, commit: 'a'.repeat(40), selectedText: '  ' })).toThrow();
});
```

Run navigation, handoff, and dialog tests red. Add a dialog test that receives initial content, is edited, rerenders with polling data, and preserves the edit until close.

- [ ] **Step 2: Implement fixed-project session UI.** Add the Codex navigation item; task filter items must not remain visually active while it is selected. Show the fixed Symphony label, Read-only badge, source commit, session timestamps/statuses, New/Stop/Resume, and the four-session limit reason from the server. A null commit displays Unknown context with start/resume/handoff disabled; never abbreviate a null value. Use the existing Button/Badge and responsive layout conventions. Running means process alive only. Make session selection compact on narrow widths and keep keyboard access to controls outside the terminal.

- [ ] **Step 3: Wire selection-to-draft handoff.** Use `TerminalPaneHandle.getSelection()` synchronously before moving focus. Preserve selection on pointer interaction with Create task by preventing pointer-down focus loss; keyboard activation uses the already retained selected text. Reject empty/oversized selection visibly. Treat selected text as plain textarea content and strip only terminal control characters that must not enter Markdown; never execute or interpret it as HTML. Include the full visible provenance paragraph before passing `initialDraft` to the existing dialog.

```ts
const selectedText = terminalRef.current?.getSelection() ?? '';
if (!session.commit) throw new Error('Session context is unavailable');
onCreateTask({ sessionId: session.id, commit: session.commit, selectedText });
```

`NewTaskDialog` initializes from `initialDraft` only on a closed-to-open transition. A polling render cannot overwrite edits. Cancelling does not call submit. Successful submission reuses `useWorkspace.submit`, routes to All tasks, and leaves the process untouched. Ordinary New task passes no initial content and stays blank.

- [ ] **Step 4: Respect terminal shortcuts and input focus.** Mark the terminal host with `data-codex-terminal`. Modify `SearchShortcut` to return early for key events originating within it; do not disable workspace shortcuts globally. Add a visible focus-out control or documented keyboard path to the toolbar. Terminal input is enabled only after its connection snapshot is ready, not merely because coordinator status is healthy.

- [ ] **Step 5: Test workflow boundaries and commit.** In App/dialog tests, simulate accepted-but-response-lost submission and retry identical Markdown with the same request ID; edited bytes get a new ID. Test close/reopen while an earlier submit is pending, cancellation with no intake call, task navigation without stop, empty selection, and ordinary draft regression. Run all modified UI tests plus `src/tasks/useWorkspace.test.tsx` and `npm run build`. Commit `feat: add Codex workspace and reviewed task handoff`.

### Task 9: Verify the complete flow and document operation

**Files:** Create `tests/codex-terminal.integration.test.ts`, `docs/superpowers/execution/codex-terminal-verification.md`; extend `tests/codex-terminal.host.test.ts`, `scripts/preview-fake.mjs`, `README.md`, and `docs/coordinator-operations.md`.

**Interfaces:** No new product contract. Consume `startApplication`'s test-only terminal injection, the Task 5 manager, existing task intake, and the fake terminal child. The preview must print and display `FAKE CODEX TERMINAL` and never use production authentication or source paths.

- [ ] **Step 1: Write the end-to-end integration test.** Build real disposable source/store/manager/HTTP with the fake PTY child and fake coordinator. Open a session over HTTP and a real `ws` client, send input, reconnect with a new ticket, assert one process, select known response text through the handoff function, submit via `/api/drafts`, and assert exactly one eventual task for the receipt. Stop/restart the application and assert the conversation is not automatically relaunched. Resume preserves the original commit and changes generation.

```ts
expect(controlled.launched).toHaveLength(1);
expect(reconnectedSnapshot.generation).toBe(firstSession.generation);
expect(reconnectedSnapshot.data).toContain('FAKE CODEX TERMINAL');
expect(createdTasks.filter(task => task.source === `drafts/${receipt.submissionId}.md`)).toHaveLength(1);
```

Use the real fake child where PTY/screen integration is the subject; use Task 5's controlled launcher for crash/late-start injection. Name these separate tests so fake lifecycle evidence is not presented as proof of native PTY behavior.

- [ ] **Step 2: Extend fake browser preview and inspect it.** Exercise desktop and narrow widths; create/switch sessions, type and paste, scroll/select a multiline brief, resize during output, refresh, force disconnect, contend from a second tab, and submit/cancel/edit a draft. Confirm the terminal remains native-looking, copy/paste works, focus escapes, and Command/Ctrl+K is not intercepted in the terminal. Record browser/version and observed results, not screenshots of real credentials or private conversations.

- [ ] **Step 3: Run real acceptance in disposable context.** Repeat Task 1's host gate through the full HTTP/browser integration with the installed Codex, including native startup with no unsolicited model turn, code reads, attempted writes by different tool paths and changed permissions, blocked coordinator/daemon access, runtime persistence, process cleanup, and native resume after server restart. Bind evidence to the exact CLI/config/policy and host identity. Confirm source working/index/ref bytes are unchanged. A skipped or blocked real test is recorded as unverified and leaves real launch disabled.

- [ ] **Step 4: Run the final checks once fixes are complete.** Run `npm test -- --run` and `npm run build`. Confirm the lockfile contains exact new direct versions and production build excludes fake/test helpers. If failures reveal a product bug, fix it with the corresponding focused regression before repeating affected checks. Do not claim completion from fake tests alone.

- [ ] **Step 5: Write operational documentation and commit.** Document the Codex tab, fixed committed context, read-only meaning, selection-based handoff, session stop/resume semantics, four-session limit, host verification command, supported login recovery, native dependency build requirements, and storage under `localRoot/codex-sessions/`. Clarify that a server restart is required after rebuilding, matching the existing README. The verification record lists exact commands/results, real/fake coverage, and any unresolved host limitation. Commit `test: verify native Codex terminal workflow and document operation` with only Task 9 changes.

## Spec coverage and execution handoff

| Approved requirement | Owning tasks |
| --- | --- |
| Native CLI interface, fixed Symphony context, no unsolicited turn | 1, 2, 7, 8, 9 |
| Committed bytes, snapshot limits, source preservation | 2, 9 |
| Whole-process read-only policy and verified authentication/runtime | 1, 5, 9 |
| Durable sessions, idempotency, process ownership and restart | 3, 5, 6, 9 |
| Terminal state reconstruction, input bounds and slow clients | 4, 6, 7 |
| Origin/Host checks, tickets and single-controller takeover | 5, 6, 7 |
| Workspace navigation, responsive display and keyboard use | 7, 8, 9 |
| Reviewed selection-to-draft with unchanged intake semantics | 8, 9 |
| Feature failure isolation and complete shutdown | 5, 6, 9 |

Planning sources: the approved spec, existing repository APIs/tests, local Codex help/version, npm registry metadata, [node-pty documentation](https://github.com/microsoft/node-pty), [xterm.js security guidance](https://xtermjs.org/docs/guides/security/), the [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), and [documented thread metadata queries](https://learn.chatgpt.com/docs/app-server). Dependency installation, host probes, product changes, and tests described above have not run during planning.

The user has approved the specification, but has not selected an execution method or reviewed this plan. Present this file for review before execution. Recommend **Native** execution because the tasks share tightly coupled lifecycle/transport interfaces and the first host gate may alter implementation details; it avoids repeated agent context while retaining a whole-branch independent review. **Subagent-driven** execution remains available for separate implementation/review gates per task.
