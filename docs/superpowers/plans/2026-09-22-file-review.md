# Synced File Reviews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user answer questions and approve or reject work by editing a synced Markdown file and renaming it to `.ready.md`.

**Architecture:** Add an opt-in file-review adapter around the existing `applyHumanCommand` path. The adapter exports review drafts, captures stable submitted bytes in a host-local journal, applies existing commands, and publishes receipts. The existing task store remains the sole authority for task transitions and idempotency.

**Tech Stack:** Existing Node.js/TypeScript ESM, filesystem promises, Vitest, and React workspace issues. No new runtime dependencies or cloud APIs.

**Spec:** [Approved design](../specs/2026-09-22-file-review-design.md).

## Global Constraints

- “Automatic saving while writing must not count as submission.”
- “Stop editing after submission.”
- “Keep the UI available as an alternative.”
- “First release supports question answers and workflow/artifact approvals and rejections.”
- “Approval with nonempty feedback is rejected with an explanation, rather than silently discarding it or interpreting conditional approval.”
- “Pause, cancellation, request-changes, and uncertain-run reconciliation remain available through the existing UI.”
- “Read bounded UTF-8 regular files, reject symlinks and path escapes, and apply the existing 1 MiB intake limit.”
- “Require identical bytes across two observations at least `stableMs` apart.”
- “Use the issued token as the stable request ID and the captured revision and review binding; do not replace these with newer values to force acceptance.”
- “The first valid decision accepted by the store wins.”
- “A receipt-write failure retries receipt publication, not the decision.”
- “The coordinator does not rewrite user response files or move them while the user may still be editing.”
- “Never reuse a rejected/invalid token, since delayed sync could replay its previous contents.”
- “Add an opt-in `fileReviewsEnabled` setting, default false.”
- “A lost sync connection leaves work waiting; no cloud API or internet-accessible service is required.”
- Use the repository's existing Node >=22.12 requirement and POSIX host assumptions. Do not modify the UI styling, agent permissions, or unrelated task behavior.

## Review Focus

1. Phone editors can use CRLF, insert a BOM, or alter headings: accept CRLF normalization only; unsupported encoding/prefix changes get a correction receipt without applying a decision (Tasks 1–3).
2. Questions and answers can contain Markdown headings, fences, and `action:` examples: locate the response using the stored prefix length, never search/split on a heading in user content; duplicate top-level action lines are invalid (Tasks 1, 3).
3. An edited response may arrive again after acceptance or after the next review is created: retain the first captured operation and report replay/conflict without answering newer work (Task 4).
4. A request, receipt, or material export may already exist with different bytes, or local records may disappear: never overwrite user content or infer trusted bindings from synced documents; show an actionable issue (Tasks 2, 4).
5. Several reviews may be pending, or the task may move folders after approval: export only the first actionable pending review, and keep exported artifact copies usable after task movement (Tasks 2, 5).

## Files and responsibilities

Create these focused modules and their colocated tests:

- `server/file-reviews/model.ts`: durable record types and validation, supported-review selection and binding checks.
- `server/file-reviews/document.ts`: filename creation, readable immutable prefix, response parser, command translation, and receipt rendering.
- `server/file-reviews/io.ts`: confined directories, bounded no-follow reads, exclusive publication, and durable local journal updates.
- `server/file-reviews/adapter.ts`: export, observation, snapshot, apply, recovery, correction, and issues lifecycle.
- `server/file-reviews/testing.ts`: test fixtures only; exclude this helper from the server build alongside `server/testing`.
- `tests/file-reviews.integration.test.ts`: application-level tests with the existing fake CLI.

Modify:

- `server/config/settings.ts` and `.test.ts`: boolean opt-in.
- `server/coordinator/coordinator.ts` and `.test.ts`: awaited hook inside the existing serialized tick before dispatch.
- `server/main.ts`: compose adapter and existing human-command handler; aggregate adapter issues.
- `server/main.test.ts`: use an ephemeral free port if still fixed to 4317, so local development does not make this suite fail.
- `config/examples/settings.json`, `README.md`, `docs/coordinator-operations.md`: opt-in and exact phone interaction/recovery instructions.
- `tsconfig.server.json`: exclude the new test helper.

Do not add domain events or bypass `Store.apply`. Existing APIs of interest: `Store.get`, `Store.list`, `Store.readArtifact`, `applyHumanCommand`, `BoundaryError`, `confinedPath`, and `writeAtomic`. Read their implementations before using them. In particular, `writeAtomic` replaces its destination, so it is suitable for coordinator-owned local journal records, not user-editable synced files.

## Task 1: Review documents, parsing, and immutable bindings

**Files:** Create `server/file-reviews/model.ts`, `document.ts`, `document.test.ts`.

**Interfaces:** Define and export these contracts; subsequent tasks must use these names.

```ts
import type { ArtifactRef, Command, Issue, Review, Task, Workflow } from '../../shared/contracts.js';
export type FileReviewKind = 'question' | 'workflow' | 'artifact';
export type Binding = {
  taskId: string; taskRevision: number; review: Review;
  workflow: Workflow | null; // proposedWorkflow for workflow; workflow for artifact
};
export type Material = { ref: ArtifactRef; filename: string };
export type Snapshot = { base64: string; sha256: string };
export type Outcome = {
  status: 'Accepted' | 'Outdated' | 'Needs correction'; message: string;
  acceptedRevision: number | null;
};
export type RequestRecord = {
  schemaVersion: 1; token: string; basename: string; binding: Binding;
  prefix: string; initialResponse: string; materials: Material[];
  predecessor: string | null;
  phase: 'issued' | 'captured' | 'applying' | 'settled';
  publication: 'pending' | 'attempted' | 'published';
  snapshot: Snapshot | null; command: Command | null;
  outcome: Outcome | null; receiptPublished: boolean;
};
export function selectReview(task: Task): Review | null;
export function bindReview(task: Task, review: Review): Binding;
export function matchesBinding(task: Task, binding: Binding): boolean;
export function parseRecord(value: unknown): RequestRecord;
export function makeRequest(task: Task, review: Review, token: string,
  predecessor?: string | null, response?: string): RequestRecord;
export function parseResponse(record: RequestRecord, bytes: Uint8Array): Command;
export function renderDraft(record: RequestRecord): string;
export function renderReceipt(record: RequestRecord): string;
```

- [ ] **1. Add failing document/command tests using real task fixtures.** Include a question helper within the test file:

```ts
function questionTask() {
  const task = waitingTask();
  task.proposedWorkflow = null;
  task.reviews = [{ id: 'question-1', kind: 'question', workflowVersion: null,
    stepId: '$triage', artifacts: [], attemptId: 'run-1',
    prompt: 'Which Java version?', answer: null, decision: null }];
  return task;
}
it('maps a CRLF answer to the issued task and revision', () => {
  const task = questionTask();
  const token = '33333333-3333-4333-8333-333333333333';
  const record = makeRequest(task, task.reviews[0], token);
  const bytes = Buffer.from((record.prefix + 'action: answer\n\nJava 17.\n').replace(/\n/g, '\r\n'));
  expect(parseResponse(record, bytes)).toEqual({ requestId: token,
    taskId: task.id, expectedRevision: 1,
    action: { kind: 'answer', reviewId: 'question-1', text: 'Java 17.' } });
});
it.each(['approve', 'reject', 'retry', 'cancel', 'changes'])('rejects %s on a question', action => {
  const task = questionTask();
  const record = makeRequest(task, task.reviews[0], crypto.randomUUID());
  expect(() => parseResponse(record, Buffer.from(record.prefix + `action: ${action}\n\nReason`))).toThrow();
});
it('does not silently accept conditional approval', () => {
  const task = waitingTask();
  const record = makeRequest(task, task.reviews[0], crypto.randomUUID());
  expect(() => parseResponse(record, Buffer.from(record.prefix + 'action: approve\n\nOnly if tests pass.'))).toThrow();
});
```

Also parameterize tests for: empty answer, blank action, reject without reason, scope/prompt edits, invalid UTF-8, BOM, >1 MiB, headings/fences in question text, an answer containing `## Your response`, and a second line beginning `action:`. Assert against emitted `Command` and rejected input, not source text. Test exact artifact digest translation for an artifact review and refusal of pause/reconciliation reviews. Verify `selectReview` does not skip an unsupported first pending review to export a later one.

- [ ] **2. Run:** `npx vitest run server/file-reviews/document.test.ts`. Expect failure because the new imports are not implemented; subsequent failures must reflect missing behavior, not a broken fixture.

- [ ] **3. Implement document and binding functions.** Use the full UUID token in filenames, a lower-case ASCII slug capped at 48 characters, and fallback `task` for an empty slug. All three filenames derive from the same immutable basename: `.md`, `.ready.md`, `.receipt.md`. Clone the review and relevant workflow into the binding. Validate pending status, captured revision, complete review snapshot, relevant workflow snapshot, and that this is still the first pending review. Do not bind unrelated future reviews.

Render the immutable prefix as plain Markdown, including task title, question/approval explanation, allowed actions, exact rename instructions, and `## Your response\n`. Show workflow steps and their scope explicitly, plus a verbatim JSON snapshot in a fence longer than any backtick sequence in that snapshot. For artifact reviews, list exact versions/digests and generated links under `materials/<token>/`; explain whether approval continues or completes work. Never derive filesystem paths from titles or Markdown. Set the initial response to `action: answer\n\n` for questions and `action: \n\n` for approval reviews. Reject generation if the complete default document exceeds 1 MiB, surfacing an issue and preserving the UI path.

Parser core:

```ts
const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  .decode(bytes).replace(/\r\n/g, '\n');
if (bytes.byteLength > 1024 * 1024 || !text.startsWith(record.prefix))
  throw new Error('Review text changed or file exceeds 1 MiB');
const response = text.slice(record.prefix.length);
const [line, ...bodyLines] = response.split('\n');
const match = /^action:[ \t]*(answer|approve|reject)[ \t]*$/.exec(line);
if (!match || bodyLines.some(line => /^action:/.test(line)))
  throw new Error('Provide exactly one supported action line');
const body = bodyLines.join('\n').trim();
```

Validate per-review action and body rules, then call existing `parseCommand` on the constructed object before returning it. `parseRecord` validates types, UUIDs/basenames, phase invariants, binding task/review associations, snapshot SHA-256/base64, and command request ID/task/revision/action association. A settled record requires an outcome; applying requires snapshot+command; no record may broaden the supported actions. Use exact stored data in receipts, including token, source filename, snapshot digest and escaped response content in a safe fence. Receipt headings must not imply a decision was accepted when it was invalid or merely captured.

- [ ] **4. Run the document tests and `npm test -- --run`; fix failures.** Do not update unrelated tests to accommodate accidental behavior changes.
- [ ] **5. Commit:** `git add server/file-reviews/model.ts server/file-reviews/document.ts server/file-reviews/document.test.ts && git commit -m "feat: define file review documents and bound commands"`.

## Task 2: Durable journal and safe review export

**Files:** Create `server/file-reviews/io.ts`, `io.test.ts`, `adapter.ts`, `adapter.test.ts`, `testing.ts`; modify `tsconfig.server.json`.

**Interfaces:**

```ts
import type { Command, Issue, Task } from '../../shared/contracts.js';
import type { Store } from '../store/task-store.js';
import type { RequestRecord } from './model.js';
export type FileReviewAdapter = { scan(nowMs: number): Promise<void>; issues(): Promise<Issue[]> };
export type FileReviewOptions = {
  workspaceRoot: string; localRoot: string; stableMs: number; store: Store;
  apply(command: Command): Promise<Task>;
};
export function createFileReviews(options: FileReviewOptions): FileReviewAdapter;
// io.ts
export function readBounded(root: string, relative: string): Promise<Buffer | null>;
export function publishExclusive(root: string, relative: string, bytes: Uint8Array): Promise<void>;
export function saveRecord(localRoot: string, record: RequestRecord): Promise<void>;
export function loadRecords(localRoot: string): Promise<{ records: RequestRecord[]; issues: Issue[] }>;
```

`readBounded` returns null only for ENOENT and otherwise throws a typed invalid/unavailable `BoundaryError`. `publishExclusive` never replaces an existing path; the caller handles EEXIST by verifying existing content without changing it. `saveRecord` uses `file-reviews/requests/<token>.json` below localRoot, via `confinedPath` and `writeAtomic`; only validated records are saved. Local record failures must prevent issuing or applying that request.

- [ ] **1. Add safe I/O tests.** Test regular UTF-8 input, invalid UTF-8 at the parser boundary, oversized/growing reads, symlink root/ancestor/leaf, nonregular files, traversal, and existing destinations with same/different content. Use temporary roots and real filesystem calls; no global fs mocks. Verify the exclusive writer leaves the pre-existing file byte-for-byte intact.

```ts
it('does not replace an existing response file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-review-io-'));
  try {
    await mkdir(join(root, 'reviews'));
    await writeFile(join(root, 'reviews/answer.md'), 'My unfinished answer');
    await expect(publishExclusive(root, 'reviews/answer.md', Buffer.from('generated'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(root, 'reviews/answer.md'), 'utf8')).toBe('My unfinished answer');
  } finally { await rm(root, { recursive: true, force: true }); }
});
```

- [ ] **2. Define the test harness in `testing.ts`, using real store/command behavior.** Export `fileReviewFixture(task = waitingTask(), overrides: Partial<Store> = {})` returning `{root, workspaceRoot, localRoot, store, adapter, restart, dispose}`. Create disjoint temporary roots, `openStore`, and `store.create(task, 'fixture-created')`. Build `store = {...realStore, ...overrides}` so tests can inject failures without replacing unrelated effects. `restart()` reopens the real store and constructs a fresh adapter. `dispose()` recursively removes only this temporary root. `apply` calls real `applyHumanCommand(store, coordinator, command)` where the stub coordinator implements `tick`, `shutdown`, `stopTask` as async no-ops; these supported actions never need process termination. Tests with actual scheduling use Task 5 instead. Add `server/file-reviews/testing.ts` to the server-build excludes.

Add test helpers in this same file:

```ts
export async function draftFile(workspaceRoot: string): Promise<string> {
  const files = (await readdir(join(workspaceRoot, 'reviews')))
    .filter(name => name.endsWith('.md') && !name.endsWith('.ready.md') && !name.endsWith('.receipt.md'));
  if (files.length !== 1) throw new Error(`Expected one draft, got ${files.length}`);
  return join(workspaceRoot, 'reviews', files[0]);
}
export async function submitFile(path: string, response: string): Promise<string> {
  const document = await readFile(path, 'utf8');
  const marker = '## Your response\n';
  const offset = document.lastIndexOf(marker);
  if (offset < 0) throw new Error('Fixture response marker missing');
  await writeFile(path, document.slice(0, offset + marker.length) + response);
  const ready = path.replace(/\.md$/, '.ready.md');
  await rename(path, ready);
  return ready;
}
```

The last-index helper is for controlled test fixtures only; production parsing must use the stored prefix length.

- [ ] **3. Add export tests before implementing export.** Confirm a waiting task exports exactly one draft; repeated scans/restart do not overwrite edits. Rename an issued draft to `.ready.md` and confirm no new draft appears simply because the old filename is absent. Verify each unsupported review produces no draft, and that missing/corrupt local records produce issues for orphaned synced files. Add an artifact fixture using `store.publishArtifact` and `store.readArtifact`; check the exported material bytes and SHA match the declared artifact even after the task later becomes terminal.
- [ ] **4. Run:** `npx vitest run server/file-reviews/io.test.ts server/file-reviews/adapter.test.ts`. Expect specific missing behavior failures.
- [ ] **5. Implement safe I/O and export.** Ensure dirs through `confinedPath` and `lstat`; reject symlink directories. Open input with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, inspect handle type, read at most limit+1 bytes, and compare handle/path identity and metadata after read; an unstable read resets observations. Do not use `readFile` followed only by a size check for untrusted input. Use `open('wx', 0o600)` for new synced documents, sync and close handles, and sync the parent directory where supported. Failures must leave existing user files untouched and produce issues.

Persist `issued/pending` record before publication. Persist `publication: attempted` before the first write; then publish the generated file and persist `published`. On recovery of an attempted publication, inspect draft and ready paths: a matching draft or ready file resolves the publication; a differing draft is preserved and reported. If neither exists, publication outcome is ambiguous: report an issue and do not recreate a possibly-renamed draft automatically. Never regenerate missing files marked published.

Artifacts must remain readable after task folder movement. Copy approved bytes, obtained through `Store.readArtifact`, to create-only `reviews/materials/<token>/<artifact-id>.v<version>.bin` files; their filenames come from validated artifact IDs. Persist their binding before export. Verify these copies against their trusted digests before accepting approval; changed/missing copies cannot authorize a different artifact. Do not use relative links into the movable `active/<task>/` directory. If material preparation fails, do not publish an actionable review document.

Keep a promise queue around `scan`; indexes are reconstructed from durable validated records. Only the first pending supported review is eligible. Use `(taskId, taskRevision, reviewId)` as the export identity; a record awaiting application blocks another export for that review until recovery settles it. A settled invalid record may get one successor in Task 4. Surface deterministic `Issue` IDs (hash of filename/token + error category) to avoid duplicate banners. Known `.md`, `.ready.md`, `.receipt.md`, and materials are recognized; unknown/conflict Markdown files generate an issue and are not consumed.

Do not manufacture replacement trusted records for orphaned synced files. If journal corruption makes the affected task identity unknowable, suspend new exports until that local journal issue is resolved, while preserving UI operation and unrelated already-valid requests. For merely unknown synced filenames, report the issue and ignore the file; do not guess its task from its slug.

- [ ] **6. Run focused tests and `npm test -- --run`, then commit:** `git add server/file-reviews tsconfig.server.json && git commit -m "feat: persist and export synced review requests"`.

## Task 3: Stable rename pickup and existing human-command application

**Files:** Modify `server/file-reviews/adapter.ts`, `adapter.test.ts`.

**Interfaces:** Consume `FileReviewOptions.apply`, `RequestRecord`, document/parser/I/O functions from Tasks 1–2. Produce working `scan(nowMs)` submission handling; do not change public contracts.

- [ ] **1. Write failing autosave, stability, and command tests.** Import the Task 2 helpers and clean up every fixture in `finally`.

```ts
it('ignores autosaves until rename and two stable observations', async () => {
  const task = waitingTask();
  const f = await fileReviewFixture(task);
  try {
    await f.adapter.scan(0);
    const draft = await draftFile(f.workspaceRoot);
    await writeFile(draft, (await readFile(draft, 'utf8')).replace('action: \n', 'action: approve\n'));
    await f.adapter.scan(4000);
    expect((await f.store.get(task.id)).revision).toBe(1);
    const ready = draft.replace(/\.md$/, '.ready.md');
    await rename(draft, ready);
    await f.adapter.scan(5000);
    expect((await f.store.get(task.id)).revision).toBe(1);
    await f.adapter.scan(7001);
    expect((await f.store.get(task.id)).reviews[0].decision).toBe('approve');
    expect(await readFile(ready.replace('.ready.md', '.receipt.md'), 'utf8')).toContain('Accepted');
  } finally { await f.dispose(); }
});
```

Add test cases: changed bytes between observations reset the interval; disappearance resets it; CRLF accepted; same byte length with changed content is not stable; unsupported actions leave review pending; answer and reject persist exact text; missing/tampered artifact material blocks approval. A partial `.ready.md` that stays unchanged can be invalid and require correction; do not promise detection of future unseen sync data.

- [ ] **2. Run:** `npx vitest run server/file-reviews/adapter.test.ts`. Observe missing pickup behavior.
- [ ] **3. Implement capture and apply.** For issued ready files, use observations `{sha256, firstSeenMs}`; require two separate successful reads with identical digest and elapsed interval. Do not infer readiness from mtime or action field alone.

State transitions:

```text
issued -> captured: save original bytes as base64 and SHA-256 before parsing
captured -> settled Needs correction: invalid prefix/action/text/encoding
captured -> settled Outdated: task/review/revision/workflow binding changed
captured -> applying: save exact parsed Command after binding/material checks
applying -> settled Accepted: apply the saved Command through options.apply
applying -> settled Outdated: an existing command conflict proves the request is stale
settled -> receiptPublished: publish immutable receipt; never reapply command here
```

Use a **single journal save** for each transition. On unavailable I/O or unknown application errors, retain captured/applying state and show a retryable issue; do not guess that a command failed before commit. On replay of an `applying` record, call `apply` with its original command without a fresh revision precheck: `Store.apply` checks operation identity before revision and can return the already committed state. This is essential after a crash between task commit and journal update. Map `BoundaryError('conflict')` to Outdated, `invalid` to Needs correction only when the command is provably unapplied, and `unavailable`/unknown failures to retryable issues. Corrupt records are never attempted.

- [ ] **4. Run focused tests and full suite, then commit:** `git add server/file-reviews/adapter.ts server/file-reviews/adapter.test.ts && git commit -m "feat: accept stable renamed review submissions"`.

## Task 4: Recovery, receipts, corrections, and races

**Files:** Modify `server/file-reviews/adapter.ts`, `adapter.test.ts`, `io.test.ts`; add `server/file-reviews/recovery.test.ts`.

**Interfaces:** Keep prior contracts. Store corrections as new `RequestRecord` entries with `predecessor` equal to the retired token. Find successors by predecessor from the journal, not synced filenames.

- [ ] **1. Add race/replay tests against the real store.**

```ts
it('does not apply an old file after a UI decision', async () => {
  const task = waitingTask();
  const f = await fileReviewFixture(task);
  try {
    await f.adapter.scan(0);
    const ready = await submitFile(await draftFile(f.workspaceRoot), 'action: reject\n\nWrong scope.');
    await f.store.apply(task.id, 1, 'ui-approval', { kind: 'human', command: {
      requestId: 'ui-approval', taskId: task.id, expectedRevision: 1,
      action: { kind: 'approve', reviewId: task.reviews[0].id, artifactDigests: [] },
    } });
    await f.adapter.scan(1); await f.adapter.scan(2002);
    expect((await f.store.get(task.id)).reviews[0].decision).toBe('approve');
    expect(await readFile(ready.replace('.ready.md', '.receipt.md'), 'utf8')).toContain('Outdated');
  } finally { await f.dispose(); }
});
```

Add the reverse race, duplicate ready copies, same token changed after acceptance, and delayed old token after correction. Assert task revisions/decisions, not mock call counts. For response replay after restart, use the reopened store returned by `restart`, not the old in-memory object.

- [ ] **2. Add recovery tests with targeted failures.** Wrap the real apply callback to execute a successful command and then throw once, simulating loss after commit. Restart adapter/store and confirm one review decision and one revision increment. Inject journal-write/receipt-write failures through a small `io` dependency seam on `createFileReviews` only if filesystem manipulation cannot isolate the failure; name it `io?: Partial<FileReviewIo>` and define/export `FileReviewIo` as the exact existing I/O function signatures. Do not add testing methods to the task store. Use the real I/O implementation for every uninjected operation.

Test boundaries: before snapshot save; after snapshot save; before command persistence; after command persistence; after command commit; after outcome persistence; before receipt creation; after receipt creation but before publication flag. In every case, restart with real persistent state and assert the same immutable snapshot/command resumes, or no command was dispatched when durability failed.

- [ ] **3. Add correction tests.** Submit an empty answer or edited immutable prefix. Expect a Needs correction receipt, unchanged task revision, retained ready bytes, exactly one new-token draft after repeated scans/restarts, and successful correction only after renaming that new draft. Carry forward response content only if it was safely parsed after the exact prefix; do not copy unknown edited question text as an answer. Preserve invalid action/body for correction but reset the action for unsupported actions. Outdated requests get a replacement only if a currently actionable review still exists; never carry response text onto a different review.

- [ ] **4. Run:** `npx vitest run server/file-reviews`. Expect the new recovery/correction tests to fail before implementing them.
- [ ] **5. Implement outcome recovery and receipt publication.** Once settled, do not execute the stored command again; only reconcile/publish its receipt and any successor. Use create-only receipt publication; if an existing receipt differs, preserve it, report an issue, and keep publication pending. A modified consumed ready file creates a conflict issue while the original accepted receipt and snapshot remain unchanged. Ignore a draft disappearing after its publication, and never delete original response files. Superseded requests become Outdated when observed, but a captured/applying operation is always recovered before generating fresh exports. A missing current task never grants permission to a file; surface missing/unavailable state conservatively.

A correction successor is written to the local journal first. Only one record may reference a retired predecessor; detect duplicate journal successor records as a conflict. Persist the invalid outcome before creating that successor. Fresh exports for new task revisions must not collide with predecessor-based corrections. The request record, not receipt file presence, determines whether a correction has already been issued.

- [ ] **6. Run focused tests and full suite, then commit:** `git add server/file-reviews && git commit -m "fix: recover file decisions and preserve synced corrections"`.

## Task 5: Opt-in configuration, coordinator scheduling, and workspace issues

**Files:** Modify `server/config/settings.ts`, `settings.test.ts`, `server/coordinator/coordinator.ts`, `coordinator.test.ts`, `server/main.ts`, `main.test.ts`, and typed Settings fixtures identified by the compiler; create `tests/file-reviews.integration.test.ts`.

**Interfaces:** Extend `Settings` with required `fileReviewsEnabled: boolean` after loading, default false. Extend coordinator deps with `beforeDispatch?: (now: Date) => Promise<void>`. Do not add a second timer.

- [ ] **1. Add config tests for omitted/false/true and reject `"true"`, `1`, `null`, arrays/objects.** Add coordinator test using real store and controlledRunner: the hook answers a pending question; the same tick can then dispatch its newly eligible step. A hook failure rejects the tick and dispatches no agents.
- [ ] **2. Add application-level fixtures with disjoint temporary roots, free port, fake CLI, and explicit opt-in.** Follow `tests/coordinator.integration.test.ts` for `unusedPort`, startup and cleanup. Create a task through UI draft intake, allow the fake CLI to propose workflow, inspect generated review, write+rename approve, and observe the existing workflow execute to its next review. Do not approve any actual user tasks. For disabled mode, place a `.ready.md` file before startup and prove task state unchanged and no local file-review journal created. Verify failures appear in GET `/api/workspace` without adding a new UI component.
- [ ] **3. Run:** `npx vitest run server/config/settings.test.ts server/coordinator/coordinator.test.ts tests/file-reviews.integration.test.ts`. Verify meaningful failures.
- [ ] **4. Implement config and composition.** Add default false to settings so existing allowlisted config keys accept it; validate actual boolean. Add the hook after `intake.scan` and before `store.list` in `tickInternal`, and recheck shutdown before invoking it.

Composition shape in `startApplication`, after recovery/capability verification:

```ts
let fileReviews: FileReviewAdapter | undefined;
coordinator = createCoordinator({ store, intake, registry, runner, settings, recovered: true,
  beforeDispatch: async now => { await fileReviews?.scan(now.getTime()); },
});
const activeCoordinator = coordinator;
if (settings.fileReviewsEnabled) {
  fileReviews = createFileReviews({ store, workspaceRoot: settings.workspaceRoot,
    localRoot: settings.localRoot, stableMs: settings.stableMs,
    apply: command => applyHumanCommand(store, activeCoordinator, command),
  });
}
// In createApi's existing issues callback:
// issues: async () => [...startupIssues, ...(await fileReviews?.issues() ?? [])]
```

Malformed individual files create issues and leave their task waiting; they must not block unrelated tasks. Missing/corrupt local journal infrastructure must fail closed for file decisions and expose an issue. Ordinary per-file problems should not throw out of `scan`; unrecoverable journal writes must prevent that affected request from dispatching a decision. The application's existing shutdown awaits the serialized tick; do not start detached file-processing promises.

The Settings compiler errors should be fixed by adding false to full typed fixture objects, preserving all other defaults. If `server/main.test.ts` still binds 4317, use its own ephemeral port helper as in the integration tests instead of stopping a user server to run tests.

- [ ] **5. Run:** `npm test -- --run` and `npm run build`. Expected all checks pass (existing opt-in real CLI test may remain skipped). Then commit changed production/test files with message `feat: enable file reviews in the coordinator loop`.

## Task 6: Operator instructions and end-to-end acceptance

**Files:** Modify `README.md`, `docs/coordinator-operations.md`, `config/examples/settings.json`; optionally modify the ignored `symphony.config.json` only after the user chooses to enable this feature locally.

**Interfaces:** Existing `npm run start:local`, boolean `fileReviewsEnabled`, and generated review/receipt files; no new CLI command.

- [ ] **1. Document exact config and instructions.** The example config keeps the feature disabled:

```json
"fileReviewsEnabled": false
```

Explain enabling it with true, stopping/restarting the designated host, and keeping `workspaceRoot` as the OneDrive-synced root while `localRoot` remains host-local. Show three complete response examples (`answer` with text, blank-body `approve`, and `reject` with a reason). Explain the exact rename including `.md`, avoiding duplicated extensions, save/close before rename, no editing after submit, and the separate receipt as confirmation. Explain that reject rejects the task, and questions cannot be rejected as an approval. Direct request-changes, pause/cancel and reconciliation to the UI. Explain the new correction draft, stale UI/file races, edited header rejection, orphaned files after lost local records, and that a stability interval does not prove cloud delivery order. Warn against deleting the host-local journal while submissions are in flight. Keep copy short and user-facing instructions free of hash/revision jargon.
- [ ] **2. Run the automated acceptance scenario in a disposable root.** Exercise generated question -> repeated autosaves -> ready rename -> answer -> workflow review -> approval -> exact artifact review -> approval -> done, plus a separate rejected task. Verify receipts contain the exact chosen response, the UI/API show the same decision, and final artifact links still open after terminal movement. Use the fake CLI fixture for this full lifecycle; no model/network calls are needed.
- [ ] **3. Verify real phone/OneDrive behavior only on the intended deployment.** If a synced root and phone editor are not available, explicitly record this check as unverified and ask the user to perform it after deployment. Do not claim local rename tests prove OneDrive compatibility. Do not silently redirect the user's currently local workspace or start their server after a prior stop request.
- [ ] **4. Final checks:** `git diff --check`, `npm test -- --run`, `npm run build`. Inspect the complete diff for accidental changes to UI, existing roles, Codex configuration, or saved tasks. Commit docs and example config with message `docs: explain synced file review setup and recovery`.

## Self-review and handoff

Spec coverage: document binding/action restrictions (Task 1); exports, artifact snapshots, filesystem limits (Task 2); autosave/rename/stability/command path (Task 3); receipts, restarts, correction tokens and competing UI decisions (Task 4); optional integration, scheduling and existing-task export (Task 5); deployment and actual phone checks (Task 6). All five review-focus cases have owning tests above.

Implementation detail to preserve: an `applying` record must replay its exact command through the idempotent store before checking whether current task revision advanced. A stale precheck here would misreport an already accepted decision as Outdated after restart.

The user approved this plan and its subagent-driven execution method. Implementation and acceptance work have proceeded under that approval.
