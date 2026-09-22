# Read-only project discovery and investigation context

## Status and intent

The user approved automatic project matching and the target/reference distinction on 2026-09-22, then specified a dedicated read-only projects root configured in global settings. This revision replaces the earlier individual-folder/clone connection flow and single-project-per-task restriction. The user approved this written specification on 2026-09-22. The implementation plan is prepared for review; execution-method selection and implementation remain pending.

Symphony investigates repositories to produce grounded findings, designs, and implementation plans. A leading `[project-name]` in the task title identifies where changes are intended in a later implementation phase. Project names mentioned elsewhere select reference repositories. Without a title prefix, matched projects are references only; the system does not infer a change target. All repositories remain read-only in this phase, including the future change target.

The user supplies a dedicated folder of maintained project copies, ideally separate from their everyday `~/projects` development folder. Symphony resolves project names from that root. Success means that users configure the location once, tasks automatically find the relevant repositories, and plans preserve the target/reference distinction with inspectable evidence from fixed commits.

Design choices for this revision: discover immediate child repositories, use their directory names as canonical matching names, and leave cloning/updating those copies to the user or an external process. These choices keep discovery predictable and respect the root's read-only boundary. Symphony does not guarantee that a local copy is current with its remote.

## Scope

- One optional global projects root, configured through the application and persisted on the coordinator host.
- Discover one Git repository per immediate child directory; editable aliases and project briefs are saved in Symphony storage.
- Automatically resolve zero or one future change target and zero or more references from task text.
- Choose a default branch per project and allow task-specific branch selection.
- Pin every selected repository to an exact commit and immutable brief version.
- Investigate committed source and publish findings, designs, and implementation plans with source citations.
- Keep connected-task triage, research, writing, and review read-only.
- Preserve projectless intake, task history, artifact reviews, and historical legacy configured-project behavior.

Remote connection forms, cloning, fetching/pulling, scheduled synchronization, recursive repository discovery, arbitrary non-Git folders, working-tree changes, automatic source indexing, execution of repository scripts/tests, source implementation, PR creation, merge, and deployment are outside this feature. Rebinding an accepted task requires a new task. Legacy workflows retain their existing policy; they are not automatically converted into root-discovered tasks.

## Global settings and discovery

Global Settings exposes **Projects root folder**, its saved canonical path, validation status, and **Rescan projects**. The user enters an absolute directory path on the coordinator host. There is no default pointing to `~/projects`, no automatic directory creation, and no browser upload. An unset root leaves projectless use available. Copy explains that the folder holds externally maintained repository copies and that Symphony only reads it.

Add nullable `projectsRoot` to host settings, defaulting to null for existing configurations. A narrow settings service reads and atomically updates that field in the existing host configuration file, using a revision/digest precondition and preserving all other settings. The API exposes only the project-root setting and related status, not the whole host configuration. Saving applies discovery configuration live without requiring restart; it does not reload unrelated process settings. An unwritable configuration file produces an actionable save error and leaves the previous setting active.

Validate that the root exists, is a readable/searchable directory, and is canonically disjoint from both `workspaceRoot` and `localRoot`, including ancestor overlap. The writable host configuration file must also be outside this root. Symphony does not change permissions or require that the OS itself has marked the folder unwritable: read-only describes Symphony's access contract. Revalidate canonical containment before importing a source, so a replaced folder or symlink cannot redirect access outside the saved root.

Discover immediate, non-symlink child directories that are standalone, non-bare Git repositories with their Git metadata inside that child. Verify the repository top level equals the child: a plain directory nested in an enclosing repository is not a project. Do not recurse, follow directory links, accept linked worktrees with external Git metadata, or use external Git object alternates. Ineligible entries appear with an explanation in discovery results; they do not stop other projects from being discovered. Empty repositories remain visible but unusable until they contain a commit.

The child directory basename is its canonical matching name. Optional aliases and display labels are stored outside the source. Normalize names/aliases with Unicode NFC, trimmed whitespace, and case-insensitive comparison. Prevent newly saved aliases from colliding with another project's names; if discovery introduces a collision, mark it ambiguous rather than choosing arbitrarily. Renaming a display label does not silently change matching names. Renaming a source folder creates a new discovery identity in this release.

Scan when a root is saved, at startup, on explicit rescan, and before accepting a new submission. Scans read directory/Git metadata only; they do not generate briefs or investigate all repositories. Assign stable IDs within a root generation. Changing or clearing the configured root retires its catalog for future submissions and creates a new generation; old task contexts and evidence remain retained. A removed/unreadable source is unavailable for new bindings, while existing tasks can continue using their owned snapshots. A stale task-creation preview must be refreshed before its changed project binding can be accepted.

The Projects page lists discovered names, aliases, default branches, last observed commits, last scan times, brief versions, and readiness. “Last scanned” does not imply remote freshness. Rescan never runs fetch, pull, checkout, hooks, or repository scripts.

## Automatic task matching

Use a deterministic resolver shared by UI preview and server intake. It operates on the user's submitted title and description, never an agent-rewritten title. UI submissions preserve the explicit title as structured input. For filesystem drafts, use the first nonempty line when it is a level-one Markdown heading; otherwise use the filename stem as the title. The remaining text supplies the description. No front matter is required.

After trimming title whitespace, a single leading `[name]` identifies the future change target. Resolve it exactly against canonical names and aliases. Unknown, ambiguous, malformed, or multiple leading bracketed targets require correction/clarification before repository investigation. Do not silently discard the prefix or promote a reference instead.

Find names and aliases in the remainder of the title and in the description using the same normalization and complete-name boundaries. Letters, digits, underscores, and hyphens count as name characters, so `shop` does not match `workshop` or `shop-api`. Match the longest complete name first when candidate spans overlap; do not also select a shorter nested name. Preserve punctuation inside names. This is lexical matching, not model-based interpretation of intent or fuzzy spelling correction. A literal occurrence in a negation, quote, or code sample still matches and can be removed in the preview.

Each matched project becomes a reference unless it is already the target. Deduplicate by stable project ID. With no prefix, all matched projects are references even if only one matches. With no matches and no prefix, submit a projectless task. Ordinary unrecognized words do not create missing-project errors. An ambiguous recognized mention requires clarification; the user can select its intended project or exclude it as a reference. Unknown explicit targets remain errors, with guidance to put the repository under the root and rescan or correct the name.

Task creation displays **Future change target** and **Reference projects** as the user types, including the matching text behind each selection. References can be excluded before submission. Exclusions and ambiguity resolutions are explicit draft metadata tied to the text and catalog revision; edits recompute the preview and require re-resolution when those inputs change. Users correct a target through its title prefix. The task dialog links to global root configuration and the discovered-project list rather than offering local-folder or clone connection actions.

The server recomputes and validates resolution, exclusions, and choices at submission, using the current catalog revision. A changed selection returns a conflict with the new preview while preserving draft text; it is never silently substituted. Filesystem drafts run through the same resolver without UI exclusions. An unresolved filesystem draft is durably retained with a clarification issue and does not dispatch repository work until corrected/resolved. Resolving it retains the original submission identity; it must not create a duplicate task.

Example: `[storefront] Add checkout validation` with “Follow the conventions in payments-service” selects storefront as target and payments-service as reference. Removing the prefix while mentioning both names makes both repositories references. Outputs then remain investigation/design material without inventing a future target.

## Preparation, task binding, and display

Selecting a discovered project for use, or explicitly preparing it from Projects, starts bounded preparation. List its local branches, preselect the current named branch when available, and allow a project default and task override. If there is no usable current/default branch, require a selection rather than guessing `main`. Detached HEAD is acceptable when a named branch can be selected. Filesystem submissions use saved defaults and require clarification if none is usable.

For each selected project, validate read-only agent access, import committed objects, and generate the first brief from an exact commit. The first successfully generated brief becomes current without another approval checkpoint. Preparation status distinguishes Discovered, Needs setup, Preparing, Ready, and Failed. Brief generation is on demand, not part of every root scan. Users can supply a manual brief after generation failure, but cannot bypass read-only access verification. All selected contexts must be ready before triage; unavailable references are never silently dropped. A user can explicitly remove a reference in the draft, or correct/remove a target prefix, to change a pending selection.

On the first accepted submission, durably journal the resolved target/reference IDs, root/catalog generation, chosen refs and exact brief versions. Resolve each chosen ref once and durably record its commit before importing that repository's snapshot. Crash recovery uses the recorded commits; any entries not yet resolved finish binding before dispatch. The completed context is a fixed set of independently pinned repositories, not a promise of an atomic cross-repository snapshot. Newer branch tips, aliases, root settings, or library briefs never replace bound values on retry. Reusing a request ID for different input is a conflict.

The immutable context contains optional target ID, ordered/deduplicated reference IDs, and per-project repository identity, name at binding, ref, commit, snapshot manifest, and copied brief version/text/digest. The target and references must belong to this bound set. Keep this context separate from the legacy single `projectId`; that field alone cannot represent the new relationship. Publish the task to intake only when the complete context is durable and ready, before triage can launch.

The task page groups target and references and shows branch, abbreviated commit, brief version, and Read-only access for each. Briefs based on older commits remain visibly labeled and must be checked against the current task snapshot. Initial binding cannot be changed by triage, later workflow proposals, or root rescans. Using different context after task acceptance requires a new task.

## Read-only boundary and committed snapshots

There are two distinct authorities: the coordinator prepares its own storage, and agents investigate code. The coordinator may write imported objects, snapshot material, project records, briefs, and task artifacts into Symphony-owned locations outside the projects root. Neither coordinator nor agents write inside the root or its repository metadata. Agents receive only read actions for connected tasks. Connecting a repository never authorizes agents to modify that source or a copy of its code.

For a local folder, canonicalize and validate the Git source, then import committed Git objects into Symphony-owned storage. Do not switch its branch, modify its index, create a worktree in its Git metadata, fetch into it, install dependencies, execute its scripts, or alter its working files. Locally changed, staged, ignored, and untracked working-tree content is excluded; tracked bytes come from the chosen commit. Git inspection/import must avoid optional source locks and automatic maintenance that would mutate the user's repository.

There are no remote Git operations in this feature. Import uses only objects already available in the selected local copy. Do not push, execute hooks, check out through repository-provided filters, or recursively initialize submodules. Disable optional locks, automatic maintenance, lazy remote-object fetching, and external transports during source inspection/import. Unsupported or missing objects fail preparation visibly. If an external updater moves a ref during import, keep the already resolved commit; retry that commit or report unavailable objects, never silently switch commits. Redact sensitive Git diagnostics before persistence or display.

Materialize a plain, committed file snapshot from that owned object store, with a manifest binding repository ID, commit, relative paths, object identities, and content digests. Agents receive the selected snapshot path, not the user's live checkout or the object store. Do not reuse `prepareCheckout`, which creates writable task branches and modifies source worktree metadata.

Materialization handles Git entries deliberately: regular tracked files are copied; symbolic links are represented as inert link metadata and never followed; submodules are listed with their pinned object IDs but not traversed; LFS pointers are identified as pointers without downloading external objects. Binary or invalid-UTF-8 files may exist in the snapshot but are not accepted as text line citations. Exceeding configured snapshot byte/file limits fails preparation visibly rather than silently omitting regular files. The user-facing limit values and unsupported entries must be reported.

Default preparation limits across one task's selected snapshots are 100,000 entries and 1 GiB of total materialized content, with 64 MiB for an individual regular file; positive host settings can override them. Git subprocesses have a preparation timeout and bounded diagnostic capture. Brief text is limited to 128 KiB of UTF-8, with at most 256 citations per brief or report. Existing aggregate assignment-input and report-output limits still apply and are checked before dispatch/publication rather than truncating saved context.

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

A task carries a durable copy of each selected project's brief text and citation metadata, identified by version and digest. Later library changes do not affect queued, running, retried, or completed tasks. Brief citations continue to open their own originating snapshot; investigation citations open the corresponding repository's task snapshot. The UI makes differing commits visible rather than presenting old brief evidence as current task evidence.

Connected-task triage receives every selected brief and pinned repository context, with explicit target/reference roles. It proposes a read-only workflow that investigates relevant code before writing a design and implementation plan. Each step may use only a subset of the bound repositories, and never add repositories from the wider root. Research follows relevant entry points, related implementations, and tests; its report distinguishes observed behavior, inferred conclusions, proposed changes, and missing evidence. Subsequent writers and reviewers receive the accepted research artifacts and cite or recheck the relevant source. Plans assign future source changes only to the target. Reference findings can inform those changes but never authorize edits in references. Without a target, outputs remain reference-only investigation/design/planning material and must state that an execution destination has not been selected. If a reference appears to need changes, report the dependency and request a separate task with that project as target; do not silently expand scope.

## Citations and source viewing

Citations are structured data, not arbitrary agent-provided file URLs. Each citation has an ID, repository ID, exact commit, normalized repository-relative path, file object/content identity, and inclusive one-based start/end lines. Report text refers to those IDs next to the claims it supports. Citation IDs and text are persisted together as a versioned output; editing a brief cannot silently retarget an existing citation.

Before publishing a report, validate that every referenced citation belongs to the cited repository's authorized snapshot, names a regular text file, matches its stored identity, and specifies existing lines in ascending order. Reports may cite multiple bound repositories, with repository identity explicit in every citation. Reject absolute paths, traversal, unknown citation IDs, symlinks, missing files, incorrect commits, and invalid line ranges. Invalid evidence must be corrected or the assignment blocked; it is not published as a successful grounded report. A report may state that relevant code was not found, but must identify that as an evidence gap rather than invent a citation.

The source viewer is a read-only, bounded text preview addressed through the task/report or brief version and citation ID. The server derives the allowed snapshot and file; clients cannot supply arbitrary filesystem paths. Show the repository name, path, commit, line numbers, and highlighted range. Limit an individual cited range to 1,000 lines and 256 KiB of text, and validate that it can be displayed before accepting the citation. Return that range with surrounding context within the same response cap, rather than loading an entire large file into the browser. Escape file contents and preserve them as literal text. A file that cannot be displayed has an explicit unavailable/unsupported state.

Validating a citation establishes that the reference points to real snapshot bytes. It does not establish that those bytes prove the author's interpretation; the reviewer and user assess that connection. Unstructured Markdown links do not receive the source-citation treatment.

## Architecture and persistence

Keep the existing sequential coordinator, review workflow, task store, and runner. Add focused units:

| Unit | Responsibility and boundary |
| --- | --- |
| Global project settings | Validate/persist the optional root and its revision; notify discovery without reloading unrelated host settings. |
| Root discovery and catalog | Scan eligible direct children; own stable identities, root generations, aliases, branch defaults, and readiness. Never update source repositories. |
| Task project resolver | Parse submitted titles and match names/aliases; return target, references, match provenance, and clarification errors. No agent or Git execution. |
| Git source and snapshot service | Read contained sources, import objects, resolve refs, materialize/verify committed snapshots, and serve bounded source bytes. |
| Access verifier | Verify actual read-only execution scope and return ready, needs-setup, stale, or failed. |
| Brief service | Schedule bounded generation; version human/generated text and citations with provenance. |
| Task-context binding | Journal and pin all selected contexts; preserve identity through intake, retries, event replay, and runs. |
| Citation validation | Resolve structured evidence only against authorized immutable snapshots. |
| Settings, Projects, and task UI | Configure the root, inspect discovery/readiness, preview matching, and view task context and evidence. |

Project records, imported Git objects, snapshot manifests, operation journals, and brief history live beneath `localRoot`. The user-supplied projects root, synced task store, and managed runtime trees remain canonically disjoint. No metadata, sidecar, or generated brief is written into source folders. Host-local storage matches the single-coordinator deployment; multi-host project portability is outside scope.

The discovered catalog is separate from legacy `projects/projects.json`. Use distinct ID namespaces; never mix legacy names into root-based automatic matching. Existing stored legacy tasks/events and capability checks retain their historical meaning. New submissions use root discovery when a root is configured; deployments with no configured root retain their legacy intake behavior. If a root is configured but unavailable, new project resolution reports the failure rather than silently falling back to legacy projects or treating all mentions as absent.

Extend task contracts with versioned immutable connected-context metadata containing the entire target/reference set and copied briefs. Accept existing schema-version-1 records unchanged; parsers, store, replay, and UI must understand the new schema. Do not backfill historical commits or rewrite immutable events. Bound metadata is part of task creation's durable intent and digest, not mutable catalog pointers.

UI draft submission carries title, description, preview revision, reference exclusions, ambiguity resolutions, and per-project branch/brief choices. Filesystem intake derives title/description as specified and uses saved defaults. Both converge on the same server resolver and idempotent preparation journal before task publication. Raw Markdown can request project selection but cannot forge repository IDs, snapshots, commits, or authorized paths. Recovery before or after publication must preserve the recorded binding and task receipt.

Settings, alias, and brief mutations use request IDs and expected revisions. Discovery, import, access verification, and generation expose durable status rather than holding an HTTP request open for an agent run. Generation uses the existing global scheduling limit and process lifecycle support. Browser disconnects do not discard operations; interrupted work remains resumable or explicitly retryable.

The HTTP layer adds narrow global project-settings reads/updates, discovery/rescan, project detail/aliases/defaults, task-resolution preview, preparation/readiness, brief history/edit/generate, and citation previews. Existing loopback/origin checks and bounded JSON handling apply. Client project IDs resolve through the catalog; clients cannot nominate arbitrary repository paths. Source previews are restricted to persisted authorized citations. Arbitrary host file browsing and remote clone endpoints are unnecessary for this design.

## Capability integration

The current registry is read once at startup, and existing capability attestations hash the whole projects file and match exact repository source paths. Simply editing that file in a UI would leave running catalog state stale and invalidate profiles. Per-task snapshot paths also do not match the current source-path access contract.

For new connected projects, introduce an explicit snapshot-access scope instead of changing or bypassing legacy scope matching. Its identity includes project/repository ID, canonical Symphony-owned snapshot root, read-only role/profile policy, CLI version, allowed actions/environment, configuration and selected-skill digests, and recorded verification evidence. Each assignment additionally binds a manifest-verified snapshot underneath that project's scope. Caller-supplied paths cannot enlarge or redirect it. Brief text, display names, and default branches are content/settings, not execution-policy grants.

Before an assignment launches, require exactly one matching verified read-only profile covering the exact selected set of snapshot scopes and unchanged execution policy. Multi-project access must validate the combined assignment; independent per-project attestations alone cannot imply that a combined profile is safe or available. Verification must cover repository/snapshot write denial, task-store write denial, unrelated repository/tool access restrictions required by the deployment, and denial of write-capable external tools such as merge/deploy. Plain `read-only` sandbox selection, successful discovery/import, recomputed digests, or fabricated check labels cannot substitute for these probes.

The Projects/preparation UI exposes Check agent access and readable recovery guidance. A supported host verifier can validate an existing compatible profile and run the required disposable probes. If the host has no compatible scoped profile or verification provider, the discovered project remains visible in Needs setup and the UI explains the host configuration required. It must not mark the project ready or generate a brief using an unverified fallback. This specification does not promise universal automatic CLI isolation provisioning; actual host verification is an acceptance requirement for the real happy path.

Adding an unready project must not stop unrelated ready projects or prevent the application from opening. Policy changes invalidate the affected scope and block its next launch; content-only brief/name changes do not require re-verification. The legacy attestation path remains strict for legacy assignments. No new write-enabled profile is provisioned by this feature.

## Failure and recovery behavior

| Failure | Required behavior |
| --- | --- |
| Invalid/inaccessible root or settings save conflict/failure | Retain the previous saved setting and unsaved form value; show a specific error. A previously saved root that later disappears is unavailable, not an empty catalog. |
| Invalid child, external Git metadata, non-Git folder, or empty repository | Report its eligibility/readiness error without disrupting other discovered projects. |
| Unknown target or ambiguous name/alias | Preserve the draft and request correction or explicit resolution before dispatch. |
| Root/catalog changes after preview | Return refreshed resolution for user review; never silently change selected projects. |
| Missing source objects or concurrent external update | Preserve bound commits; offer retry for those commits, never substitute a newer tip. Partial imports are not ready snapshots. |
| Missing selected branch | Stop preparation and request another selection; never fall back silently. |
| Branch advances or is deleted after successful binding | Continue using retained committed objects and the exact bound snapshot. |
| Missing/stale access verification | Keep the project visible in Needs setup; block agent work for that scope with actionable guidance. |
| Brief generation failure or timeout | Preserve any current brief and expose retry/manual editing; do not present partial generated text as the current saved version. |
| Concurrent brief edit | Reject the stale save, retain unsaved text, and offer reload/compare. |
| Invalid citation | Reject the report before successful publication and surface a correctable evidence error. |
| Snapshot corruption or lost owned objects | Block affected work/viewing; restore only the same commit and verified bytes, never a newer branch tip. |
| Restart during preparation or generation | Recover from persisted operation identity and existing process lifecycle rules; do not duplicate catalog records, submissions, or successful versions. |

## Verification and acceptance

Implementation tests must demonstrate behavior, including:

- Global root settings survive restart; stale or failed saves preserve the previous value and unrelated settings. Missing settings remain backward-compatible; invalid roots never default to the user's development folder.
- Discovery finds only eligible immediate children, validates repository top levels, rejects symlink escapes/external Git metadata/object alternates and storage overlap, reports unreadable/empty entries, and does not run Git network operations.
- All root contents, source files, index, branches, and Git metadata remain unchanged during scanning, preparation, brief generation, and investigation. Dirty/staged/untracked content never enters snapshots.
- Matching covers target prefixes, reference-only tasks, aliases, Unicode/case normalization, whole-name boundaries, overlapping names, deduplication, ambiguity, unknown targets, exclusions, and root/catalog changes between preview and submission. UI and filesystem submissions have equivalent resolution semantics.
- No-prefix tasks never acquire a target, and repeated mentions of a target do not also create a reference. A literal name in quoted/negated text remains removable in preview.
- Each repository ref resolves once after its binding is journaled; retries and recovery use recorded commits/briefs. Root changes, branch updates, alias edits, and source removal do not change accepted task contexts or citations.
- All contexts must be prepared before dispatch. Missing references or unavailable combined access profiles block visibly; they are never dropped or handled through unverified access.
- Triage and initial/revised workflows cannot alter target/reference roles, add unbound repositories, or introduce writes. Dispatch rechecks constraints after recovery. Design/plan artifacts preserve the intended target and identify reference dependencies without proposing unapproved edits there.
- Snapshot handling and limits cover the aggregate task selection, symlinks, submodules, LFS pointers, binary/oversized files, invalid paths, and altered manifests.
- Brief provenance survives edits/regeneration and concurrent-save conflicts. Existing tasks retain copied versions.
- Citations reject traversal, unknown IDs, unselected repositories, wrong commits/identities, and invalid lines. Source previews escape content and show the correct repository and pinned commit.
- Settings changes, discovery/import/generation, and intake publication recover without duplicate successful operations/tasks. Legacy schema/event replay and projectless workflows remain compatible.

Run focused implementation tests, then `npm test -- --run` and `npm run build`. Use disposable roots and repositories for browser checks covering root setup/change/failure, rescan, discovery errors, aliases, matching preview/exclusions, reference-only and target-plus-reference submissions, preparation/readiness, brief editing, and citation navigation. Check keyboard access, narrow screens, and disconnected states using established UI components.

Before claiming the real read-only path works, run genuine host capability probes and a real investigation against a disposable repository containing committed and dirty sentinel content. Exercise both a single-project and combined target/reference assignment. Confirm the agent cannot write through its permitted tools, returned citations resolve to each pinned commit, and the root and all source repositories are unchanged. Exercise a root mounted read-only or equivalent OS-enforced write denial, and external source updates between tasks; new tasks may bind the new commits while old tasks keep the old ones. Do not use the user's company repositories as test fixtures. If host verification is unavailable, report that limitation; passing fake tests alone does not complete this acceptance condition.

## Existing implementation anchors

- [Host settings](../../../server/config/settings.ts): strict startup configuration parsing; extend with optional root and a narrow live settings service.
- [Task dialog](../../../src/components/NewTaskDialog.tsx): current title/brief submission; add matching preview and context choices.
- [HTTP API](../../../server/http/api.ts): settings/discovery/preview and preparation endpoints.
- [Project registry](../../../server/config/registry.ts): current static projects, repository paths, and ref rules.
- [Application startup](../../../server/main.ts): startup registry load and capability checks.
- [Repository workspace](../../../server/repos/workspace.ts): current ref resolution and mutable worktree preparation.
- [Coordinator](../../../server/coordinator/coordinator.ts): project lookup, live ref resolution, staging, and dispatch.
- [Repository access](../../../server/codex/repository-access.ts) and [capability verification](../../../server/codex/capability.ts): current access/path validation and attestation boundaries.
- [Prompt](../../../server/codex/prompt.ts) and [result schema](../../../server/codex/result-schema.ts): assignment context and currently unstructured evidence.
- [Contracts](../../../shared/contracts.ts), [validation](../../../shared/validate.ts), [intake](../../../server/intake/intake.ts), and [task store](../../../server/store/task-store.ts): context binding, schema compatibility, and replay.
- [Approved UI specification](2026-09-22-linear-inspired-ui-design.md): presentation system and navigation integration.

## Review handoff

The written specification is approved. Review the [implementation plan](../plans/2026-09-22-project-discovery.md), including supported-host capability verification and integration with the existing workspace UI. Implementation begins only after that plan has been reviewed and its execution method selected.
