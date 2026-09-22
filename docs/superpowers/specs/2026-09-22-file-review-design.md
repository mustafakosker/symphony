# Human review through synced Markdown files

## Intent and agreed interaction

Allow the user to answer questions, approve work, and reject work from their phone through the existing OneDrive-synced workspace. Automatic saving while writing must not count as submission. Keep the UI available as an alternative.

The agreed submission gesture is: edit the generated Markdown file, save and close the editor, then rename `name.md` to `name.ready.md`. Stop editing after submission. The coordinator ignores ordinary draft files regardless of how often they change.

This introduces a file-based input adapter to the existing human-command path, not a second workflow engine. No implementation is authorized by this document alone.

## User experience

When a supported review becomes pending, create one file under `workspaceRoot/reviews/`. Use a readable task slug plus a unique request identifier in its filename. Existing tasks with pending reviews receive files when the feature is enabled.

For example, `java-upgrade-a1b2c3.md` contains:

```markdown
# Java upgrade

## Question
Which Java version is the project currently using?

## Instructions
Write your answer below. Save and close this file, then rename it
to java-upgrade-a1b2c3.ready.md to submit. Do not edit after submitting.

## Your response
action: answer

We currently use Java 17.
```

Actual question templates have an empty answer, not the example answer above. The generated filename and document explain exactly which actions are allowed.

For workflow and artifact reviews, the action starts blank. The user fills in `approve` or `reject`. Rejection requires a reason in the response body; approval requires no response text. Approval with nonempty feedback is rejected with an explanation, rather than silently discarding it or interpreting conditional approval. A workflow review includes the exact proposed steps, repository/action scope, and completion criteria. An artifact review includes relative links to the exact versioned artifacts plus the explanation of what approval permits next. Show a final completion warning when approval completes the task.

The coordinator writes a separate `name.receipt.md` with Accepted, Outdated, or Needs correction, an explanation, and the exact response it processed. This is the confirmation visible from the phone. The original submitted file is retained; its presence must never cause a second decision. The coordinator does not rewrite user response files or move them while the user may still be editing.

## Scope

First release supports question answers and workflow/artifact approvals and rejections. The template lists only the actions valid for that review. Rejection means rejecting the task, matching the UI; it does not mean requesting revisions.

Pause, cancellation, request-changes, and uncertain-run reconciliation remain available through the existing UI. In particular, a generic file answer must not trigger reconciliation or retry. No changes to agents, repository permissions, or task lifecycle semantics are included.

## Submission parsing and binding

Each export has a durable coordinator-owned request record beneath `localRoot/file-reviews/`. It binds a unique token and exact filename to the task ID, task revision, review ID, review kind, workflow version, attempt association where present, and artifact versions/digests. The user never enters these identifiers manually. Changing readable task titles or text cannot change the target decision.

The request record also stores the generated document prefix, through the `## Your response` heading. On submission that prefix must match after normalizing CRLF to LF. This prevents accidental edits to the displayed question or approval scope being treated as approval of different work. Only the action line and response body are editable. The action line is a single `action: answer`, `action: approve`, or `action: reject`; reject unknown actions and duplicate action fields. The remaining body is plain Markdown text and is never executed.

Only exact issued filenames with the `.ready.md` suffix are actionable. Conflict copies and unknown filenames produce a visible issue rather than being guessed at. Read bounded UTF-8 regular files, reject symlinks and path escapes, and apply the existing 1 MiB intake limit.

Require identical bytes across two observations at least `stableMs` apart. Then capture an immutable local snapshot and its digest before validating or applying it. The settling interval reduces incomplete-delivery problems; it is not proof of user intent or a guarantee of sync ordering. The rename is the user's submission signal. The receipt identifies the exact bytes accepted. This design intentionally does not promise to infer unseen later edits from another device.

## Exactly-once decisions and competing UI input

Translate a valid snapshot into the existing `Command` and call `applyHumanCommand`. Use the issued token as the stable request ID and the captured revision and review binding; do not replace these with newer values to force acceptance. For approval, supply only the artifact digests from the trusted request record and validate the recorded workflow/artifact binding against current state.

The existing store remains responsible for serialization, revision checks, domain validation, and idempotent command application. If the UI already answered or the reviewed work changed, the file is Outdated and cannot act on a newer question or workflow. The first valid decision accepted by the store wins. Replays cannot execute twice, including after restart.

Persist a request's submission snapshot and operation identity before applying the command. After a crash, recover that same operation and write its receipt; never substitute newly synced bytes for an operation already attempted. A receipt-write failure retries receipt publication, not the decision. Changed bytes under an already consumed token cannot replace an accepted answer.

## Corrections and durability

Invalid submissions leave the task paused and preserve the captured input. The receipt explains the error. Retire the submitted token and issue a fresh draft for the same still-pending review, carrying forward the response where possible. The user corrects that draft and renames it to submit again. Never reuse a rejected/invalid token, since delayed sync could replay its previous contents.

Only issue a replacement after the prior request's terminal outcome has been durably recorded. Export files with create-only writes. Do not regenerate a request merely because its draft filename disappeared: it may have been renamed on another device. Recover exports from the durable request record after restart. If local request records are missing, fail closed on old submitted files and surface an issue; never reconstruct trusted bindings from user-editable content.

## Integration

Add an opt-in `fileReviewsEnabled` setting, default false. Enabling it creates `reviews/` and the host-local request store. The coordinator's existing serialized loop scans submissions and exports pending reviews before dispatching eligible work. Accepted file decisions enter the same task-wide pause/resume rules and audit history as UI decisions. File-review failures appear in workspace issues as well as receipt files where possible.

The file adapter owns request export, parsing, snapshots, and receipts. `applyHumanCommand` continues owning the bridge to task commands. The task store and domain logic retain ownership of workflow validity. A lost sync connection leaves work waiting; no cloud API or internet-accessible service is required.

## Verification

- Repeated autosaves to `.md` never dispatch a decision.
- Renamed files require stable observations, allowed actions, and required text.
- Answers resume the correct question; approvals bind exact workflow/artifacts; rejections require feedback.
- Edits to question/scope text, unknown filenames, conflict copies, oversized files, and symlinks are rejected.
- UI/file races, outdated requests, and repeated sync events cannot apply a second or newer decision.
- Restart before/after command commit and receipt publication preserves one recorded decision.
- Invalid submissions produce a clear receipt and a fresh correction draft without overwriting user edits.
- Disabled mode preserves the current UI-only review behavior.
- Manually exercise edit, close, rename, receipt, and correction on the intended phone editor and OneDrive deployment before claiming real sync compatibility.

## Approval status

The user approved renaming as the submission gesture. This written design is pending user review before implementation planning.
