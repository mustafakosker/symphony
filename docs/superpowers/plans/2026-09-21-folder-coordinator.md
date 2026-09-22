# Folder Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn OneDrive Markdown drafts into durable, reviewed workflows executed by Codex CLI and managed through the existing internal workspace UI.

**Architecture:** A single Node.js process owns a folder-backed task store, sequential workflow scheduler, internal HTTP API, and Codex subprocess adapter. Immutable events and versioned snapshots support recovery; agents supply structured handoffs while coordinator code enforces decisions. The existing React app becomes an API client.

**Tech Stack:** Existing TypeScript, React, Vite, Tailwind, Vitest, and Testing Library; Node.js built-in filesystem, HTTP, crypto, and child-process modules; installed Codex CLI. Compile the server with TypeScript; no new runtime framework or database is required.

**Spec:** [Approved design](../specs/2026-09-21-folder-coordinator-design.md). User approved it on 2026-09-21. User selected subagent-driven execution; implementation is in progress.

## Global Constraints

- “Codex CLI is the initial execution runtime. Do not use Codex App Server or build a separate custom agent CLI.”
- “Files remain the persistent task store; browser storage and Codex conversation history are not authoritative task state.”
- “Human answers, approvals, pause requests, and cancellations happen only through that UI.”
- “Default global concurrency is one; waiting tasks release their execution slot.”
- “Every pending human decision pauses the entire task.”
- “Terminal tasks are inspectable and immutable in this version.”
- “Repository work directories are separate from the OneDrive tree.”
- “A local lock cannot coordinate multiple synced machines, which are unsupported.”
- “Only a successful process exit plus a valid, accepted result can complete a step.”
- “Default automatic retries apply only to clearly transient failures before side effects, capped at two retries with backoff.”
- Preserve the existing README's Node.js 22.12 or newer floor and installed dependency versions; do not upgrade unrelated packages.
- No Git repository currently exists. Do not initialize one or run worktree/commit commands automatically. Record each completed task and checks in `docs/superpowers/execution/folder-coordinator-progress.md`; if the workspace later becomes a repository, make one focused commit per completed task.
- All commands below run from `/Users/mustafakosker/projects/symphony`. Tests use temporary directories outside the user's actual OneDrive and repositories.

## Review Focus

1. Filename case/Unicode variants and symlinked submissions must not escape intake or silently overwrite another idea; pin in Task 3.
2. Disk-full/permission errors between event publication and snapshot replacement must stop dispatch and preserve a recoverable decision; pin in Task 2.
3. UTF-8/JSON lines split across process chunks and excessive output must not corrupt events or consume unbounded memory; pin in Task 5.
4. Approval retry after a lost HTTP response must return the original accepted decision, while the same ID with a different payload is rejected; pin in Tasks 2 and 8.
5. Disconnects, long titles, and stale selected task responses must not show invented progress or apply a decision to another task; pin in Tasks 9 and 10.

## File map and execution order

Keep the approved scope in one plan because its pieces share the same lifecycle and handoff contracts. Each task yields an independently testable unit. Execute 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11.

| Paths | Responsibility |
|---|---|
| `shared/contracts.ts`, `shared/validate.ts` | Wire/persistence types and explicit runtime validation; no browser or filesystem dependencies. |
| `server/domain/workflow.ts` | Pure state reduction, eligibility, invalidation, and checkpoint rules. |
| `server/store/{atomic,paths,task-store,lock}.ts` | Safe filesystem access, durable events/snapshots, serialization, host ownership. |
| `server/intake/intake.ts` | Stable reads, pickup receipts, conflict capture and draft submission. |
| `server/config/{settings,registry}.ts` | Host settings, project aliases, roles and capability profiles. |
| `server/repos/workspace.ts` | Exact revision selection and isolated local checkout preparation. |
| `server/codex/{adapter,result-schema,prompt,process-control}.ts` | CLI protocol, assignment context, result validation and process lifecycle. |
| `server/coordinator/{coordinator,recovery,reviews}.ts` | Dispatch, attempt reconciliation and human decisions. |
| `server/http/{api,access,static}.ts`, `server/main.ts` | Internal endpoints, access boundary, static UI and startup/shutdown. |
| `server/testing/fixtures.ts`, `server/testing/fake-cli.mjs` | Deterministic test records and controlled subprocess behavior. |
| `src/tasks/{api,useWorkspace,presentation}.ts` | Browser data access, refresh ordering and display helpers. |
| `src/components/{ReviewPanel,RunOutput,WorkflowJourney}.tsx` | Human decisions, bounded output and dynamic journey. |
| Existing `src/App.tsx`, `src/components/{Inbox,TaskDetail,StageCard,NewTaskDialog,Icons}.tsx`, `src/styles.css` | Adapt the current UI without changing its visual direction. |
| `server/**/*.test.ts`, `shared/*.test.ts`, `src/**/*.test.tsx` | Behavior and failure tests alongside code. |
| `tests/coordinator.integration.test.ts`, `tests/codex.smoke.test.ts` | Full local lifecycle and opt-in real CLI verification. |
| `config/examples/*.json`, `docs/coordinator-operations.md`, `README.md` | Concrete setup examples, supported-host checks and operation/recovery guide. |
| `tsconfig.server.json`, `tsconfig.json`, `package.json`, `.gitignore`, `vite.config.ts` | Server compilation, shared types, commands and development proxy. |

Delete the old demo model, fixtures, storage and their obsolete tests only in Task 9 when every live consumer is migrated. Never load `symphony-demo-v1` into the executable task store.

## Task 1: Define the task, workflow and decision contracts

**Files:** Create `shared/contracts.ts`, `shared/validate.ts`, `shared/validate.test.ts`, `server/domain/workflow.ts`, `server/domain/workflow.test.ts`, `server/testing/fixtures.ts`; create `tsconfig.server.json`; modify `tsconfig.json`, `package.json`, `.gitignore`.

**Consumes:** Approved spec only; existing frontend continues to work during this task.

**Produces:** Export the following contracts from `shared/contracts.ts`. IDs are opaque strings generated by trusted code; validators restrict filesystem IDs to UUIDs or fixed coordinator-generated prefixes.

```ts
export type Status = 'triaging' | 'queued' | 'running' | 'waiting-for-human'
  | 'blocked' | 'done' | 'rejected' | 'cancelled';
export type Role = 'triage' | 'researcher' | 'prd-writer' | 'implementer' | 'reviewer';
export type ActionClass = 'read' | 'write-local' | 'open-pr' | 'merge' | 'deploy';
export type ArtifactRef = { id: string; version: number; digest: string; path: string };
export type RepoRef = { repository: string; rule: string; commit: string; selectedCommits: string[] };
export type AgentStep = {
  kind: 'agent'; id: string; title: string; role: Role; instructions: string;
  inputs: ArtifactRef[]; repositories: string[]; actions: ActionClass[];
  outputs: string[]; checks: string[];
};
export type HumanStep = {
  kind: 'human'; id: string; title: string; producerStepId: string;
  artifactIds: string[]; allowsStepId: string | null;
};
export type Workflow = {
  version: number; steps: Array<AgentStep | HumanStep>; completionChecks: string[];
};
export type Review = {
  id: string; kind: 'workflow' | 'artifact' | 'question' | 'pause' | 'reconciliation';
  workflowVersion: number | null; stepId: string; artifacts: ArtifactRef[];
  prompt: string; answer: string | null;
  decision: 'approve' | 'changes' | 'reject' | 'answer' | null;
};
export type Run = {
  id: string; stepId: string; workflowVersion: number | null;
  generation: number; phase: 'launch-intent' | 'running' | 'ended' | 'uncertain';
  pid: number | null; processStartedAt: string | null; runtimeVersion: string;
  inputRefs: ArtifactRef[]; repos: RepoRef[]; startedAt: string;
  endedAt: string | null; exitCode: number | null;
  retryCount: number; nextRetryAt: string | null; result: AgentResult | null;
};
export type Task = {
  schemaVersion: 1; id: string; revision: number; title: string; idea: string;
  type: string; projectId: string | null; source: string; status: Status;
  workflow: Workflow | null; proposedWorkflow: Workflow | null;
  currentStepId: string; completedStepIds: string[]; staleStepIds: string[];
  generation: number; intent: 'pause' | 'cancel' | null;
  reviews: Review[]; runs: Run[]; artifacts: ArtifactRef[];
  blockedReason: string | null; queuedAt: string | null; createdAt: string; updatedAt: string;
};
export type AgentResult = {
  taskId: string; attemptId: string; summary: string; artifacts: ArtifactRef[];
} & (
  | { kind: 'completed'; evidence: Record<string, string> }
  | { kind: 'needs_human'; question: string; checkpoint: string }
  | { kind: 'propose_workflow_change'; workflow: Workflow; reason: string;
      title: string; taskType: string; projectId: string | null }
  | { kind: 'blocked'; reason: string }
  | { kind: 'failed'; reason: string; retryable: boolean }
);
export type HumanAction =
  | { kind: 'answer'; reviewId: string; text: string }
  | { kind: 'approve'; reviewId: string; artifactDigests: string[] }
  | { kind: 'changes'; reviewId: string; text: string }
  | { kind: 'reject'; reviewId: string; text: string }
  | { kind: 'pause' }
  | { kind: 'cancel' }
  | { kind: 'retry'; text: string }
  | { kind: 'insert-review'; beforeStepId: string; title: string };
export type Command = {
  requestId: string; taskId: string; expectedRevision: number; action: HumanAction;
};
export type DomainEvent =
  | { kind: 'human'; command: Command }
  | { kind: 'launch'; run: Run }
  | { kind: 'started'; attemptId: string; pid: number; processStartedAt: string }
  | { kind: 'finished'; attemptId: string; generation: number;
      exitCode: number; result: AgentResult }
  | { kind: 'stopped'; attemptId: string; uncertainEffects: boolean }
  | { kind: 'run-failed'; attemptId: string; reason: string;
      retryAt: string | null; exitCode: number | null; uncertainEffects: boolean }
  | { kind: 'block'; reason: string };
export type StoredEvent = {
  operationId: string; payloadDigest: string; revision: number; at: string;
  event: DomainEvent | { kind: 'created' }; state: Task;
};
export type Issue = { id: string; taskId: string | null; message: string };
export type WorkspaceView = { tasks: Task[]; issues: Issue[]; coordinator: 'ready' | 'degraded' };
```

`shared/validate.ts` exports `parseTask(value: unknown): Task`, `parseWorkflow(value: unknown): Workflow`, `parseCommand(value: unknown): Command`, and `parseAgentResult(value: unknown): AgentResult`. Throw `Error` with actionable field names on invalid values; validate nested discriminants, finite positive revisions, duplicate step IDs, earlier producer references, allowed roles/actions, and nonempty checks. Do not cast untrusted JSON into these types.

`server/domain/workflow.ts` exports `reduceTask(task: Task, event: DomainEvent, now: string): Task`, `eligibleStep(task: Task): AgentStep | null`, and `isTerminal(status: Status): boolean`. The reducer does not increment revisions; the store does. A built-in `$triage` step is eligible on fresh/continuing triage without workflow approval. All other execution requires an approved workflow. Questions leave the current step incomplete; final review can transition directly to done.

- [x] Add these test fixtures, exporting `draftTask(): Task`, `workflowProposal(): Workflow`, and `waitingTask(): Task`. Each returns fresh objects with fixed test UUIDs. `waitingTask()` has a pending workflow review named `workflow-review`, proposal version 1 with researcher step `research` followed by human step `findings`, and revision 1.

```ts
it('cannot dispatch proposed work before approval', () => {
  const t = waitingTask();
  expect(eligibleStep(t)).toBeNull();
  const next = reduceTask(t, { kind: 'human', command: {
    requestId: 'approve-1', taskId: t.id, expectedRevision: 1,
    action: { kind: 'approve', reviewId: 'workflow-review', artifactDigests: [] },
  } }, '2026-09-21T12:00:00Z');
  expect(eligibleStep(next)?.id).toBe('research');
});
it('rejects malformed workflow references', () => {
  const w = workflowProposal();
  w.steps[1] = { kind: 'human', id: 'findings', title: 'Review',
    producerStepId: 'missing', artifactIds: [], allowsStepId: null };
  expect(() => parseWorkflow(w)).toThrow(/producer/i);
});
```

- [x] Run `npm test -- --run shared/validate.test.ts server/domain/workflow.test.ts`; expect missing exports or missing behavior, not unrelated configuration failure.
- [x] Implement validators and reducer with explicit branches. Add cases for cancellation of queued tasks, terminal immutability, answered questions remaining unapproved, request-changes returning to the producer, and completion requiring all checks/reviews. Keep schema and domain errors distinct from retryable process errors.

```ts
export function eligibleStep(task: Task): AgentStep | null {
  if (isTerminal(task.status) || task.intent || task.blockedReason) return null;
  if (task.reviews.some(r => r.decision === null)) return null;
  if (task.status !== 'triaging' && task.status !== 'queued') return null;
  return lookupEligibleAgentStep(task);
}
```

Implement private `lookupEligibleAgentStep(task: Task): AgentStep | null` in the same file: construct the read-only triage step for `$triage`; otherwise find `currentStepId` in `task.workflow.steps` and require `kind === 'agent'` and not completed/stale without a rerun target. This helper must not consult `proposedWorkflow`. Validators permit `$triage` as the special checkpoint producer for reviewing the initial proposal. `run-failed` always ends or marks uncertain the attempt before queueing a permitted retry; it cannot leave a failed process counted as running. Set `queuedAt` when entering queued/triaging, preserve it during retries, and clear it on terminal completion.

- [x] Add server compiler configuration: `module` and `moduleResolution` `NodeNext`, `target` `ES2023`, `rootDir` `.`, `outDir` `dist-server`, `strict: true`, `types: ['node']`, include `server` and `shared`, exclude tests and `server/testing`. Use `.js` suffixes in server relative imports. Include `shared` in frontend typechecking. Add `build:ui` with the existing build command and `build:server` as `tsc -p tsconfig.server.json`; set `build` to run both. Ignore `dist-server/` and `.symphony-local/`.

```json
{
  "compilerOptions": {
    "target": "ES2023", "module": "NodeNext", "moduleResolution": "NodeNext",
    "rootDir": ".", "outDir": "dist-server", "strict": true,
    "skipLibCheck": true, "types": ["node"]
  },
  "include": ["server/**/*.ts", "shared/**/*.ts"],
  "exclude": ["**/*.test.ts", "server/testing"]
}
```

- [x] Run the focused tests and `npm run build`; record results. No server launch or real agent invocation is needed.

## Task 2: Implement durable storage, path boundaries and host ownership

**Files:** Create `server/store/atomic.ts`, `paths.ts`, `task-store.ts`, `lock.ts`, and matching `.test.ts` files.

**Consumes:** Task 1 contracts, parsers and reducer.

**Produces:**

```ts
export type Store = {
  create(task: Task, operationId: string): Promise<Task>;
  get(taskId: string): Promise<Task>;
  list(): Promise<WorkspaceView>;
  apply(taskId: string, expectedRevision: number, operationId: string,
    event: DomainEvent): Promise<Task>;
  recover(): Promise<Issue[]>;
  publishArtifact(taskId: string, artifactId: string, bytes: Uint8Array): Promise<ArtifactRef>;
  publishWorkflow(taskId: string, workflow: Workflow): Promise<void>;
  publishRunFiles(taskId: string, attemptId: string,
    files: Record<string, Uint8Array>): Promise<void>;
};
// task-store.ts
export function openStore(root: string): Promise<Store>;
// atomic.ts
export function writeAtomic(path: string, bytes: string | Uint8Array): Promise<void>;
// paths.ts: realpath/lstat checks, no symlinks; require target beneath root
export function confinedPath(root: string, relative: string): Promise<string>;
// lock.ts: operational local root, outside synced workspace
export function acquireHostLock(localRoot: string): Promise<() => Promise<void>>;
```

- [x] Write temporary-directory tests for idempotency and revision conflicts:

```ts
it('replays the same operation before checking its old revision', async () => {
  const store = await openStore(root); // root created with fs.mkdtemp in beforeEach
  const t = await store.create(waitingTask(), 'create-1');
  const event: DomainEvent = { kind: 'human', command: {
    requestId: 'approve-1', taskId: t.id, expectedRevision: t.revision,
    action: { kind: 'approve', reviewId: 'workflow-review', artifactDigests: [] },
  } };
  const first = await store.apply(t.id, t.revision, 'approve-1', event);
  expect(await store.apply(t.id, t.revision, 'approve-1', event)).toEqual(first);
  const changed = structuredClone(event);
  changed.command.action = { kind: 'cancel' };
  await expect(store.apply(t.id, t.revision, 'approve-1', changed)).rejects.toThrow(/operation/i);
});
```

- [x] Run `npm test -- --run server/store`; expect failure before implementation.
- [x] Implement per-task promise serialization. Hash canonical event payloads with recursively sorted object keys; compare repeated operation IDs before revision checks. For a new operation validate revision, reduce, increment revision once, durably publish immutable event then update `task.json`. `create` starts at revision 1. Preserve and validate original bytes in `idea.md`.

Persist workflow versions, review records and run inputs/results through the store before publishing events that reference them. `publishArtifact` assigns the next immutable version and computes the digest; `publishWorkflow` rejects different content at an existing version; `publishRunFiles` accepts only fixed filenames `input.json`, `stdout.log`, `stderr.log`, `result.json`, and `process.json`. Stream live logs under the local operational root and publish bounded final logs after exit. Artifact publication alone never advances state. For read-only report output, turn named evidence text matching declared step outputs into artifacts through `publishArtifact` before the completion event.

```ts
// atomic.ts core sequence; finally removes leftover temp file on failure.
const handle = await open(tempPath, 'wx', 0o600);
try { await handle.writeFile(bytes); await handle.sync(); }
finally { await handle.close(); }
await rename(tempPath, destination);
// Flush parent directory where supported; report real I/O errors.
```

Generate the temporary filename in the destination's directory with `randomUUID()`. Immutable event names contain padded revision and operation ID; reject a conflicting existing revision before publication. Host locking plus task serialization prevents concurrent publisher replacement.

- [x] Add disk-failure tests by injecting `writeAtomic` failure after event publication. After reopening, expect snapshot reconstructed with the accepted decision and exactly one event. Check disk-full before publication leaves no advanced state and disables affected dispatch. Test incomplete temp files, duplicate task IDs, invalid schemas, missing event revisions, and terminal-state publication before folder move.
- [x] Implement recovery by validating ordered events and reconstructing snapshots, completing terminal directory moves, and reporting conflicts as `Issue`s. Never schedule a conflicting task. Use nonrecursive safe directory scans; reject `../`, absolute artifact paths and symlink escapes. Do not follow symlinks in the task tree.

Use typed boundary errors with codes `invalid`, `missing`, `conflict`, and `unavailable` (export `BoundaryError extends Error` from `shared/validate.ts`). Store/API code branches on the code, not message text. Keep complete immutable payloads in events so rebuilding derived review/run snapshots does not lose decisions.
- [x] Implement exclusive host ownership using an atomically created lock directory plus owner PID/start token. A live or uncertain owner blocks startup; remove a stale lock only when ownership is proven dead. Do not claim cross-machine safety. Test a second local owner is rejected.
- [x] Run `npm test -- --run server/store` and `npm run build`; record the persistence fault results.

## Task 3: Build OneDrive-compatible intake and replay protection

**Files:** Create `server/intake/intake.ts`, `server/intake/intake.test.ts`.

**Consumes:** Store, atomic writer and confined paths from Task 2.

**Produces:**

```ts
export type Intake = {
  scan(nowMs: number): Promise<void>;
  submit(markdown: string, requestId: string): Promise<{ submissionId: string }>;
  issues(): Promise<Issue[]>;
};
export function createIntake(root: string, store: Store,
  stableMs: number): Intake;
```

- [x] Write stability and replay tests using `mkdtemp`, `writeFile`, and an injected clock argument:

```ts
it('waits for stability and ignores replay of a received source', async () => {
  const intake = createIntake(root, store, 2000);
  await writeFile(join(root, 'drafts', 'idea.md'), 'Investigate login failures');
  await intake.scan(0);
  expect((await store.list()).tasks).toHaveLength(0);
  await intake.scan(2001);
  const id = (await store.list()).tasks[0].id;
  await writeFile(join(root, 'drafts', 'idea.md'), 'Investigate login failures');
  await intake.scan(3000); await intake.scan(5001);
  expect((await store.list()).tasks.map(t => t.id)).toEqual([id]);
});
```

- [x] Run `npm test -- --run server/intake/intake.test.ts`; confirm failure.
- [x] Implement two stable byte/digest observations separated by `stableMs`; verify bytes again immediately before pickup. Decode using fatal UTF-8 decoding, reject blank or over-1-MiB drafts with an intake issue, preserve raw bytes for invalid/conflicting files. Ignore temporary extensions and directories.

```ts
// Durable pickup order, resumed by receipt on the next scan:
await writeAtomic(receiptPath, JSON.stringify(receipt));
await store.create(task, receipt.operationId);
// Re-read source; unlink only if it still matches receipt.digest.
```

Persist receipts under `.intake/receipts/` with original relative filename, normalized lookup key, digest, task ID, operation ID and pickup phase. Normalize Unicode to NFC and use platform-appropriate case comparison, preserving original spelling. A key collision with different bytes becomes an issue. Changed bytes after claim are copied under `.intake/conflicts/`; do not overwrite `idea.md`. Independent filenames with identical content create independent tasks.

- [x] Add tests for crash after receipt/before materialization, after task/before inbox deletion, changed source after claim, UTF-8 filenames, case collision, symlink source, and two distinct identical drafts. Verify no content is lost or executed twice. Directory watchers will only trigger `scan`; polling is sufficient for correctness.
- [x] Implement `submit` with a UUID/request-ID-derived filename, atomic `.tmp` → `.md` publication and idempotency receipt. Same request ID/different content is a conflict. Submission response is an intake ID, not a promise that triage already completed.
- [x] Run intake/store tests and `npm run build`; record results.

## Task 4: Configure roles, projects and isolated repository inputs

**Files:** Create `server/config/settings.ts`, `registry.ts`, matching tests, `server/repos/workspace.ts`, `workspace.test.ts`, `config/examples/settings.json`, `project.json`, `roles.json`.

**Consumes:** Role, ActionClass and RepoRef contracts.

**Produces:**

```ts
export type Settings = {
  workspaceRoot: string; localRoot: string; codexBinary: string;
  port: number; concurrency: number; scanMs: number; stableMs: number;
  runTimeoutMs: number; stopGraceMs: number; outputLimitBytes: number;
  allowedOrigin: string; environmentKeys: string[];
};
export type Repository = { id: string; localPath: string | null;
  mcpProfile: string | null; baseRef: string; defaultRef: string };
export type Project = { id: string; names: string[]; repositories: Repository[] };
export type RoleConfig = { role: Role; instructions: string; skills: string[];
  cliProfile: string; actions: ActionClass[] };
export type Registry = { projects: Project[]; roles: RoleConfig[] };
export function loadSettings(path: string): Promise<Settings>;
export function loadRegistry(workspaceRoot: string): Promise<Registry>;
export function matchProjects(registry: Registry, name: string): Project[];
export function resolveLocalRef(repository: Repository, rule: string): Promise<RepoRef>;
export function prepareCheckout(localRoot: string, taskId: string,
  repository: Repository, ref: RepoRef): Promise<string>;
```

- [x] Write registry and local Git fixture tests. Initialize only temporary fixture repositories, make two commits/tags, and prove selection is recorded as a commit ID and two task checkouts differ. Check matching is ambiguous rather than silently picking the first project.

```ts
it('returns all matching projects for clarification', () => {
  const registry: Registry = { roles: [], projects: [
    { id: 'one', names: ['Sales'], repositories: [] },
    { id: 'two', names: ['Sales'], repositories: [] },
  ] };
  expect(matchProjects(registry, 'sales').map(p => p.id)).toEqual(['one', 'two']);
});
```

- [x] Run `npm test -- --run server/config server/repos`; confirm failures.
- [x] Implement strict config parsing and safe argument-array Git calls. For the first version define `latest-tag` as newest commit-date tag reachable from `baseRef` (deterministic name tie-break); `recent:N` as the last N commits on `baseRef`, recording head SHA in `commit` and explicit selected SHAs in `selectedCommits`; ordinary refs resolve with `git rev-parse --verify <ref>^{commit}` after rejecting option-like refs. `selectedCommits` contains the one resolved SHA for ordinary refs/tags. Preserve the literal rule in RepoRef. Mutable work uses a unique task branch/worktree outside the synced root. Never checkout/reset the source repository.

```ts
spawn('git', ['-C', repository.localPath!, 'worktree', 'add',
  '-b', `symphony/${taskId}`, targetPath, ref.commit], { shell: false });
```

Before creation, verify task ownership if the directory/branch already exists; reuse only for the same recorded task/revision. Record mappings under the host-local task directory. If a reference is unavailable, block with its repository/rule; do not silently use HEAD.

- [x] Create examples with one alias-based project and five roles. Triage/research/PRD/reviewer default to read access; implementer allows local writes. External actions require a separately provisioned profile exposing the relevant tool without wider credentials. For MCP-only research, use a recorded read-only preparation assignment with step ID `$resolve:<step-id>` under the same scheduler/concurrency/pause rules; it returns a versioned `repository-refs.json` artifact containing validated RepoRef records before the main assignment starts. It does not mark the research step complete. Missing or malformed SHA evidence blocks subsequent work. Do not invent GitLab credentials or an MCP server implementation.
- [x] Settings defaults: concurrency 1, scan 2000 ms, stability 2000 ms, timeout 30 minutes, stop grace 5 seconds, output cap 10 MiB per run, port 4317, allowedOrigin `http://127.0.0.1:4317`, no additional environment keys. Require absolute disjoint workspace/local roots, valid positive limits, existing Codex binary, and profile names without path traversal. Missing company profiles remain actionable configuration errors. Example JSON files use explicit example paths and require editing before use; never silently point at the user's real folders.
- [x] Run focused tests and build; record results and example configuration paths.

## Task 5: Execute bounded assignments through Codex CLI

**Files:** Create `server/codex/adapter.ts`, `result-schema.ts`, `prompt.ts`, `process-control.ts`, matching tests, and `server/testing/fake-cli.mjs`.

**Consumes:** Settings/RoleConfig from Task 4, Task/AgentResult/Run from Task 1.

**Produces:**

```ts
export type Assignment = {
  task: Task; step: AgentStep; run: Run; role: RoleConfig;
  cwd: string; outputDir: string; schemaPath: string;
};
export type Exit = { code: number | null; signal: string | null;
  result: AgentResult | null; error: string | null };
export type Running = {
  pid: number; processStartedAt: string; completion: Promise<Exit>;
  stop(): Promise<void>;
};
export type Runner = {
  probe(): Promise<{ version: string }>;
  start(assignment: Assignment, onLine: (line: string) => void): Promise<Running>;
};
export type LaunchOverride = { executable: string; prefixArgs: string[] };
export function createCodexRunner(settings: Settings, launchOverride?: LaunchOverride): Runner;
export function buildPrompt(assignment: Assignment): string;
export function writeResultSchema(path: string): Promise<void>;
// process-control.ts
export function stopProcessTree(pid: number, graceMs: number): Promise<void>;
```

- [x] Create a test-only executable fixture controlled by a JSON scenario file in its working directory. It supports `--version`, `exec --help`, stdin capture, JSONL chunks, a final output file, exit code, wait-until-killed, and spawning a waiting child. Fixture modes: success, question, malformed-final, zero-no-final, split-utf8, overflow, nonzero, hang. Use `launchOverride: { executable: process.execPath, prefixArgs: [absoluteFakeCliPath] }` to run the `.mjs` directly without a build. The application entry point never accepts this override from requests or task files.

```ts
// Fake CLI split-stream scenario:
const bytes = Buffer.from('{"message":"Investigating café"}\n');
const split = bytes.indexOf(Buffer.from('é')) + 1;
process.stdout.write(bytes.subarray(0, split));
setTimeout(() => process.stdout.write(bytes.subarray(split)), 5);
// For hang mode keep a timer open; signals must terminate it and its child.
```

- [x] Add tests proving malformed/absent final output never becomes completion; prompt contents such as `$(touch unwanted)` stay literal stdin; partial UTF-8 and line chunks assemble correctly; JSONL logs do not count as final results. Test output cap and timeout terminate the process tree and return errors.

```ts
it('requires validated final output even after exit zero', async () => {
  const active = await runner.start(assignment, () => {});
  // beforeEach configures the fixture's zero-no-final scenario.
  const exit = await active.completion;
  expect(exit.code).toBe(0);
  expect(exit.result).toBeNull();
  expect(exit.error).toMatch(/final/i);
});
```

- [x] Run `npm test -- --run server/codex`; confirm meaningful failures.
- [x] Probe the actual executable's version/help once at startup. Require noninteractive exec, JSON events, schema and final-output file support. Before model work, verify configured profiles expose only the declared filesystem/tools/credentials: sandbox confinement protects the task store; read-only profiles cannot write repositories; local-write profiles cannot use merge/deploy credentials. Run host-specific confinement probes against disposable sentinel files during deployment verification. Profiles that inherit broader ambient tools must be isolated or rejected. Pin tested flag construction to its capabilities; do not use App Server, `--last`, or approval/sandbox bypass flags. Build the process call as:

```ts
const args = ['-a', 'never', '-p', assignment.role.cliProfile,
  'exec', '--json', '--output-schema', assignment.schemaPath,
  '--output-last-message', finalPath, '-C', assignment.cwd, '-'];
const child = spawn(settings.codexBinary, args, {
  shell: false, stdio: ['pipe', 'pipe', 'pipe'],
  detached: process.platform !== 'win32', env: allowedEnvironment,
});
child.stdin.end(buildPrompt(assignment));
```

`allowedEnvironment` copies host essentials (`PATH`, temporary directory and required Codex authentication/profile location variables) plus explicitly configured tool variables. Do not inherit unrelated repository credentials automatically. Verify argument placement against installed `codex --help` and `codex exec --help` during implementation; unsupported installations fail startup with the missing capability.

- [x] Write a complete JSON schema matching AgentResult and validate the same envelope at runtime. The agent writes its artifacts beneath the assignment output directory; coordinator ingestion computes actual digests and versions, rejects nonmatching declared content, symlinks and escaping paths, and copies accepted files into the task store before applying completion. External links are artifact contents, not arbitrary filesystem paths.
- [x] Implement fresh prompt assembly with original idea, selected role/skill text, exact repository refs, approved actions, relevant artifacts, prior result summary and human feedback. Explicitly instruct interactive skills to return `needs_human` and exit. Triage returns a workflow proposal; it cannot declare the whole task done. A request for forbidden permissions returns blocked, not an interactive terminal prompt. Read-only roles return report text in the final result evidence, allowing the coordinator to materialize Markdown artifacts without granting arbitrary write access. Local-write roles may also produce confined output files.
- [x] Capture complete logs to host-local files with bounded total bytes; expose only bounded tails to callbacks/UI. Use stream decoding and line buffering. On timeout or cap, stop the process tree and preserve partial output. POSIX uses the managed process group; Windows requires a tested process-tree termination implementation (`taskkill /PID <pid> /T`, then `/F` on escalation). If the host cannot enforce or verify stopping/permissions, block execution with an explicit capability error.
- [x] Run adapter tests and build. Record installed CLI compatibility from help/probe without starting real agent work.

## Task 6: Dispatch approved work and reconcile interrupted attempts

**Files:** Create `server/coordinator/coordinator.ts`, `recovery.ts`, matching tests.

**Consumes:** Store, Intake, Registry, Runner, domain eligibility and repository preparation.

**Produces:**

```ts
export type Coordinator = {
  tick(now: Date): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  shutdown(): Promise<void>;
};
export function createCoordinator(deps: {
  store: Store; intake: Intake; registry: Registry;
  runner: Runner; settings: Settings;
}): Coordinator;
export function recoverAttempts(store: Store, localRoot: string): Promise<Issue[]>;
```

- [x] Write a controlled fake Runner using a pending promise per assignment, with `start` calls recorded and `stop` resolving an interrupted Exit. Export this test helper as `controlledRunner(): { runner: Runner; starts: Assignment[]; finish(attemptId: string, exit: Exit): void }` from `server/testing/fixtures.ts`. Add concurrency tests:

```ts
it('never dispatches a waiting task and does not await another run in tick', async () => {
  await store.create(waitingTask(), 'waiting');
  const t = draftTask();
  await store.create(t, 'draft');
  await coordinator.tick(new Date('2026-09-21T12:00:00Z'));
  expect(control.starts).toHaveLength(1);
  expect(control.starts[0].task.id).toBe(t.id);
  await coordinator.tick(new Date('2026-09-21T12:00:01Z'));
  expect(control.starts).toHaveLength(1);
});
```

Use unique fixture task IDs in this test. Also test concurrency two across three tasks and a pending human task releasing its slot.

- [x] Run `npm test -- --run server/coordinator/coordinator.test.ts server/coordinator/recovery.test.ts`; confirm failures.
- [x] Implement a nonoverlapping tick: intake scan, list eligible records, select by oldest queued timestamp/task ID, reserve an in-memory slot, re-read eligibility under the task serializer, persist launch intent, then spawn. Preparation/probe failures release the slot and persist blocked state; never await assignment completion inside tick.

```ts
const launched = await store.apply(task.id, task.revision, run.id, { kind: 'launch', run });
const active = await runner.start(assignment, captureLine);
await store.apply(launched.id, launched.revision, `${run.id}:started`, {
  kind: 'started', attemptId: run.id, pid: active.pid,
  processStartedAt: active.processStartedAt,
});
void active.completion.then(exit => acceptExit(run.id, exit)).catch(recordOperationalFailure);
```

Define `captureLine(line: string): void`, `acceptExit(attemptId: string, exit: Exit): Promise<void>` and `recordOperationalFailure(error: unknown): void` as private coordinator helpers. `acceptExit` finds the recorded owning task, persists logs/artifacts, re-reads it and applies a version-checked finished/run-failed/stopped event. If a pause races with launch, the post-spawn check immediately stops the process and never applies normal completion. Run generation and relevant workflow/input references govern acceptance; unrelated log updates do not invalidate results. An insertion affecting only future steps preserves the running assignment's generation and input binding; it must not discard otherwise valid current work.

- [x] Implement startup recovery before intake/scheduling. Rebuild store snapshots/moves, then inspect every unfinished run. Proven-dead read-only work may requeue within retry bounds; proven-live orphan work occupies capacity and is monitored/stopped before retry; unknown identity becomes blocked reconciliation. Do not signal a reused PID. A launch-intent without verified registration is uncertain even if no PID exists. Preserve partial work/output.
- [x] Add a race/failure matrix: crash after launch intent, after spawn/before registration, after output/before state application, cancellation before spawn completes, duplicate final callback, stale generation after workflow revision, failure to persist started state, two failed transient launches then exhaustion. For fake time, use 1-second then 5-second retry delays; no automatic retry of any started mutating attempt unless reconciliation proves absence of effects.
- [x] Recheck completion evidence against step checks. Each required check ID needs evidence; referenced artifacts must exist with verified digests. Checks that require human judgment remain checkpoints; an agent's text cannot authorize merge/deploy. Unsupported action profiles block the step before launch.
- [x] Run store, domain, coordinator and adapter tests plus build; record results.

## Task 7: Implement review decisions, workflow revisions and task-wide pauses

**Files:** Create `server/coordinator/reviews.ts`, `reviews.test.ts`; extend `server/domain/workflow.ts` and its tests.

**Consumes:** Store, Coordinator.stopTask, HumanAction and artifact versions.

**Produces:**

```ts
export function applyHumanCommand(store: Store, coordinator: Coordinator,
  command: Command): Promise<Task>;
```

- [x] Add a test that persists a pause before invoking process stop and rejects result advancement during that window:

```ts
it('persists the pause barrier before requesting stop', async () => {
  const coordinator = { tick: async () => {}, shutdown: async () => {},
    stopTask: async (id: string) => {
      expect((await store.get(id)).intent).toBe('pause');
    } };
  const t = await store.create(draftTask(), 'create');
  await applyHumanCommand(store, coordinator, { taskId: t.id,
    expectedRevision: t.revision, requestId: 'pause-1', action: { kind: 'pause' } });
  expect(eligibleStep(await store.get(t.id))).toBeNull();
});
```

- [x] Run `npm test -- --run server/coordinator/reviews.test.ts server/domain/workflow.test.ts`; confirm missing behaviors fail.
- [x] Implement command application with `store.apply` first and process stopping second. Queued/triage tasks with no live run can pause immediately; running tasks keep intent visible until exit. Cancellation follows the same barrier and reaches terminal state only after confirmed stop; rejection requires a pending review.

```ts
const next = await store.apply(command.taskId, command.expectedRevision,
  command.requestId, { kind: 'human', command });
if (next.intent === 'pause' || next.intent === 'cancel') {
  await coordinator.stopTask(next.id);
}
return store.get(next.id);
```

- [x] Implement approval guards: pending review ID, matching workflow version/digests, available artifacts, no terminal task and no unresolved earlier review. Empty artifacts are valid for an initial workflow review only; its proposal version/content is still bound by the persisted review and task revision. Answers clear only the question; they do not clear approval checkpoints.
- [x] Implement request-changes: require trimmed feedback, resolve the pending decision, invalidate the producer and its dependent suffix, select the producer for rerun, and create new artifact versions on completion. A proposed workflow revision cannot activate until approved. Changed permissions or changed earlier work invalidate affected approvals; preserve earlier history.
- [x] Implement checkpoint insertion before an unstarted step: new immutable workflow version, inserted HumanStep bound to the preceding producer or current completed artifact set, explicit UI command as authorization for this restrictive change. Preserve approvals for unchanged completed work with recorded provenance; do not duplicate a protected action. For insertion before the first agent step, bind to the approved workflow proposal using `$triage` as producer. If target started meanwhile, reject with conflict and offer pause instead.

When preserving an approval across a restrictive revision, record both its original workflow version and the new version's unchanged step/artifact binding in the revision event. Never rewrite the original decision. When prior work becomes stale, remove affected IDs from `completedStepIds`, retain their artifacts/history, and queue the earliest approved rerun target. Clear each stale marker only after a new accepted result.
- [x] Add tests for repeated brainstorming questions, final approval → done, request-changes → rerun → new review, altered digest rejection, deleting/reordering a checkpoint via agent proposal requiring approval, inserting review during another step, rejection after partial work and cancellation preserving PR evidence. A manual pause has an explicit “Continue” approval tied to its recorded context; uncertainty uses reconciliation, requiring a note before retry.
- [x] Run all domain/store/coordinator tests and build; record results.

## Task 8: Expose the internal API and application entry point

**Files:** Create `server/http/api.ts`, `access.ts`, `static.ts`, corresponding tests, `server/main.ts`; modify `package.json`, `vite.config.ts`.

**Consumes:** Settings, Registry, Store, Intake, Coordinator and review commands.

**Produces:** `createApi(deps: { store: Store; intake: Intake; coordinator: Coordinator; allowedOrigin: string }): import('node:http').RequestListener`. HTTP contracts:

| Method/path | Request/result |
|---|---|
| `GET /api/workspace` | WorkspaceView, including intake/store operational issues. |
| `GET /api/tasks/:id` | Task or 404. |
| `POST /api/drafts` | `{ requestId, markdown }` → 202 `{ submissionId }`. |
| `POST /api/tasks/:id/commands` | Command → persisted Task. |
| `GET /api/tasks/:id/runs/:runId/log?offset=N` | `{ text, nextOffset, complete }`; bounded 64-KiB response. |
| `GET /api/tasks/:id/artifacts/:artifactId?version=N` | Safe text/download with content disposition; never execute HTML. |
| `GET /api/health` | `{ status: 'ready' | 'degraded', runtimeVersion: string }`; no credentials. |

- [x] Test with a real ephemeral HTTP server and global fetch:

```ts
it('does not turn a stale browser decision into an approval', async () => {
  const response = await fetch(`${base}/api/tasks/${task.id}/commands`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ requestId: 'stale', taskId: task.id,
      expectedRevision: 0, action: { kind: 'approve',
        reviewId: 'workflow-review', artifactDigests: [] } }),
  });
  expect(response.status).toBe(409);
  expect((await store.get(task.id)).status).toBe('waiting-for-human');
});
```

Use `server.listen(0, '127.0.0.1')` in setup and close it in teardown. Also simulate lost response/repeated request, mismatched body/path ID, malformed JSON, foreign Origin and oversized bodies.

- [x] Run `npm test -- --run server/http`; confirm failures.
- [x] Implement explicit route matching and body limit (1 MiB), JSON validation, 400 invalid, 404 missing, 409 stale/conflicting operation, 413 too large, 503 persistence/runtime unavailable. Internal error responses omit stack traces and secrets; log an operation ID locally. Read request bodies incrementally and stop at the limit. Serve only confined artifact paths and known build output paths with safe MIME types.
- [x] Bind application HTTP to `127.0.0.1` by default. Corporate access is through an authenticated company reverse proxy; do not trust caller-supplied identity headers unless received through a deployment-configured trusted proxy. Check configured Origin on mutations, deny CORS by default, and reject unsolicited cross-origin requests. Local loopback mode is for a single host user. Remote deployment is not claimed ready until the company access boundary is configured and checked.
- [x] Compose startup: load config → acquire lock → recover store/runs → probe CLI/profile capabilities → create loop/API → serve built UI → set ready. When configuration/capability checks fail, show clear startup diagnostics without dispatch. The main loop uses an awaited tick followed by the next scheduled timeout; HTTP remains responsive. On SIGINT/SIGTERM stop scheduling, stop/wait for active processes, flush results, close HTTP, release lock. Save uncertain runs if termination cannot be confirmed.

```json
{
  "start": "node dist-server/server/main.js",
  "build": "npm run build:ui && npm run build:server",
  "dev": "vite --host 127.0.0.1"
}
```

Document `npm run build` before first `npm run start`; resolve config from `SYMPHONY_CONFIG` or fail with the expected path. Development uses built backend plus Vite proxy `/api` to loopback backend, preserving the frontend Origin expected by the configured API. Do not add an automatic real-work launch to install/build hooks.
- [x] Run HTTP/coordinator tests and `npm run build`; verify startup/shutdown with fake CLI and temporary roots. Record the endpoint and process-lifecycle results.

## Task 9: Replace browser-owned demo state with coordinator data

**Files:** Create `src/tasks/api.ts`, `useWorkspace.ts`, `presentation.ts`, corresponding tests; modify `src/App.tsx`, `src/components/Inbox.tsx`, `NewTaskDialog.tsx`, `Icons.tsx`, `TaskDetail.tsx`, `StageCard.tsx`; delete `src/tasks/model.ts`, `storage.ts`, `fixtures.ts`, and obsolete tests once every consumer compiles against the new contracts (migrate TaskDetail/StageCard with read-only output; controls follow in Task 10).

**Consumes:** Task, WorkspaceView and Command API contracts.

**Produces:**

```ts
export type WorkspaceApi = {
  load(signal?: AbortSignal): Promise<WorkspaceView>;
  submit(markdown: string, requestId: string): Promise<{ submissionId: string }>;
  command(value: Command): Promise<Task>;
};
export const workspaceApi: WorkspaceApi;
export function useWorkspace(api?: WorkspaceApi): {
  view: WorkspaceView | null; connected: boolean; error: string | null;
  refresh(): Promise<void>; submit(markdown: string): Promise<void>;
  act(command: Command): Promise<void>;
};
```

`presentation.ts` exports `statusLabel(task: Task): string`, `needsReview(task: Task): boolean`, `isClosed(task: Task): boolean`. Pause/cancellation intent takes precedence over normal status label. Filter Active includes triaging/queued/running/blocked; Needs review includes pending reviews. Display free-form task types with a generic icon fallback rather than forcing all tasks into idea/bug/jira.

Change App's signature to `App({ api = workspaceApi }: { api?: WorkspaceApi })` so tests inject the boundary without patching global browser state.

- [x] Replace demo integration tests with mocked API tests while retaining meaningful search, filter, modal and keyboard checks. Prove existing `symphony-demo-v1` contents are ignored and an unavailable API produces a disconnected notice, not a seeded fake workspace:

```tsx
it('does not invent work when the coordinator is unavailable', async () => {
  const api: WorkspaceApi = {
    load: async () => { throw new Error('Coordinator unavailable'); },
    submit: vi.fn(), command: vi.fn(),
  };
  localStorage.setItem('symphony-demo-v1', '{"tasks":[{"title":"Fake"}]}');
  render(<App api={api} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Coordinator unavailable');
  expect(screen.queryByText('Fake')).not.toBeInTheDocument();
});
```

- [x] Run `npm test -- --run src/App.test.tsx src/tasks`; confirm new tests fail for the actual missing backend behavior.
- [x] Implement polling every two seconds with abort-on-unmount and request generation ordering. A slower earlier fetch must not overwrite a later accepted command or newer view. Keep the last known task visible on disconnect with stale status; disable mutation controls until reconnection/refetch. Handle 409 by retaining user feedback, refreshing the task, and requesting a new decision; never auto-retry a stale approval with a newer revision.

```ts
const generation = ++latestRequest.current;
const loaded = await api.load(controller.signal);
if (generation === latestRequest.current) setView(loaded);
```

Use an additional mutation generation barrier so a poll issued before a command cannot overwrite that command's result. Preserve selection by task ID; if a selected record disappears show unavailable and do not redirect pending actions to another task.
- [x] Change NewTaskDialog to one required free-form brief field and optional filename/title hint. Submission creates a Markdown draft through the API, clears filters, and shows “Submitted; waiting for pickup” until polling reveals it. Do not claim triage or persistence before the POST succeeds. Persist only UI preferences (selection/filter) under a new preference key.
- [x] Remove reset-demo controls, simulated completion buttons, fake release output and browser-only “Saved locally” status. Render the current real workflow as read-only stages while Task 10 adds controls. Keep the existing dark styling and responsive inbox/detail navigation. Update help copy to describe OneDrive intake and internal reviews.
- [x] Run frontend tests and the full build; record migration results and explicitly confirm no sample task can reach the runner.

## Task 10: Add live review, workflow and run panels

**Files:** Create `src/components/ReviewPanel.tsx`, `RunOutput.tsx`, `WorkflowJourney.tsx`, corresponding `.test.tsx` files; modify `TaskDetail.tsx`, `StageCard.tsx`, `src/styles.css`, `src/App.test.tsx`.

**Consumes:** Task/Review/Command and useWorkspace.act.

**Produces:** Component contracts:

```ts
type ReviewPanelProps = { task: Task; review: Review; disabled: boolean;
  onCommand: (command: Command) => Promise<void> };
type WorkflowJourneyProps = { task: Task; disabled: boolean;
  onCommand: (command: Command) => Promise<void> };
type RunOutputProps = { taskId: string; runId: string };
```

- [x] Add interaction tests for answer versus approve, feedback validation, exact digest payloads, pause-requested copy, and a submitted command that fails. For all command callbacks, build `taskId`, expected revision and review/artifact bindings from the same rendered task. Freeze that decision's request ID across network retries but generate a fresh ID for changed input.

```tsx
it('answers a question without approving the workflow', async () => {
  const t = waitingTask();
  t.reviews[0] = { ...t.reviews[0], kind: 'question', prompt: 'Which repository?' };
  const onCommand = vi.fn().mockResolvedValue(undefined);
  render(<ReviewPanel task={t} review={t.reviews[0]} disabled={false}
    onCommand={onCommand} />);
  await userEvent.type(screen.getByLabelText('Your answer'), 'sales-api');
  await userEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  expect(onCommand.mock.calls[0][0].action.kind).toBe('answer');
  expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
});
```

- [x] Run `npm test -- --run src/components src/App.test.tsx`; confirm new tests fail before implementation.
- [x] Implement pending reviews prominently above workflow details. Show exact artifact versions and what approval enables. Approvals offer Approve/Request changes/Reject task; clarification offers Send answer; pause offers Continue; reconciliation explains uncertainty and requires a resolution note before Retry. Reject/cancel preserve partial output links. Disable double submission, retain text on failure, and only clear on persisted acceptance.
- [x] Implement dynamic workflow stage cards with current/completed/stale/upcoming labels and artifact links. Add “Review before this step” to unstarted agent steps, “Pause for review” on active tasks, and cancellation control on all nonterminal tasks. The UI uses the latest server state to refresh actions but the server remains authoritative.
- [x] Implement log polling by offset with a bounded visible tail, text-only rendering and inner scrolling. Fetch artifacts by version through the safe API; render text as text and download other content. Show process failure, blocked reason and real completion summary without suggesting merge/deployment unless evidence exists.
- [x] Test long unbroken titles, multiline questions, unchanged feedback after a 409, selection switches during delayed requests and terminal actions disabled. Verify markup has labels, visible focus, `aria-expanded`, and status text beyond color.
- [x] Run focused frontend tests and build; record results. Keep real-browser layout/focus verification for Task 11.

## Task 11: Verify the full lifecycle and document operation

**Files:** Create `tests/coordinator.integration.test.ts`, `tests/codex.smoke.test.ts`, `docs/coordinator-operations.md`; update `README.md`, `package.json`, `docs/superpowers/execution/folder-coordinator-progress.md`.

**Consumes:** All public contracts above. No additional production API is introduced.

- [x] Build a real filesystem/HTTP/fake-CLI integration test. Start the composed components on an ephemeral port with isolated roots, create a Markdown draft, scan twice, wait for a workflow review, POST approval, run the researcher fixture, approve findings, assert `done/<id>/task.json`, shut down and reopen the store. Assertions must inspect persisted events and exact attempt counts, not just rendered status.

```ts
expect((await reopened.get(taskId)).status).toBe('done');
expect((await reopened.get(taskId)).runs.filter(r => r.stepId === 'research')).toHaveLength(1);
expect(await readFile(join(root, 'done', taskId, 'idea.md'), 'utf8')).toBe(originalIdea);
```

- [x] Add integration variants for human clarification twice, request changes then new artifact review, mid-run pause with a child process, restart after final output before acceptance, stale browser approval, intake conflict, and write failure. After each, assert no extra dispatch or PR-like fake side effect occurred. Run `npm test -- --run tests/coordinator.integration.test.ts` and fix failures before broadening.
- [x] Add the opt-in smoke test using an isolated temporary repository and a read-only configured Codex profile. Gate with `SYMPHONY_CODEX_SMOKE=1`; otherwise mark skipped. Prompt it only to summarize a harmless fixture and return the result envelope, then issue a second invocation with a recorded human answer to verify handoff context. Do not connect company repositories or enable writes for this smoke test.

```ts
const smoke = process.env.SYMPHONY_CODEX_SMOKE === '1' ? it : it.skip;
smoke('accepts a real CLI result under the deployment profile', async () => {
  const running = await runner.start(readOnlyAssignment, () => {});
  const exit = await running.completion;
  expect(exit.code).toBe(0);
  expect(exit.result?.taskId).toBe(readOnlyAssignment.task.id);
});
```

The test constructs `readOnlyAssignment` using Task 1 fixtures, Task 4 example profile and a temporary output/schema directory. If authentication/network/profile is unavailable, report the smoke as blocked/skipped, not passed. The host-specific process-tree stop and permission confinement checks are required before enabling real mutating workflows.
- [x] Run `npm test -- --run` and `npm run build`. Record pass/fail/skip counts and runtime versions. Run the smoke separately only where configured: `SYMPHONY_CODEX_SMOKE=1 npm test -- --run tests/codex.smoke.test.ts`.
- [x] Start the app against fake data and inspect with an available browser tool at 1440×900 and 390×844. Walk free-form submission, review, feedback, pause, cancellation, blocked recovery, reload and disconnect. Verify keyboard dialog focus and pending buttons. Save screenshots/notes outside production workspace data. If browser control is unavailable, record the unverified checks explicitly; DOM tests do not replace visual verification.
- [x] Document concrete setup: provision the OneDrive local sync root on the designated host, keep required files locally available, copy project/role examples, configure credentials/profiles outside the sync root, build, set `SYMPHONY_CONFIG`, and run `npm run start`. Describe folder meanings, CLI capability checks, all settings/defaults, local-only versus company-proxy access, logs, cancellation semantics, receipt conflicts, stale-lock reconciliation, bounded retries and backup/restore of both task records and local work directories.
- [x] Update README from simulated prototype to the actual verified feature set. Include commands and limitations, no App Server instructions, no promises of mobile UI access, and no implied production deployment. Record unsupported host/profile combinations and what has actually been tested.
- [x] Check every spec section against delivered behavior, record remaining external deployment prerequisites, and provide the final review with actual evidence. Do not mark production readiness if company authentication, OneDrive sync or real Codex permissions remain unverified.

## Coverage and handoff

| Spec requirement | Owning tasks |
|---|---|
| Free-form OneDrive intake and conflict/replay handling | 2–3 |
| Task lifecycle, terminal folders, durable records | 1–2, 6–7 |
| Approved sequential workflow and task-wide human decisions | 1, 6–7 |
| Codex CLI, role/skill context, MCP/project references | 4–5 |
| Exact input/artifact versions and scope enforcement | 1, 4–7 |
| Restart recovery, uncertain effects, bounded retries | 2, 5–6, 11 |
| Real UI, revision-safe commands and safe artifacts | 8–10 |
| Concurrency, host ownership and lifecycle | 2, 6, 8 |
| Verification, operating instructions and deployment prerequisites | 11 |

Planning self-review completed against the approved spec: every requirement is mapped above, the five Review Focus cases have owning tests, and contract inconsistencies found during review were corrected (repository commit selections, process failure events, test executable launch, and API configuration). Task completion boxes remain unchecked until implementation actually runs. The documented test commands are future execution steps; no implementation tests have been claimed as run during planning.

Recommended execution: **subagent-driven**, sequentially, with per-task review. This plan crosses persistence, subprocess and approval boundaries where independent review of each deliverable is valuable. Native execution remains an option with one final independent review. The user must review this plan and choose the execution method before implementation starts.
