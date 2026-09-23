# Save ideas before resolving projects

## Status and intended outcome

The user approved the proposed flow and this written specification on 2026-09-23: save an idea, resolve projects in the background, then ask for review before investigation starts. The [implementation plan](../plans/2026-09-23-async-idea-project-review.md) is ready for review. Product implementation has not started; plan review and execution-method selection are still required.

Success means the idea popup closes after durable capture without waiting for project discovery, the saved idea remains visible while resolution runs, and the user can review the result later. Reloading the browser or restarting the coordinator must not lose the idea, bypass review, or create duplicate tasks. The review checkpoint applies even to unambiguous matches and projectless results.

This design extends existing pending submissions, project matching, and binding operations. It replaces the UI submission behavior in the [project discovery specification](2026-09-22-project-connection-design.md), including matching while typing and implicit acceptance of ready matches for new HTTP submissions. Existing matching rules, source access restrictions, and immutable task contexts continue to apply.

## Current behavior and cause

- `NewTaskDialog` requires a valid `ProjectDraft` before submission and mounts `ProjectSelection` while the user types.
- `ProjectSelection` waits for resolution, the catalog, and every selected project's details. Each resolution calls `refreshCatalog`, which scans the root and inspects Git metadata. Scans are serialized.
- The browser request helper does not forward its abort signal for POST requests. Superseded previews can continue consuming server work; ignoring an obsolete result does not stop its scan.
- `intake.submit` waits for `ensurePublished`, which calls `projectGate.prepare` before returning. Submission and intake scanning share a queue, so removing the popup picker alone would leave another blocking path.
- The draft gate can automatically accept saved defaults or a result with no projects. The existing pending-draft panel loads once and is located under Projects.

These are code-path findings. This design does not claim that a particular live repository or subprocess has been identified as the cause of the user's latest wait.

## Scope and approach

Use the existing pending-submission store as the durable background work source. Keep the current in-process coordinator and project services; no external queue, separate daemon, or new notification service is needed.

Two smaller alternatives were considered. A dismissible matching popup would not provide durable recovery by itself. Saving first while retaining automatic acceptance would not provide the requested review checkpoint. Extending pending submissions covers both requirements with the existing architecture.

This change covers new ideas submitted through the HTTP/UI capture path. Filesystem and phone drafts keep their established acceptance policy; they benefit from nonblocking project processing but do not gain a mandatory additional approval. Existing accepted tasks and already approved bindings retain their context and progress. Automated preparation of previously unprepared projects, operating-system notifications, remote repository updates, and task workflow redesign are outside scope.

## User experience

### Capture

The new-idea dialog contains the optional title, brief, and **Save idea** button. Project readiness does not disable capture. Supporting text explains: “Save now. Review project matches before investigation starts.” Typing does not launch discovery or matching requests.

Save closes the dialog only after the server acknowledges a durable receipt. Validation or storage failures preserve the entered text and show an error. A lost response can be retried with the same request ID. The UI immediately shows the saved idea's status and remains usable for another idea.

The capture request preserves structured title and description, including an explicitly empty title; a generated UUID filename must not become a UI idea's matching title. Markdown is validated against those fields. Older clients without structured text use the existing Markdown derivation rules.

### Progress and attention

Expose pending idea summaries through the existing workspace polling response. Include durable capture receipts that have not yet acquired a pending record as queued entries, deduplicated by submission ID. Show a compact persistent workspace notice for each pending idea, using its title or a brief excerpt, with its current status and an action to open that idea in the existing pending-draft panel under Projects. Do not automatically open a modal or change the user's current page.

Statuses distinguish **Resolving projects**, **Review projects**, **Needs project setup**, **Checking approved projects**, **Preparing project context**, and a failure with **Retry**. Queued work can say “Waiting to resolve projects.” A status must never suggest that investigation is running before approval.

The review notice remains until approval has been accepted; afterward the same entry shows preparation/pickup progress until the task is available. Pending entries use submission IDs, not task IDs, for navigation. When intake publishes the task, remove the pending notice and retain the ordinary task entry. A transient pickup delay must not make the saved idea disappear.

### Review

Opening the notice expands the matching pending idea. Display the saved title and brief, future change target, reference projects, match explanations, branches, and saved brief versions. Existing default branches and current briefs are suggestions only.

The user can correct the title or brief, resolve ambiguity, exclude references, and select available branches and brief versions. **Save changes and resolve** persists edited text and choices and queues resolution; it does not approve. Text changes reset text-dependent ambiguity choices and exclusions as they do today. Unchanged text preserves explicit choices and valid selections. Only the latest saved revision can be approved.

Missing setup links to the existing Projects preparation controls. Preparing a repository remains a separate explicit action. **Refresh matches** queues a fresh resolution after setup or external repository changes. No setup screen traps the user in the capture dialog.

**Approve and continue** is enabled only for a current, valid review with every required project ready. A projectless review explicitly says “No projects selected” and still requires approval. Clicking approval records the decision promptly, then shows background validation/preparation. It does not wait in the browser for a root scan or snapshot import.

The panel polls persisted status while open and preserves unsaved editor text. If another client changes the submission, show a conflict and require the user to reload or reapply their edits; polling must not overwrite local edits or silently approve a newer revision. Keep errors and status updates accessible through existing alert/status conventions.

## Persisted lifecycle and approval

Introduce a versioned shared pending-submission contract. Store the capture origin and review policy, structured text and Markdown, stable submission ID and filename, revision, phase, latest preview and selections, any approval record, binding operation ID, failure stage/message, and eventual task ID. A preview can be absent before first resolution. The table describes the mandatory-review HTTP path; filesystem/phone intake may follow its existing automatic acceptance policy after resolution.

| Phase | Meaning and permitted next step |
| --- | --- |
| `queued` | Saved and waiting for background resolution. |
| `resolving` | Resolving the current revision; on completion enter review or failure. |
| `needs-input` | Matching problems or missing preparation require user action. |
| `awaiting-review` | A complete proposal, including an empty project set, awaits approval. |
| `validating` | Approval is durable; background freshness validation is in progress. |
| `preparing` | Approved project choices have a durable binding operation. |
| `ready` | Approval and any required context are complete; intake may publish. |
| `accepted` | Intake has durably created the task; retain the receipt for recovery. |
| `failed` | A processing stage failed; retain content and expose the appropriate retry. |

For HTTP captures, only explicit approval can transition a valid proposal to `validating`. Store approval request ID, submission revision, resolution/catalog revisions, and the exact text, choices, branches, and brief versions approved. A request without approval cannot reach `ready`, including when the root is unset or no project matches.

Editing is allowed before approval and from a resolution failure. Saving increments the revision, clears old approval/proposal data as applicable, and queues resolution. During validation, binding, and pickup the approved input is immutable. Conflicts return the current submission without destroying local editor text. Retrying a failure increments its processing attempt and cannot silently substitute a different approved input.

Resolution retries return to `queued`; validation retries repeat the saved approval check; preparation retries resume the existing binding operation. Pickup retries use the existing intake receipt. A failed preparation does not allow edits to replace an already bound selection. Correcting that selection requires capturing a new idea under the existing immutable-context policy.

Background validation refreshes the catalog and validates the approved proposal. If the catalog/resolution revision changed or a selection became invalid, clear the approval and return to a fresh review or `needs-input`, with an explanation. Do not accept changed matches automatically. A successful check creates the existing durable binding; projectless approval instead becomes `ready` after the same freshness check.

Catalog freshness retains the existing semantic revision behavior: a different scan timestamp alone does not invalidate approval. Initial resolution proposes saved defaults; subsequent resolution preserves still-valid explicit branch and brief selections instead of replacing them with newer defaults.

Preserve the existing binding guarantees: resolve each approved ref once, record its commit before snapshot work, and retry already recorded commits without replacing them with newer tips. Brief versions are fixed at approval. Approval covers the selected branch; the exact task commit is the one recorded during binding, not an implicit promise to use the earlier scan's branch tip.

## Saving, background work, and concurrency

### Fast durable capture

The HTTP capture handler validates and atomically writes the existing idempotent submission receipt, including the review policy and structured text, then returns `202` with the stable submission ID. It must not wait for discovery, project details, binding, or the long-running intake scan queue.

Separate receipt mutation serialization from intake traversal. The receipt is the recovery authority: if the process stops after capture but before creating its pending record or publishing its Markdown, the next pass completes those steps from the receipt. Unreviewed HTTP submissions must retain their policy when rediscovered through a filename or intake receipt; a recovery path must never treat them as automatically accepted filesystem drafts.

Use short serialized persistence transitions for submission state. Read an input revision and attempt, perform slow work outside the persistence lock, and commit its result only if that revision and attempt remain current. List, save, edit, and approval requests must not queue behind filesystem scans or snapshot work. The original capture receipt remains immutable for idempotency; later text edits live in the versioned pending record and supply the final task content.

### Worker integration

Project services own the background resolution pass using their existing tick/lifecycle pattern. Intake's project gate registers or reads a pending submission and returns its current disposition promptly; it does not run discovery inline. Slow project work must not delay unrelated task scheduling, workspace reads, or new captures.

Process a bounded number of submissions with one active resolution pass at a time initially. Coalesce overlapping root refresh requests for the same root/settings revision. Never reuse a scan from an older root generation after settings change, and do not publish obsolete results. Catch failures per submission so the next queued idea can proceed.

Use the existing configured `projectGitTimeoutMs` as the whole resolution-pass time budget as well as retaining per-command limits. Timeout handling aborts supported underlying work and prevents late results from mutating state. Discovery traversal checks cancellation between filesystem operations; do not merely race an uncancelled scan against a timer and accumulate abandoned work. A timeout leaves a retryable failure with the saved idea intact.

Startup loads durable submission/catalog state and schedules discovery through background work rather than awaiting a full root scan before serving capture requests. Interrupted `resolving` work is requeued; interrupted `validating` work resumes the saved approval check. Existing durable binding operations resume through their current recovery mechanism.

Shutdown stops accepting worker passes and quiesces or cancels active work before releasing the host lock. Crash recovery rejects obsolete attempt results and uses idempotent operation IDs to reconcile any binding or task already created before a state transition was saved.

### Matching freshness

Remove project matching from capture. Review presents a persisted proposal. Lightweight previews, where still needed by existing controls, resolve against the saved catalog without rescanning on each keystroke; label their freshness and preserve revision checks. Explicit refresh and background approval validation perform discovery. Forward abort signals for both GET and POST requests, while relying on server revision/attempt checks for correctness rather than browser cancellation alone.

## Interfaces and ownership

- `shared/projects.ts` owns the versioned submission states, summaries, review inputs, and approval data shared by browser and server. `WorkspaceView` adds pending submission summaries without changing task workflow states.
- `server/intake/intake.ts` owns durable capture receipts, request deduplication, Markdown publication, and exactly-once task pickup. It preserves HTTP review policy through recovery.
- `server/intake/project-drafts.ts` owns pending state transitions, revisions, saved edits, approval/retry idempotency, and the fast intake gate. Extract focused worker code if needed to keep state transitions separate from discovery orchestration.
- `server/projects/service.ts` coordinates background resolution, catalog refresh, and the existing binding service. `binding.ts` continues to own approved snapshot/context preparation.
- `POST /api/drafts` retains its receipt response and accepts structured draft text. New HTTP submissions require review server-side; an older client's optional `projectDraft` is a proposed selection, not proof of approval.
- Existing submission list/detail reads return current persisted state. Add a revision-checked edit/refresh operation and a retry operation. The existing submission `/resolve` action becomes explicit approval: validate the submitted review against persisted state, journal it, and return `202` without awaiting discovery. Retain request-ID conflict semantics.
- `NewTaskDialog` and `useWorkspace` handle capture and the immediate receipt. `App` renders durable workspace notices and opens a submission by ID. `ProjectSubmissions` and reusable project selection controls implement review, setup links, editing, and status refresh.

The implementation plan will define the exact request/response types and route shapes before coding. These boundaries and externally visible semantics are fixed by this spec.

## Compatibility and failure handling

Version existing pending records on read. Records with a ready result or an existing binding continue their previously accepted lifecycle. Legacy unresolved records remain available for manual resolution; do not retroactively approve them or duplicate their receipt. New mandatory-review policy applies only to captures journaled under the new HTTP behavior. Filesystem/phone intake retains its defaults policy and no-project acceptance behavior.

Request IDs deduplicate capture, edits, refresh, approval, and retries. Reusing an ID with a different payload is a conflict. Recovery must reconcile the gap between approval and binding creation and the gap between task creation and marking the submission accepted.

Unavailable roots, missing branches/briefs, ambiguity, timeouts, and snapshot failures are distinct from “no projects matched.” Each retains the idea and a useful next action. Setup and resolver failures do not mark the whole coordinator unavailable. Storage failures that prevent durable capture keep the popup open; storage failures after capture remain visible as service issues and recover from the receipt.

## Verification and acceptance

Use deterministic deferred work and temporary filesystem fixtures, not elapsed-time guesses or real company repositories.

1. Hold discovery indefinitely and verify capture returns its durable receipt, the dialog closes, a second idea can be saved, workspace reads respond, and unrelated scheduling continues.
2. Verify typing in capture does not call resolve/catalog/detail, and a save failure preserves entered fields and supports an idempotent retry.
3. Exercise matching, missing setup, ambiguity, failure, and no-project results. Every new HTTP idea remains unpublished until explicit approval; filesystem/phone policies remain intact.
4. Verify persistent notices update without visiting Projects, open the correct submission, survive reload, and disappear only when the corresponding task is durably published.
5. Verify review edits persist, reset dependent choices correctly, invalidate obsolete work, and retain valid explicit selections. Polling must not overwrite unsaved edits.
6. Verify approval responds while validation is held, changed catalog/root revisions require fresh review, and malicious or obsolete approval payloads cannot bypass the gate.
7. Restart after each durability boundary: capture, resolution start, approval, binding creation, recorded commit, task creation. Resume the correct phase without losing content or duplicating a task.
8. Verify scan coalescing, cancellation/timeout, root changes during a scan, stale attempts, and multiple queued ideas. A failed idea cannot starve later work.
9. Verify binding retries keep recorded commits and chosen brief versions and preserve all existing read-only context guarantees.
10. Run relevant unit, API, intake, coordinator, and UI regressions, then the complete test suite and builds. Browser-check capture, background progress, review, retry, and narrow-screen navigation with a disposable fake environment.

The acceptance criterion is a working end-to-end sequence: **Save idea → leave the popup → see background progress → review projects → approve → investigation becomes eligible**, with the same guarantees after reload and restart.
