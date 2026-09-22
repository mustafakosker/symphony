# Project discovery verification

Implementation branch: `codex/project-discovery`, based on `2fa404e`.

- Full suite: 514 passed, one existing skip (70 files); UI and server builds passed.
- Public API integration: target-plus-reference and reference-only drafts, generated briefs sharing coordinator capacity, dirty/untracked exclusion, workflow approval, bounded citations, hidden internal jobs, restart, and preserved historical commits.
- Browser (Chrome, disposable fake preview): global root save/clear, canonical path handling, discovery, alias edit, preparation, generated brief, source evidence, alias target/reference matching, reference removal/restoration, task pickup, read-only workflow approval, pinned context, both report citations, 390px source dialog, Escape and focus restoration.
- Regression fixes from verification: canonical initial root aliases with redirection detection; asynchronous scheduler-slot cleanup in the concurrency test; connected report rendering in review panels; explicit retries using original pinned commits; internal job failure isolation; stale brief comparison preserving edits.

## Real-host acceptance remains outstanding

The real `codex-cli 0.155.1` probe ran against disposable repositories and owned snapshots, with no company repositories involved. The production access verifier refused launch because no `verifiedProfilesPath` containing compatible snapshot profiles was configured. Source tree digests remained identical. Agent reads, attempted write denials, combined read-scope isolation, external-tool restrictions, returned citations, and an OS-enforced read-only root were **not verified**. Unattempted writes were recorded as unattempted, never as denied. Fake-runner checks do not establish real confinement.

The feature keeps unverified projects in **Needs setup**. The diagnostic script does not provision a scope mechanism or install an attestation. Host configuration/provider verification is required before claiming the real investigation path is usable.

## Execution decisions

1. Used the approved isolated-workspace plan as authorization to create the development worktree; the implementation remains on its own branch.
2. Introduced the shared Git reader during discovery to avoid a second command policy.
3. Imported the selected commit and complete tree/blob graph, excluding unrelated ancestor history. Future history browsing requires additional imports.
4. Added a narrow operation retry endpoint because retries must retain journaled commits; this adds one API operation beyond the plan's route table.
