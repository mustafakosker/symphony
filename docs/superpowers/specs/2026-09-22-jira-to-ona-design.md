# Jira documents and ONA handoff

## Status and intended outcome

Revised on 2026-09-23 following the user's request to remove brainstorming and attach externally prepared design and implementation documents before sending to ONA. The user approved this revised specification and requested an implementation plan. This revision supersedes the earlier conversational preparation design. Implementation awaits review of the plan and selection of its execution method.

Symphony brings open Jiras assigned to the user into their inbox. The user opens a ticket, attaches their design and implementation documents, reviews an editable launch prompt and target repository, and explicitly sends the complete package to ONA. Success is a persisted receipt for the exact package reviewed, not completed implementation or an existing merge request.

Jira intake and ONA handoff remain mocked behind replaceable server adapters. This flow requires no local Codex execution, conversational agent, generated plan, or GitLab repository investigation. Codex execution belongs downstream in ONA when the real integration is added.

The approved first version uses local uploads of Markdown or plain-text documents. Link acquisition and PDF/Word conversion are outside this first version.

## Scope and approach

Use a focused Jira handoff mode within existing Symphony tasks, reusing the inbox, task store, versioned artifacts, repository configuration, command boundary, and durable recovery patterns. Keep the entire preparation experience in the Jira task page.

Included:

- Automatic intake of assigned open Jira tickets and manual refresh.
- Separate Design document and Implementation plan attachment slots.
- Saved attachments, an editable launch prompt, and repository/branch selection.
- Explicit submission of a frozen package containing the Jira context, both documents, the exact prompt, and target.
- A mock ONA receipt, definitive-failure retry, and uncertain-outcome reconciliation.

Excluded:

- Brainstorming, chat, AI document analysis, prompt generation by an agent, and local Codex runs for these tasks.
- GitLab MCP investigation or source-code checkout before sending.
- Real Jira/ONA connectors, integration-management UI, and credential setup.
- Jira creation or updates; running implementation, opening or tracking merge requests, merging, or deployment.
- The separately specified Symphony UI redesign and a general document-management system.

Existing generic Symphony workflows remain unchanged. The editable launch prompt can request implementation, tests, and a GitLab merge request from the downstream ONA agent; the mock does not perform those actions.

## User flow

### 1. Open a Jira from the inbox

When explicitly enabled, sync Jira at server startup, every 60 seconds, and through Refresh Jira. Serialize sync operations. Fetch a complete normalized snapshot of tickets assigned to the adapter's configured current user and considered open by that source. Identify a ticket by connection plus immutable issue ID, rather than its displayed issue key.

New rows show the Jira key, title, source status, and local preparation status. Opening one displays the description, acceptance criteria when supplied, source link, attachments, launch prompt, and target. Importing, opening, editing, or attaching documents starts no agent.

Update the latest source snapshot for nonterminal tasks without replacing saved documents or prompt edits. Keep the original brief and source versions referenced by a submitted package. If a successful complete sync omits a previously imported ticket, retain its task with a notice that it no longer matches the assigned-open query. Failed or incomplete syncs cannot establish absence. Accepted and cancelled tasks keep their final snapshots and still prevent duplicate reimport.

### 2. Attach the documents

Provide two clearly labeled slots: Design document and Implementation plan. Each accepts one nonempty UTF-8 .md or .txt file, up to 1 MiB. Both are required before sending. Show the chosen filename, size, upload/save state, and access to the exact saved content.

Uploading persists the bytes as an immutable versioned artifact. Replacing a slot selects a new version; removing an attachment clears the selection while preserving historical artifacts. The active selections survive refresh. A failed replacement leaves the previous selected version intact and clearly reports the failure. The latest selected files must be explicitly visible before sending.

Render document previews as escaped plain text, and offer downloads. Original filenames are display metadata, never filesystem paths. Validate supported format, byte size, and UTF-8 content on the server. Do not summarize, rewrite, or judge the completeness of the documents.

### 3. Review the launch prompt and target

Initialize a saved, editable prompt from a fixed template when the user first prepares the handoff. For example: implement the linked Jira according to the attached design and implementation plan, run the plan's checks, and open a GitLab merge request with a summary and test results. This is deterministic template text; no agent generates it.

Show the complete prompt beside the selected documents and Jira context. The user can add instructions or replace the text. Do not append hidden implementation instructions at send time or automatically rewrite the draft after an attachment or source change. Keep a visible reminder when the Jira changed since the draft was initialized.

Suggest the repository through a configured Jira-project-to-Symphony-project mapping. Select automatically only when unambiguous; otherwise allow selection from configured repositories. This slice targets one repository. Default the target branch to its configured base branch and allow editing. No MCP lookup is performed, and the UI must not claim the repository or branch has been remotely verified.

Save prompt and target edits with visible saving/saved/error states. Preserve local text on failure and flush pending edits before leaving the form. Only saved data can be sent. Returning to the task restores saved attachments, prompt, and target.

### 4. Send to ONA

The review surface shows the exact prompt, both selected document versions, Jira snapshot, repository, and branch. Send to ONA is the explicit launch action; no additional generic workflow or artifact approval sequence is needed.

Require both successfully saved documents, a nonblank saved prompt, a configured repository, and a nonblank branch. Disable sending while an upload/save is pending or failed, the server is disconnected, or a handoff is sending, unconfirmed, or accepted.

Persist the frozen package before calling the adapter. Bind its task and request IDs, creation time, Jira identity and exact source snapshot, prompt revision/text, document roles and immutable artifact references/digests, and repository/branch. Verify document bytes against their digests before launch. The adapter receives the prompt and the actual document contents, not host-local paths that an ONA environment cannot access.

The eventual live adapter is responsible for materializing both files into the ONA environment and making their locations available to its Codex run. Its accepted response must mean that the complete package has been accepted for execution. Transfer mechanics and the live connector are outside this mock implementation.

### 5. Inspect the receipt

On acceptance, show Sent to ONA, the accepted time, receipt ID, exact submitted prompt, target, and both submitted document versions. The mock is labeled Simulated ONA handoff and does not invent a working environment or merge-request URL.

Sent tasks remain inspectable but cannot be edited or resubmitted in this slice. This is the end of the workflow; it does not indicate that implementation finished.

## State and persistence

The lifecycle is Inbox → Preparing → Ready to send → Sent to ONA, with Sending, Failed, and Handoff unconfirmed substates. Ready to send means the required saved fields and attachments are present, not that an agent validated the documents.

Add an optional, explicitly validated handoff preparation payload to the existing version-1 task format. Its presence identifies this mode. Store source snapshots, active document references, working prompt/revision, target, phase, and handoff attempts. Document and prompt bodies use existing versioned artifacts. Do not add conversation, turn, or generated-plan state.

Preserve existing revision checks, operation IDs, serialized task writes, event history, atomic publication, and artifact digests. Legacy tasks without this payload retain their current behavior; no destructive migration is needed. Reference artifacts in durable events only after their bytes are successfully published.

| Condition | Shared status | Display |
| --- | --- | --- |
| Imported, no preparation changes | waiting-for-human | Inbox |
| Attachments or required fields incomplete | waiting-for-human | Preparing |
| Required documents, prompt, and target saved | waiting-for-human | Ready to send |
| Submission pending | running | Sending to ONA |
| Definitive failure or unknown acceptance | blocked | Send failed or Handoff unconfirmed |
| Package accepted | done | Sent to ONA |
| Cancelled before sending | cancelled | Cancelled |

Needs review includes prepared packages awaiting submission and handoff failures needing attention. Incomplete tasks remain reachable in All tasks. Closed includes accepted and cancelled tasks. Mode-specific labels must avoid describing an accepted handoff as completed implementation.

Generic triage, Codex scheduling, and synced-file review processing skip these tasks. Their page exposes document, prompt, target, send, retry, reconciliation, and eligible cancellation controls. Cancellation before launch is allowed; it cannot claim to cancel an environment once sending begins. Editing is locked while sending or acceptance is unknown, preserving the package being reconciled.

## Component and API boundaries

### Jira intake

A server adapter returns normalized assigned-open snapshots, with explicit completeness and mock/live designation. The intake service validates records and uses deterministic task identity from connection/issue ID plus idempotent creation operations to prevent duplicates across refresh and restart. Configuration is opt-in so demo tickets are not silently injected into an existing workspace.

### Document and draft handling

Use focused document-upload/preview and prompt/target editor components in the existing task page. The server owns selected document versions and saved draft state. Extend the HTTP boundary with a bounded upload operation and explicit revision-checked commands to select/remove documents, save the prompt, select a target, send, retry, reconcile, and cancel. Refresh Jira is a workspace command; task mutations use expected task revisions.

Keep the existing global JSON request limit. A dedicated bounded file-upload operation handles documents separately rather than increasing limits for every API route. Preserve same-origin access checks and use server-generated artifact identities. Never use client-supplied paths as storage destinations.

Duplicate commands with identical IDs and content return their recorded outcome. Reuse of an ID with different content conflicts. Conflicting saves or uploads retain the user's input and display an actionable error without silently replacing a newer server version.

### ONA handoff

A dedicated service owns package freezing, validation, launch, and reconciliation. It calls a replaceable adapter exposing launch(package) and lookup(requestId). The stable request ID is the idempotency key. Lookup returns accepted with a receipt, definitively not accepted, or unknown; errors cannot count as proof of nonacceptance.

The mock keeps a durable ledger across restart. It accepts the complete document package without starting Codex or creating an environment. Deterministic test scenarios include acceptance, definitive rejection, and acceptance followed by a timeout. A future MCP/CLI connector implements the same contract.

## Failure and recovery behavior

- A Jira sync failure retains existing tasks and reports stale source data plus last successful sync time.
- An invalid or failed upload retains previous selected documents, blocks sending while unresolved, and reports how to retry or discard the failed replacement.
- A failed prompt/target save retains entered text. Disconnecting retains last-known data and disables mutations.
- Sending first records intent and the immutable package. A crash or timeout around launch leads to Handoff unconfirmed and lookup of the original request, never an automatic new launch.
- Reconciliation to accepted saves the original receipt. Definitive nonacceptance allows retry; unknown stays blocked. Unchanged retry uses the original key. Editing after definitive nonacceptance creates a new package and request for the next send.
- Duplicate clicks and process restarts cannot create multiple accepted environments for one request. Corrupt or missing document bytes block launch before the adapter is called.
- Submitted packages preserve exact document versions, prompt, source context, and target despite later Jira changes.

## Verification and acceptance

Automated tests use deterministic Jira and ONA adapters; this mode needs no fake or real Codex runner. Cover:

1. Assigned-open import, duplicate prevention across refresh/restart, failed/incomplete sync, and preservation of saved documents and draft edits.
2. Upload, preview/download, replace, remove, and restore both document roles; invalid formats, encoding, oversize files, and failed replacements.
3. Required-field readiness, repository mapping, branch editing, and explicit mock labels without claiming live repository validation.
4. Exact prompt/document bytes and target in the submitted package, digest verification, revision conflicts, and duplicate command handling.
5. Definitive rejection, accept-then-timeout, restart recovery, unknown lookup, and reconciliation without duplicate submission.
6. No Codex launches on import, open, upload, edit, or send; continued generic workflow behavior for legacy tasks.
7. Keyboard access, saving/upload/error states, narrow-screen usability, disconnection, accepted-task inspection, and eligible cancellation.

Run the existing full test suite and production build, then inspect the disposable preview for preparation, successful mock handoff, and failure/recovery states. No real ONA launch, GitLab write, or local Codex run is part of this feature's verification.

Acceptance is an imported Jira with the user's saved design and implementation documents, an editable launch prompt and target, and one explicit submission of that exact package to the mock ONA adapter, followed by a persisted, visibly simulated receipt.
