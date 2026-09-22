# Jira preparation and ONA handoff

## Status and intended outcome

The user approved the interaction flow and architecture in conversation on 2026-09-22. This document records that design for written review. Implementation planning begins only after the user approves this specification; implementation follows review of the resulting plan and selection of its execution method.

Symphony should bring open Jiras assigned to the user into their inbox, help them turn a ticket into an implementation prompt, and send the reviewed prompt to ONA. A sufficiently clear ticket can go directly to prompt preparation. An unclear ticket can first become a conversation with Codex, with additional user context and repository investigation.

The user explicitly selected real Codex for brainstorming and GitLab repository access through MCP. Jira intake and ONA handoff are mocked for this slice behind replaceable server adapters. Success is a persisted, inspectable handoff of the exact prompt the user reviewed. It does not mean implementation finished or a merge request exists.

## Scope and selected approach

Add a focused Jira preparation mode to existing Symphony tasks. Reuse its task store, inbox, command boundary, Codex subprocess runner, repository configuration, and recovery infrastructure. Preparation has a fixed lifecycle rather than the generic triage/workflow/artifact approval sequence.

The alternatives considered were using the existing general workflow unchanged, which adds approval friction to conversation, and building a separate launcher, which duplicates task history and persistence. The focused mode keeps the new interaction small while retaining the existing execution foundation.

Included:

- Automatic intake of assigned open Jiras, refresh, stable identity, and source details.
- Real, persisted brainstorming with read-only GitLab MCP investigation.
- Direct prompt preparation without a preceding conversation.
- Saved generated prompt versions and a separately editable working draft.
- Review of the target repository, branch, and exact prompt before explicit submission.
- Mock ONA acceptance, receipts, retry, and reconciliation of uncertain outcomes.

Excluded:

- Real Jira and ONA connectors, integration discovery, and credential-management UI.
- Jira creation, comments, status changes, or other Jira writes.
- Running implementation in ONA, actually opening a GitLab merge request, PR polling, review, merge, or deployment.
- Local implementation worktrees, a workflow editor, and a general chat platform.
- Implementing the separately specified Symphony UI replacement as part of this feature.

The downstream prompt may instruct the ONA agent to implement, test, and open a GitLab merge request. This slice only prepares and hands off those instructions.

## User flow

### Inbox and Jira details

When Jira intake is enabled, perform a sync at server startup and every 60 seconds, with a manual Refresh Jira action. These requests use the same serialized sync operation. A failed sync retains the previous results and exposes the error and last successful sync time.

The adapter returns a complete normalized snapshot of tickets that are assigned to its configured current user and considered open by that source. The mock explicitly supplies these eligibility fields; the UI does not interpret arbitrary Jira status names. Identity is the configured Jira connection plus immutable issue ID. The displayed issue key is not the deduplication key.

New items appear in the existing inbox with Jira key, title, source status, and preparation status. Opening one displays its description, acceptance criteria when provided, original Jira link, and selected repository if known. Importing or opening a task does not launch Codex.

Refresh updates the latest Jira snapshot for nonterminal tasks, without replacing the original task brief, messages, prompt drafts, or receipts. Runs and generated prompts record which source snapshot they used. If a successful complete sync no longer includes an imported nonterminal issue, retain its task and mark it as no longer in the assigned-open query. Failed or incomplete syncs do not establish absence. Retained nonterminal tasks remain usable, with their source freshness visible. Accepted and cancelled tasks retain their final source snapshot; their identities still prevent reimport as new tasks.

### Brainstorming

Brainstorm opens the conversation and starts the first Codex turn using the Jira snapshot. The user can then answer questions or add context. Codex can inspect the selected GitLab repository through its configured read-only MCP access, explain findings, and ask focused questions. Repository findings include file paths and the inspected commit when available.

There is at most one queued or running turn per task. Each turn persists the user input and its context before execution. The interface distinguishes queued, running, completed, and failed turns. Show the final conversational response and expose existing run output separately; token-by-token chat streaming is not required.

The user chooses Prepare for ONA when ready. The agent may suggest that action, but cannot send the task. There is no mandatory number of conversation turns or separate workflow approval.

### Direct preparation and repository selection

Prepare for ONA is also available immediately from the Jira details. It runs real Codex once to draft a useful implementation prompt using the Jira and any saved context. It can inspect the selected repository. Missing requirements become explicit questions or assumptions, never fabricated decisions; the user can return to brainstorming or resolve them in the editor.

Use a configured Jira-project-to-Symphony-project mapping to suggest a repository. Select it automatically only when the mapping identifies one repository unambiguously. Otherwise allow selection from configured repositories. Discussion can begin without a repository; repository investigation and submission require a selected target. This slice hands off to one target repository per task.

The branch defaults to the repository's configured base branch and is editable before submission. Resolve the selected branch through MCP for investigation and record the inspected commit. Keep the branch sent to ONA distinct from this historical evidence: recording an inspected SHA does not imply ONA will check out that exact SHA.

### Prompt review

Both entry paths arrive at the same editor with the selected repository and branch. The generated prompt covers the Jira identity and problem, scope, agreed requirements, acceptance criteria, relevant repository findings, constraints, verification expectations, remaining assumptions, and the requested downstream implementation/merge-request outcome.

The complete effective implementation prompt is visible and editable. Do not append hidden task instructions or regenerate content during submission. Repository and branch are separate, visible launch parameters.

Persist the working draft with a visible saving/saved/error state. Flush pending edits when leaving the editor or sending. If saving fails, retain the local text, show the error, and prevent submission until it is saved. Server drafts survive refresh; unsaved text is never presented as saved.

Keep generated versions immutable. The first generated version initializes an empty editor. Later generations appear as candidates with an explicit Use this version action; they never replace an existing working draft automatically. Returning to brainstorming, changing the target, or receiving changed Jira content retains edits and marks the prompt as needing review. Opening the editor clears that review reminder, but never sends automatically. Show when the source snapshot used to generate the draft differs from the latest Jira snapshot.

### Send and receipt

Send to ONA submits the saved prompt and visible target. Disable it while a turn is active, a save is pending or failed, the server is disconnected, or a handoff is sending, unconfirmed, or already accepted. Require a nonblank prompt, a configured repository, and a nonblank target branch.

Persist a frozen launch payload before calling the adapter. It binds the task, Jira identity, the draft's originating source snapshot and latest source snapshot at submission, prompt revision and exact text, target repository and branch, creation time, and stable handoff request ID. The adapter receives this payload unchanged.

On acceptance, show Sent to ONA with the receipt, accepted time, and submitted prompt. Show an environment link only if the adapter returns a real usable link. The mock clearly says Simulated ONA handoff and provides no fabricated working environment or PR link. Sent tasks remain inspectable and cannot be resubmitted in this slice.

## Lifecycle and existing task compatibility

The preparation lifecycle is Inbox, Preparing, Ready to send, and Sent to ONA. Sending, failed, and unconfirmed are handoff substates. Preparing includes both active agent work and waiting for another user message. Ready to send means a prompt draft exists; it is not an assertion that the agent has proven every requirement complete.

Add an optional, explicitly validated preparation payload to the existing version-1 task format. Its presence identifies this mode; legacy records without it retain their existing behavior. The payload holds source snapshots, selection, preparation phase, conversation/turn references, prompt references, working-draft revision, and handoff attempts. Store large message and prompt bodies as existing versioned artifacts and reference them from task events. Historical source snapshots must also remain available when referenced by a run or receipt.

Continue using the existing task revision, serialized writes, operation IDs, durable events, artifact digests, and atomic publication rules. Missing preparation fields in legacy records require no destructive migration. New mode validation must reject inconsistent state rather than silently discard its fields.

Map the preparation mode into shared task statuses for scheduling and filters:

| Preparation condition | Shared status | Display |
| --- | --- | --- |
| Imported or awaiting user input | waiting-for-human | Inbox or Preparing |
| Turn awaiting execution | queued | Preparing: queued |
| Turn executing | running | Preparing |
| Prompt review selected, draft available, no active turn | waiting-for-human | Ready to send |
| Handoff pending | running | Sending to ONA |
| Execution failure or uncertain handoff | blocked | Specific failure or Handoff unconfirmed |
| Handoff accepted | done | Sent to ONA |
| User cancellation before submission | cancelled | Cancelled |

For this mode, Needs review includes unanswered agent questions, prompt drafts awaiting action, and failures needing intervention. Imported Inbox items remain visible in All tasks without implying an agent review has occurred. Closed includes accepted and cancelled tasks. Preparation-aware labels must show Sent to ONA rather than imply that implementation is done.

Generic triage and workflow scheduling must skip preparation tasks. Their UI exposes conversation, prompt, and handoff actions instead of generic workflow approval, insert-review, or local implementation controls. Existing generic tasks and synced-file reviews keep their current behavior. Preparation conversations and prompt approval are handled in the UI; adding them to the synced-file review protocol is out of scope.

Cancellation can stop a queued or running read-only preparation turn using the existing process controls. It cannot claim to cancel an environment after a handoff has begun. Reconciliation remains available for an unconfirmed handoff.

## Components and interfaces

### Jira adapter and intake service

The server-owned Jira adapter provides a complete assigned-open snapshot with stable issue IDs, keys, links, project identifiers, titles, descriptions, acceptance criteria, source status, assignment eligibility, and source update times. It carries an explicit mock/live designation. This implementation supplies only the mock adapter.

The intake service normalizes and validates results, persists source revisions, and creates or refreshes preparation tasks. Serialize syncs and use a deterministic task identity derived from the connection and immutable Jira ID, with idempotent creation operations, so restart or concurrent refresh cannot duplicate a task. No Codex launch occurs during sync.

### Preparation service and Codex execution

A dedicated preparation service owns mode-specific transitions and turn construction. It reuses the existing runner's process execution, bounded output, durable logs, timeouts, and profile verification. Use the existing read-only researcher role and configured MCP repository mappings. Reuse repository-ref resolution while selecting the user-reviewed target branch.

Preparation requires its own prompt builder and validated turn-result schema; the generic workflow prompt currently instructs triage to propose a workflow. Select the prompt and schema by assignment mode while keeping existing generic assignments compatible. Turn results contain a conversational response, an optional question, an optional generated prompt, and repository evidence, or a structured failure. They cannot authorize a handoff.

Each turn receives the current Jira snapshot, saved conversation, user context, current draft when present, and selected repository evidence. Bind outputs to the originating turn and task generation. A cancelled, superseded, or mismatched result cannot update the task. Share the existing coordinator concurrency budget rather than creating an unbounded second execution pool.

Preserve bounded input/output limits. If accumulated context exceeds the supported limit, report a context-size error with the saved history and draft intact; do not silently truncate agreed requirements. The user can still review, edit, and send an existing draft. Automatic summarization is outside this slice.

### Prompt and handoff services

Prompt edits are revision-checked commands. The handoff service freezes a saved revision and persists its request before invoking ONA. Source sync events cannot rewrite a frozen payload.

The ONA adapter exposes launch(payload) and lookup(requestId). Launch uses the persisted request ID as its idempotency key. Lookup returns accepted with a receipt, definitively not accepted, or unknown. Adapter implementations must preserve these meanings; a lookup failure is unknown, not proof that launching is safe.

The mock persists its request ledger across server restart and supports deterministic accepted, rejected, and accept-then-timeout scenarios for tests. It does not execute Codex or create an ONA environment. A future connector can translate the same contract to the user's MCP/CLI integrations without changing the preparation interaction.

### API and UI boundaries

Extend the existing same-origin HTTP API, workspace data boundary, and command submission mechanism with explicit preparation actions: sync Jira, begin/post a turn, prepare a prompt, save/select a draft, select a target, send, retry, reconcile, and cancel where eligible. User mutations carry request IDs and expected task revisions. Reject conflicting commands while retaining entered text for correction or retry.

Create focused Jira details, conversation, prompt editor, and handoff receipt components inside the existing task page. Reuse inbox navigation, connection handling, and artifact/log access. Keep the feature compatible with the separately approved UI design without requiring that redesign to ship first. UI-only state includes the selected view and unsaved field text, not authoritative execution state.

## Failure handling and recovery

- A Jira failure keeps previous tasks visible and marks source data stale. It does not erase preparation work or launch agents.
- A missing Codex profile, unavailable MCP connection, or inaccessible branch produces a specific blocked state. Preserve the existing profile verification rules; a filesystem read-only sandbox alone does not restrict remote MCP writes. The configured preparation profile must expose only the intended read operations.
- Failed turns retain user messages and prior valid outputs. Explicit retry uses the saved turn inputs without duplicating the user message. Restart recovery must settle or terminate an orphaned process before another turn runs for that task.
- Duplicate save, turn, and send commands with the same operation identity and content return the recorded outcome. Reusing an identity with different content is a conflict.
- Persist send intent before the external call. After a timeout or crash around launch, show Handoff unconfirmed and lookup the original request. Never automatically submit a new request while acceptance is unknown.
- Reconciliation to accepted records the original receipt. Definitively not accepted unlocks retry. Unknown retains the blocked state. An unchanged retry reuses the original key; edited content creates a new attempt only after nonacceptance is definitive.
- Accepted handoffs are immutable. Preserve their prompt and target even if the Jira later changes.
- During disconnection keep last-known data visible and disable mutations. Local field contents survive a failed command; reconnecting does not silently overwrite them.

## Configuration and mock boundary

Jira intake and mock ONA are explicitly enabled server-side; they do not silently inject demo tasks into an existing workspace. Mock source and handoff labels remain visible. Supply example configuration and fixtures for a clear ticket, an ambiguous ticket, and a ticket with repository mapping.

Brainstorming still uses real Codex in this mixed setup. GitLab investigation uses the user's configured real MCP connection. Mock Jira fixtures must not imply successful access to a repository that is not configured. Automated tests and the disposable fake preview may substitute the existing fake runner, but the enabled product flow never silently falls back to simulated conversation.

Credentials and connection configuration remain server-side in the existing profile/configuration system. Document setup requirements and identify missing configuration in the UI without adding an integration-management subsystem.

## Verification and acceptance

Use deterministic adapters and a fake runner for automated tests. Cover:

1. Assigned-open import, duplicate prevention across refresh/restart, query departure, failed sync, and preservation of conversation and draft edits.
2. Both entry paths: direct preparation and multiple real-shaped conversation turns leading to a prompt.
3. Repository mapping/selection, branch selection, MCP-access assignment construction, and provenance tied to the inspected commit.
4. Conversation and saved-draft restoration, explicit replacement by generated versions, source refresh during editing, and stale revision rejection without lost text.
5. Exact prompt and target submission, durable payload binding, repeated clicks, duplicate command replay, and disabled invalid actions.
6. Definitive launch rejection, acceptance followed by timeout, restart recovery, unknown lookup, and reconciliation without a duplicate launch.
7. Mode-specific scheduling and filtering, accepted/cancelled inspection, legacy task loading, and preservation of existing generic workflow behavior.
8. Keyboard access, labeled controls, saving/busy/error states, narrow-screen usability, and unmistakable mock labels.

Run the full existing test suite and production build. Inspect the disposable preview for both paths and failure states. Separately exercise a real read-only Codex conversation and GitLab MCP lookup when the user's configured connection is available; report any missing configuration as a verification limitation rather than treating fake-runner coverage as proof of live access. No real ONA launch or GitLab write is part of verification.

Acceptance is an imported Jira that can be discussed with real Codex, investigated through configured GitLab MCP, turned into an editable prompt, and submitted exactly once to the mock ONA adapter, with a persisted and visibly simulated receipt. The experience ends at Sent to ONA.
