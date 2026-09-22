# Native Codex terminal sessions in Symphony

## Status and agreed intent

The user approved the conversational design and this written specification on 2026-09-22. Implementation planning is authorized. Implementation awaits review of the resulting plan and selection of its execution method.

The user wants an experience like Xirp's embedded agent terminals and session switching, using the actual Codex CLI interface. The initial purpose is to start with an idea, discuss it with Codex using a selected project's code, and turn the agreed brief into a Symphony task. For this release the project is fixed to Symphony at `/Users/mustafakosker/projects/symphony`, and sessions are read-only.

Success means the user can open the Codex workspace tab, start or revisit an idea conversation, see and operate the native terminal interface, investigate committed Symphony code without changing it, and deliberately submit a reviewed brief through the existing task intake.

## Scope and relationship to other work

This is a new terminal-session subsystem alongside the existing sequential coordinator. The coordinator continues to own submitted tasks, runs, artifacts, and reviews. Interactive sessions are not coordinator assignments and do not consume coordinator run slots.

Included:

- A Codex workspace destination with a session list, New session, Stop, Resume, and Create task controls.
- The real installed Codex CLI running in a server-owned pseudoterminal, displayed in the browser.
- A fixed Symphony source, one committed snapshot per conversation, and visible read-only status.
- Reconnection to running processes after navigation or browser refresh, plus conversation resumption after process or application shutdown.
- Manual selection of a Codex response to prefill the existing editable task draft.
- Host-local session storage, bounded terminal buffers, process cleanup, and verified read-only enforcement.

Project selection, cloning, branch selection, other agents, editing code, writable Git worktrees, split-terminal grids, remote access, automatic task creation, and controlling existing task workflows from Codex are outside this release. A session has a generated date/time label and can be distinguished by creation time; custom naming, deletion, and archival are not part of this slice.

The [project-connection design](2026-09-22-project-connection-design.md) remains a separate pending feature. Reuse its committed-source and read-only principles, but do not implement its project catalog, generated briefs, source viewer, or connection flow as a prerequisite. Do not change that document's approval status.

This first handoff submits ordinary Markdown. It does not introduce a formally bound connected-project task or promise that later coordinator assignments inherit the interactive session's repository access or conversation history.

## User experience

### Workspace and terminal

Add Codex as a destination in the existing workspace navigation. Selecting it shows a session list beside a large terminal panel. On narrow screens the session list becomes a compact selector above the panel. Keep the current Symphony layout and components around the terminal; the terminal contents come directly from Codex.

The header shows `Symphony`, `Read-only`, and the snapshot's abbreviated commit. A small context description explains that the conversation uses committed code captured when it began. There is no editable project or repository path field.

The empty state offers New session. Starting one captures the current Symphony `HEAD` commit and opens Codex with brief instructions about the source snapshot, brainstorming purpose, read-only scope, and final task-brief handoff. Do not start an idea discussion or model turn until the user types an idea; startup context must use configuration/instructions rather than automatically submitting an initial user prompt.

The terminal supports normal Codex text input, streamed output, terminal prompts, keyboard navigation, selection, copy/paste, scrolling, and resizing. Use Codex's supported `--no-alt-screen` option on launch and resume so its native inline interface retains terminal scrollback for response selection. Preserve Codex's native colors and layout. Browser-reserved shortcuts can differ from a desktop terminal; document the supported copy/paste and focus shortcuts without claiming exact keyboard parity.

Workspace shortcuts must not steal input while the terminal is focused. In particular, the existing global Command/Ctrl+K handler must defer to the terminal in that case. Users can leave terminal focus and reach the session controls by keyboard. Avoid announcing every output byte through an ARIA live region; use the terminal's accessibility support and concise status announcements.

### Session switching and lifecycle

Selecting another session or task detaches the visible terminal without stopping its process. Switching back and refreshing the browser reconnect to that same process while the Symphony server is running. Terminal reconnection must not send the user's input again or create a duplicate Codex process.

Stop terminates the session's Codex process and descendants and preserves its saved conversation. Exiting through Codex has the same stopped result. Resume starts a new terminal process against that session's isolated Codex history and its original snapshot. Starting New session uses the current source commit instead; an existing session never silently changes context when `HEAD` moves.

Application shutdown stops interactive processes. On the next startup, sessions are shown as stopped or interrupted, with Resume available after validation. They do not automatically restart or continue model work. Resuming restores Codex's saved conversation, not the old process or exact old screen contents. A session stopped before Codex saved a conversation is labeled accordingly and can be started again against the same snapshot.

The session list shows Preparing, Running, Stopped, Interrupted, or Unavailable. Running means a process exists; it does not infer whether the model is thinking, waiting for input, or finished. Do not parse decorative terminal output to guess agent state.

### Reviewed task handoff

The user asks Codex to write a final Markdown brief, selects the relevant terminal text, and presses Create task. Capture the selected plain text before moving focus or opening the dialog. With no selection, explain how to select a response; do not guess which screen text is the final answer or silently submit the entire terminal history.

Open the existing draft dialog with the selection as editable brief text and the title initially empty. Add a clearly separated, editable provenance paragraph identifying Symphony and the source commit. The exact Markdown that will be submitted must be visible in the editor, including that paragraph. Terminal wrapping and decorations may require user cleanup; do not claim the selection is a structured Codex message.

Opening and cancelling the dialog have no task-side effects. Submit draft uses the existing `/api/drafts` contract and request-ID retry behavior. After a successful receipt, show the normal submitted state and navigate to All tasks. Keep the Codex session available for later return. Failed submissions retain the edited text and the same request ID for retries of the same bytes; editing the payload starts a new submission identity.

The provenance paragraph is informational context in the brief, not an authorization record or a `projectId` binding. Existing triage and review rules continue to apply. Users may create more than one task from a conversation through separate, deliberate submissions.

## Committed source context

Keep the fixed source path in one server-owned constant, not duplicated in the browser or accepted from requests. Resolve and validate it as the expected Git repository before use. A missing source or missing `HEAD` makes new sessions unavailable with a specific explanation. Test fixtures inject a source only through a test-only dependency; there is no runtime arbitrary-path endpoint.

At first acceptance of a New session request, resolve `HEAD` to an exact commit and save that association before materialization. Retrying the same request reuses the same session ID and commit. A branch change during preparation cannot retarget the session. Detached `HEAD` is acceptable if it identifies a commit.

Materialize tracked blob bytes into Symphony-owned storage by enumerating the exact Git tree and reading objects. Do not create source worktrees, switch branches, modify the index, fetch, run hooks or checkout filters, or execute source scripts during preparation. Use read-only Git invocations with optional locks and automatic maintenance disabled. Do not use `git archive` transformations that omit or substitute committed bytes.

Uncommitted, staged, untracked, and ignored working files are excluded. Symlinks are recorded as inert manifest entries and never followed or created as live links. Submodules are recorded with their commit IDs but not populated. LFS pointer files remain pointer files; no downloads occur. Preserve regular committed file contents and record unsupported entries for display. The source snapshot has no live `.git` metadata connected to the original repository.

Limit preparation to 100,000 entries, 1 GiB of total regular-file content, and 64 MiB per regular file, matching the project-context design. Fail visibly on exceeding a limit instead of silently omitting files. Preparation has a two-minute deadline and bounded diagnostics. Partial snapshots cannot launch a session.

An immutable manifest binds the commit, relative file paths, object identities, content digests, and unsupported entries. Verify the snapshot before every new or resumed process. Retain it for as long as its session record exists; no automatic snapshot cleanup is introduced. If bytes are missing or changed, mark the session unavailable rather than replacing its context with a newer commit.

Launch Codex from a neutral session working directory and supply the snapshot path as code context. The snapshot is data to inspect, not a source of executable host configuration. Repository instructions such as `AGENTS.md` may inform the discussion but cannot expand permissions. Loading repository hooks, project MCP servers, or plugins is not part of this feature.

## Read-only execution boundary

Read-only is an execution requirement, not just text in the initial instructions. The restriction must cover agent tools, native terminal commands, subprocesses, permission changes through the CLI, and resumed sessions.

The initial supported host is this local macOS deployment. Use a macOS process sandbox around the entire interactive process tree, in addition to Codex's read-only sandbox and `never` approval policy. The proposed host mechanism is a generated `sandbox-exec` profile. Its availability was confirmed during design exploration; its compatibility with this Codex build has not been tested. Implementation acceptance requires the real probes below, and a failed probe leaves the feature unavailable rather than weakening its policy.

The host wrapper denies filesystem writes except in the selected session's explicitly separated Codex runtime and temporary directories, plus the minimum terminal device access necessary for the PTY. In particular it denies writes to the source repository, source snapshot, coordinator task store, session metadata, other sessions, and personal configuration. The configured runtime root happens to sit under the Symphony checkout in this deployment; only the specific runtime subdirectories are writable exceptions, not their repository ancestor. Validate canonical paths, ownership, and symlink boundaries before launch and resume.

Deny access to the coordinator's loopback HTTP port and unrelated local service sockets from the session process tree. This prevents terminal code from posting directly to task intake and bypassing the reviewed browser handoff. Only private IPC needed by that session's own Codex processes is permitted. All processes performing session tool execution must be inside the same host boundary; do not connect the terminal to an ambient shared daemon with greater access.

Use a dedicated, minimal Codex home for each Symphony session. Do not inherit personal or project MCP servers, hooks, plugins, external agent configurations, or unrelated environment credentials. Prepare authentication from the existing supported Codex login mechanism without logging tokens or modifying the user's personal Codex settings. Session-owned credential files, if required by that mechanism, use owner-only permissions. Symphony must not return their contents through session APIs, log them, or inject them into terminal output. If login needs attention, show an unavailable/authentication state and supported recovery instructions.

Model-service access remains necessary. This design promises filesystem write confinement and a denied path to local coordinator mutation, not comprehensive Internet isolation, a host file-read allowlist, or protection against a separate host user deliberately reconfiguring the application. Do not describe the snapshot or a read-only CLI flag alone as an operating-system security boundary.

Store verified terminal capability evidence separately from existing coordinator-role attestations. Bind it to the installed CLI identity, host policy digest, effective isolated configuration, source/snapshot/runtime scopes, and probe results. Changes invalidate readiness for new and resumed sessions. The browser cannot supply executable names, launch arguments, working directories, environment variables, or broader permissions.

## Architecture and data flow

Use a browser terminal based on xterm.js, a `node-pty` process adapter in the Node server, and a local WebSocket transport for terminal input/output and resize messages. Launch Codex directly through the verified sandbox wrapper with argument arrays; do not provide an intermediate general-purpose shell. Exiting Codex closes the session terminal.

Keep responsibilities separate:

| Unit | Responsibility |
| --- | --- |
| Source snapshot service | Resolve the fixed source commit, materialize committed files, and verify retained snapshots. |
| Session store | Own session identity, revision, creation request, context binding, lifecycle, and process ownership metadata. |
| Terminal policy/launcher | Prepare isolated Codex runtime, verify host confinement, spawn/stop the PTY process tree, and report exits. |
| Session manager | Serialize start/resume/stop, limit live processes, manage terminal buffers and controller leases, and recover interrupted sessions. |
| HTTP/WebSocket adapter | Validate requests and connection access; carry terminal messages without interpreting them as workflow commands. |
| Codex workspace view | Render the session list, native terminal, status, and selection-to-draft handoff. |

The flow is: browser New session request -> durable session/context record -> verified snapshot and policy -> one PTY process -> terminal output stream -> xterm.js. Keystrokes and resize events take the reverse path to the same owned PTY. Task submission follows the existing draft flow separately.

Do not retrofit the noninteractive `Runner` abstraction to act as an interactive terminal. Existing assignment timeouts, JSON result schemas, and coordinator scheduling are not appropriate session semantics.

### Session persistence

Persist host-owned records under `localRoot/codex-sessions/<sessionId>/`. Use separate subdirectories for trusted metadata, the source snapshot, and the process-writable Codex runtime/temp area. Records contain schema version, revision, session ID, creation request ID, generated label/timestamps, fixed source identity, commit/manifest digest, lifecycle state, launch generation, isolated-history location, and process ownership data when active.

Use atomic writes and serialized transitions per session. Persist intent before launching; distinguish requested launch, confirmed process ownership, and completed exit so partial startup can be recovered. Keep an application-lifetime ownership lock and validate PID/start identity before terminating any recovered process. Never kill an unrelated process because a PID was reused.

Each session home belongs to exactly one top-level conversation. Resume uses the installed CLI's native resume mechanism within that home; verify that it selects that conversation before enabling it. Do not use global `--last`, scrape screen output for IDs, or couple this feature to undocumented internal history-file schemas. A history mismatch or ambiguous recovery makes the session unavailable with a recovery explanation.

Browser storage holds only the selected workspace destination/session. It is not authoritative for session existence, permission scope, process state, or submitted task receipts.

### API and transport contract

Add a dedicated session API namespace, with validated UUIDs and bounded JSON bodies:

- `GET /api/codex/sessions`: readiness plus session summaries.
- `POST /api/codex/sessions`: create using a client request ID; idempotently return the owned session.
- `POST /api/codex/sessions/:id/resume`: resume a stopped session with request ID and expected revision.
- `POST /api/codex/sessions/:id/stop`: stop with request ID and expected revision; repeating the accepted request does not signal another process.
- `POST /api/codex/sessions/:id/connection`: issue a short-lived, one-use terminal connection ticket for the current launch generation.
- WebSocket upgrade under `/api/codex/sessions/:id/terminal`: consume the ticket and attach to the existing PTY, never spawn one.

Preserve the existing loopback-only listener. Require the exact allowed browser origin and reject cross-site requests for session mutations and WebSocket upgrades. Validate Host against the configured local listener and development origin as appropriate; do not trust forwarded headers. Carry the connection ticket as a WebSocket subprotocol value, not a URL query parameter or log field. It expires after 30 seconds, is tied to the session/generation, and is consumed once. Existing local same-user access remains part of the application's trust model.

Allow one controlling terminal connection per session. Another tab can list sessions but receives an explicit already-connected result when it requests control. The connection request accepts a `takeControl` boolean, default false. An explicit Take control action obtains a ticket that revokes the previous controller atomically on successful attachment, before accepting new input. Issuing a ticket alone does not disconnect the current controller. Reconnecting a controller cannot leave two writers. Detaching a connection does not terminate the PTY.

Transport messages carry launch generation and output sequence identity. Enforce a 16 KiB input-frame limit, 1 MiB/s input rate, and integer resize bounds of 20-400 columns and 5-200 rows. Reject input while disconnected, stopped, recovering, or attached to an old generation. A disconnected client's keystrokes are not queued for automatic replay.

The backend keeps a bounded headless terminal state, using a matching xterm.js version and serialization addon, with at most 5,000 scrollback lines and a 10 MiB serialized-state cap per live session. Trim the oldest scrollback as needed; this is a retained-state limit, not a cumulative output allowance that terminates a long conversation. On attach, capture a terminal-state snapshot at an output sequence and then stream only later output in order. Bound the catch-up queue to 1 MiB; a slow client is disconnected and can obtain a fresh snapshot without stopping Codex. Do not replay an arbitrary trailing byte slice as if it were a complete ANSI screen. Persist Codex conversation history, not unbounded raw PTY transcripts; terminal-state buffers need only survive browser disconnection, not server shutdown.

Start at most four live interactive sessions. Further starts/resumes explain that the user must stop a session first; there is no hidden queue. Retain stopped sessions. Do not apply coordinator assignment timeouts or inactivity termination to interactive conversations.

Treat all terminal output as untrusted terminal data. Do not render it as HTML, execute control-sequence clipboard writes, or automatically open links. Enable text selection and user-initiated copy; keep automatic link handling and clipboard-control extensions disabled in this slice. Error logs use IDs and bounded diagnostics without terminal contents, authentication material, or connection tickets.

## Failure handling and shutdown

Missing Codex, missing source, invalid snapshots, unavailable authentication, failed policy verification, and PTY failures affect the Codex feature and the relevant session. They must not prevent the existing task UI and coordinator from starting when those are otherwise healthy.

When launch fails, retain the session/context record and show a retryable or unavailable reason. Never fall back to an unrestricted process. When a socket drops, keep Codex running and show Reconnecting with input disabled. Acquire a fresh ticket for each connection attempt and use bounded backoff. A process exit closes its controller and updates durable status before offering Resume.

On graceful server shutdown, stop accepting session mutations/upgrades, close controller connections, stop all owned process trees with the configured grace period, persist their outcomes, and release ownership only after cleanup. Session cleanup and coordinator cleanup must both run even if one fails. Uncertain cleanup is recorded and blocks that session's next launch until reconciled; it does not launch a second copy.

On an ungraceful restart, validate recorded process identity and reconcile surviving owned processes before marking a session resumable. Uncertain ownership is an unavailable state with a clear diagnostic. This release does not attempt to reattach a new Node process to an orphaned PTY.

## Implementation boundaries

Expected implementation anchors are:

- New focused `server/codex-sessions/` modules for source snapshots, records, policy, PTY lifecycle, transport buffering, and orchestration.
- A separate HTTP session adapter integrated into [server/main.ts](../../../server/main.ts), including WebSocket upgrades and shutdown.
- Additive settings/readiness handling in [server/config/settings.ts](../../../server/config/settings.ts), with terminal failure isolated from coordinator readiness.
- A new Codex workspace view and terminal component, integrated through [src/App.tsx](../../../src/App.tsx), [WorkspaceShell.tsx](../../../src/components/WorkspaceShell.tsx), [WorkspaceSidebar.tsx](../../../src/components/WorkspaceSidebar.tsx), and [navigation.ts](../../../src/tasks/navigation.ts).
- A bounded initial-content input for [NewTaskDialog.tsx](../../../src/components/NewTaskDialog.tsx), preserving the existing empty-draft behavior and editing/submission semantics.
- A dedicated session API client and contracts; no permission to change coordinator task schemas is implied.
- WebSocket development proxy support in [vite.config.ts](../../../vite.config.ts), plus appropriate terminal CSS and exact, compatible dependency versions in the lockfile.

Avoid unrelated layout or workflow refactoring. The design adds a terminal destination and focused lifecycle services; it does not replace the application shell or existing runner.

## Verification and acceptance

Automated checks use disposable repositories, isolated temporary state, and a fake interactive executable. Cover:

- Capturing one commit despite retries or moving `HEAD`; excluding dirty/untracked content; inert symlinks/submodules; limits, partial preparation, and changed manifests.
- Idempotent creation/start/stop, concurrent clicks, stale revisions, launch failures, process ownership, shutdown, crash recovery, and the four-process cap.
- Origin/Host validation, expired/replayed tickets, cross-session/generation access, controller takeover, bounds, slow consumers, and input disabled during reconnect.
- Screen-state reconstruction with ANSI cursor movement, alternate-screen updates, resize, split UTF-8 bytes, and buffered output across a reconnect.
- Session switching without process restart, selected-text handoff, cancelling/editing/retrying drafts, and compatibility with ordinary task creation and navigation.

Run focused tests during implementation, then `npm test -- --run` and `npm run build`. Check the real browser terminal at desktop and narrow sizes, including keyboard focus, paste, selection, resize, reconnect, and two-browser-tab control contention. A fake PTY preview must be explicitly labeled and must never silently launch the user's real Codex session.

Before enabling real sessions, test the installed Codex CLI and host wrapper against a disposable repository. Confirm real native terminal rendering, supported authentication, startup without an unsolicited model turn, read access to committed context, reconnect, saved conversation selection, and resume after a Symphony restart. The locally inspected CLI version during design was `0.155.1`; implementation must verify the actual version and pin capability evidence to it.

Read-only probes must attempt writes through normal tools, direct terminal commands, a child process, and changed CLI permission settings. Check the source, snapshot, task store, personal configuration, session metadata, and another session's runtime. Also attempt coordinator HTTP mutation and access to an unrelated local daemon. Verify that permitted runtime/history writes still succeed and that source bytes, working-tree/index state, and refs remain unchanged. Run these checks on disposable fixtures, never on the user's company repositories.

Fake tests do not prove real host confinement. If authentication or the real boundary cannot be verified, report that limitation and keep live-session launch unavailable. Approval of this design does not waive these acceptance conditions.

## Source references

- [Xirp documentation](https://backstage.spotify.com/docs/xirp): reference for project-oriented persistent native agent terminals and session switching.
- [xterm.js](https://xtermjs.org/) and [node-pty](https://github.com/microsoft/node-pty): proposed browser terminal and pseudoterminal components.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server): the custom-client alternative considered earlier; a custom chat interface is not selected for this release.
- Locally inspected `codex --help`, `codex resume --help`, and `codex --version`: interactive launch, read-only flags, native resume, and the installed version. No interactive session or permission probe was launched while preparing this specification.

## Review handoff

The written specification is approved. The implementation plan must cover the native terminal, snapshot/session lifecycle, verified read-only boundary, task handoff, and validation. Implementation starts only after that plan has been reviewed and its execution method selected.
