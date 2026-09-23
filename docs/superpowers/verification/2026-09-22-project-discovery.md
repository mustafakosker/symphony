# Project discovery verification

Implementation branch: `codex/project-discovery`, based on `2fa404e`.

- Full suite: 527 passed, one existing skip (70 files); UI and server builds passed.
- Public API integration: target-plus-reference and reference-only drafts, generated briefs sharing coordinator capacity, dirty/untracked exclusion, workflow approval, bounded citations, hidden internal jobs, restart, and preserved historical commits.
- Browser (Chrome, disposable fake preview): global root save/clear, canonical path handling, discovery, alias edit, preparation, generated brief, source evidence, alias target/reference matching, reference removal/restoration, task pickup, read-only workflow approval, pinned context, both report citations, 390px source dialog, Escape and focus restoration, historical citations after root clearing, disconnected state, and reconnect after preview restart.
- Regression fixes from verification: canonical initial root aliases with redirection detection; asynchronous scheduler-slot cleanup in the concurrency test; connected report rendering in review panels; explicit retries using original pinned commits; internal job failure isolation; stale brief comparison preserving edits.

## Final code review and fixes

A fresh reviewer assessed the whole branch and found seven Important issues, with no Critical findings or deferred minors. Ten regression cases reproduced the failures before their fixes; expanded focused coverage passed 47 tests, followed by the full 527-pass suite and successful UI/server builds. No second reviewer was used.

- Discovery now refreshes at every startup and before accepting new bindings. A replaced repository invalidates an old preview; accepted journals retain their original context.
- An optional empty title gets a nonempty task title without changing the title/description used for matching.
- A failed configuration replacement retires its intent when the original bytes remain, preserving readable settings and genuine crash recovery.
- Editing an existing brief retains its originating snapshot and citations after newer preparation.
- Aggregate binding applies host-configured limits, including overrides above the defaults.
- Automatic detail refresh preserves the project form's edit-base revision. Conflicts retain edits and expose saved values for comparison before explicit rebasing.
- An unset root bypasses discovery prefix matching, retaining both UI and filesystem legacy intake.

## Real-host acceptance remains outstanding

The real `codex-cli 0.155.1` probe ran against disposable repositories and owned snapshots, with no company repositories involved. The production access verifier refused launch because no `verifiedProfilesPath` containing compatible snapshot profiles was configured. Source tree digests remained identical. Agent reads, attempted write denials, combined read-scope isolation, external-tool restrictions, returned citations, and an OS-enforced read-only root were **not verified**. Unattempted writes were recorded as unattempted, never as denied. Fake-runner checks do not establish real confinement.

The feature keeps unverified projects in **Needs setup**. The diagnostic script does not provision a scope mechanism or install an attestation. Host configuration/provider verification is required before claiming the real investigation path is usable.

## Execution decisions

1. Used the approved isolated-workspace plan as authorization to create the development worktree; the implementation remains on its own branch.
2. Introduced the shared Git reader during discovery to avoid a second command policy.
3. Imported the selected commit and complete tree/blob graph, excluding unrelated ancestor history. Future history browsing requires additional imports.
4. Added a narrow operation retry endpoint because retries must retain journaled commits; this adds one API operation beyond the plan's route table.

5. Real-host confinement and investigation remain unverified. Keep the fail-closed setup requirement; operational use waits for deployment verification.
6. No maximum-size performance claim is made. Inputs remain bounded and verified; representative profiling may reveal unacceptable large-catalog/snapshot latency.
7. A step may reuse valid citations from other bound snapshots through accepted research artifacts. Direct reads still require its exact selected scope. A stricter evidence-chain requirement would need additional provenance linkage.

## Main integration verification

Merged with the phone-draft intake feature on main. Intake options retain both phone opt-in and project binding; an application-level regression proves unresolved phone project mentions stay pending and that resolving them publishes the task and advances the numbered template.

Full-suite verification exposed an artifact read racing a terminal task-directory move. A deterministic regression failed with a missing artifact, then passed after reads joined the per-task serialization queue. The test runner now excludes sibling `.worktrees`, and real-Git service integration fixtures have a bounded 15-second timeout for concurrent suite load.

Final merged-tree verification: **544 passed, one existing skip (72 files)**. UI and server builds passed. Real-host acceptance remains outstanding as described above.
