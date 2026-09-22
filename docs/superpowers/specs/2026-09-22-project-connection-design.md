# Project connection and useful code context

## Status and intent

The user approved the connection flow and context design in conversation on 2026-09-22, selected committed code rather than working-tree changes, and requested read-only connected repositories. This specification incorporates those decisions. Written-specification review and implementation planning remain pending; no product implementation is authorized by this document alone.

Symphony should turn a broad request such as “Improve onboarding” into a proposal grounded in the user's application. A user connects a repository once, maintains an editable project brief, and chooses that project for a task. Agents investigate the selected code and cite the files behind their findings.

Success means that connecting and using a project is available through the application; the task's code and brief remain reproducible; the connected repository is read-only to agents; and the user can inspect the evidence behind a proposal.

## Approved scope

- A reusable project library with one Git repository per newly connected project.
- Connect an existing local Git folder or clone an HTTPS/SSH repository using the host's existing Git authentication.
- Choose a project default branch and override the branch when submitting a task.
- Generate and edit a project brief covering architecture, conventions, and test commands.
- Pin each new connected task to an exact commit and an immutable brief version.
- Investigate committed source and publish reports with source citations that open in Symphony.
- Keep connected tasks read-only, including their initial triage, research, writing, and review assignments.
- Preserve existing projectless intake, task history, review approvals, and legacy configured-project behavior.

The first release attaches a project when a task is created. Rebinding an existing task, supporting multiple repositories through the new connection UI, arbitrary non-Git folders, working-tree changes, automatic repository indexing, OAuth account setup, code implementation, PR creation, merge, deployment, and executing project test/build/install scripts are outside this feature. Existing legacy multi-repository or mutating workflows retain their existing policy and are not converted into connected projects automatically.

## User experience

### Project connection

Add Projects and Connect project to the workspace navigation, using the approved Symphony UI design. The UI implementation is in the separate `codex/linear-ui` worktree at specification time; integrate with its sidebar, task page, and shared components when that work lands rather than introducing a second presentation system.

1. Choose Local folder or Clone repository. The folder chooser browses directories on the coordinator's host and accepts an absolute path. It does not upload a browser-selected directory. The clone form accepts the repository URL and a display name; Symphony chooses its managed destination.
2. Validate the Git source and list branches. Preselect the local repository's current branch when it exists, or the remote's declared default branch for a clone. Otherwise require a selection; do not guess `main` or silently choose another branch. Detached local HEAD is acceptable when another named branch can be selected; an empty repository has no usable committed context.
3. Save the connection and check agent access. The project page distinguishes Connected from Agent access ready. A usable Git URL/path is not evidence that the agent's execution profile has been verified.
4. When read-only agent access is ready, generate the first brief from the selected branch's exact commit. Show progress, the source commit, and an editable result. The first successfully generated brief becomes the current version without introducing an extra approval checkpoint. Its generated provenance remains visible.
5. The project becomes selectable for a task after it has verified read-only access and a saved brief. A user can write a brief manually if generation fails; that does not bypass the access requirement.

The user can rename a project, choose its default branch, edit the brief, refresh available branches, and retry failed preparation. Source identity is fixed: connecting a different folder or remote creates a different connection. Removal and automatic repository cleanup are outside this slice, so saved task evidence is retained.

### Task creation and task page

New task adds an optional Project selector and, when selected, a Branch selector. Projectless submission remains available. The selected branch and brief version are part of the submission, not instructions embedded into the idea text.

On the first accepted submission, the server resolves the selected branch once and durably journals that commit and the exact brief version selected in the form before starting snapshot preparation. It imports the committed snapshot and completes the context record before intake can dispatch triage. A newer library brief does not silently replace the selected version. A retried request uses the already bound commit and brief even if the branch or library changes. Reusing a request ID for different input is a conflict.

The task page shows project name, selected branch, abbreviated commit, brief version, and Read-only access. Opening the brief shows the exact version saved with this task. A brief generated from another commit is marked as based on that earlier commit; it remains usable as guidance, and agents must verify code claims against the task snapshot. Regeneration is offered before a future task is submitted, not imposed during an existing task.

Initial task binding cannot be changed by triage or later workflow proposals. An agent can ask the user about a mismatch, but cannot silently select another project, branch, commit, or brief. Using different context requires a new task in this release.

## Read-only boundary and committed snapshots

There are two distinct authorities: the coordinator prepares its own storage, and agents investigate code. The coordinator may write clones, snapshot material, project records, briefs, and task artifacts into Symphony-owned locations. Agents receive only read actions for connected tasks. Connecting a repository never authorizes agents to modify that source or a copy of its code.

For a local folder, canonicalize and validate the Git source, then import committed Git objects into Symphony-owned storage. Do not switch its branch, modify its index, create a worktree in its Git metadata, fetch into it, install dependencies, execute its scripts, or alter its working files. Locally changed, staged, ignored, and untracked working-tree content is excluded; tracked bytes come from the chosen commit. Git inspection/import must avoid optional source locks and automatic maintenance that would mutate the user's repository.

Remote cloning and explicit refresh update only Symphony's managed object store. Do not push, execute hooks, check out through repository-provided filters, or recursively initialize submodules. Authentication uses the host's existing approved Git mechanisms; embedded credentials in clone URLs are rejected and sensitive Git diagnostics are redacted before persistence or display.

Materialize a plain, committed file snapshot from that owned object store, with a manifest binding repository ID, commit, relative paths, object identities, and content digests. Agents receive the selected snapshot path, not the user's live checkout or the object store. Do not reuse `prepareCheckout`, which creates writable task branches and modifies source worktree metadata.

Materialization handles Git entries deliberately: regular tracked files are copied; symbolic links are represented as inert link metadata and never followed; submodules are listed with their pinned object IDs but not traversed; LFS pointers are identified as pointers without downloading external objects. Binary or invalid-UTF-8 files may exist in the snapshot but are not accepted as text line citations. Exceeding configured snapshot byte/file limits fails preparation visibly rather than silently omitting regular files. The user-facing limit values and unsupported entries must be reported.

Default preparation limits are 100,000 entries, 1 GiB of total materialized content, and 64 MiB for an individual regular file; positive host settings can override them. Git subprocesses have a preparation timeout and bounded diagnostic capture. Brief text is limited to 128 KiB of UTF-8, with at most 256 citations per brief or report. Existing aggregate assignment-input and report-output limits still apply and are checked before dispatch/publication rather than truncating saved context.

Verify the manifest before dispatch and before serving citations. A missing or altered snapshot blocks that context and may be rebuilt only from the same retained Git objects; branch movement never authorizes replacement with a different commit. Keep snapshots and owned objects referenced by tasks or brief versions. There is no automatic deletion of referenced context in this release.

Enforce connected-task actions exactly as `['read']` when accepting an initial workflow, accepting a revised workflow, and launching after normal scheduling or recovery. Reject write-local, open-pr, merge, and deploy actions for these tasks even if a configured role supports them or the user approves the proposed workflow. The runner uses a verified read-only profile and supplies no writable repository directory. Agents return report text; the coordinator persists it through the existing artifact mechanism.

Read-only execution is a write restriction, not by itself an operating-system read allowlist. The feature must not claim stronger host isolation than has actually been verified. Scope verification must cover the configured tools and actual snapshot access mechanism; a prompt instructing the agent to use a path is not a capability proof. Project code, scripts, and tests are not executed by this flow. Test commands in the brief are discovered recommendations and are labeled Not run.

## Project brief and investigation

A brief contains these editable sections:

1. Application purpose and major entry points.
2. Architecture and responsibilities of important directories/components.
3. Repository conventions, using explicit repository guidance where present and labeling inferred conventions.
4. Test, build, and validation commands, their working directories, and where they were discovered.
5. Areas not inspected, unsupported source entries, and other limits of the generated description.

Generation is a bounded read-only assignment using the verified researcher role and the same snapshot/citation rules as task investigation. It first examines repository documentation, manifests, test configuration, and representative source files. It reports what it found and what remains uncertain. Repository text cannot grant actions beyond the assigned read-only policy.

Brief saves use an expected revision and create immutable versions. Each version records its text digest, author kind (generated, human, or human-edited), originating snapshot, source citations, and timestamp. A manually authored first brief binds to a prepared snapshot of the project's selected branch; human prose is not thereby labeled as verified source evidence. A rename or edit does not erase provenance. Regeneration creates a separate candidate for comparison; it never overwrites a saved human edit. The user explicitly saves the candidate when replacing the current brief. Concurrent edits produce a conflict while retaining the unsaved text.

A task carries a durable copy of its selected brief text and citation metadata, identified by version and digest. Later library changes do not affect queued, running, retried, or completed tasks. Brief citations continue to open their own originating snapshot; investigation citations open the task's selected snapshot. The UI makes differing commits visible rather than presenting old brief evidence as current task evidence.

Connected-task triage receives the brief and the pinned repository context immediately. It proposes a read-only workflow that includes code investigation before application-specific recommendations or a PRD. Research follows relevant entry points, related implementations, and tests; its report distinguishes observed behavior, inferred conclusions, proposed changes, and missing evidence. Subsequent writers and reviewers receive the accepted research artifacts and cite or recheck the relevant source.

## Citations and source viewing

Citations are structured data, not arbitrary agent-provided file URLs. Each citation has an ID, repository ID, exact commit, normalized repository-relative path, file object/content identity, and inclusive one-based start/end lines. Report text refers to those IDs next to the claims it supports. Citation IDs and text are persisted together as a versioned output; editing a brief cannot silently retarget an existing citation.

Before publishing a report, validate that every referenced citation belongs to the allowed snapshot, names a regular text file, matches its stored identity, and specifies existing lines in ascending order. Reject absolute paths, traversal, unknown citation IDs, symlinks, missing files, incorrect commits, and invalid line ranges. Invalid evidence must be corrected or the assignment blocked; it is not published as a successful grounded report. A report may state that relevant code was not found, but must identify that as an evidence gap rather than invent a citation.

The source viewer is a read-only, bounded text preview addressed through the task/report or brief version and citation ID. The server derives the allowed snapshot and file; clients cannot supply arbitrary filesystem paths. Show the repository name, path, commit, line numbers, and highlighted range. Limit an individual cited range to 1,000 lines and 256 KiB of text, and validate that it can be displayed before accepting the citation. Return that range with surrounding context within the same response cap, rather than loading an entire large file into the browser. Escape file contents and preserve them as literal text. A file that cannot be displayed has an explicit unavailable/unsupported state.

Validating a citation establishes that the reference points to real snapshot bytes. It does not establish that those bytes prove the author's interpretation; the reviewer and user assess that connection. Unstructured Markdown links do not receive the source-citation treatment.

## Architecture and persistence

Keep the existing sequential coordinator, review workflow, task store, and runner. Add focused services with these responsibilities:

| Unit | Responsibility and boundary |
| --- | --- |
| Project catalog | Own live connection records, revisions, default branch, and readiness; expose validated reads/writes without server restart. |
| Git source and snapshot service | Inspect selected sources, own clones/imported objects, resolve branch to commit, materialize/verify snapshots, and serve bounded source bytes. Does not launch agents. |
| Access verifier | Check the selected role/profile and snapshot scope against actual host verification evidence; return ready, needs-setup, stale, or failed. Does not infer permission from a connection record. |
| Brief service | Schedule bounded generation through the coordinator, version human/generated text and citations, and retain provenance. |
| Task-context binding | Bind the submission to project, repository, branch, commit, snapshot manifest, and brief version/digest; preserve that identity through intake, replay, and runs. |
| Citation validation | Resolve structured references against allowed immutable snapshots before publication and when serving previews. |
| Project UI | Connect/manage projects, show readiness and brief edits, select task context, and inspect source references. |

New project records, clone objects, snapshot manifests, job journals, and brief history live beneath the host-local runtime root in dedicated project directories. They are not stored in the connected repository or browser storage. Local source folders must be outside the task-store and managed runtime trees, with canonical-path checks against overlap and redirection. Host-local storage is consistent with the current single-coordinator deployment; this feature does not introduce multi-host project portability.

The live catalog is separate from legacy `projects/projects.json`. Keep existing registry parsing and verification for legacy projects. Use distinct IDs across the two catalogs and reject collisions. New project names may be edited without changing the immutable repository identity or invalidating unrelated profiles. Existing tasks/events retain their historical meaning.

Extend the task contract with immutable connected-context metadata and the exact saved brief. Accept existing schema-version-1 records unchanged; newly created connected records use an explicitly versioned schema that is understood by the parser, store, event replay, and UI. Do not backfill historical task commits or rewrite immutable events. New context metadata is part of task creation's durable intent and digest, not a loosely associated mutable library pointer.

Draft submission gains a structured optional project/branch/brief selection. For connected submissions, persist an idempotent preparation journal before publishing the draft to intake. Intake must recover the validated context by submission identity and bind it during task creation; raw Markdown cannot forge context metadata. A crash before intake publication can resume preparation, and a crash after publication must replay the same bound context and task receipt. Existing filesystem Markdown submissions continue to use their current intake path without requiring front matter.

Project mutations and brief saves use request IDs and expected revisions. Clone/import, access verification, and generation expose durable operation status rather than holding an HTTP request open for an agent run. Generation uses the coordinator's global scheduling limit and process lifecycle support; it does not create an uncontrolled second runner. Browser disconnect leaves durable background work observable after reconnect. An interrupted operation remains resumable or explicitly retryable and never appears ready by assumption.

The HTTP layer adds project listing/detail, host directory selection, connection operations, branch listing/refresh, brief history/edit/generate, readiness checks, and citation previews. Existing loopback/origin checks and bounded JSON handling apply. Directory selection returns directory metadata, not general file contents. The source-preview API is restricted to persisted authorized citations.

## Capability integration

The current registry is read once at startup, and existing capability attestations hash the whole projects file and match exact repository source paths. Simply editing that file in a UI would leave running catalog state stale and invalidate profiles. Per-task snapshot paths also do not match the current source-path access contract.

For new connected projects, introduce an explicit snapshot-access scope instead of changing or bypassing legacy scope matching. Its identity includes project/repository ID, canonical Symphony-owned snapshot root, read-only role/profile policy, CLI version, allowed actions/environment, configuration and selected-skill digests, and recorded verification evidence. Each assignment additionally binds a manifest-verified snapshot underneath that project's scope. Caller-supplied paths cannot enlarge or redirect it. Brief text, display names, and default branches are content/settings, not execution-policy grants.

Before an assignment launches, require exactly one matching verified read-only profile for the selected scope and unchanged execution policy. Verification must cover repository/snapshot write denial, task-store write denial, unrelated repository/tool access restrictions required by the deployment, and denial of write-capable external tools such as merge/deploy. Plain `read-only` sandbox selection, a successful clone, recomputed digests, or fabricated check labels cannot substitute for these probes.

The connection UI exposes Check agent access and readable recovery guidance. A supported host verifier can validate an existing compatible profile and run the required disposable probes. If the host has no compatible scoped profile or verification provider, the connection remains saved in Needs setup and the UI explains the host configuration required. It must not mark the project ready or generate a brief using an unverified fallback. This specification does not promise universal automatic CLI isolation provisioning; actual host verification is an acceptance requirement for the real happy path.

Adding an unready project must not stop unrelated ready projects or prevent the application from opening. Policy changes invalidate the affected scope and block its next launch; content-only brief/name changes do not require re-verification. The legacy attestation path remains strict for legacy assignments. No new write-enabled profile is provisioned by this feature.

## Failure and recovery behavior

| Failure | Required behavior |
| --- | --- |
| Invalid folder, non-Git folder, inaccessible source, or empty repository | Show the specific connection error and retain form values. |
| Clone authentication/network failure | Preserve the connection operation and offer retry; redact credentials; partial objects never count as a ready snapshot. |
| Missing selected branch | Stop preparation and request another selection; never fall back silently. |
| Branch advances or is deleted after successful binding | Continue using retained committed objects and the exact bound snapshot. |
| Missing/stale access verification | Keep the project visible in Needs setup; block agent work for that scope with actionable guidance. |
| Brief generation failure or timeout | Preserve any current brief and expose retry/manual editing; do not present partial generated text as the current saved version. |
| Concurrent brief edit | Reject the stale save, retain unsaved text, and offer reload/compare. |
| Invalid citation | Reject the report before successful publication and surface a correctable evidence error. |
| Snapshot corruption or lost owned objects | Block affected work/viewing; restore only the same commit and verified bytes, never a newer branch tip. |
| Restart during preparation or generation | Recover from persisted operation identity and existing process lifecycle rules; do not duplicate connections, submissions, or successful versions. |

## Verification and acceptance

Implementation tests must demonstrate behavior, including:

- Local source files, index, branch, and Git metadata remain unchanged through connection, refresh, brief generation, and task investigation. Dirty/staged/untracked local content never enters the snapshot.
- A moving branch resolves once per submission; retries, subsequent steps, and restarts use the original commit and brief. Reused request IDs cannot change the selection.
- Connected-task triage cannot overwrite the project binding, and initial/revised workflows cannot introduce writes, other repositories, or mutable context. Dispatch rechecks the same constraints after recovery.
- New catalog changes are visible without restart; malformed/unready connections do not disrupt unrelated work. Legacy task loading, event replay, projectless intake, and profile enforcement remain compatible.
- Snapshot materialization handles symlinks, submodules, LFS pointers, large/binary files, path redirection, and altered manifests as specified.
- Generated brief versions retain provenance, manual edits survive regeneration failures and concurrent saves, and existing tasks keep their original copied context.
- Citations reject traversal, unknown IDs, wrong commits/files/identities, and nonexistent line ranges; source previews display the pinned bytes and escape content.
- Interrupted clone/import/generation and intake handoff recover without duplicate successful operations or tasks.
- Access checks exercise the new snapshot scope and refuse unverified/stale/mutating profiles; fake-runner tests are not represented as proof of real CLI confinement.

Run the relevant focused tests during implementation, then `npm test -- --run` and `npm run build`. Use disposable repositories and the fake coordinator for browser checks covering local connection, clone progress/failure, branch selection, access pending/ready, brief generation/edit/regeneration, task creation, fixed context display, and citation navigation. Check keyboard access, narrow screens, and disconnected states using the established UI components.

Before claiming the real read-only path works, run genuine host capability probes and a real investigation against a disposable repository containing committed and dirty sentinel content. Confirm the agent cannot write through its permitted tools, returned citations resolve to the pinned commit, and the source repository is unchanged. Do not use the user's company repositories as test fixtures. If host verification is unavailable, report that limitation; passing fake tests alone does not complete this acceptance condition.

## Existing implementation anchors

- [Project registry](../../../server/config/registry.ts): current static projects, repository paths, and ref rules.
- [Application startup](../../../server/main.ts): startup registry load and capability checks.
- [Repository workspace](../../../server/repos/workspace.ts): current ref resolution and mutable worktree preparation.
- [Coordinator](../../../server/coordinator/coordinator.ts): project lookup, live ref resolution, staging, and dispatch.
- [Repository access](../../../server/codex/repository-access.ts) and [capability verification](../../../server/codex/capability.ts): current access/path validation and attestation boundaries.
- [Prompt](../../../server/codex/prompt.ts) and [result schema](../../../server/codex/result-schema.ts): assignment context and currently unstructured evidence.
- [Contracts](../../../shared/contracts.ts), [validation](../../../shared/validate.ts), [intake](../../../server/intake/intake.ts), and [task store](../../../server/store/task-store.ts): context binding, schema compatibility, and replay.
- [Approved UI specification](2026-09-22-linear-inspired-ui-design.md): presentation system and navigation integration.

## Review handoff

The next step is user review of this written specification. After approval, use the writing-plans skill to create a concrete implementation plan, including supported-host capability verification and the UI integration dependency. Implementation begins only after that plan has been reviewed and its execution method selected.
