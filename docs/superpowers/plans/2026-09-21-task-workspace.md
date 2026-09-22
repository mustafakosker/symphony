# Task Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an interactive inbox and task journey prototype for supervising task automation.

**Architecture:** A standalone React application owns a typed task collection, selected task, and activity history. A pure transition function enforces the workflow; focused components render the inbox, selected task, and stage actions. Browser storage preserves demo state.

**Tech Stack:** React, TypeScript, Vite, Tailwind CSS; Vitest for workflow and persistence tests.

**Spec:** `docs/superpowers/specs/2026-09-21-task-workspace-design.md`

## Global Constraints

- The immediate deliverable is a frontend prototype using mock data; the coordinator loop and real integrations are future work.
- Task type (Idea, Bug, or Jira) is independent of stage.
- All generated plans, logs, verification results, and production outcomes are visibly marked as demo content.
- Terminal tasks remain inspectable with editing and transition actions disabled.
- Backend services, authentication, real automation, custom stage editing, and production deployment are outside this prototype's scope.
- Use the approved React, TypeScript, Vite, and Tailwind CSS stack.
- The workspace has no Git repository; do not assume worktree or commit operations are available.

## Review Focus

1. Whitespace-only task titles: reject submission with a labeled inline error (Task 2 browser check).
2. Repeated or stale stage actions: reject invalid transitions without adding activity (Task 1 test).
3. Corrupt or unavailable browser storage: recover seed data or continue in memory with a notice (Task 1 tests).
4. Filters hiding the selected task: retain the detail view; creating a task clears filters so its new row is visible (Task 2 browser check).
5. Long descriptions and narrow screens: wrap text, contain command overflow, and preserve navigation and review actions (Task 3 browser check).

## File Structure

- `package.json`, `index.html`, `tsconfig*.json`, `vite.config.ts`: application commands and build configuration.
- `src/main.tsx`, `src/styles.css`: React entry point, Tailwind import, typography and shared visual tokens.
- `src/tasks/model.ts`: types, stage metadata, and allowed transitions.
- `src/tasks/fixtures.ts`: varied sample tasks and demo artifacts.
- `src/tasks/storage.ts`: validated local persistence and recovery.
- `src/tasks/model.test.ts`, `src/tasks/storage.test.ts`: behavioral tests.
- `src/App.tsx`: task state, selection, filters, and action callbacks.
- `src/components/Inbox.tsx`: search, filters, counts, and task rows.
- `src/components/NewTaskDialog.tsx`: validated creation form and keyboard dialog behavior.
- `src/components/TaskDetail.tsx`: description, source, stage journey, and terminal summary.
- `src/components/StageCard.tsx`: expandable stage artifacts and appropriate actions.
- `README.md`: local run instructions, demo controls, and limitations.

### Task 1: Establish the app and tested task workflow

**Files:** Create configuration, entry point, styles, all `src/tasks/` files listed above.

**Interfaces:** Produce these shared types and functions:

```ts
type TaskType = 'idea' | 'bug' | 'jira';
type Stage = 'draft' | 'analysis' | 'plan-review' | 'implementation'
  | 'result-review' | 'done' | 'rejected' | 'canceled';
type Action = 'start-analysis' | 'complete-analysis' | 'approve-plan'
  | 'complete-implementation' | 'approve-result' | 'request-changes'
  | 'reject' | 'cancel';
type Activity = { id: string; at: string; stage: Stage; message: string };
type Task = {
  id: string; title: string; description: string; type: TaskType;
  stage: Stage; source: string; activity: Activity[];
};
type Snapshot = { version: 1; tasks: Task[]; selectedId: string | null };
// Export the types above and these functions from their owning modules:
// model.ts
function transition(task: Task, action: Action, note?: string): Task;
// fixtures.ts: a factory returns fresh data for seed/reset/tests.
function createSeedTasks(): Task[];
// storage.ts: Storage is the browser's Storage interface.
function loadSnapshot(storage: Storage): { snapshot: Snapshot; notice: string | null };
function saveSnapshot(storage: Storage, snapshot: Snapshot): string | null;
```

- [ ] Check Node/package manager availability; consult current official Vite and Tailwind setup instructions before installing compatible dependencies. Create the React TypeScript app directly in the workspace while preserving `docs/`. Include `dev`, `build`, and `test` scripts. Use Tailwind's Vite integration:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({ plugins: [react(), tailwindcss()] });
```

```css
@import "tailwindcss";
```

- [ ] Write workflow tests before implementation, including the normal path, both change-request loops, blank review notes, reject/cancel, and invalid actions. Example test bodies with imports from `vitest`, `./model`, and `./fixtures`:

```ts
it('requires a plan review before implementation', () => {
  const draft = { ...createSeedTasks()[0], stage: 'draft' as const };
  expect(() => transition(draft, 'approve-plan')).toThrow();
  const analysis = transition(draft, 'start-analysis');
  const review = transition(analysis, 'complete-analysis');
  expect(transition(review, 'approve-plan').stage).toBe('implementation');
});
it('retains change feedback and blocks stale approval', () => {
  const task = { ...createSeedTasks()[0], stage: 'plan-review' as const };
  const changed = transition(task, 'request-changes', 'Cover retry failures');
  expect(changed.stage).toBe('analysis');
  expect(changed.activity.at(-1)?.message).toContain('Cover retry failures');
  expect(() => transition(changed, 'approve-plan')).toThrow();
  expect(() => transition(task, 'request-changes', '   ')).toThrow();
});
it('prevents reopening terminal tasks through stage actions', () => {
  const task = { ...createSeedTasks()[0], stage: 'done' as const };
  expect(() => transition(task, 'cancel')).toThrow();
});
```

- [ ] Run `npm test -- --run`; confirm failures concern missing workflow behavior. Implement an explicit stage/action map, immutable updates, required trimmed review notes, and one activity entry per successful transition. Map change requests from Plan review to Analysis and Result review to Implementation; permit Reject only at Plan review and Cancel only before terminal states.
- [ ] Seed six or more realistic tasks across Draft, Analysis, Plan review, Implementation, Result review, and Done, spanning all three types. Include readable descriptions and activity. Derive clearly labeled demo artifacts from task title/type rather than suggesting real agent output.
- [ ] Write storage tests using a small in-memory Storage stub; cover invalid JSON, structurally invalid tasks, unknown stages, stale selected IDs, and a throwing `setItem`. For corrupt data expect a valid seeded snapshot; for failed saves expect a nonempty notice. Run tests failing, then implement guarded JSON parsing and runtime validation under key `symphony-demo-v1`.
- [ ] Run `npm test -- --run` and `npm run build`; resolve failures before continuing.

### Task 2: Build the interactive inbox and journey

**Files:** Create `src/App.tsx` and all listed components; extend `src/styles.css`.

**Interfaces:** Consume Task, Stage, Action, transition, fixtures, and storage from Task 1. App owns mutations and passes callbacks to components:

```ts
type InboxProps = {
  tasks: Task[]; selectedId: string | null; query: string;
  filter: 'all' | 'review' | 'active' | 'closed';
  onSelect: (id: string) => void; onQuery: (query: string) => void;
  onFilter: (filter: InboxProps['filter']) => void; onNew: () => void;
};
type TaskDetailProps = {
  task: Task; onAction: (action: Action, note?: string) => void;
  onDescription: (description: string) => void; onBack: () => void;
};
type NewTaskDialogProps = {
  open: boolean; onClose: () => void;
  onCreate: (input: Pick<Task, 'title' | 'description' | 'type'>) => void;
};
type StageCardProps = {
  task: Task; stage: Stage; expanded: boolean;
  onToggle: () => void; onAction: (action: Action, note?: string) => void;
};
```

- [ ] Build a neutral light workspace: subtle tinted canvas, white panels, dark text, one accent color, readable stage badges, and restrained typography. Use approximately 340px for the desktop inbox and the remaining width for details, with independent scrolling. At narrow widths show one panel with Back to inbox navigation.
- [ ] Implement combined title/description search and filters: Review includes both reviews; Active includes analysis and implementation; Closed includes all terminal outcomes. Show counts, current selection, attention indicators, source/type labels, and empty states.
- [ ] Implement a native dialog with labeled title/type/description controls, Escape dismissal, restored trigger focus, inline blank-title validation, and trimming. Creation generates a unique ID, records initial draft activity, selects the task, clears filters, and opens details.
- [ ] Render all six normal journey stages. Expand the current stage on selection or progress, preserve inspectability of completed stages, label upcoming stages, and display rejected/canceled outcomes separately. Only Draft descriptions are editable. Show coordinator notes, a sample plan, command output, verification summary, and prompt/command/integration chips as relevant stage artifacts.
- [ ] Wire the exact actions from the spec to `transition`. Ask for a note when requesting changes and retain it in activity. Present transition failures inline. Update list badges, details, and persisted state together; keep a filtered-out selection visible in details.
- [ ] Use an explicit Demo label and clearly named simulation buttons for analysis and implementation. Display a simulated production summary only when Done. Include reset confirmation and a persistence failure notice.
- [ ] Check in browser: create a task, reject a whitespace title, search it, apply a filter that hides its row, and confirm details remain visible. Create another task and confirm filters reset. Walk a task through both review loops to Done; inspect retained feedback. Verify Reject and Cancel end tasks and disable actions.

### Task 3: Verify, polish, and document the prototype

**Files:** Refine existing UI as needed and create `README.md`.

**Interfaces:** No new public interfaces; preserve the tested transition and component contracts.

- [ ] Check desktop at roughly 1440×900 and mobile at roughly 390×844. Test a long unbroken task title and multiline description; verify no page-wide horizontal overflow, command blocks scroll internally, and action controls remain reachable.
- [ ] Verify keyboard navigation through inbox, modal, stage accordions, and review controls. Use buttons with `aria-expanded` for stages, visible focus outlines, text alongside status colors, and labels associated with inputs. Confirm modal focus returns after close.
- [ ] Refresh after creating a task and after a review action; verify task state, selection, and activity survive. Reset with cancellation first, then confirmation; verify only confirmation resets data.
- [ ] Run `npm test -- --run` and `npm run build`. Fix newly found issues and rerun the affected checks. Inspect browser console for errors.
- [ ] Add README commands and limitations:

```sh
npm install
npm run dev
npm test -- --run
npm run build
```

Explain the demo stage buttons, browser-only persistence, reset behavior, and that integrations/coordinator/deployment are simulated.
- [ ] Review the final result against every spec section, report actual verification outcomes, and provide the local preview address when a development server is running.

## Execution outcome

Implemented in place. All 24 workflow/storage/DOM tests pass, and the production build passes. Real-browser desktop/mobile inspection and native focus checks are blocked by missing Computer Use permissions; see `../execution/progress.md` for details.

## Execution recommendation

Use native execution in this session. These three tasks share a small state model and tightly coupled UI, so implementing sequentially keeps interface coordination low. Obtain user review of this plan and their execution-method choice before implementation, per the writing-plans skill.
