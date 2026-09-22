# Symphony UI replacement

## Status and purpose

The user approved the visual direction and revised density on 2026-09-22, then authorized implementation planning after receiving this written specification. Implementation awaits review of the plan and selection of its execution method.

Replace Symphony's existing presentation with a task workspace inspired by Linear's layout discipline, using actual shadcn/ui components, Geist Sans, and the user's charcoal/lavender palette. Success means users can scan their tasks, open a focused task page, inspect agent work, and answer or approve reviews through a consistent, readable interface.

The user explicitly chose visual design adoption rather than Linear project/issue integration. The approved revision combines a full task list, a dedicated task page, larger supporting text, and tighter margins.

## Approved reference

The approved local mockup is `.superpowers/brainstorm/89686-1790077496/content/geist-workspace-v3.html`, with `density-refinement.css` overriding the initial styles. These ignored companion files are a visual reference; the production UI must be implemented with shadcn/ui components. Illustrative tasks, mock notifications, the design-review header, and preview-only controls do not become product content.

Reference sources:

- [Linear's design refresh](https://linear.app/now/behind-the-latest-design-refresh): restrained navigation, predictable location and view controls, subtle structural separation.
- [shadcn/ui](https://ui.shadcn.com/) and its [existing Vite project setup](https://ui.shadcn.com/docs/installation/vite).
- [Geist](https://vercel.com/font).

## Visual system

| Token | Value | Use |
| --- | --- | --- |
| Background | `#111113` | Application background and sidebar |
| Panel | `#19191C` | Main workspace and inset artifact rows |
| Raised surface | `#222226` | Review cards, selected navigation, menus |
| Main text | `#F0EFED` | Titles and primary content |
| Accent | `#A89BE8` | Primary actions, focus, active tab indicator |
| Secondary text | `#99989F` | Supporting descriptions |
| Metadata | `#8A8992` | Readable secondary labels at 12px |
| Subtle separator | White at 6% opacity | Passive grouping and panel boundaries |

The first five values are the user's exact palette. Metadata and control boundaries must meet contrast requirements on their actual surfaces; passive separators need not serve as interactive boundaries. Use restrained amber, green, and red only when communicating a meaningful state. Status always includes text or an accessible name.

Bundle Geist Sans locally with its license and use 400 and 500 weights. Use the existing system monospace stack for raw output. Avoid reliance on a font CDN at runtime.

| Typography | Size | Weight |
| --- | --- | --- |
| Task title | 26px desktop, 24px narrow | 500 |
| List title | 24px | 500 |
| Review title | 18px | 500 |
| Body, navigation, tabs, task rows, workflow titles | 14px | 400 or 500 |
| Buttons and compact property values | 13px | 400 or 500 |
| Metadata, supporting labels, secondary timestamps | 12px | 400 |

Body line height is approximately 1.65. Use a 4px spacing scale with the approved measurements as explicit exceptions: 208px sidebar, 224px property rail, 49px location bar, 47px task rows, 34px buttons, 22px review-card padding. The main task content has 30px top padding, 36px horizontal padding, and a maximum reading width of 920px. At wide desktop sizes, center that reading area within the available main pane. Review cards use an 8px radius; controls use approximately 6px. Reduce spacing at smaller widths without shrinking readable text.

## Layout and navigation

The desktop shell contains a subdued left sidebar and the main workspace. The sidebar provides Search tasks, All tasks, Needs review, Active, and Closed, with live counts from coordinator data. Its footer shows connection state and the personal workspace label. The location bar contains the current view and, on a task page, the task title.

The task list and task detail are separate main views. Opening a task gives its content the main pane rather than squeezing it beside a permanently visible list. A properties rail occupies the right edge of the task page. Clicking a sidebar view returns to its task list. The back control names the originating list (for example, Back to all tasks or Back to needs review), preserves its search/filter context, and returns keyboard focus to the selected row when it remains visible.

Fresh sessions open All tasks. Presentation preferences retain the selected task, list filter, and current list/detail screen across reloads. Existing stored selected IDs and filters remain readable; legacy preferences with a selected ID and no screen field restore the detail screen. A stored ID that no longer exists produces a Task unavailable view when opening/restoring that detail, instead of selecting an unrelated task. All preference storage is optional and failure-tolerant.

Search operates on the existing title, brief, type, and source fields. The sidebar search control and Command/Ctrl+K open the current list and focus its search input. They do not launch a new command-palette subsystem. Sidebar navigation preserves the query; submitting a draft clears the query and returns to All tasks, matching existing submission behavior.

## Task list

Use compact rows with a status icon, title, current status/review label, and task type where space permits. Render real task data without fabricated issue numbers, dates, owners, or progress. Titles may truncate in the list; the task page exposes the complete title.

All tasks is grouped into Needs review, Active, Waiting, and Closed, omitting empty groups. Waiting catches nonterminal tasks awaiting a human without an actionable review, so every task remains reachable. Preserve the existing filter predicates: Active includes triaging, queued, running, and blocked tasks; Closed includes done, rejected, and cancelled. Within each group, preserve coordinator order. Display blocked, pausing, and cancelling states accurately even when grouped with active work.

New task opens the draft dialog. Empty workspace, empty filter results, and no search matches have distinct copy and appropriate actions. Initial loading uses skeleton rows; connection failure must not fabricate tasks or imply an empty successful response.

## Task page and review content

The task header shows title, brief, type, status, and workflow version. The desktop properties rail contains status, type, current step, source, task ID, and workflow version. Long identifiers wrap or use an accessible overflow treatment. Next-step guidance appears only when it can be derived accurately from the current workflow; uncertain cases omit it.

Task sections use Overview, Activity, and Artifacts tabs:

- Overview displays actionable reviews prominently, followed by the workflow and applicable task controls. The current workflow step is expanded initially. Users can expand completed, upcoming, or stale steps independently.
- Activity displays existing run summaries and review decisions/answers. Preserve the information currently available and show timestamps only when recorded; do not invent a complete chronological audit log from undated review data.
- Artifacts exposes saved versions for active and closed tasks, including previews and downloads. Review cards continue to show the exact versions being reviewed, even if newer versions exist elsewhere.

Preserve every current review kind: workflow, artifact, question, pause, and reconciliation. Questions have an answer field; changes and rejection require feedback; reconciliation requires its resolution note. Workflow review exposes proposed steps, role permissions, repositories, inputs, outputs, and completion checks before approval. Proposed and approved workflow histories remain distinguishable.

Artifact/workflow approval is the primary lavender action. Request changes reveals an inline feedback form. Rejection is available through a clearly labeled dropdown action that reveals a required reason field; it must not submit on menu selection alone. Pause reviews provide Continue. When multiple reviews are pending, only the first eligible review is actionable, preserving the existing ordering rule.

Preserve pause, cancel, blocked-task retry/reconciliation, and insert-review-before-step behavior and their existing eligibility conditions. Place task-wide controls in a labeled task action menu; keep recovery instructions near the blocked state. Run output remains expandable within the relevant step, with its existing streaming/polling and error behavior. Completed, rejected, and cancelled tasks remain inspectable with mutation controls unavailable.

Submitting commands preserves review IDs, the expected task revision, request identifiers, and artifact digests through the existing command boundary. Reviews remain bound to their existing workflow versions. Busy states prevent duplicate submission. Failed submission retains entered text and displays the error beside the affected control.

## Draft dialog

Use a shadcn/ui Dialog with the existing optional title hint and required Markdown brief. Preserve the current Markdown payload construction, length constraints, request identity, and submission receipt behavior. A successful submission shows Submitted; waiting for pickup, rather than immediately creating a client-side task.

Use the dialog primitives' focus management, keyboard behavior, and return focus. Preserve the draft after a failed request. Disable submission during a request or disconnect. Copy describes the configured coordinator intake without assuming that every local workspace uses OneDrive.

## Responsive and accessible behavior

At 1150px and below, reduce the sidebar to approximately 184px, the property rail to 190px, and main padding to 26px. Below 950px, move task properties into an accessible collapsible section in the task page instead of hiding access to that information. Below 650px, expose sidebar navigation in a shadcn/ui Sheet with a visible menu trigger, use 20px main horizontal padding, and show one primary view at a time. Mobile users must retain search, filters, New task, review actions, and a visible back control.

Use semantic navigation, real buttons/links, labeled fields and icon controls, and accessible Tabs/Dialog/DropdownMenu/Sheet behavior. Focus indicators use the lavender token. New task and feedback flows return focus predictably. Keyboard users can navigate task rows, open details, and return to the list. Essential text meets WCAG AA contrast; state is never communicated by color alone. Respect reduced motion and avoid automatic scrolling that interrupts reading live output.

## Component and data boundaries

Keep React, TypeScript, Vite, Tailwind, Lucide icons, and the current coordinator API. Adopt the Radix-backed shadcn/ui component variants consistently, using copied component source under `src/components/ui`, the shadcn configuration file, a shared class-name utility, and semantic CSS theme tokens. Add only the components actually used: Sidebar, Button, Badge, Tabs, Dialog, Sheet, DropdownMenu, Input, Textarea, Label, Collapsible, Separator, Skeleton, and Tooltip as needed. A bespoke data-table engine is unnecessary for the current task list.

Separate the workspace shell/sidebar, task list, task header/properties, review cards, workflow steps, artifact viewer, and draft dialog into focused components. Extract artifact preview behavior from ReviewPanel for reuse in review cards and the Artifacts tab. Centralize tokens and shared primitives rather than styling each screen independently.

`useWorkspace` and `workspaceApi` remain the server-state boundary. `useTaskCommand` remains the command construction/submission boundary. Existing presentation helpers remain the source for filter/status semantics. UI navigation state contains only presentation choices, never authoritative task state. Existing artifact preview size limits, abort behavior, content-type checks, version URLs, and run-output boundaries remain intact.

Replace the old app shell, inbox/detail presentation, workflow/review styling, and dialog styling. Remove obsolete CSS and unused presentation components after their replacements are connected. Keep coordinator, filesystem stores, scheduling, file review integration, persisted tasks, and shared API contracts unchanged. No Linear API connection, backend redesign, workflow editor, light theme, or theme settings are included.

## Connection and error states

Use a compact sidebar connection indicator with correct connected, degraded, or disconnected status. A degraded coordinator must not appear fully healthy. When disconnected, keep the last known list/detail available and visibly stale; disable all mutations and draft submission. Initial unavailability shows a connection failure state. Workspace issues and polling errors remain visible in a consistent alert region, with command and artifact errors local to their affected content.

## Verification and acceptance

Update tests around intended user behavior where navigation changes from split-pane to list/detail. Preserve existing tests for domain and API guarantees. Add focused coverage for list/detail navigation, restored preferences, accessible tab/dialog behavior, filtered/empty states, mobile navigation, and review feedback interactions. Verify missing selection, disconnect and disabled actions, exact artifact-version approval, all review kinds, command failures, terminal states, and artifact previews without weakening existing assertions about data integrity.

Run `npm test -- --run` and `npm run build`. Use the disposable fake coordinator preview to inspect populated, empty, pending-review, running, blocked, closed, and disconnected states. Check the approved desktop composition at approximately 1512px, an intermediate width, and a narrow 390px viewport. Verify keyboard focus, text contrast, content overflow, actual Geist loading, and consistent component spacing. The fake preview may execute fake workflows only; do not exercise real task mutations solely for visual verification.

The work is accepted when the old UI has been fully replaced with the approved system, real shadcn/ui components are used, every existing coordinator workflow remains reachable, and the tests, build, and browser checks pass.
