# Async Idea Capture and Project Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save an idea immediately, resolve projects durably in the background, and require project review before investigation.

**Architecture:** Separate durable capture from intake traversal and project discovery. Extend pending submissions with revision-checked review state, use the existing project-service background lifecycle for slow work, and expose progress through workspace polling. Keep task publication behind the project gate and reuse immutable project binding.

**Tech Stack:** TypeScript, Node.js 22.23.2, React, existing filesystem journals, Vitest and Testing Library; no new runtime dependencies.

**Spec:** [Approved async idea/project review design](../specs/2026-09-23-async-idea-project-review-design.md), approved after commit `e745f81` on 2026-09-23.

## Global Constraints

- “The review checkpoint applies even to unambiguous matches and projectless results.”
- “This change covers new ideas submitted through the HTTP/UI capture path.”
- “Filesystem and phone drafts keep their established acceptance policy; they benefit from nonblocking project processing but do not gain a mandatory additional approval.”
- “Typing does not launch discovery or matching requests.”
- “The original capture receipt remains immutable for idempotency; later text edits live in the versioned pending record and supply the final task content.”
- “Use the existing configured `projectGitTimeoutMs` as the whole resolution-pass time budget as well as retaining per-command limits.”
- “Brief versions are fixed at approval.”
- “Shutdown stops accepting worker passes and quiesces or cancels active work before releasing the host lock.”
- Preserve existing 1 MiB capture validation, origin protection, read-only repository rules, semantic catalog revisions, and immutable binding commits.
- Use `.nvmrc` (22.23.2) and the committed lockfile. Do not touch `.symphony-local`, run real agent assignments, add dependencies, or change the user's source repositories for testing. Temporary fixture repositories are permitted.

## Review Focus

- A blank explicit UI title with a Markdown heading in its brief must not become a generated filename or silently promote the heading into a target (Tasks 2 and 6).
- A lost response followed by a retry after edits, approval, or restart must return the original command result without creating work twice (Tasks 1, 2, 4, 5).
- Saving a new projects root while a scan completes must not publish results for the retired root or clear a newer refresh (Tasks 3 and 4).
- A second browser editing a submission while the first has unsaved changes must preserve local text and block stale approval (Task 7).
- A crash after task creation but before pending-state acknowledgement must remove the pending notice on recovery without recreating or modifying the task (Tasks 2 and 8).

---

## Execution and file map

Read the spec and this plan before coding. At execution time use `superpowers:using-git-worktrees` to obtain isolation, preserving an existing managed worktree if present. This is one coordinated feature; execute tasks in order because their contracts are shared. Each numbered task has its own failing-test, implementation, verification, and commit cycle. Code blocks show the key assertions and implementation boundaries; preserve existing validation and durability machinery around them.

| Area | Files and responsibility |
| --- | --- |
| Shared state | Extend `shared/projects.ts`; create `shared/project-submissions.ts` for pure normalization/status helpers; extend `shared/contracts.ts` for workspace summaries. |
| Submission persistence | Create `server/intake/project-submission-store.ts`; own version migration, atomic state, revisions, idempotent commands, and compare-and-set worker completion. |
| Capture | Create `server/intake/capture.ts`; extract only capture receipt persistence from `intake.ts`, leaving filesystem claim/conflict handling in place. |
| Discovery | Create `server/projects/refresh.ts`; coalesce and cancel root scans. Extend `discovery.ts` and `git.ts` for cancellation. |
| Review orchestration | Refactor `server/intake/project-drafts.ts` into the fast gate; create `server/projects/submission-worker.ts` for slow resolution and approval validation. |
| Binding/lifecycle | Adapt `server/projects/service.ts`, `binding.ts`, `server/main.ts`, and coordinator wiring without changing workflow states. |
| HTTP/browser API | Extend existing `server/http/api.ts`, `server/http/projects.ts`, `src/tasks/api.ts`, and `src/projects/api.ts`. |
| UI | Simplify `NewTaskDialog`; create `PendingIdeaNotices` and `ProjectSubmissionReview`; adapt `ProjectSubmissions`, `ProjectSelection`, `ProjectsPage`, `App`, and navigation. |
| Evidence | Extend adjacent tests and fake preview; write `docs/superpowers/verification/2026-09-23-async-idea-project-review.md` after verification. |

## Task 1: Versioned submission state and durable command journal

**Files:** Modify `shared/projects.ts`, `shared/contracts.ts`; create `shared/project-submissions.ts`, `shared/project-submissions.test.ts`, `server/intake/project-submission-store.ts`, `server/intake/project-submission-store.test.ts`, `server/testing/submissions.ts`.

**Interfaces:** Define these exported contracts in `shared/projects.ts`, reusing `DraftText`, `ProjectDraft`, `ResolutionChoices`, `ProjectSelection`, `ProjectName`, `ProjectReadiness`, and `ResolutionPreview`:

```ts
type SubmissionPhase = 'queued' | 'resolving' | 'needs-input' |
  'awaiting-review' | 'validating' | 'preparing' | 'ready' | 'accepted' | 'failed';
type SubmissionPolicy = 'required' | 'automatic' | 'legacy-review';
type ProjectReviewOption = {
  id: string; name: string; readiness: ProjectReadiness;
  defaultRef: string | null; branches: string[]; briefVersions: number[];
};
type SubmissionProposal = {
  preview: ResolutionPreview; names: ProjectName[];
  projects: ProjectReviewOption[]; selections: ProjectSelection[];
  blockers: string[];
};
type SubmissionApproval = { requestId: string; bindingRequestId: string;
  submissionRevision: number; draft: ProjectDraft };
type PendingSubmission = {
  schemaVersion: 2; submissionId: string; filename: string;
  origin: 'http' | 'filesystem' | 'legacy'; policy: SubmissionPolicy;
  revision: number; attempt: number; phase: SubmissionPhase;
  text: DraftText; markdown: string; choices: ResolutionChoices;
  selections: ProjectSelection[]; proposal: SubmissionProposal | null;
  approval: SubmissionApproval | null; operationId: string | null;
  taskId: string | null; message: string; retryRequestId: string | null;
  failure: { stage: 'resolution' | 'validation' | 'preparation' | 'pickup';
    message: string } | null;
};
type PendingSubmissionSummary = Pick<PendingSubmission,
  'submissionId' | 'revision' | 'phase' | 'text' | 'message' | 'failure' | 'taskId'>;
type SubmissionEdit = { expectedRevision: number; requestId: string;
  text: DraftText; choices: ResolutionChoices; selections: ProjectSelection[] };
type SubmissionAction = { expectedRevision: number; requestId: string };
type SubmissionApprove = SubmissionAction & { projectDraft: ProjectDraft };
```

`shared/project-submissions.ts` exports `submissionLabel(summary): string`, `submissionStatus(summary): string`, and `proposalDraft(item): ProjectDraft | null`. `WorkspaceView.pendingSubmissions?: PendingSubmissionSummary[]` is additive for old test/client payloads; the real server always returns an array.

`openSubmissionStore(localRoot: string): Promise<SubmissionStore>` returns:

```ts
type SubmissionStore = {
  get(id: string): Promise<PendingSubmission>;
  list(): Promise<PendingSubmission[]>;
  ensure(item: PendingSubmission): Promise<PendingSubmission>;
  command(id: string, expectedRevision: number, requestId: string,
    payload: unknown, update: (current: PendingSubmission) => PendingSubmission
  ): Promise<PendingSubmission>;
  compareAndSet(id: string, revision: number, attempt: number,
    update: (current: PendingSubmission) => PendingSubmission
  ): Promise<PendingSubmission | null>;
};
```

Updates are synchronous pure callbacks. The store increments revision, clones returned values, and writes atomically under a short promise queue. Only `command` keeps request digests/results; replay is checked before expected revision. `compareAndSet` returns null for obsolete work. `ensure` deduplicates by ID and filename; existing edited content is never reset from the capture receipt.

- [ ] **Write failing tests for replay, stale work, and migration.** Add `pendingSubmissionFixture(overrides: Partial<PendingSubmission> = {}): PendingSubmission` and `deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }` to the test helper. The fixture is a required-review HTTP idea with empty choices/selections, null proposal/approval/operation/task/failure/retryRequestId, revision 1, attempt 0, phase queued. Use `createProjectFixture` for durable roots.

```ts
it('replays the original command after a later edit and restart', async () => {
  const f = await createProjectFixture();
  try {
    const store = await openSubmissionStore(f.local);
    const initial = await store.ensure(pendingSubmissionFixture());
    const payload = { text: { title: 'Updated', description: 'Brief' } };
    const result = await store.command(initial.submissionId, 1, 'edit-1', payload,
      item => ({ ...item, text: payload.text, markdown: '# Updated\n\nBrief' }));
    await store.command(initial.submissionId, result.revision, 'edit-2', {},
      item => ({ ...item, message: 'Newer state' }));
    const reopened = await openSubmissionStore(f.local);
    expect(await reopened.command(initial.submissionId, 1, 'edit-1', payload,
      () => { throw new Error('Replay must not execute'); })).toEqual(result);
    expect(await reopened.compareAndSet(initial.submissionId, 1, 0,
      item => ({ ...item, phase: 'ready' }))).toBeNull();
  } finally { await f.dispose(); }
});
```

Add table-driven migration cases using legacy `{items, requests}` records at `projects/submissions/state.json`: `ready: true` maps to ready; an `operationId` maps to preparing; neither maps to legacy-review/needs-input. Preserve old request results separately so an old `/resolve` retry cannot execute twice. A missing policy on a legacy record is never interpreted as a new required-review capture. Invalid identities, malformed records, reused IDs with different payloads, and duplicate filenames must fail without rewriting the original file.

- [ ] **Run red:** `npm test -- --run shared/project-submissions.test.ts server/intake/project-submission-store.test.ts`. Missing exports are the initial expected failure; after implementation, failures must be behavioral rather than fixture errors.
- [ ] **Implement the store and pure helpers.** Use `confinedPath`, `writeAtomic`, and the existing promise-queue pattern. Keep the existing state path, add a top-level schema version, retain immutable old request receipts, and apply migration in one atomic write. A worker result must pass both revision and attempt checks:

```ts
if (current.revision !== revision || current.attempt !== attempt) return null;
const next = { ...update(structuredClone(current)), revision: current.revision + 1 };
```

`proposalDraft` returns null for absent proposals, matching problems, blockers, missing/duplicate selections, unavailable branches or brief versions; otherwise it uses persisted text, choices, preview revisions, and exact saved selections. Status copy distinguishes needs-input matching problems from missing setup. Empty title labels use a bounded brief excerpt; never use the generated filename.

- [ ] **Run green:** repeat the targeted command and run `npm run build:server`.
- [ ] **Commit:** stage only this task's files and commit `feat: persist versioned idea review state`.

## Task 2: Durable capture independent of intake scans

**Files:** Create `server/intake/capture.ts`, `server/intake/capture.test.ts`; modify `server/intake/intake.ts`, `server/intake/intake.test.ts`, `server/intake/project-drafts.ts`, `server/intake/project-drafts.test.ts`.

**Interfaces:** Export `CaptureRecord` with the existing receipt fields (`requestId`, `digest`, `submissionId`, `filename`, `bytes`, optional `projectDraft`) plus `schemaVersion: 2`, `origin: 'http'`, `policy: 'required'`, and `text: DraftText`. Export `LegacyCaptureRecord` as the unchanged old receipt type and `StoredCapture = CaptureRecord | LegacyCaptureRecord`; distinguish them using the schema version without mutating old bytes. `openCaptureStore(workspaceRoot)` exposes `save(markdown, requestId, projectDraft?, text?): Promise<{submissionId: string}>`, `list(): Promise<StoredCapture[]>`, and `findByFilename(filename): Promise<StoredCapture | null>`. Keep legacy records readable without changing their policy. `Intake.submit(markdown, requestId, projectDraft?, text?)` delegates to capture saving and adds `pendingSubmissions(): Promise<PendingSubmissionSummary[]>` for receipt fallback summaries.

- [ ] **Write the failing capture tests.** Import `createIntake`, `openStore`, `createProjectFixture`, `openCaptureStore`, `deferred`, and Vitest. Verify save while another intake action is held and no project resolver has run. Preserve the existing intake fixture's `io` hooks to hold traversal rather than adding a production delay.

```ts
it('captures structured blank-title text without project processing', async () => {
  const f = await createProjectFixture();
  try {
    const store = await openStore(f.workspace);
    const intake = createIntake(f.workspace, store, 0);
    const text = { title: '', description: '# [shop] This is brief text' };
    const result = await intake.submit(text.description, 'capture-1', undefined, text);
    const records = await (await openCaptureStore(f.workspace)).list();
    expect(records[0]).toMatchObject({ ...result, text, policy: 'required' });
    expect((await store.list()).tasks).toHaveLength(0);
    expect(await intake.submit(text.description, 'capture-1', undefined, text)).toEqual(result);
    await expect(intake.submit('Different', 'capture-1')).rejects.toMatchObject({ code: 'conflict' });
  } finally { await f.dispose(); }
});
```

Also cover simultaneous same-ID capture, byte-size overflow, blank brief, Markdown/text mismatch, storage failure, and recovery with a receipt but no pending record. Use a deferred `io.open` on an existing draft to keep `scan()` pending, await a successful `submit()` while that deferred is unresolved, then release traversal in `finally`. That assertion must fail against the old shared queue.

- [ ] **Run red:** `npm test -- --run server/intake/capture.test.ts server/intake/intake.test.ts`.
- [ ] **Extract receipt persistence and decouple submit.** Preserve request digest validation, no-follow directory/file safeguards, atomic writes and original bytes. Normalize explicit text without deriving a title from its brief; use existing `deriveDraftText` only if text was omitted. Validate `draftMarkdown(text) === markdown` for structured input. New captures use their own short queue:

```ts
submit(markdown, requestId, projectDraft, text) {
  return captures.save(markdown, requestId, projectDraft, text);
}
```

Do not call `ensurePublished` from save. `scanInternal` reconciles capture receipts into pending records before publishing Markdown. Until the fast gate is integrated in Task 4, new required-review receipts must be held safely, never auto-published as legacy drafts. No-gate configurations expose saved captures but cannot silently bypass required review.

- [ ] **Preserve identity through pickup/recovery.** Resolve origin/policy by capture filename before creating or resuming a pending record. Store the original capture submission ID separately from the intake task ID where they differ; `markAccepted(submissionId, taskId)` is called only after `store.create` succeeds. If the task already exists after a crash, reconcile its identity and mark accepted without reconstructing it from new content. Original receipt bytes remain immutable; project-gate output supplies edited title/Markdown for first task publication.

`pendingSubmissions()` returns queued summaries from capture receipts not yet represented by pending state or an accepted task. Task 5 merges these with richer project summaries by submission ID. Corrupt receipt reads report issues and do not disappear silently.

- [ ] **Run green:** repeat targeted tests; run `npm test -- --run server/intake/phone-drafts.test.ts` to protect the original intake policy.
- [ ] **Commit:** `feat: save idea receipts without waiting for project scans`.

## Task 3: Cancellable discovery and coalesced refresh

**Files:** Create `server/projects/refresh.ts`, `server/projects/refresh.test.ts`; modify `server/projects/discovery.ts`, `server/projects/discovery.test.ts`, `server/projects/git.ts`, `server/projects/git.test.ts`, `server/projects/service.ts`.

**Interfaces:** Extend `runGit` options with `signal?: AbortSignal`; extend `scanRoot(root, {timeoutMs, signal?})` and source validation cancellation propagation. Export `createCatalogRefresh({settings, catalog, timeoutMs, scan?})`, returning `{ refresh(): Promise<CatalogSnapshot>; close(): Promise<void> }`. `settings` is `Pick<ProjectSettingsService, 'read'>`, `catalog` is `ProjectCatalog`, and injectable `scan` has `typeof scanRoot`. `close` cancels and drains active work and disallows new refreshes.

- [ ] **Write failing tests for coalescing and settings replacement.** Use deferred discovery results and fixture settings/catalog. Capture the signal and count scans, then assert old generation results cannot reconcile.

```ts
it('coalesces refreshes and aborts a retired root', async () => {
  const f = await createProjectFixture();
  try {
    let root = { state: 'ready' as const, projectsRoot: f.root,
      generation: 'g1', revision: 'r1', message: null };
    const pending = deferred<DiscoveryResult>();
    const started = deferred<AbortSignal>();
    const scan = vi.fn(async (_root: RootSetting, options: { signal?: AbortSignal }) => {
      started.resolve(options.signal!);
      await pending.promise;
      options.signal!.throwIfAborted();
      return { entries: [], scannedAt: '2026-09-23T00:00:00Z' };
    });
    const catalog = await openProjectCatalog(f.local);
    const refresh = createCatalogRefresh({ settings: { read: async () => root },
      catalog, timeoutMs: 120000, scan });
    const first = refresh.refresh().catch(error => error);
    const signal = await started.promise;
    const second = refresh.refresh().catch(error => error);
    root = { ...root, generation: 'g2', revision: 'r2' };
    const third = refresh.refresh();
    pending.resolve({ entries: [], scannedAt: '' });
    await Promise.all([first, second, third]);
    expect(signal.aborted).toBe(true);
    expect((await catalog.read()).generation).toBe('g2');
    expect(scan).toHaveBeenCalledTimes(2);
    await refresh.close();
  } finally { await f.dispose(); }
});
```

Add fake-timer tests for the whole-pass timeout and use a fake Git executable/process fixture in existing Git tests to prove cancellation kills and awaits the child. Restore timers/environment in cleanup. Test pre-aborted signals, abort during metadata traversal, timeout not being swallowed as a detached HEAD or ineligible directory, and fresh calls after a rejected scan.

- [ ] **Run red:** `npm test -- --run server/projects/refresh.test.ts server/projects/discovery.test.ts server/projects/git.test.ts`.
- [ ] **Implement cancellation and refresh lifecycle.** One active scan is keyed by settings revision/generation. Same-key callers share it. Different-key callers cancel/drain old work and reread settings before starting; compare settings again before reconcile. Clear in-flight state only if it still refers to that exact promise. Never cache a resolved promise as a fresh scan for future approval.

```ts
signal.throwIfAborted();
const discovery = await scan(root, { timeoutMs, signal });
signal.throwIfAborted();
const current = await settings.read();
if (current.revision !== root.revision) throw new BoundaryError('conflict', 'Projects root changed');
return catalog.reconcile(current, discovery);
```

Scope one timeout controller to the entire scan; forward it through every Git call and check it between filesystem operations. In catch blocks call `signal?.throwIfAborted()` before treating an error as an ineligible repository. `runGit` removes abort listeners/timers on error/close, records cancellation as failure, kills the child, and rejects after termination. Preserve current environment/config restrictions and output limits. Avoid a promise race that leaves work running.

- [ ] **Run green:** repeat the targeted command, plus `npm test -- --run server/projects/catalog.test.ts` for semantic revisions and source identity preservation.
- [ ] **Commit:** `fix: bound and coalesce project discovery work`.

## Task 4: Background resolution, explicit approval, and fast intake gate

**Files:** Modify `server/intake/project-drafts.ts`, `server/intake/project-drafts.test.ts`, `server/projects/service.ts`, `server/projects/service.test.ts`, `server/projects/binding.ts`, `server/projects/binding.test.ts`, `server/main.ts`; create `server/projects/submission-worker.ts`, `server/projects/submission-worker.test.ts`.

**Interfaces:** `createProjectDrafts` consumes the Task 1 store and existing binding service. Keep `prepare`'s existing pending/needs-input/ready result, adding origin/policy/text on its registration input. Expose `get(id)`, `list()`, `edit(id, SubmissionEdit)`, `refresh(id, SubmissionAction)`, `approve(id, SubmissionApprove)`, `retry(id, SubmissionAction)`, and `markAccepted(id, taskId)`. Mutation results are `PendingSubmission`; `resolveIssue` is replaced by `approve` with a compatibility adapter for old stored request receipts.

`createSubmissionWorker({store, refreshCatalog, catalog, briefs, binding})` returns `{runOnce(): Promise<void>; recover(): Promise<void>}`. `runOnce` claims one actionable submission in FIFO order, does slow work outside store callbacks, and conditionally commits its result. `recover` requeues interrupted resolving work with a new attempt, resumes validating decisions, and reconciles bindings without changing approved input. `runOnce` is single-flight when called by project services.

- [ ] **Write a failing no-project approval test.** Build the gate/worker with empty-catalog fixtures; a binding fake must throw if called for projectless work.

```ts
it('holds a resolved projectless HTTP idea until durable approval', async () => {
  const f = await createProjectFixture();
  try {
    const store = await openSubmissionStore(f.local);
    const catalog = await openProjectCatalog(f.local);
    const binding = { begin: vi.fn(() => { throw new Error('No binding expected'); }) } as unknown as BindingService;
    const gate = await createProjectDrafts({ store, binding });
    const worker = createSubmissionWorker({ store, catalog, binding,
      refreshCatalog: () => catalog.read(), briefs: { history: async () => [] } as unknown as BriefService });
    const input = { submissionId: 'idea', requestId: 'capture', filename: 'idea.md',
      markdown: 'Brief', text: { title: '', description: 'Brief' },
      origin: 'http' as const, policy: 'required' as const };
    expect(await gate.prepare(input)).toMatchObject({ state: 'pending' });
    await worker.runOnce();
    const review = await gate.get('idea');
    expect(review.phase).toBe('awaiting-review');
    const saved = await gate.approve('idea', { expectedRevision: review.revision,
      requestId: 'approve', projectDraft: proposalDraft(review)! });
    expect(saved.phase).toBe('validating');
    expect(await gate.prepare(input)).not.toMatchObject({ state: 'ready' });
    await worker.runOnce();
    expect(await gate.prepare(input)).toMatchObject({ state: 'ready', context: null });
  } finally { await f.dispose(); }
});
```

Use `BriefService.history(projectId)` to populate `briefVersions`, `current(projectId)` for initial defaults, and `get(projectId, version)` to validate chosen versions; the projectless fake above never calls them. Expand worker tests with table cases:

```ts
const resolutionCases = [
  ['required', 'empty', 'awaiting-review'],
  ['required', 'ready-project', 'awaiting-review'],
  ['required', 'missing-brief', 'needs-input'],
  ['required', 'ambiguous', 'needs-input'],
  ['automatic', 'empty', 'ready'],
  ['automatic', 'ready-project', 'validating'],
  ['legacy-review', 'empty', 'awaiting-review'],
] as const;
```

For each case use the existing repository/brief fixtures to generate the named catalog state, register its policy, run one pass, and assert the expected phase. Hold resolution with `deferred`, save a newer edit, release old work, and assert it cannot overwrite the newer revision. Hold validation and assert approval/list/edit-conflict responses remain immediate. Cover unchanged timestamps, changed root/catalog, removed branch/brief, preserving explicit valid selections, replayed approval, and all stage-specific retries.

- [ ] **Run red:** `npm test -- --run server/intake/project-drafts.test.ts server/projects/submission-worker.test.ts`.
- [ ] **Implement gate commands with short atomic transitions.** `prepare` ensures a record and reads its phase; it never scans. Editing resets dependent choices only when text changes, removes approval/proposal, bumps attempt, and queues work. Refresh preserves valid saved selections. Approval requires awaiting-review, exact persisted `proposalDraft` equality, and the current revision, then journals:

```ts
return store.command(id, input.expectedRevision, input.requestId, input, item => ({
  ...item, phase: 'validating', failure: null,
  approval: { requestId: input.requestId,
    bindingRequestId: `submission:${id}:approval:${input.requestId}`,
    submissionRevision: item.revision, draft: input.projectDraft },
  message: 'Checking approved projects',
}));
```

Reject edits after approval; reject retry outside failed state. Resolution retry queues resolution, validation retry retains approval, preparation retry resumes the same binding, and pickup retry preserves the existing intake operation. Preparation retry stores its command ID in `retryRequestId`, moves to preparing, and lets the worker call `binding.retry(operationId, retryRequestId)` outside the persistence queue. Clear that intent only after the retry is durably acknowledged; replay uses the same ID.

- [ ] **Implement the worker phase switch.** Claim via compare-and-set, increment attempt, and save resolving before scanning. Resolve against a fresh catalog; gather names for ambiguity and all selected project options. Preserve valid explicit selections, otherwise propose available defaults; unmatched text requires no invented target. Commit needs-input if problems/blockers remain, otherwise awaiting-review. Automatic policy may journal its defaults for validation; legacy-review may not auto-accept. Root-unavailable is needs-input, never a projectless success.

For validation, refresh and compare semantic preview/catalog revisions and all selections. Changed input returns a new proposal for review and clears approval. Otherwise create/recover the binding with the durable `bindingRequestId`, commit preparing, and later read its complete context to mark ready. No-project approval becomes ready only after the same check. Do not hold state locks while calling binding methods.

Keep binding's final freshness check; a conflict between validation and `binding.begin` returns to review. Recovery first reconciles an already created binding by its idempotent request identity before performing a new freshness check, so an already pinned decision is not discarded after a crash. Add `BindingService.findByRequestId(requestId: string): Promise<OperationStatus | null>`, using the same hash scheme already used by `begin`. A missing record returns null; a corrupt record fails visibly. Existing bindings resume without rescanning or changing their input.

- [ ] **Integrate background lifecycle and shutdown.** Project services schedule resolution independently from potentially slow preparation/binding work, while each lane remains single-flight. `tick` starts work and returns promptly. Startup performs store recovery and schedules refresh instead of awaiting full discovery. Capture/list reads use pending state rather than awaiting binding's queue. Shutdown disables new passes, cancels/drains refresh, awaits workers/bindings, then releases the host lock. Existing tests use `close()` as a drain between ticks: add `drain(): Promise<void>` for that purpose and reserve `close()` for actual shutdown. Update service tests in this task; update the remaining integration callers and fake preview in Task 8. Export the constructed `submissionWorker` on `ProjectServices` alongside the existing `draftGate` and `binding` to allow deterministic worker passes in integration tests.

- [ ] **Run green:** targeted tests, then `npm test -- --run server/projects/binding.test.ts server/projects/service.test.ts server/coordinator/coordinator.test.ts server/intake/phone-drafts.test.ts`.
- [ ] **Commit:** `feat: resolve saved ideas in background with approval gating`.

## Task 5: HTTP contracts and workspace progress

**Files:** Modify `server/http/api.ts`, `server/http/projects.ts`, `server/http/api.test.ts`, `server/http/projects.test.ts`, `src/projects/api.ts`, `src/projects/api.test.ts`, `src/tasks/api.ts`, `src/tasks/api.test.ts`.

**Interfaces:** The exact routes are:

| Route | Body/result |
| --- | --- |
| `POST /api/drafts` | `{markdown, requestId, text?, projectDraft?}` → `202 {submissionId}`. Required review is server-assigned. |
| `GET /api/workspace` | Existing view plus `pendingSubmissions` merged by submission ID. |
| `GET /api/project-submissions` | `PendingSubmission[]` excluding accepted, including ready/pickup. |
| `GET /api/project-submissions/:id` | Current `PendingSubmission`; accepted records remain readable for navigation recovery. |
| `POST /api/project-submissions/:id/edit` | `SubmissionEdit` → `202 PendingSubmission`. |
| `POST /api/project-submissions/:id/refresh` | `SubmissionAction` → `202 PendingSubmission`. |
| `POST /api/project-submissions/:id/resolve` | `SubmissionApprove` → `202 PendingSubmission`. |
| `POST /api/project-submissions/:id/retry` | `SubmissionAction` → `202 PendingSubmission`. |

Keep existing project-operation retry routes for project setup. `ProjectApi` gets `editSubmission`, `refreshSubmission`, `approveSubmission`, and `retrySubmission` with `(id, body)` signatures; `submission`/`submissions` use shared types. Remove the old client-side duplicate `ProjectSubmission` shape. `WorkspaceApi.submit` keeps `(markdown, requestId, projectDraft?, text?)` until the compatibility argument is no longer needed by existing callers.

- [ ] **Write failing route/API tests.** Extend the current local HTTP fixture and use a held worker refresh. POST a capture, then GET workspace while held; expect 202 and one queued/resolving summary. Test that a forged `policy: 'automatic'` is rejected. Replay edit/refresh/approval/retry bodies and check identical results, not repeated work. Reject wrong origin, malformed nested selections, duplicate IDs, unexpected keys, missing positive revisions, and different content under a reused request ID. A legacy `projectDraft` on capture must still require review.

```ts
it('forwards cancellation for project POST requests', async () => {
  const controller = new AbortController();
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  vi.stubGlobal('fetch', fetcher);
  await projectApi.resolve({ title: '', description: 'Brief' },
    { excludedReferenceIds: [], ambiguities: {} }, controller.signal);
  expect(fetcher).toHaveBeenCalledWith('/api/projects/resolve',
    expect.objectContaining({ method: 'POST', signal: controller.signal }));
});
```

- [ ] **Run red:** `npm test -- --run server/http/projects.test.ts server/http/api.test.ts src/projects/api.test.ts src/tasks/api.test.ts`.
- [ ] **Implement the routes and stable progress reads.** Reuse boundary parsers; convert validation errors to `BoundaryError('invalid', ...)`, retain revision conflicts as 409, and retain origin checks. Resolve-only previews read the saved catalog; only worker/explicit refresh starts discovery. Workspace merge prefers pending state over capture fallback and removes accepted entries after matching a durable task. If capture exists but pending registration has not run, detail reads register or project a queued entry through the fast path, so its notice action never returns a misleading 404.

```ts
const summaries = new Map(captureSummaries.map(item => [item.submissionId, item]));
for (const item of pendingItems) {
  if (item.phase === 'accepted') summaries.delete(item.submissionId);
  else summaries.set(item.submissionId, toSummary(item));
}
```

Define local `toSummary(item: PendingSubmission): PendingSubmissionSummary` by selecting the shared fields. Reconcile already-created tasks before this merge; do not mark accepted based solely on an optimistic browser receipt. Continue reporting ordinary filesystem intake issues; suppress only duplicate pending-state notices for the same registered submission.

- [ ] **Run green:** repeat targeted tests and `npm run build:server`.
- [ ] **Commit:** `feat: expose asynchronous idea review APIs and progress`.

## Task 6: Simple capture and persistent workspace notices

**Files:** Modify `src/components/NewTaskDialog.tsx`, `src/components/NewTaskDialog.test.tsx`, `src/tasks/useWorkspace.ts`, `src/tasks/useWorkspace.test.tsx`, `src/App.tsx`, `src/App.test.tsx`, `src/tasks/navigation.ts`, `src/tasks/navigation.test.ts`, `src/components/ProjectsPage.tsx`, `src/styles/workspace.css`; create `src/components/PendingIdeaNotices.tsx`, `src/components/PendingIdeaNotices.test.tsx`.

**Interfaces:** `NewTaskDialog.onSubmit(markdown: string, text: DraftText): Promise<void>`; remove its `projects` prop and project/setup destinations. `useWorkspace.submit(markdown, text)` journals both for request-ID reuse and returns the saved receipt after setting optimistic progress. `PendingIdeaNotices({items, onOpen})` uses `PendingSubmissionSummary[]` and `onOpen(submissionId: string): void`. Add `NavigationState.submissionId: string | null` and event `{type:'submission', id:string}` to open Projects at that submission; parsing old preferences supplies null. `ProjectsPage` accepts `submissionId?: string | null`.

- [ ] **Write the failing capture test and retain existing focus/reopen cases.** Update accessible copy and button names in those tests rather than deleting the cases.

```tsx
it('saves structured text without a project picker', async () => {
  const user = userEvent.setup(), submit = vi.fn(async () => {}), close = vi.fn();
  render(<NewTaskDialog open canSubmit onClose={close} onSubmit={submit} />);
  await user.type(screen.getByLabelText('Brief'), '# [shop] A heading in the brief');
  expect(screen.queryByRole('region', { name: 'Project matching' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Save idea' }));
  expect(submit).toHaveBeenCalledWith('# [shop] A heading in the brief',
    { title: '', description: '# [shop] A heading in the brief' });
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});
```

Add notice cases for queued/resolving/review/setup/validating/preparing/failed/ready; assert each status and action by accessible name. App tests change loaded workspace state from resolving to awaiting-review while staying on a task detail page, verify the review action opens the correct submission, and verify reload restores the notice without a local optimistic receipt. Add two consecutive captures, save failure/retry request identity, lost response, old response after reopening, and no project API calls while typing.

- [ ] **Run red:** `npm test -- --run src/components/NewTaskDialog.test.tsx src/components/PendingIdeaNotices.test.tsx src/tasks/useWorkspace.test.tsx src/tasks/navigation.test.ts src/App.test.tsx`.
- [ ] **Implement simple capture and keyed progress.** Preserve duplicate-submit protection, session isolation, field limits, error retention, and focus restoration. Replace the single permanent “Submitted; waiting for pickup” banner with keyed optimistic entries merged into server summaries; do not keep a captured entry after the server reports its task accepted. A missing summary during the first post-save poll is not evidence of acceptance.

```tsx
<PendingIdeaNotices items={workspace.pendingSubmissions}
  onOpen={id => dispatch({ type: 'submission', id })} />
```

Expose `pendingSubmissions: PendingSubmissionSummary[]` from `useWorkspace`, merging optimistic captures with loaded summaries and existing task-source identity for old payloads. Use the task ID when supplied by the pending lifecycle; never assume a submission ID equals the task ID. Polling remains the existing 2-second mechanism and pauses only for short mutations, not throughout resolution.

- [ ] **Run green:** repeat targeted tests and `npm run build:ui`.
- [ ] **Commit:** `feat: capture ideas immediately and show review progress`.

## Task 7: Durable project review, edits, retry, and conflicts

**Files:** Create `src/components/ProjectSubmissionReview.tsx`, `src/components/ProjectSubmissionReview.test.tsx`; modify `src/components/ProjectSubmissions.tsx`, `src/components/ProjectSelection.tsx`, `src/components/ProjectSelection.test.tsx`, `src/components/ProjectsPage.tsx`, `src/components/ProjectsPage.test.tsx`, `src/styles/workspace.css`.

**Interfaces:** `ProjectSubmissions({api, submissionId?, onOpenSettings})` polls submission state and expands the requested ID. `ProjectSubmissionReview({api, item, onChanged, onOpenSettings})` owns local editor state; its `api` type is `Pick<ProjectApi, 'editSubmission' | 'refreshSubmission' | 'approveSubmission' | 'retrySubmission'>` and `onChanged(item: PendingSubmission)` updates the parent. Parent polling owns connectivity and passes `connected?: boolean` (default true for isolated tests). Refactor `ProjectSelection` into controlled presentation taking `{proposal: SubmissionProposal, choices: ResolutionChoices, selections: ProjectSelection[], onChoices, onSelections, onOpenSettings}`. It renders saved names/options/evidence and never fetches or rescans by mounting. Remove its debounce/network ownership after updating all callers.

- [ ] **Write failing review tests with `pendingSubmissionFixture` and a complete `ProjectApi` fake based on existing ProjectsPage fixtures.** Use stored proposal options for ready/setup/ambiguous cases; do not fake an approval-ready state with missing project metadata.

```tsx
it('preserves local text and blocks approval after another client edits', async () => {
  const user = userEvent.setup();
  const text = { title: '', description: 'Brief' };
  const choices = { excludedReferenceIds: [], ambiguities: {} };
  const preview = previewResolution(text,
    { generation: 'unset', revision: 'unset', state: 'unset', projects: [] }, choices);
  const first = pendingSubmissionFixture({ phase: 'awaiting-review', text,
    proposal: { preview, names: [], projects: [], selections: [], blockers: [] } });
  const unexpected = async () => { throw new Error('Unexpected mutation'); };
  const api: Pick<ProjectApi, 'editSubmission' | 'refreshSubmission' |
    'approveSubmission' | 'retrySubmission'> = {
    editSubmission: vi.fn(unexpected), refreshSubmission: vi.fn(unexpected),
    approveSubmission: vi.fn(unexpected), retrySubmission: vi.fn(unexpected),
  };
  const { rerender } = render(<ProjectSubmissionReview api={api} item={first}
    onChanged={vi.fn()} onOpenSettings={vi.fn()} />);
  await user.clear(screen.getByLabelText('Pending brief'));
  await user.type(screen.getByLabelText('Pending brief'), 'My unsaved text');
  rerender(<ProjectSubmissionReview api={api}
    item={{ ...first, revision: first.revision + 1, text: { title: '', description: 'Other edit' } }}
    onChanged={vi.fn()} onOpenSettings={vi.fn()} />);
  expect(screen.getByLabelText('Pending brief')).toHaveValue('My unsaved text');
  expect(screen.getByRole('button', { name: 'Approve and continue' })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('changed');
});
```

Add tests for no-project approval, Save changes and resolve not approving, text changes resetting exclusions/ambiguities, branch-only changes preserving choices, refresh preserving explicit brief selection, failed-stage retry, setup navigation, and a rejected approval retaining all local values. With a deferred approval response, prevent double-clicks; after the response enters validating, permit navigation away while work proceeds. Poll detail/list responses out of order and assert stale revisions cannot replace newer state. On browser/API disconnection retain state and disable mutations.

- [ ] **Run red:** `npm test -- --run src/components/ProjectSubmissionReview.test.tsx src/components/ProjectSelection.test.tsx src/components/ProjectsPage.test.tsx`.
- [ ] **Implement controlled review and polling.** Initialize editor values from a specific revision. Track dirty state and the editor's base revision separately from newest server status. For external conflicts preserve edits and expose **Reload saved version** and **Reapply my changes**; the latter uses an explicit save against the newly displayed revision, never an automatic retry of approval. Saved/reloaded values replace the editor only after the user action succeeds.

```ts
const canApprove = item.phase === 'awaiting-review' && !dirty && !conflict &&
  !busy && connected && proposalDraft(item) !== null;
```

Store a request ID with each exact mutation payload across uncertain retries. Approval sends the persisted proposal, not uncommitted local choices. Editing any review input disables approval until Save changes and resolve completes. When approval succeeds, display validating progress immediately; no forced modal, automatic setup, or automatic investigation. Ensure notice expansion focuses the relevant heading without repeatedly stealing focus on polls.

- [ ] **Run green:** repeat targeted tests and `npm test -- --run src/App.test.tsx src/projects/useProjects.test.tsx`.
- [ ] **Commit:** `feat: review saved project matches before investigation`.

## Task 8: Recovery proof, end-to-end verification, and documentation

**Files:** Create `server/intake/async-submissions.test.ts`, `docs/superpowers/verification/2026-09-23-async-idea-project-review.md`; modify `server/main.test.ts`, `server/coordinator/coordinator.test.ts`, `server/projects/integration.test.ts`, `scripts/preview-fake.mjs`, `README.md`, `docs/coordinator-operations.md` and any service tests still using `close` as a drain.

**Interfaces:** No new product interfaces. Use the shared capture/store/gate/worker methods defined in Tasks 1–5 and the existing fake runner.

- [ ] **Write failing recovery and fairness integration cases before changing integration wiring.** Build temporary roots with `createProjectFixture`, `openStore`, `openCaptureStore`, and `openProjectServices`; use the existing fake runner instead of real Codex.

```ts
const crashBoundaries = [
  'after-capture', 'during-resolution', 'after-approval', 'after-binding-create',
  'after-commit-recorded', 'after-task-create',
] as const;
```

For each boundary inject one failure through the owning service's existing dependency or filesystem wrapper, reopen services against the same temporary roots, and finish the flow. Assert one capture receipt, one pending identity, exactly one task, unchanged approved selections/recorded commits, and no task before approval. For after-task-create failure, make `markAccepted` fail once after the real `store.create`, reopen and verify the original task bytes/revision remain unchanged. Add a real task eligible for fake dispatch while resolution is deferred and assert it launches without releasing resolution. Capture a second idea during the same hold.

The capture-boundary test can use the real services without a CLI assignment. Import `writeFile`, `loadSettings`, the existing fixture/store/intake/project-service factories, and shared `proposalDraft`:

```ts
it('recovers a saved receipt and still requires review', async () => {
  const f = await createProjectFixture();
  let services: ProjectServices | undefined;
  try {
    await writeFile(f.configPath, JSON.stringify({ workspaceRoot: f.workspace,
      localRoot: f.local, codexBinary: process.execPath }));
    const settings = await loadSettings(f.configPath);
    const taskStore = await openStore(f.workspace);
    const receipt = await (await openCaptureStore(f.workspace)).save('Brief', 'capture');
    services = await openProjectServices(f.configPath, settings, taskStore);
    const intake = createIntake(f.workspace, taskStore, 0, {}, { projectGate: services.draftGate });
    await intake.scan(1);
    await services.submissionWorker.runOnce();
    expect((await taskStore.list()).tasks).toHaveLength(0);
    const review = await services.draftGate.get(receipt.submissionId);
    expect(review.phase).toBe('awaiting-review');
    await services.draftGate.approve(receipt.submissionId, {
      expectedRevision: review.revision, requestId: 'approve', projectDraft: proposalDraft(review)!,
    });
    await services.submissionWorker.runOnce();
    await intake.scan(2);
    await intake.scan(3);
    const first = (await taskStore.list()).tasks;
    expect(first).toHaveLength(1);
    await intake.scan(4);
    expect((await taskStore.list()).tasks).toEqual(first);
  } finally { await services?.close(); await f.dispose(); }
});
```

- [ ] **Run red:** `npm test -- --run server/intake/async-submissions.test.ts server/main.test.ts server/coordinator/coordinator.test.ts server/projects/integration.test.ts`.
- [ ] **Finish integration and update the disposable preview.** Replace intermediate `close()` calls with `drain()`, close service instances before reopening the same storage, and ensure cleanup drains workers before deleting temporary directories. Seed saved submissions through new capture/approval APIs, not direct ready-state mutations. Keep fixture repositories inside the temporary preview root and mark all generated content fake. Update README and operations with Save idea, pending statuses, explicit review, setup/refresh, immutable binding retry, and restart behavior. Note filesystem/phone policy preservation.
- [ ] **Run green, then the complete checks once:**

```sh
npm test -- --run server/intake/async-submissions.test.ts server/main.test.ts server/coordinator/coordinator.test.ts server/projects/integration.test.ts
npm test -- --run
npm run build
git diff --check
```

Do not weaken timing or durability assertions to make them pass. Fix actual failures and rerun affected checks; broaden again only for changed shared behavior.

- [ ] **Browser-check the fake environment.** Start `npm run preview:fake`, open its reported loopback URL through the browser tool, and exercise: save a blank-title idea; save another while processing; navigate away/reload; open the exact review; edit and re-resolve; approve; confirm task pickup. Repeat with `[shop]` and a reference project, missing setup, a retryable failure fixture, and a narrow viewport. Verify source tree digests remain unchanged in integration tests. Stop the fake server and preserve only the evidence report, not temporary workspaces.
- [ ] **Write the verification report with actual evidence.** Record commit, runtime, commands/results, browser scenarios, crash-boundary results, and any unverified condition. Do not claim the real user's repository scan is repaired solely from fixtures.
- [ ] **Commit:** `test: verify async idea review recovery and capture flow`.

## Self-review and execution handoff

Coverage: spec capture and identity → Tasks 1–2, 5–6; notifications and review → Tasks 5–7; lifecycle/retries/migration → Tasks 1, 4, 8; concurrency/timeouts/root freshness → Tasks 2–4; immutable binding/approval → Tasks 4, 8; startup/shutdown → Tasks 3–4, 8; API boundaries → Task 5; verification → all tasks plus Task 8.

Plan status: written for user review; all implementation checkboxes intentionally remain unchecked. No execution method has been selected. Recommended method is **Native** execution in this session with a final independent branch review: these eight tasks share durable-state contracts and benefit from one implementer retaining their context. Subagent-driven execution remains available if the user prefers independent review after every task.

After plan approval and method selection, create or reuse an isolated worktree, execute the selected implementation skill, and preserve both this approved spec and the plan in the checkout. Do not begin product changes merely because the plan has been written.
