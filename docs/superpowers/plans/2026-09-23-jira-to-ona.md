# Jira Documents to ONA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user open an assigned Jira, upload design and implementation documents, edit a launch prompt and target, and submit the exact package once to a mock ONA adapter.

**Architecture:** Add an optional Jira preparation payload to existing tasks and a dedicated domain reducer, bypassing the generic agent workflow. Reuse the folder store and versioned artifacts for source history, documents, drafts, and frozen packages; put Jira intake and ONA launch/lookup behind server interfaces. Compose focused preparation services into the existing API and task page without adding a Codex execution path.

**Tech Stack:** Existing TypeScript, Node.js HTTP server, React, Vite, Vitest, Testing Library, and filesystem persistence. Node.js 22.12 or newer, as required by the repository README. No new runtime dependencies are planned.

**Spec:** [Jira documents and ONA handoff](../specs/2026-09-22-jira-to-ona-design.md), revised and approved 2026-09-23.

## Global Constraints

- “Jira intake and ONA handoff remain mocked behind replaceable server adapters.”
- “Each accepts one nonempty UTF-8 .md or .txt file, up to 1 MiB.” “Both are required before sending.”
- “When explicitly enabled, sync Jira at server startup, every 60 seconds, and through Refresh Jira.”
- “This slice targets one repository.”
- “No MCP lookup is performed, and the UI must not claim the repository or branch has been remotely verified.”
- “The adapter receives the prompt and the actual document contents, not host-local paths that an ONA environment cannot access.”
- “Keep the existing global JSON request limit.”
- “Generic triage, Codex scheduling, and synced-file review processing skip these tasks.”
- “Editing is locked while sending or acceptance is unknown, preserving the package being reconciled.”
- “Sent tasks remain inspectable but cannot be edited or resubmitted in this slice.”
- Work only in `/Users/mustafakosker/projects/symphony/.worktrees/jira-to-ona`, branch `codex/jira-to-ona`. Do not modify, restart, rebase, or merge the other tab's checkout/worktree. Do not use its live `.symphony-local` data or occupied ports.
- The feature is opt-in; omitted configuration preserves legacy behavior. Preserve generic task validation, capability checks, and file-review behavior. The existing host's Codex startup checks remain unchanged; this feature never calls `Runner.start`.
- This document is a plan, not evidence of implementation or passing product tests. Implementation requires plan review and an execution-method choice.

## Review Focus

1. A browser loses an upload/save response and retries after restart: replay must not create a second selected artifact version or overwrite newer edits. Tests in Tasks 2, 4, and 7.
2. ONA accepts just before timeout/shutdown: lookup must recover the original receipt while edits and repeat launches remain locked. Tests in Tasks 5 and 6.
3. A Jira refresh or another tab updates the task during typing/upload: keep local input, reject stale writes, and bind a send to the visible snapshot. Tests in Tasks 3, 7, and 8.
4. Unicode filenames, CRLF/BOM text, exact byte limits, and aborted bodies: retain accepted file bytes exactly and never attach partial files or render uploaded HTML. Tests in Tasks 4, 6, and 8.
5. Someone cancels or sends while a replacement upload is in flight: enforce server revision/state checks, preserve historical documents, and never use an uncommitted replacement. Tests in Tasks 2, 4, and 8.

## Execution context and file map

The worktree starts from `035b842` plus the design commit `1993db1`; the approved revision is being committed with this plan. It contains the original inbox/detail UI, not the other tab's UI replacement. Integrate through the existing `App`, `TaskDetail`, `useWorkspace`, and `workspaceApi` seams. Do not copy files from the other worktree.

Before implementing Task 1, run `git status --short`, `git branch --show-current`, and `git rev-parse --git-dir --git-common-dir` here. Install locked dependencies with `npm ci` if needed, then run `npm test -- --run` and `npm run build` for a baseline. Stop to report an existing failure rather than silently changing unrelated code. Do not run `npm run start:local` for feature verification.

| Area | New files | Existing integration points |
| --- | --- | --- |
| Contracts and validation | `shared/jira-preparation.ts`, `shared/jira-validation.ts` | `shared/contracts.ts`, `shared/validate.ts` |
| Pure transitions | `server/preparation/reducer.ts`, `server/domain/transition-conflict.ts` | `server/domain/workflow.ts`, store, recovery, file reviews |
| Intake/configuration | `server/jira/adapter.ts`, `mock.ts`, `intake.ts`, `server/config/jira-handoff.ts` | settings, registries, application startup |
| Documents/drafts | `server/preparation/documents.ts`, `drafts.ts`, `operations.ts`, `service.ts` | existing versioned artifact store |
| Handoff/recovery | `server/ona/adapter.ts`, `mock.ts`, `server/preparation/handoff.ts` | application startup/shutdown |
| HTTP | `server/http/jira-preparation.ts` | `server/http/api.ts`, `access.ts` |
| Client state | `src/tasks/preparationApi.ts`, `src/tasks/usePreparation.ts` | `src/tasks/api.ts`, `useWorkspace.ts` |
| UI | `src/components/jira/JiraTaskDetail.tsx`, `DocumentSlot.tsx`, `HandoffEditor.tsx`, `HandoffReceipt.tsx` | App, inbox, presentation helpers, styles |
| Fixtures/verification | `server/preparation/testing.ts`, `tests/jira-handoff.integration.test.ts`, `scripts/preview-jira.mjs` | example config, README, operations docs |

Keep changes to large existing modules as dispatch/validation hooks. Put new behavior in the focused modules above. Each new production module gets a neighboring `.test.ts`/`.test.tsx` unless its behavior is exercised through an explicitly named integration test below.

## Shared contract reference

Task 1 defines these types in `shared/jira-preparation.ts`. Import `ArtifactRef`, `Task`, and `StoredEvent` with type-only imports to avoid runtime cycles.

```ts
export type DocumentRole = 'design' | 'implementation';
export type Target = { projectId: string; repositoryId: string; branch: string };
export type JiraSnapshot = {
  connectionId: string; issueId: string; key: string; url: string;
  projectKey: string; title: string; description: string;
  acceptanceCriteria: string | null; status: string;
  assignedToCurrentUser: boolean; open: boolean; updatedAt: string;
};
export type DocumentSelection = {
  role: DocumentRole; filename: string; size: number; ref: ArtifactRef;
};
export type PromptSelection = {
  ref: ArtifactRef; revision: number; sourceDigest: string; nonblank: boolean;
};
export type OnaReceipt = {
  requestId: string; receiptId: string; acceptedAt: string; simulated: boolean;
};
export type FrozenPackage = {
  taskId: string; requestId: string; createdAt: string; jira: JiraSnapshot;
  prompt: PromptSelection;
  documents: { design: DocumentSelection; implementation: DocumentSelection };
  target: Target;
};
export type HandoffAttempt = {
  requestId: string; packageRef: ArtifactRef; payloadDigest: string;
  dispatch: number; status: 'sending' | 'unconfirmed' | 'not-accepted' | 'accepted';
  receipt: OnaReceipt | null; reason: string | null;
};
export type JiraPreparation = {
  mode: 'jira-ona'; source: JiraSnapshot; sourceDigest: string; matchesQuery: boolean;
  phase: 'inbox' | 'preparing' | 'ready' | 'sent';
  documents: Record<DocumentRole, DocumentSelection | null>;
  prompt: PromptSelection | null; target: Target | null;
  attempts: HandoffAttempt[];
};
export type PreparationAction =
  | { kind: 'prepare' }
  | { kind: 'save'; promptText: string; target: Target | null }
  | { kind: 'remove-document'; role: DocumentRole }
  | { kind: 'send' }
  | { kind: 'retry'; handoffRequestId: string }
  | { kind: 'reconcile'; handoffRequestId: string }
  | { kind: 'cancel' };
export type PreparationCommand = {
  requestId: string; taskId: string; expectedRevision: number;
  action: PreparationAction;
};
export type UploadCommand = {
  requestId: string; taskId: string; expectedRevision: number;
  role: DocumentRole; filename: string;
};
export type PreparationChange =
  | { kind: 'source'; source: JiraSnapshot; digest: string; matchesQuery: boolean }
  | { kind: 'draft'; prompt: PromptSelection; target: Target | null }
  | { kind: 'document'; role: DocumentRole; document: DocumentSelection | null }
  | { kind: 'dispatch'; attempt: HandoffAttempt }
  | { kind: 'settle'; handoffRequestId: string; dispatch: number;
      outcome: 'accepted' | 'not-accepted' | 'unconfirmed';
      receipt: OnaReceipt | null; reason: string | null }
  | { kind: 'cancel' };
export type PreparationEvent = {
  kind: 'preparation'; inputDigest: string; change: PreparationChange;
};
export type JiraSyncView = {
  enabled: boolean; simulated: true; syncing: boolean;
  lastSuccessAt: string | null; error: string | null;
};
export type TargetOption = { projectId: string; repositoryId: string; baseBranch: string };
export type PreparationDetail = { taskId: string; revision: number; promptText: string };
```

Add `preparation?: JiraPreparation` to `Task`, `PreparationEvent` to `DomainEvent`, and optional `jira?: JiraSyncView & { targets: TargetOption[] }` to `WorkspaceView`. Keep the generic `Command`/`HumanAction` unchanged; use a dedicated preparation command route. No browser-visible object includes local repository paths, MCP profile names, or credentials.

### Task 1: Establish validated preparation contracts

**Files:** Create `shared/jira-preparation.ts`, `shared/jira-validation.ts`, `shared/jira-validation.test.ts`, `server/preparation/testing.ts`; modify `shared/contracts.ts`, `shared/validate.ts`, `shared/validate.test.ts`, `tsconfig.server.json`.

**Interfaces:** Export the types above; `parseJiraPreparation(value: unknown): JiraPreparation`, `parsePreparationCommand(value: unknown): PreparationCommand`, `parseFrozenPackage(value: unknown): FrozenPackage`, and `parseJiraSnapshot(value: unknown): JiraSnapshot`. `parseTask` preserves optional preparation state. Export `jiraIssue(overrides?: Partial<JiraSnapshot>): JiraSnapshot` and `jiraTask(overrides?: Partial<Task>): Task` from the test fixture module, building the latter from existing `draftTask()` with empty generic workflow/run/review arrays and `currentStepId: 'jira-preparation'`.

- [ ] Write the first failing schema tests, including legacy round-trip and optional-state preservation:

```ts
it('preserves preparation on task round-trip without changing legacy tasks', () => {
  expect(parseTask(draftTask())).toEqual(draftTask());
  const task = jiraTask();
  expect(parseTask(task).preparation).toEqual(task.preparation);
});
it('rejects preparation state that would also run a generic workflow', () => {
  expect(() => parseTask(jiraTask({ status: 'queued' }))).toThrow();
  expect(() => parseTask(jiraTask({ currentStepId: '$triage' }))).toThrow();
});
```

- [ ] Run `npm test -- --run shared/jira-validation.test.ts shared/validate.test.ts`; confirm the new tests fail for missing schema support.
- [ ] Implement explicit parsers using the existing validator's object/string/integer/choice patterns. Export only reusable primitive validators needed by the new module; avoid importing `parseTask` back into it. Validate UUID task IDs, safe operation IDs, timestamps, SHA-256 digests, artifact references, role/ref agreement, branch text, and HTTP(S) Jira source URLs. Reject selected/attempt references absent from `task.artifacts`, duplicate attempt IDs, receipts bound to another request, and accepted attempts without receipts. Preparation tasks have no generic runs/workflows/reviews, no generic intent, and cannot be triaging/queued.

```ts
// In parseTask's field construction, preserve omission for legacy event digests.
...(v.preparation === undefined
  ? {}
  : { preparation: parseJiraPreparation(v.preparation) })
```

- [ ] Add table-driven malformed-state cases for every invariant above. Do not add an empty preparation object to legacy task snapshots: event replay hashes must remain stable.
- [ ] Exclude the new fixture module from the production server compilation by adding `server/preparation/testing.ts` to `tsconfig.server.json`'s existing `exclude` list. Run both schema suites again; require all cases to pass. Commit with `git add -- shared/contracts.ts shared/validate.ts shared/validate.test.ts shared/jira-preparation.ts shared/jira-validation.ts shared/jira-validation.test.ts server/preparation/testing.ts tsconfig.server.json` and `git commit -m "feat: define Jira handoff task contracts"`.

### Task 2: Add pure transitions and durable operation replay

**Files:** Create `server/preparation/reducer.ts`, `server/preparation/reducer.test.ts`, `server/domain/transition-conflict.ts`; modify `server/domain/workflow.ts`, `server/domain/workflow.test.ts`, `server/store/task-store.ts`, `server/store/task-store.test.ts`, `server/coordinator/recovery.ts`, `server/file-reviews/adapter.ts`, `server/file-reviews/adapter.test.ts`.

**Interfaces:** `reducePreparation(task: Task, event: PreparationEvent, now: string): Task`; `preparationReady(value: JiraPreparation): boolean` in shared contracts for UI/domain parity. Add `Store.operation(taskId: string, operationId: string): Promise<StoredEvent | null>` as a cloned read of the recovered operation map. Move `TransitionConflict` to its own module and re-export from `workflow.ts` to preserve existing imports.

- [ ] Write reducer tests that select/remove both documents, save a prompt, send, settle, cancel, and reject mutations during sending/unconfirmed/accepted states. Use `draft`/`document` changes with concrete fixture refs; test that removal retains historical `task.artifacts`. Add this boundary regression:

```ts
it('never makes a Jira task eligible for the generic runner', () => {
  const task = jiraTask();
  expect(eligibleStep(task)).toBeNull();
  expect(() => reduceTask(task, {
    kind: 'human', command: {
      requestId: 'wrong-route', taskId: task.id, expectedRevision: 1,
      action: { kind: 'cancel' },
    },
  }, task.updatedAt)).toThrow();
});
```

- [ ] Run `npm test -- --run server/preparation/reducer.test.ts server/domain/workflow.test.ts server/store/task-store.test.ts`; confirm new failures.
- [ ] Add explicit dispatch before the generic reducer's event switch, and an early `null` return in `eligibleStep` for preparation tasks:

```ts
if (task.preparation || event.kind === 'preparation') {
  if (!task.preparation || event.kind !== 'preparation') {
    throw new TransitionConflict('Command does not match task mode');
  }
  return reducePreparation(task, event, now);
}
```

- [ ] Implement immutable transitions: readiness requires both documents, a nonblank prompt, and target; UI display `sent` maps to shared `done`; cancel maps to `cancelled`; dispatch locks editing; settlement matches both request ID and dispatch number. Only `settle` or source refresh is allowed during dispatch, and source refresh cannot change a frozen package. Terminal tasks accept no new changes. A late result for an older dispatch conflicts. New dispatch adds an attempt; retry updates the matching definitively rejected attempt only when the digest/ref are unchanged and dispatch increases by one. Append each newly selected prompt/document/package ref to `task.artifacts` without dropping previous versions.

```ts
export function preparationReady(value: JiraPreparation): boolean {
  return Boolean(value.documents.design && value.documents.implementation &&
    value.prompt?.nonblank && value.target?.projectId &&
    value.target.repositoryId && value.target.branch.trim());
}
```
- [ ] Verify all newly referenced preparation artifacts before event publication in `Store.apply`. Keep historical references in `task.artifacts` so existing recovery verifies them. `Store.operation` returns a clone, including for terminal tasks, and returns `null` for an unused operation on an existing task. Skip preparation tasks explicitly in generic recovery and file-review export.
- [ ] Add a store test: publish a document, apply its selection event, reopen with `openStore`, assert the recovered operation has the same `inputDigest`, artifact, and revision; replay the same event without increasing revision; reject changed input. Also corrupt a referenced artifact and assert recovery reports the task unavailable. Run the listed suites plus `server/file-reviews/adapter.test.ts`.
- [ ] Commit the Task 2 file list with message `feat: persist Jira preparation transitions and receipts`.

### Task 3: Implement opt-in mocked Jira intake and target mapping

**Files:** Create `server/config/jira-handoff.ts`, `server/config/jira-handoff.test.ts`, `server/jira/adapter.ts`, `server/jira/mock.ts`, `server/jira/intake.ts`, `server/jira/intake.test.ts`, `config/examples/jira-handoff.json`, `config/examples/jira-issues.json`; modify `server/config/settings.ts`, `server/config/settings.test.ts`.

**Interfaces:** Export `JiraHandoffConfig = { mode: 'mock'; connectionId: string; fixturesPath: string; projectMappings: Record<string, string> }` and `loadJiraHandoffConfig(path: string, registry: Registry): Promise<JiraHandoffConfig>`. Add optional `jiraHandoffConfigPath?: string | null` to `Settings`, defaulting to `null`. Export `JiraBatch = { complete: boolean; issues: JiraSnapshot[] }`, `JiraAdapter = { listAssignedOpen(): Promise<JiraBatch> }`, `createMockJiraAdapter(config: JiraHandoffConfig): JiraAdapter`, `jiraTaskId(connectionId: string, issueId: string): string`, and `createJiraIntake(options: { store: Store; adapter: JiraAdapter; config: JiraHandoffConfig; registry: Registry; localRoot: string }): JiraIntake`. `JiraIntake` exposes `sync(now: Date): Promise<JiraSyncView>`, `tick(now: Date): Promise<void>`, and `view(): JiraSyncView`.

- [ ] Write an intake test with a mutable in-memory adapter, a temporary store, and real registry fixtures. Sync twice, edit a task through a preparation event, then change the adapter's Jira description and sync again. Assert one task, unchanged `idea`, unchanged prompt/document refs, and updated `preparation.source`. Confirm a complete empty batch marks `matchesQuery: false`, while an incomplete or rejected batch does not.

```ts
it('gives the same issue a stable task ID even after its key changes', () => {
  const first = jiraIssue({ key: 'APP-10' });
  const renamed = { ...first, key: 'NEW-10' };
  expect(jiraTaskId(first.connectionId, first.issueId))
    .toBe(jiraTaskId(renamed.connectionId, renamed.issueId));
  expect(jiraTaskId('another-connection', first.issueId))
    .not.toBe(jiraTaskId(first.connectionId, first.issueId));
});
```

- [ ] Run `npm test -- --run server/jira/intake.test.ts server/config/jira-handoff.test.ts server/config/settings.test.ts` and confirm missing-feature failures.
- [ ] Implement deterministic UUID-shaped IDs from SHA-256 of `JSON.stringify(['jira-ona-v1', connectionId, issueId])`, using 16 hash bytes with RFC version-5/variant bits. This is a stable application ID, not a claim to implement UUIDv5 SHA-1. Check the store for that ID before creation; after interrupted creation, use existing store recovery and never create a second UUID. Preserve creation `idea` forever because recovery compares it to immutable `idea.md`.

```ts
export function jiraTaskId(connectionId: string, issueId: string): string {
  const bytes = createHash('sha256')
    .update(JSON.stringify(['jira-ona-v1', connectionId, issueId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20)].join('-');
}
```
- [ ] Validate the full batch before applying it: connection, unique issue IDs, normalized eligibility booleans, safe HTTP(S) links, and a maximum 1 MiB encoded snapshot per issue. Incomplete batches may upsert listed eligible issues but do not mark absences or update `lastSuccessAt`. Do not record a successful sync until all valid updates are persisted. On task revision conflict, re-read and retry only the source event; do not overwrite document/draft fields.
- [ ] Skip unchanged source digest/membership pairs. For a changed pair, derive the source-event operation ID from task ID and next revision, not source digest alone: a ticket may legitimately move from snapshot A to B and back to A. Add this A/B/A regression to `intake.test.ts`.
- [ ] Serialize `sync` calls through one promise; `tick` schedules only when at least 60,000 ms have elapsed since the previous attempt. Persist `lastSuccessAt` atomically under the confined `localRoot/jira-handoff/sync.json`; retain it across failures/restart. Use existing `confinedPath`/`writeAtomic` and verify directories are not symlinks. Tests inject dates and adapters, never sleep for a minute.
- [ ] Populate target choices from project/repository IDs and `baseRef` only. A project mapping with exactly one repository supplies the initial target; multiple or missing choices leave it `null`. Never expose `localPath` or `mcpProfile`. Validate config paths and mapping project IDs; unknown mapping targets are configuration errors. Provide mock fixtures with clear, incomplete, and ambiguous repository examples.
- [ ] Run all Task 3 suites with restart, duplicate-batch, partial-apply retry, cancelled/sent reimport, and concurrent-manual-refresh cases. Commit the listed files with message `feat: import assigned Jira issues through a mock adapter`.

### Task 4: Save document versions and editable prompts without agents

**Files:** Create `server/preparation/operations.ts`, `server/preparation/documents.ts`, `server/preparation/documents.test.ts`, `server/preparation/drafts.ts`, `server/preparation/drafts.test.ts`.

**Interfaces:** `validateDocument(filename: string, bytes: Uint8Array): { filename: string; size: number }`; `initialPrompt(source: JiraSnapshot): string`; `createPreparationOperations(store: Store): PreparationOperations`. The operations object exposes `serial<T>(taskId: string, work: () => Promise<T>): Promise<T>`, `replay(taskId: string, requestId: string, inputDigest: string): Promise<Task | null>`, and `digest(value: unknown): string` using a canonical sorted-key JSON representation. Create `createDocumentService(store: Store, operations: PreparationOperations)` returning `upload(command: UploadCommand, bytes: Uint8Array): Promise<Task>` and `remove(command: PreparationCommand): Promise<Task>`. Create `createDraftService(store: Store, registry: Registry, operations: PreparationOperations)` returning `prepare(command: PreparationCommand): Promise<Task>`, `save(command: PreparationCommand): Promise<Task>`, and `detail(taskId: string): Promise<PreparationDetail>`. All services share one operations instance.

- [ ] Add byte-preservation and hostile-input tests before implementation:

```ts
it('preserves accepted UTF-8 bytes including BOM and CRLF', () => {
  const bytes = Buffer.from('\uFEFF# Café\r\nDesign\r\n');
  const before = Buffer.from(bytes);
  expect(validateDocument('café.md', bytes).size).toBe(bytes.length);
  expect(bytes).toEqual(before);
});
it.each(['../plan.md', 'a\\b.md', 'plan.html', 'plan.md\u0000'])
  ('rejects an unsafe or unsupported name: %s', filename => {
    expect(() => validateDocument(filename, Buffer.from('text'))).toThrow();
  });
```

- [ ] Run `npm test -- --run server/preparation/documents.test.ts server/preparation/drafts.test.ts`; confirm new failures.
- [ ] Validate basename-only filenames of 1–255 Unicode characters, `.md`/`.txt` case-insensitively, no controls/separators, 1–1,048,576 bytes, fatal UTF-8 decoding, and nonblank decoded content. Validate without normalizing/re-encoding the uploaded bytes. Reject HTML by extension, but allow text containing HTML and render it escaped later. Keep bytes in the artifact store, not in task state or command events.

```ts
export function validateDocument(filename: string, bytes: Uint8Array) {
  if (!filename || [...filename].length > 255 ||
      /[\u0000-\u001f\u007f/\\]/u.test(filename) || !/\.(md|txt)$/i.test(filename)) {
    throw new BoundaryError('invalid', 'Use a Markdown or text filename without paths');
  }
  if (!bytes.length || bytes.length > 1024 * 1024) {
    throw new BoundaryError('invalid', 'Document must be between 1 byte and 1 MiB');
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new BoundaryError('invalid', 'Document must contain valid UTF-8 text'); }
  if (!text.trim()) throw new BoundaryError('invalid', 'Document must not be blank');
  return { filename, size: bytes.length };
}
```
- [ ] Implement command idempotency before publishing artifacts. Canonical input digest includes command metadata plus SHA-256 of raw bytes for uploads; save includes exact prompt text and target. `replay` calls `Store.operation`: compare `event.kind === 'preparation'` and `inputDigest`, reject mismatches, and return the current task after a match. This avoids regressing the UI to the historic receipt's task revision.

```ts
// Inside operations.serial, after computing inputDigest from the external request.
const prior = await operations.replay(command.taskId, command.requestId, inputDigest);
if (prior) return prior;
const task = await store.get(command.taskId);
if (task.revision !== command.expectedRevision) {
  throw new BoundaryError('conflict', 'Task revision has changed');
}
// Validate mode/state before publishing. Publish bytes, then apply the bound event.
```

- [ ] Upload under server-derived IDs `jira-design`/`jira-implementation`; bind selected filename/size/ref in one `document` event. A crash between publication and selection may leave an unreferenced artifact but must not select it or make it downloadable through the task API. A crash after the event replays the original selection without another publication. Test both seams by injecting a rejected `store.apply` or restarting after a committed event.
- [ ] Initialize the deterministic prompt only on `prepare` when there is no existing prompt; selecting the page alone does not mutate. Save exact prompt UTF-8 bytes as `jira-prompt` versions, storing `nonblank: Boolean(promptText.trim())`. Blank drafts can be saved but are not ready to send. Keep the draft's original `sourceDigest` on edits to preserve changed-Jira notices. Validate target IDs against the registry and branch as nonblank, at most 255 characters, with no NUL/CR/LF; this is input validation, not remote branch verification. `detail` reads the selected prompt artifact and returns its text with the task revision.
- [ ] Record even an already-prepared `prepare` command as a `draft` event referencing the current prompt/target, without publishing another artifact. This preserves command-ID binding and replay while keeping user edits intact. Parse `save.promptText` as a string that may be empty; only send rejects blank prompt content.

```ts
export function initialPrompt(source: JiraSnapshot): string {
  return [
    `Implement ${source.key}: ${source.title}.`,
    'Use the attached Design document and Implementation plan as the task instructions.',
    'Run the checks specified in the implementation plan.',
    'Open a GitLab merge request with a summary of changes and test results.',
    'If the documents conflict or required information is missing, report the blocker.',
  ].join('\n\n');
}
```
- [ ] Test replacement/removal history, failed replacement retaining the previous ref, replay after restart, same ID/different bytes, cancel/send winning a revision race, blank draft readiness, and repeated `prepare` preserving user edits. Run the Task 4 suites and commit with message `feat: persist Jira documents and editable launch drafts`.

### Task 5: Freeze packages and implement recoverable mock ONA handoff

**Files:** Create `server/ona/adapter.ts`, `server/ona/mock.ts`, `server/ona/mock.test.ts`, `server/preparation/handoff.ts`, `server/preparation/handoff.test.ts`.

**Interfaces:** Define the following in `server/ona/adapter.ts`:

```ts
export type OnaOutcome =
  | { kind: 'accepted'; receipt: OnaReceipt }
  | { kind: 'not-accepted'; reason: string }
  | { kind: 'unknown'; reason: string };
export type OnaLaunch = {
  package: FrozenPackage; promptText: string;
  documents: Array<{ role: DocumentRole; filename: string; bytes: Uint8Array }>;
};
export type OnaAdapter = {
  launch(input: OnaLaunch, signal: AbortSignal): Promise<OnaOutcome>;
  lookup(requestId: string, signal: AbortSignal): Promise<OnaOutcome>;
};
```

Export `createMockOnaAdapter(options: { localRoot: string; scenario?: 'accept' | 'reject' | 'accept-then-timeout' }): OnaAdapter`. `scenario` is test/preview injection only; production mock defaults to `accept`. Export `createHandoffService(options: { store: Store; registry: Registry; operations: PreparationOperations; adapter: OnaAdapter; timeoutMs?: number; now?: () => Date }): HandoffService`. Its methods are `send(command: PreparationCommand): Promise<Task>`, `retry(command: PreparationCommand): Promise<Task>`, `reconcile(command: PreparationCommand): Promise<Task>`, `recover(): Promise<void>`, and `close(): Promise<void>`; default adapter timeout is 10,000 ms, bounded by abort signals.

- [ ] Build a fixture through the real Task 4 services with two distinct byte arrays, a saved prompt, and target. Add a test spy adapter that captures `OnaLaunch`. Assert exact prompt text, both exact document byte arrays, role labels, Jira snapshot, and target; then reopen the store and inspect the frozen manifest and refs. Ensure missing/corrupt bytes prevent any `adapter.launch` call.
- [ ] Add the critical uncertainty test with a mock ledger in a temporary local root:

```ts
const adapter = createMockOnaAdapter({ localRoot, scenario: 'accept-then-timeout' });
const handoff = createHandoffService({ store, registry, operations, adapter, timeoutMs: 20 });
const uncertain = await handoff.send(sendCommand);
expect(uncertain.preparation!.attempts.at(-1)!.status).toBe('unconfirmed');
const reopenedStore = await openStore(workspaceRoot);
const recovered = createHandoffService({
  store: reopenedStore, registry,
  operations: createPreparationOperations(reopenedStore),
  adapter: createMockOnaAdapter({ localRoot }),
});
await recovered.recover();
const accepted = await reopenedStore.get(sendCommand.taskId);
expect(accepted.preparation!.attempts.at(-1)!.receipt!.requestId)
  .toBe(uncertain.preparation!.attempts.at(-1)!.requestId);
expect(accepted.status).toBe('done');
```

- [ ] Run `npm test -- --run server/ona/mock.test.ts server/preparation/handoff.test.ts`; confirm missing-feature failures.
- [ ] In `send`, replay the command before doing side effects, validate readiness/target again, and hydrate selected artifacts through `readArtifact` to verify digests. Recheck the decoded prompt is nonblank rather than trusting its metadata alone. Create a request key from task ID plus client request ID, freeze `FrozenPackage` to `jira-package`, and publish a `dispatch` event with `dispatch: 1`, `status: 'sending'`, and the canonical full-package digest. Only then invoke the adapter. Keep a map of owned in-flight calls; never hold the task mutation queue across the network wait.
- [ ] On completion, re-enter the mutation queue and match request ID/dispatch against current state. Apply `settle` using the latest task revision, permitting an intervening source refresh but rejecting mismatched results. A timeout, exception, or shutdown-abort becomes `unconfirmed`; an explicit `not-accepted` result alone enables editing/retry. Accepted results require matching request ID, receipt ID, valid accepted time, and `simulated: true`.
- [ ] `recover` scans sending/unconfirmed attempts and performs lookup only. It does not call launch. A successful lookup records the original receipt; a lookup exception remains unknown. Repeated reconciliation uses a new command ID and settlement operation, not a reused payload with a different outcome.
- [ ] `retry` is explicit and allowed only after definitive nonacceptance. Compare the current source/draft/document/target selection against the frozen package; unchanged content reuses its request key and increments dispatch. Changed content must use a new `send`, which creates a new frozen package/request. Edits alone never launch. Duplicate HTTP command replay returns current state without retrying the adapter.
- [ ] Implement the durable mock ledger under confined `localRoot/jira-handoff/ona/`, keyed by SHA-256 of request ID. Serialize ledger writes; verify the package digest and both documents before recording. Accepted keys always return their original receipt and reject changed content. The timeout scenario writes acceptance first and then waits for abort; subsequent lookup succeeds. A missing ledger entry is definitively not accepted for this mock only, while an unreadable/corrupt ledger returns unknown. Explicit reject entries permit a later unchanged retry when the adapter's configured scenario permits acceptance.
- [ ] `close` blocks new launches, aborts owned calls, waits for their uncertainty/settlement writes, and propagates persistence failures so the application does not release its host lock prematurely. Add tests for intent-before-call, repeated send, old-dispatch result rejection, edited retry, unreadable ledger, source refresh during send, and shutdown after mock acceptance. Run both suites and commit with message `feat: add durable mock ONA handoff and reconciliation`.

### Task 6: Connect bounded HTTP routes and application lifecycle

**Files:** Create `server/preparation/service.ts`, `server/http/jira-preparation.ts`, `server/http/jira-preparation.test.ts`; modify `server/http/api.ts`, `server/http/access.ts`, `server/main.ts`, `server/main.test.ts`.

**Interfaces:** `createPreparationService(options: { store: Store; registry: Registry; adapter: OnaAdapter; localRoot: string }): PreparationService` composes one shared operations instance with the document, draft, and handoff services. Expose `command(value: PreparationCommand): Promise<Task>`, `upload(value: UploadCommand, bytes: Uint8Array): Promise<Task>`, `detail(taskId: string): Promise<PreparationDetail>`, `recover(): Promise<void>`, and `close(): Promise<void>`. Dispatch cancel as a preparation event and other actions to their named service methods. Export `readBytes(request: IncomingMessage, maxBytes: number): Promise<Uint8Array>` in `access.ts`, leaving `readJson`'s current limit unchanged. Export `handlePreparationRoute(request: IncomingMessage, response: ServerResponse, url: URL, deps: { preparation: PreparationService; jira: JiraIntake }): Promise<boolean>`; return false for unrelated routes.

| Method/path | Input | Result |
| --- | --- | --- |
| `POST /api/jira/sync` | JSON `{ requestId }`, safe nonblank token | `JiraSyncView`, no launch side effects |
| `GET /api/tasks/:id/preparation` | task identity | `PreparationDetail` with revision-bound prompt text |
| `POST /api/tasks/:id/preparation/commands` | `PreparationCommand` | Current `Task` |
| `POST /api/tasks/:id/documents/:role` | raw bytes and metadata headers | Current `Task` |
| Existing artifact GET | exact selected/historical ref/version | unchanged verified text bytes/download |

Upload headers are `Content-Type: application/octet-stream`, `X-Symphony-Request-Id`, `X-Symphony-Expected-Revision`, and `X-Symphony-Filename` containing `encodeURIComponent(filename)`. Decode the filename exactly once, reject invalid encoding, and validate the resulting name with Task 4's function. The role comes from a strict `design|implementation` route segment. The browser must supply metadata but cannot supply an artifact path/ref.

- [ ] Extend the existing HTTP test pattern with a real temporary store and preparation services. Write a raw-body test using `node:http.request` so it can send chunks without `Content-Length`; assert 1 MiB succeeds and 1 MiB + 1 byte returns 413. Test an aborted body does not select a document, even when its declared length is small. Test missing/foreign Origin, malformed filename encoding, path traversal, unsupported role, and URL/body task-ID mismatch.

```ts
const response = await fetch(`${base}/api/tasks/${task.id}/documents/design`, {
  method: 'POST',
  headers: {
    Origin: allowedOrigin, 'Content-Type': 'application/octet-stream',
    'X-Symphony-Request-Id': 'upload-design',
    'X-Symphony-Expected-Revision': String(task.revision),
    'X-Symphony-Filename': encodeURIComponent('design.md'),
  },
  body: Buffer.from('# Design\r\nKeep exact bytes.\r\n'),
});
expect(response.status).toBe(200);
```

- [ ] Run `npm test -- --run server/http/jira-preparation.test.ts server/http/api.test.ts server/main.test.ts`; confirm new tests fail.
- [ ] Implement route handling after existing same-origin/target validation and before the API's 404. Unsupported/disabled preparation routes return 404; legacy workspace responses omit `jira` when disabled. Preserve existing API error mapping (400 invalid, 409 conflict, 413 too large, 503 unavailable). Ordinary mock rejection/unknown launch is saved task state and returns 200, not a fake HTTP success receipt or a generic outage.
- [ ] `readBytes` counts actual chunks, caps accumulation, rejects truncation/aborted requests, and returns untouched bytes. Keep `readJson` at 1 MiB. Reject before any artifact publication where possible. The existing artifact route must continue allowing only refs listed in `task.artifacts` and rendering `text/plain` with its current CSP.

```ts
export async function readBytes(request: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) throw new HttpError(413, 'Document is too large');
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new BoundaryError('invalid', 'Document upload was interrupted');
  }
  if (!request.complete) throw new BoundaryError('invalid', 'Document upload was interrupted');
  return Buffer.concat(chunks, size);
}
```
- [ ] Compose services in `startApplication` only when `jiraHandoffConfigPath` is set. Recover the store/generic attempts first, then recover handoffs before servicing mutations. Include public Jira sync status and target options in `/api/workspace`; include intake failures in the existing issues region without stopping generic scheduling. Add `jira.tick(now)` to the existing `beforeDispatch` hook alongside file reviews, with intake errors contained in its status. Keep initial generic runner probing/capability checks unchanged.
- [ ] In shutdown, stop accepting new preparation commands, close the preparation service and coordinator, and release the host lock only after both settle. A persistence failure keeps the lock held, matching the existing application pattern. Add test-only adapter injection to `Options` alongside the existing runner injection; do not expose scenario switches through production HTTP.
- [ ] Add a main integration test with the controlled runner and only Jira tasks: start, sync, upload, edit, send, shutdown, reopen, and assert `control.starts` is empty. Test disabled config has unchanged workspace shape and startup behavior; verify generic tasks still run through the old path. Run the Task 6 suites and commit with message `feat: expose Jira preparation API and lifecycle`.

### Task 7: Add client commands and preserve edits across refreshes

**Files:** Create `src/tasks/preparationApi.ts`, `src/tasks/preparationApi.test.ts`, `src/tasks/usePreparation.ts`, `src/tasks/usePreparation.test.tsx`; modify `src/tasks/api.ts`, `src/tasks/useWorkspace.ts`, `src/tasks/useWorkspace.test.tsx`.

**Interfaces:** `PreparationApi` has `sync(requestId: string): Promise<JiraSyncView>`, `detail(taskId: string, signal?: AbortSignal): Promise<PreparationDetail>`, `command(value: PreparationCommand): Promise<Task>`, and `upload(value: UploadCommand, file: File): Promise<Task>`. Export `preparationApi`. Export the existing HTTP response helper from `api.ts` for reuse. Add `mutateTask(operation: () => Promise<Task>): Promise<Task>` to `useWorkspace` so new commands/uploads share its mutation-generation and poll guards; generic `act` delegates to it and retains its public return behavior.

`usePreparation` consumes `{ task: Task; connected: boolean; api: PreparationApi; mutateTask: (operation: () => Promise<Task>) => Promise<Task> }` and returns `{ promptText, target, dirty, busy, error, uploadError, setPromptText, setTarget, prepare, save, upload, discardUploadError, remove, send, retry, reconcile, cancel, flush }`. Field types are `string`, `Target | null`, booleans, `string | null`, and `Partial<Record<DocumentRole, string>>`; setters take their field values; `upload(role: DocumentRole, file: File)` and `remove(role: DocumentRole)` return `Promise<boolean>`; remaining actions return `Promise<boolean>`, except `discardUploadError(role)` returns void. `send/retry` return false rather than acting when there are dirty fields or upload errors.

- [ ] Write API tests asserting the raw `File` is the upload body, metadata headers preserve operation/revision/name, and JSON bodies contain exact prompt whitespace. Write a deferred hook test: type while a detail fetch is pending, resolve it, then refresh the task from a source sync; assert text remains the user's input.
- [ ] Run `npm test -- --run src/tasks/preparationApi.test.ts src/tasks/usePreparation.test.tsx src/tasks/useWorkspace.test.tsx`; confirm expected failures.
- [ ] Implement `mutateTask` by extracting existing `act` mutation bookkeeping without weakening stale-response defenses. On success replace only that task and only with an equal/newer revision. Return it so preparation actions can use the accepted revision in subsequent operations. On failure retain last-known state and preserve current 409 behavior. A resolved mutation must not overwrite a later accepted task revision.

```ts
// Store the full command until success or an explicit conflict resolution.
const command: PreparationCommand = {
  requestId: crypto.randomUUID(), taskId: task.id,
  expectedRevision: task.revision,
  action: { kind: 'save', promptText, target },
};
await mutateTask(() => api.command(command));
```

- [ ] Keep pending command/upload identity stable across transport failures even if polling reports a newer revision: retry the exact original envelope first, allowing server receipt replay. On a definitive 409, retain input, load current state, and require the user to retry against that revision with a new identity. Never automatically rebase and submit stale user intent. Reset local state when the selected task ID changes, not on each poll.
- [ ] Autosave prompt/target after 500 ms idle, serialize requests, and retain edits typed during the in-flight save. Track edit generation so an older completion cannot mark newer text saved. `flush` saves pending edits and returns false on failure. Document changes require successful flush first; an upload error remains blocking until a successful retry or explicit discard of the failed replacement. Loading detail requires matching task ID/revision; abort or discard outdated responses.
- [ ] Test exact-envelope replay after a lost response, typing during save, task switching, aborted detail fetches, disconnect, error retention, refreshed source revision conflicts, and double send. Run all Task 7 suites plus `src/tasks/api.test.ts`; commit with message `feat: add Jira handoff client state and API`.

### Task 8: Build the document-based task page and inbox controls

**Files:** Create `src/components/jira/JiraTaskDetail.tsx`, `DocumentSlot.tsx`, `HandoffEditor.tsx`, `HandoffReceipt.tsx`, `JiraTaskDetail.test.tsx`, `DocumentSlot.test.tsx`; modify `src/App.tsx`, `src/App.test.tsx`, `src/components/Inbox.tsx`, `src/tasks/presentation.ts`, `src/tasks/presentation.test.ts`, `src/styles.css`.

**Interfaces:** `JiraTaskDetail` props are `{ task: Task; connected: boolean; targets: TargetOption[]; api: PreparationApi; mutateTask: (operation: () => Promise<Task>) => Promise<Task>; onBack: () => void; registerLeaveGuard: (guard: (() => Promise<boolean>) | null) => void }`. `DocumentSlot` takes `{ role: DocumentRole; selection: DocumentSelection | null; taskId: string; disabled: boolean; error: string | null; onUpload: (file: File) => void; onRemove: () => void; onDiscardError: () => void }`. `HandoffEditor` is a controlled prompt/target form using the Task 7 hook; `HandoffReceipt` takes `{ task: Task }` and displays only a bound accepted receipt/package, loading the exact manifest/artifact versions through existing artifact URLs.

- [ ] Write a rendered-user-flow test with a mocked `PreparationApi` and real hook: click Prepare for ONA, upload design, upload implementation, edit prompt/target, await saved state, and click Send to ONA. Assert no Brainstorm control, Send disabled before both documents, exact text in the save call, and a visible Simulated ONA handoff receipt. Use `userEvent.upload` and deferred promises to exercise actual busy behavior.

```tsx
await user.upload(screen.getByLabelText('Design document'),
  new File(['# Design\n'], 'design.md', { type: 'text/markdown' }));
expect(screen.getByRole('button', { name: 'Send to ONA' })).toBeDisabled();
await user.upload(screen.getByLabelText('Implementation plan'),
  new File(['# Plan\n'], 'implementation.md', { type: 'text/markdown' }));
```

- [ ] Run `npm test -- --run src/components/jira/JiraTaskDetail.test.tsx src/components/jira/DocumentSlot.test.tsx src/tasks/presentation.test.ts src/App.test.tsx`; confirm new feature failures.
- [ ] Route preparation tasks to `JiraTaskDetail` in `App` while leaving generic `TaskDetail` unchanged. Add an optional `preparationApi` prop for tests with the production client as default. Pass `mutateTask` from the workspace hook. Add Refresh Jira, last successful sync, source-stale/error state, and mock designation only when `workspace.view.jira` is present. Refresh failure must not replace the task list with an empty state.
- [ ] Render filename, size, saved/uploading/error state, replacement/removal, and exact-version download/preview for each slot. Fetch previews as text with abort and byte limits; show `<pre>{text}</pre>`, never `dangerouslySetInnerHTML`. A filename such as `café.md` remains readable. A document containing `<script>` displays literally. Clear file-input value after handling selection so retrying the same file works.
- [ ] Render and test the latest Jira key, title, full description, optional acceptance criteria, HTTP(S) source link, and source-update/query-membership notices separately from the immutable original brief. Do not show raw adapter credentials or local paths.
- [ ] Use labeled repository and branch fields; build options from public `TargetOption` entries. Show the whole editable prompt, upload/prompt save states, and changed-Jira notice. Initial preparation is an explicit action; show available attachments/details before initialization. Do not silently initialize or rewrite a prompt when the task page is opened or refreshed.
- [ ] Register `flush` as the task-page leave guard. Invoke it for inbox selection, Back, and other in-app navigation that unmounts the editor; remain on the page and focus the save error if it returns false. Clean up the guard on unmount. Register `beforeunload` only while text/upload changes are unsaved; do not claim that asynchronous browser unload saves are guaranteed. Saved content restores on reload.
- [ ] Make `flush` await local draft/document writes and refuse navigation on unresolved upload errors; an owned handoff request alone is not an unsaved edit and does not prevent navigating away. Keep its saved Sending state inspectable when returning. Add a test that switching tasks during an upload cannot silently discard or misattribute the uploaded document.
- [ ] Update preparation-aware `statusLabel`, `needsReview`, and filtering. Ready drafts and failures appear in Needs review; sending/unconfirmed belong in Active; accepted appears in Closed as Sent to ONA. Search includes Jira key and current source title/description. Generic predicates and labels retain their existing semantics.
- [ ] Test keyboard focus, literal HTML preview, failed replacement keeping old download available while blocking Send, discard-error recovery, navigation-save failure, cancelled/sent read-only views, missing source query membership, source change during editing, unconfirmed locked state, and explicit reconciliation. Scope CSS beneath preparation component classes; preserve desktop/narrow existing layout. Run listed suites; commit with message `feat: add Jira document review and ONA handoff UI`.

### Task 9: Prove the full flow and document the mock setup

**Files:** Create `tests/jira-handoff.integration.test.ts`, `scripts/preview-jira.mjs`, `docs/superpowers/execution/jira-to-ona-verification.md`; modify `README.md`, `docs/coordinator-operations.md`, `config/examples/README.md`, `package.json`.

**Interfaces:** Add `preview:jira` script running `node scripts/preview-jira.mjs`. The preview follows `preview-fake.mjs`'s disposable-root/close pattern and starts with the new mock config, a harmless fake runner, and test-only capability injection. Default port is 4323, overridable with `SYMPHONY_PREVIEW_PORT`; never terminate another process to free it.

- [ ] Write an HTTP integration test with isolated workspace/local roots. Start the app with test injection, sync a fixture, upload two files, prepare/save a prompt, send, close, reopen, and reconcile if needed. Download documents from the final task's bound versions and compare byte-for-byte with uploads; parse the package artifact and compare source, prompt revision, target, and receipt request identity.

```ts
expect(await store.readArtifact(task.id, manifest.documents.design.ref))
  .toEqual(designBytes);
expect(await store.readArtifact(task.id, manifest.documents.implementation.ref))
  .toEqual(implementationBytes);
expect(new TextDecoder().decode(await store.readArtifact(task.id, manifest.prompt.ref)))
  .toBe(reviewedPrompt);
expect(control.starts).toEqual([]);
```

- [ ] Run `npm test -- --run tests/jira-handoff.integration.test.ts`; confirm any unmet cross-component requirements before changing wiring. Fix production seams covered by this test, not test expectations about exact content or duplicate prevention.
- [ ] Add integration variants for a response lost after a committed upload, Jira refresh concurrent with draft save, corrupted document bytes before send, and accept-then-timeout followed by restart. Reuse fixture setup functions defined in the integration test, close all apps and temporary resources in `afterEach`, and never read company credentials/repos.
- [ ] Seed preview tasks using public service operations: Inbox, incomplete preparation, Ready to send, accepted mock receipt, and unconfirmed handoff. Include Unicode filenames and multiline prompts. Pass scenario adapters through test-only injection; do not create a production endpoint for changing outcomes. Keep the original fake preview unchanged for generic workflow checks.
- [ ] Document opt-in config, fixture JSON, project mapping, both required `.md`/`.txt` slots and 1 MiB limit, exact-byte handoff, simulated receipts, refresh behavior, and reconciliation. Explain that this feature starts no agent but the existing Symphony host retains its normal startup configuration. Document that link/PDF/Word support, real Jira/ONA integration, and PR handling are excluded.
- [ ] Run `npm test -- --run` and `npm run build` from this worktree. Investigate failures attributable to this branch; do not weaken legacy tests. Then run `SYMPHONY_PREVIEW_PORT=4323 npm run preview:jira` with its disposable roots and inspect desktop (~1440 px) and narrow (~390 px) layouts, keyboard navigation, uploads, saved draft restoration, explicit send, rejected/unconfirmed states, and receipt downloads.
- [ ] Record actual commands, counts/results, preview checks, and any limits in `docs/superpowers/execution/jira-to-ona-verification.md`. Do not claim live ONA/Jira verification. Stop only the preview process started for this worktree. Commit the Task 9 files with message `test: verify and document Jira to ONA handoff`.

## Dependency order and review gates

Execute Tasks 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Shared contracts and store semantics make parallel implementation a poor default here. Each task's red/green cycle and scoped commit provide a rollback/review boundary. Do not change another task's interface casually; update this plan and all consumers when a necessary correction is discovered.

Use `git add --` with each task's exact file list and its stated commit message; never `git add .` in a shared workspace. For final review, compare against the starting base `035b842` and include the spec/plan as reviewer context. If the other UI work lands first, reconcile only after explicit integration direction; do not merge it into this worktree during feature development.

## Spec coverage and plan self-review

| Approved requirement | Implementing tasks |
| --- | --- |
| Assigned-open inbox, opt-in mock, 60-second/manual sync, stable IDs | 3, 6, 8 |
| Preserve source history and user work across refresh | 1–4, 7–9 |
| Two required UTF-8 Markdown/text documents, 1 MiB each | 1, 2, 4, 6, 8 |
| Exact bytes, versioned replacement/removal, escaped previews | 2, 4–6, 8, 9 |
| Deterministic editable prompt, saved drafts, target mapping | 3, 4, 7, 8 |
| Explicit exact-package send, no hidden instructions | 4–6, 8, 9 |
| Frozen package, durable receipt, no duplicate launch after timeout | 2, 5, 6, 9 |
| Generic workflow compatibility and zero feature agent launches | 1, 2, 6, 9 |
| Disconnect, stale edits, navigation flush, keyboard/narrow UI | 7–9 |
| Cancellation, accepted inspection, mock-only verification/docs | 2, 5, 8, 9 |

Before presenting this plan, check every reference/type against the shared contract, scan for unfinished instructions, and verify the five Review Focus cases have owning test steps. During execution, record actual verification separately; the checklist above expresses required work, not completed work.

## Execution handoff

Recommend **Native** execution: one implementer carries the shared contracts through nine dependent tasks, followed by an independent whole-branch review. **Subagent-driven** is available for a fresh implementer/reviewer per task, at the cost of repeating these interfaces and repository context. Wait for the user's review and method selection before installing dependencies, writing product code, or running implementation steps.
