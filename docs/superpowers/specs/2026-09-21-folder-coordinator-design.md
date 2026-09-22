# Folder-based task coordinator

Status: approved by the user on 2026-09-21 for implementation planning. Implementation awaits plan review and execution-method selection.

## Purpose and agreed constraints

Turn free-form Markdown ideas into tracked agent work with explicit human decisions. A user can submit an idea through OneDrive from a phone without reaching the company network. A single Node.js application inside that network coordinates work and exposes the internal UI. Human answers, approvals, pause requests, and cancellations happen only through that UI.

The user creates drafts but does not manually edit task records after submission. The coordinator owns subsequent file updates and folder moves. Files remain the persistent task store; browser storage and Codex conversation history are not authoritative task state.

Codex CLI is the initial execution runtime. Do not use Codex App Server or build a separate custom agent CLI. `npm run start` will launch the application, which manages Codex subprocesses internally. Existing company access to Codex and repositories is a deployment prerequisite; this design does not assume network connectivity or credentials have been verified.

Success means a draft is picked up once, triaged automatically, and presented for workflow approval; approved steps run in order; human checkpoints stop the entire task; results and decisions survive restarts; the UI accurately distinguishes active work, waiting, blocked work, and terminal outcomes.

## Scope

This is one initial vertical slice: folder ingestion, a persistent sequential workflow engine, Codex CLI execution, project/role configuration, and integration with the existing React UI. These components share a task and handoff contract and belong in one implementation plan.

Support multiple tasks with a configurable global concurrency limit and at most one running assignment per task. Default global concurrency is one; waiting tasks release their execution slot. Workflows can differ by task but contain sequential steps in this version.

Out of scope: multiple coordinator machines, parallel branches within a task, additional agent runtimes, a graphical workflow designer, public/mobile access to the internal UI, automatic OneDrive provisioning, and a general integration/plugin marketplace. Existing Codex skills and approved MCP connections can be used by role configuration; building new provider-specific integrations is separate work.

The earlier task-workspace spec describes a simulated frontend. This spec supersedes its fixed demo journey and browser-only persistence for real coordinator-backed tasks. Preserve the inbox/detail layout where it fits; do not silently convert sample tasks into executable work.

## Architecture and ownership

The coordinator is a deterministic work loop. Codex supplies reasoning and performs bounded assignments; it does not own scheduling, approvals, or task transitions.

| Component | Responsibility and interface |
|---|---|
| Folder intake | Detect stable Markdown submissions and create durable task records. |
| Task store | Read validated records and serialize versioned transitions, events, and folder moves. |
| Coordinator | Select eligible steps, record attempts, dispatch work, enforce pauses, and reconcile interrupted attempts. |
| Codex adapter | Start/stop CLI processes, capture output, validate final results, and report process lifecycle. |
| Project and role registry | Resolve project aliases, repository inputs, instructions, skills, and permitted tools. |
| Internal API and UI | Present state and artifacts; submit version-checked human decisions to the coordinator. |

Only the task store writes authoritative task records. Codex receives copied assignment inputs and an output directory, not write access to the task store. Repository work directories are separate from the OneDrive tree. Tool and filesystem restrictions must enforce these boundaries; prompts alone do not enforce authority.

## Folder structure and records

```text
workspace/
  .intake/                        # Durable pickup receipts and preserved conflicts
  projects/                       # Project definitions and aliases
  roles/                          # Agent role definitions
  drafts/                         # Incoming free-form .md files
  active/
    <task-id>/
      idea.md                     # Original submitted content, preserved
      task.json                   # Current state and revision
      events/                     # Immutable ordered transition records
      workflows/                  # Immutable proposed/approved workflow versions
      reviews/                    # Questions, decisions, and artifact references
      runs/<attempt-id>/          # Inputs, logs, process metadata, validated result
      artifacts/                  # Versioned reports, PRDs, summaries, references
  done/
  rejected/
  cancelled/
```

Terminal folders contain the same complete task directories. There is no approved folder: approval belongs to a particular workflow, artifact, or action.

Task records include schema version, stable ID, title, type, project, revision, status, current step, workflow version, pause/cancellation intent, timestamps, and pending review references. Run records include attempt ID, step ID, input versions, runtime version, process identity, timestamps, exit information, and result classification.

Operational process locks and live checkout directories live outside OneDrive. Task records may refer to local checkout paths, but those paths are not portable artifacts. Credentials stay in the host's approved credential/configuration mechanisms, not task files.

## Draft ingestion

Accept free-form UTF-8 Markdown without mandatory front matter. Use the filename as a temporary label; triage proposes a meaningful title, type, project match, missing information, and workflow.

Use filesystem notifications as hints plus periodic scanning. Ignore temporary files and wait for consistent file size/content across observations before pickup. Stability is a heuristic, not proof that remote sync has finished: preserve the ingested bytes and detect later changes rather than silently merging them into an active task.

Before moving or dispatching anything, persist a receipt with source identity, content digest, and assigned task ID. Finish materializing `idea.md` and the initial task state before removing the inbox copy. Restart recovery completes an interrupted pickup using the receipt. Repeated notifications for the same received version do not create another task.

Do not use content alone to merge independently submitted ideas. Distinct filenames may intentionally contain identical text. A recreated source with identical bytes is treated as replay of its prior receipt; intentionally repeating it requires a new filename. A changed version of an already claimed source is preserved as an intake conflict and displayed in the UI, not silently launched or discarded. OneDrive conflict copies require review when they collide with known task identities.

The design assumes one designated host with one local OneDrive sync root. OneDrive is transport and replication, not a distributed lock or transactional database.

## Lifecycle

Folder location expresses broad lifecycle; status and current stage express execution detail. The coordinator validates all transitions against current persisted state.

| State | Meaning and next transitions |
|---|---|
| Draft | Unclaimed incoming file; stable pickup enters active/triaging. |
| Triaging | Automatic bounded analysis; a question or proposal enters waiting-for-human, failure enters blocked. |
| Waiting for human | Task dispatch is suspended; an answer resumes the relevant step, approval queues the next eligible work or completes a satisfied final checkpoint, changes return to the relevant authoring step, rejection ends the task. |
| Queued | Approved work is eligible; dispatch enters running. |
| Running | A CLI assignment is active; accepted completion queues the next step, opens review, or completes the task. Questions enter waiting-for-human; unresolved failures enter blocked. |
| Blocked | Access, failure, invalid output, or uncertain execution prevents progress; an explicit retry/resolution requeues eligible work. |
| Done | Approved completion conditions are satisfied and required reviews are complete. |
| Rejected | Human decision that the proposed work should not proceed. |
| Cancelled | Human withdrawal; no remaining live assignment and no future dispatch. |

Triaging is the initial active status; later agent stages use queued/running with stage labels such as research, brainstorming, PRD writing, implementation, or review.

Pause-requested and cancellation-requested are durable control intents while an assignment stops. Do not display a task as paused or cancelled while its process is still known to be running. After a requested review stops execution, enter waiting-for-human and include any partial output. Cancellation is available from any nonterminal state; it does not undo changes or remove existing PRs. Rejection is available at human review points and likewise preserves work already produced. Terminal tasks are inspectable and immutable in this version.

## Workflows and approvals

Triage runs automatically and may read configured repositories, but does not implement changes or open PRs. Its initial workflow proposal must be approved in the UI before substantive execution begins.

A workflow is an immutable versioned sequence of agent steps and human checkpoints. Agent steps declare stable IDs, role, purpose, input artifacts, expected outputs, repository scope, permitted action category, and completion checks. Checkpoints declare the artifact/action being reviewed and what the decision authorizes next. Completion conditions are part of the approved workflow.

Example:

```text
Triage → workflow approval → research → PRD → human review
       → implementation → agent review → open PR → human review → done
```

This example does not make every feature workflow mandatory. An investigation may end with reviewed findings; an implementation may finish with a reviewed PR. Merge and deployment are separate actions and require explicit inclusion and applicable approvals; done never implies deployed unless the workflow requires and verifies it.

Agents can propose workflow changes, but cannot activate them. New scope, reordered/added agent work, changed permissions, or removed/relocated checkpoints require a new workflow version and human approval. Changes invalidate affected approvals and downstream results; unaffected completed steps remain recorded. If downstream work has already occurred, show it as stale and require reconciliation before proceeding.

Approval references the exact workflow version, step, artifact version/digest, and action. Modified artifacts cannot reuse an earlier approval. Approval of a plan does not authorize a merge, and clarification answers are not approval decisions.

## Human review and conversational handoffs

Every pending human decision pauses the entire task. No new assignment is dispatched until all required decisions are resolved and the workflow permits continuation. Other tasks remain eligible.

Human attention can originate from a planned checkpoint, an agent question, or a UI pause/review request. The UI supports approve, request changes with feedback, and reject at approval checkpoints; questions accept answers; cancellation remains separate. It also supports inserting a checkpoint before an upcoming step. An explicit UI insertion records a new workflow revision and immediately enforces the new checkpoint; it does not grant additional execution permissions.

Brainstorming and similar conversations use short CLI assignments that return a structured question and checkpoint summary, then exit. The coordinator persists the handoff; after a UI answer it launches the next assignment with that answer and saved context. Skills that assume a live terminal conversation must be adapted to this handoff contract before being offered as supported workflow steps.

Pause requests first persist the dispatch barrier, then request termination of the current CLI process and its managed child processes. Escalate termination after a configured grace period. Confirm process exit before settling the task into waiting-for-human. External tool effects may outlive the local process; record uncertainty and require reconciliation before retries. Never promise rollback or immediate cancellation of an external action.

## Codex CLI execution contract

Use the supported noninteractive `codex exec` interface. Local discovery on 2026-09-21 found Codex CLI 0.155.1 with JSONL events, a final-output JSON schema option, and a final-message output file option. Implementation must check the actual deployment binary and required flags; do not assume the developer host's version matches the company host.

Launch using a subprocess argument array, with assignment text passed through stdin; never interpolate drafts or model output into a shell command. Capture stdout events, stderr, exit status, and final output independently. Apply configured time and output limits. Failures must not freeze the coordinator loop.

Inputs contain the role instructions, selected skills, original idea, approved step/workflow version, repository revisions, relevant artifacts, previous checkpoint summary, and human feedback. Give each assignment a fresh explicit context. Native session resume may be added behind the adapter if verified, but correctness must not depend on it or on selecting a global most-recent session.

The final result envelope contains a result kind, summary, artifact references, and kind-specific details:

- `completed`: outputs and evidence for completion checks.
- `needs_human`: question, context, and checkpoint summary for continuation.
- `propose_workflow_change`: proposed revision and reasons; execution waits for review.
- `blocked`: obstacle and required resolution.
- `failed`: failure description and retry classification, validated by the coordinator.

Only a successful process exit plus a valid, accepted result can complete a step. A zero exit alone is insufficient. Validate result schema, artifact existence and allowed paths, task/attempt association, and current task revision before applying results. Log messages cannot authorize state changes. Late results from cancelled or superseded attempts remain historical evidence, not permission to advance.

Run unattended with an explicit permissions profile that cannot hang on terminal approval prompts. Needed permissions that exceed the approved profile become a blocked/human handoff. Do not solve unattended execution by bypassing all protections. Each role receives only the configured repository/tool access for its assignment. Actions protected by workflow checkpoints must be unavailable to earlier steps through their credentials/tools, not merely discouraged in prompts.

## Projects, roles, and repository access

Project definitions map names and aliases (for example Digital Sales Workspace) to repository identifiers, local checkout or approved MCP access, and default ref-selection rules. Store connection identifiers, not embedded secrets. Missing or ambiguous project matches generate a UI question.

Resolve moving references such as latest tag or recent commits into exact commit IDs when preparing assignment inputs. Record the selection rule and resolved IDs. Intentional later refreshes produce new input versions, with affected results and approvals reconsidered.

Roles are configuration: triage, researcher, PRD writer, implementer, and reviewer initially. They specify instructions, available skills/tools, expected outputs, and allowed action categories. All use the same Codex adapter. Reviewer assignments receive requirements and change evidence in their own context.

Prepare isolated local working directories for mutable task work. Research through MCP remains possible without a checkout; implementation requires an available writable checkout or an explicitly supported write tool. Preserve work directories needed for recovery and record their association with the task. Concurrent tasks must not edit the same checkout.

## Persistence and recovery

Enforce a host-local exclusive coordinator lock. A local lock cannot coordinate multiple synced machines, which are unsupported. On startup validate schemas, reconcile incomplete transitions, and assess unfinished attempts before scheduling new work.

Serialize mutations per task. Each mutation has a unique operation ID and expected task revision. Persist an immutable event containing the transition and resulting state using a temporary file and atomic rename; then replace the current snapshot atomically. Recover a missing/stale snapshot from committed events. Artifacts and decision payloads are durable before an event refers to them.

For terminal moves, first persist terminal state and intended destination, then move the task directory. Recovery completes pending moves; dispatch eligibility depends on state, not folder name alone. Duplicate IDs or inconsistent histories stop the affected task and surface a conflict rather than choosing a winner silently.

Before spawning Codex, persist the attempt and launch intent; then record process identity with start metadata. A crash between launch and process registration is an uncertain attempt, not an automatic retry. On restart distinguish confirmed live, confirmed ended, and unknown attempts. Do not rely on a PID alone because it may be reused.

Default automatic retries apply only to clearly transient failures before side effects, capped at two retries with backoff. Interrupted mutating work or an uncertain external action requires checking the checkout/provider before retrying. Validate existing PR references or query by a recorded operation marker when supported; otherwise ask for human reconciliation. Local deduplication does not guarantee exactly-once external effects.

Exhausted retries enter blocked. Filesystem write failures stop affected dispatch and surface an operational error; never continue with only in-memory approvals. Immutable event publication and snapshot replacement require flushing data as supported by the host filesystem, and startup recovery must tolerate incomplete temporary files. Local durability does not imply that OneDrive has finished uploading the records.

## UI integration

Replace simulated transitions with internal API commands and coordinator-backed reads. Display task status, current stage, workflow and checkpoint sequence, real run output, versioned artifacts, review questions, and activity history. Make pending human decisions prominent. Distinguish queued, running, waiting, blocked, pause requested, and cancellation requested.

Commands include the expected task revision and a unique request ID. The API validates allowed transitions and reviewer action against current persisted state; stale tabs or double clicks cannot approve newer artifacts or dispatch twice. UI changes become visible as saved only after persistence succeeds.

Retain free-form creation in the UI by writing through the same intake path. OneDrive submissions appear after sync and ingestion; do not imply instant remote delivery. Internal UI disconnects do not stop approved background work, but pending reviews remain pending indefinitely rather than timing out into approval.

Serve the UI/API inside the company network with deployment-approved access control. No public endpoint or direct phone connectivity is required. Browser local storage may retain presentation preferences, not workflow authority. Keep demo data separate and clearly marked if retained.

## Verification and acceptance

Use a fake CLI fixture for deterministic workflow and process tests, then a small explicitly configured real-Codex smoke test against the deployment-supported binary. Real repository mutation is not necessary for most tests.

Required coverage:

1. Free-form drafts, partially synced files, repeated notifications, interrupted pickup, and source conflicts.
2. Workflow approval, repeated clarification turns, request-changes loops, checkpoint insertion, rejection, cancellation, and completion conditions.
3. Task-wide dispatch barriers; other tasks can progress while one waits; at most one assignment per task.
4. Stale UI decisions, changed artifact versions, duplicate callbacks, and late results cannot authorize work.
5. CLI malformed output, zero exit without a valid result, nonzero exit, timeouts, termination, and unavailable capabilities.
6. Crash recovery between event/snapshot writes, task-directory moves, launch/registration, and result/application boundaries.
7. Uncertain external effects block automatic repetition; retries are bounded.
8. End-to-end intake → triage → UI approval → fake agent execution → human review → done, with state preserved across restart.
9. Real-browser desktop and narrow-screen checks for workflow visibility, questions, feedback, pending controls, and keyboard interaction.

No code changes, dependency installation, or running agent assignments are part of this design-writing stage. After user review of this written spec, create the implementation plan and agree its execution method.
