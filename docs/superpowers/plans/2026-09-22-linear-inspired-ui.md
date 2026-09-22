# Symphony UI Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Symphony's existing UI with the approved shadcn/ui, Geist Sans, charcoal-and-lavender task workspace while preserving every coordinator workflow.

**Architecture:** Keep the coordinator API, server state hook, command hook, and persisted task contracts intact. Replace the presentation with a sidebar, separate task list/detail screens, focused review cards, reusable artifact previews, and shared shadcn/ui primitives. Use semantic theme tokens and local Geist assets throughout.

**Tech Stack:** Existing React 19, TypeScript, Vite, Tailwind CSS 4, Lucide, Vitest, and Testing Library; add Radix-backed shadcn/ui primitives and locally bundled Geist Sans.

**Spec:** [Approved design](../specs/2026-09-22-linear-inspired-ui-design.md). Read the spec before executing any task.

## Global Constraints

- Background `#111113`; panel `#19191C`; raised surface `#222226`; main text `#F0EFED`; accent `#A89BE8`.
- Geist Sans weights 400 and 500, locally bundled with its license. No runtime font CDN.
- Body/navigation/tabs/rows 14px; metadata 12px; compact controls 13px; task title 26px desktop / 24px narrow; review title 18px.
- Desktop sidebar 208px; property rail 224px; location bar 49px; rows 47px; buttons 34px; review padding 22px; task content padding 30px 36px and maximum width 920px.
- Use actual shadcn/ui components and a single Radix-backed component family. No imitation component library or new table engine.
- Keep React, TypeScript, Vite, Tailwind, Lucide, `useWorkspace`, `workspaceApi`, `useTaskCommand`, and shared API contracts. Do not upgrade unrelated dependencies.
- Preserve exact artifact versions/digests, expected revisions, idempotent command IDs, all five review kinds, review ordering, recovery controls, terminal history, and disconnected-state restrictions.
- Preserve existing Active filter semantics, including blocked tasks. Every task remains reachable.
- Existing task data and `.symphony-local` configuration are outside the replacement scope. No Linear API integration, server redesign, workflow editor, light theme, or theme settings.
- Node.js 22.12 or newer, as required by the repository README. Use npm and retain `package-lock.json`.
- Visual reference: `.superpowers/brainstorm/89686-1790077496/content/geist-workspace-v3.html` and `density-refinement.css`. These are local design artifacts, not production code or dependencies.

## Review Focus

1. Legacy/malformed/unavailable browser preferences: restore a valid view, keep a missing selected task explicit, and remain usable when storage throws. Tests: Tasks 2 and 3.
2. A task command completing after navigation, or after a review revision changes: never switch the user back or reuse an obsolete request identity. Tests: Tasks 3 and 5.
3. Oversized, hostile, invalid-UTF-8, or changing artifact content: bounded literal-text preview, exact version URLs, cancellation, and no cross-task preview leakage. Tests: Task 4.
4. Narrow screens and long text: every navigation/review/property action remains reachable, dialog focus is contained and restored, and identifiers do not widen the page. Tests/checks: Tasks 1, 6, and 7.
5. Disconnection during an open review, or terminal tasks with old pending reviews: retain readable history and unsent text while disabling mutations. Tests: Tasks 3, 5, and 6.

## File ownership and sequence

| Files | Responsibility | Task |
| --- | --- | --- |
| `components.json`, `src/components/ui/`, `src/lib/utils.ts`, `src/hooks/use-mobile.ts` | Generated shadcn primitives and their required helpers | 1, 3 |
| `src/styles.css`, `src/styles/tokens.css`, `src/styles/workspace.css`, `src/styles/task.css` | Final CSS entry point, tokens, shell/list layout, task/review layout | 1, 3, 5–7 |
| `src/main.tsx`, `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts` | Font imports, dependencies, aliases, test setup | 1 |
| `src/test/setup.ts` | Minimal browser-API support for component DOM tests | 1 |
| `src/components/NewTaskDialog.tsx`, `NewTaskDialog.test.tsx` | Accessible draft submission | 1 |
| `src/tasks/navigation.ts`, `navigation.test.ts` | Pure preference parsing and navigation transitions | 2 |
| `src/tasks/presentation.ts`, `presentation.test.ts` | Existing status helpers plus list grouping | 2 |
| `src/components/TaskList.tsx`, `TaskList.test.tsx` | Searchable grouped list | 2 |
| `src/components/WorkspaceShell.tsx`, `WorkspaceSidebar.tsx` | Location bar, navigation, connection state, mobile sheet | 3 |
| `src/App.tsx`, `src/App.test.tsx` | Wire server state to screen navigation | 3 |
| `src/components/ArtifactPreview.tsx`, `ArtifactPreview.test.tsx`, `TaskArtifacts.tsx` | Reusable bounded previews and version lists | 4 |
| `src/components/ReviewPanel.tsx`, `ReviewPanel.test.tsx` | Review forms and exact approval decisions | 4, 5 |
| `src/components/WorkflowJourney.tsx`, `WorkflowJourney.test.tsx`, `StageCard.tsx`, `TaskActions.tsx` | Workflow progression, scope, logs, task actions | 5 |
| `src/components/RunOutput.tsx`, `RunOutput.test.tsx` | Existing log behavior with refreshed controls | 5 |
| `src/components/TaskDetail.tsx`, `TaskDetail.test.tsx`, `TaskProperties.tsx`, `TaskActivity.tsx` | Full task page, tabs, property rail, mobile properties | 6 |
| `src/components/Inbox.tsx` | Remove when its callers have moved to TaskList | 3 |
| `scripts/preview-fake.mjs`, `README.md`, `docs/superpowers/execution/linear-inspired-ui-verification.md` | Disposable visual fixtures, navigation documentation, evidence | 7 |

Sequence: 1 → 2 → 3 → 4 → 5 → 6 → 7. No server or shared-contract changes are expected. Keep the app buildable at each commit. Temporary legacy styling can support still-unconverted components between commits; Task 7 removes it completely.

## Before execution

- [ ] Read the spec, this plan, and applicable repository instructions. Use `superpowers:using-git-worktrees` to establish an isolated execution workspace, taking account of any existing managed worktree.
- [ ] Record baseline output before changing code:

```bash
git status --short
node --version
npm test -- --run
npm run build
```

If dependencies are missing, use `npm ci`; do not run dependency upgrades. Investigate baseline failures before attributing them to the redesign. Preserve unrelated work.

### Task 1: shadcn theme and accessible draft dialog

**Files:** Create `components.json`, `src/lib/utils.ts`, `src/styles/tokens.css`, `src/test/setup.ts`, `src/components/NewTaskDialog.test.tsx`, and generated UI primitives. Modify `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `src/main.tsx`, `src/styles.css`, `src/components/NewTaskDialog.tsx`, and relevant dialog assertions in `src/App.test.tsx`.

**Interfaces:** Keep `NewTaskDialog`'s current props: `{ open: boolean; onClose(): void; onSubmit(markdown: string): Promise<void>; canSubmit: boolean }`. Produce standard named shadcn exports under `@/components/ui/*` and `cn` from `@/lib/utils`. All subsequent tasks consume these primitives and tokens.

- [ ] Add `NewTaskDialog.test.tsx` with the existing jsdom/testing-library conventions, `afterEach(cleanup)`, and this failure-preservation case:

```tsx
it("retains a draft after a failed submission and permits retry", async () => {
  const user = userEvent.setup();
  const submit = vi.fn().mockRejectedValueOnce(new Error("Save failed"))
    .mockResolvedValueOnce(undefined);
  const close = vi.fn();
  render(<NewTaskDialog open onClose={close} onSubmit={submit} canSubmit />);
  await user.type(screen.getByLabelText("Brief"), "Investigate onboarding");
  await user.click(screen.getByRole("button", { name: "Submit draft" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
  expect(screen.getByLabelText("Brief")).toHaveValue("Investigate onboarding");
  expect(close).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Submit draft" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(submit).toHaveBeenNthCalledWith(2, "Investigate onboarding");
});
```

Add `useState` to the test imports and use this focused harness for description and focus behavior. Initially reuse the repository's native-dialog test polyfills so failures describe behavior rather than missing jsdom APIs; remove those polyfills after migrating to shadcn.

```tsx
it("describes coordinator intake and returns focus after Escape", async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>New task</button>
      <NewTaskDialog open={open} onClose={() => setOpen(false)}
        onSubmit={async () => {}} canSubmit /></>;
  }
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole("button", { name: "New task" }));
  expect(screen.getByRole("dialog", { name: "Submit a draft" }))
    .toHaveAccessibleDescription("Add a Markdown brief for the coordinator to pick up.");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.getByRole("button", { name: "New task" })).toHaveFocus());
});
```

Retain existing required-brief, title-hint payload, failed POST copy, and offline tests. Use real behavior tests rather than snapshots of class strings.

- [ ] Run `npm test -- --run src/components/NewTaskDialog.test.tsx src/App.test.tsx` and record the intended failure for the missing accessible intake description. Already-passing preservation cases are a baseline, not a reason to manufacture a failure.

- [ ] Configure the `@` alias without replacing existing compiler or Vite options:

```json
"paths": { "@/*": ["./src/*"] }
```

```ts
import { fileURLToPath, URL } from "node:url";
// Add this resolve property to the existing defineConfig object.
resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } }
```

Use the official [Vite installation](https://ui.shadcn.com/docs/installation/vite), [CLI](https://ui.shadcn.com/docs/cli), and [Radix component](https://ui.shadcn.com/docs/components/radix/button) instructions. Initialize the existing project with Radix (`npx shadcn@latest init --base radix`), choose the compact New York style and zinc base when prompted, set CSS to `src/styles.css`, retain Lucide, and enable CSS variables. Inspect generated changes before accepting a replacement of existing CSS. Do not scaffold a new application.

- [ ] Install the first set of real components and the local font package:

```bash
npx shadcn@latest add button dialog input textarea label
npm install @fontsource/geist
```

Import `@fontsource/geist/400.css` and `@fontsource/geist/500.css` in `src/main.tsx`. Keep the package license in the installed dependency and record the package in the lockfile. Preserve generated utility implementation and dependencies; do not mix component bases. Inspect the generated `components.json`, primitive imports, and lockfile.

- [ ] Define the semantic theme in `src/styles/tokens.css`; map these variables through Tailwind's `@theme inline` and retain any additional primitive variables generated by shadcn:

```css
:root {
  color-scheme: dark;
  --background: #111113;
  --foreground: #f0efed;
  --card: #222226;
  --card-foreground: #f0efed;
  --panel: #19191c;
  --popover: #222226;
  --popover-foreground: #f0efed;
  --primary: #a89be8;
  --primary-foreground: #211a34;
  --secondary: #222226;
  --secondary-foreground: #f0efed;
  --muted: #222226;
  --muted-foreground: #99989f;
  --metadata: #8a8992;
  --accent: #222226;
  --accent-foreground: #f0efed;
  --border: #ffffff0f;
  --input: #66636e;
  --ring: #a89be8;
  --radius: 0.375rem;
  --font-sans: "Geist", sans-serif;
}
```

Here shadcn's `--accent` means an interactive hover surface; the user's lavender accent is `--primary`/`--ring`. Map sidebar tokens to background, raised selection, foreground, and ring. Use 14px body text and a shared 34px/13px button default. Temporarily retain legacy component selectors after the theme imports; remove global old button/input rules that would override the new dialog.

- [ ] Replace native `<dialog>`/manual focus trapping with controlled `Dialog`, `DialogContent`, `DialogTitle`, `DialogDescription`, `Label`, `Input`, `Textarea`, and `Button`. Keep the current payload and async submission functions. Use `onOpenChange` only to notify close, store the opener, and restore it in `onCloseAutoFocus` because this dialog is opened from multiple external triggers. On each false-to-true open transition reset the form; do not reset fields on rerender, failure, or connection change. Focus Brief in `onOpenAutoFocus`.

```tsx
<Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
  <DialogContent aria-describedby="draft-description">
    <DialogTitle>Submit a draft</DialogTitle>
    <DialogDescription id="draft-description">
      Add a Markdown brief for the coordinator to pick up.
    </DialogDescription>
    <Label htmlFor="draft-brief">Brief</Label>
    <Textarea id="draft-brief" value={brief}
      onChange={(event) => setBrief(event.target.value)} />
    <Button disabled={busy || !canSubmit} onClick={() => void submit()}>
      Submit draft
    </Button>
  </DialogContent>
</Dialog>
```

The composition above is the migration anchor; retain the optional title field, validation, close button, form submission, busy feedback, and error rendering from the existing component around it. Ensure a Button inside the form has the intended submit/button type.

- [ ] Add only missing jsdom APIs needed by Radix to `src/test/setup.ts` and register it in the existing Vite test config. Guard browser-only setup with `typeof window !== 'undefined'` because server tests also run. Use a deterministic `matchMedia` stub with `addEventListener`/`removeEventListener`, and `scrollIntoView`/pointer APIs only if a failure demonstrates the need. Remove the obsolete `HTMLDialogElement` patches from App tests. Do not stub focus or silence component warnings.
- [ ] Run `npm test -- --run src/components/NewTaskDialog.test.tsx src/App.test.tsx` and `npm run build:ui`. Confirm valid draft payload, failed-request retention, Escape, offline state, and focus return. Commit the task's explicit files with `feat: establish shadcn theme and draft dialog`.

### Task 2: task grouping and list navigation model

**Files:** Create `src/tasks/navigation.ts`, `src/tasks/navigation.test.ts`, `src/components/TaskList.tsx`, and `src/components/TaskList.test.tsx`. Modify `src/tasks/presentation.ts`, `src/tasks/presentation.test.ts`, and the transitional Filter export in `src/components/Inbox.tsx`. Add Badge, Skeleton, and any required primitives through the shadcn CLI.

**Interfaces:** Export `Filter = 'all' | 'review' | 'active' | 'closed'` from presentation; export `TaskGroup = { id: 'review' | 'active' | 'waiting' | 'closed'; label: string; tasks: Task[] }` and `groupTasks(tasks: Task[], filter: Filter, query: string): TaskGroup[]`. Export `NavigationState`, `NavigationEvent`, `parsePreferences(raw: string | null): NavigationState`, and `navigate(state: NavigationState, event: NavigationEvent): NavigationState` from navigation. TaskList props: `{ tasks: Task[]; filter: Filter; query: string; selectedId: string | null; loading: boolean; canSubmit: boolean; onQuery(query: string): void; onSelect(id: string): void; onNew(): void; searchRef?: React.Ref<HTMLInputElement>; returnFocusId?: string | null }`.

- [ ] Add navigation tests using Vitest `expect/it` and the proposed exports. The following is an entire new test case:

```ts
it("reads legacy selection and retains it when returning to a list", () => {
  const state = parsePreferences(JSON.stringify({ selectedId: "task-a", filter: "review" }));
  expect(state).toEqual({ selectedId: "task-a", filter: "review", screen: "detail" });
  expect(navigate(state, { type: "back" })).toEqual({ ...state, screen: "list" });
  expect(parsePreferences("{broken")).toEqual({ selectedId: null, filter: "all", screen: "list" });
  expect(parsePreferences(JSON.stringify({ selectedId: 99, filter: "invalid", screen: "detail" })))
    .toEqual({ selectedId: null, filter: "all", screen: "list" });
});
```

Add grouping tests to `presentation.test.ts` using `draftTask` and `waitingTask` from the existing server fixtures:

```ts
it("keeps blocked and review-less waiting tasks reachable", () => {
  const blocked = { ...draftTask(), id: "blocked", status: "blocked" as const };
  const waiting = { ...waitingTask(), id: "waiting", reviews: [] };
  expect(groupTasks([blocked, waiting], "all", "").map(group => [group.id, group.tasks[0].id]))
    .toEqual([["active", "blocked"], ["waiting", "waiting"]]);
  expect(groupTasks([blocked, waiting], "active", "")[0].tasks).toEqual([blocked]);
});
```

- [ ] Run `npm test -- --run src/tasks/navigation.test.ts src/tasks/presentation.test.ts`; confirm missing exports cause the expected failure.
- [ ] Implement the navigation model with this exact public event union:

```ts
export type NavigationState = {
  selectedId: string | null;
  filter: Filter;
  screen: "list" | "detail";
};
export type NavigationEvent =
  | { type: "select"; id: string }
  | { type: "filter"; filter: Filter }
  | { type: "back" }
  | { type: "submitted" };

export function navigate(state: NavigationState, event: NavigationEvent): NavigationState {
  switch (event.type) {
    case "select": return { ...state, selectedId: event.id, screen: "detail" };
    case "filter": return { ...state, filter: event.filter, screen: "list" };
    case "back": return { ...state, screen: "list" };
    case "submitted": return { ...state, filter: "all", screen: "list" };
  }
}
```

`parsePreferences` wraps JSON parsing in try/catch, validates each field, preserves legacy selected IDs, and forces `screen:'list'` when no valid selected ID exists. Keep its input pure; storage read/write failures belong to App and are tested in Task 3.

- [ ] Implement grouping after applying `matchesFilter` and the existing case-insensitive title/idea/type/source search. Use `needsReview` first, `isClosed` second, active statuses third, otherwise Waiting. Preserve input order inside each group and omit empty groups; the group order is review, active, waiting, closed. Re-export the Filter type from old Inbox temporarily so unchanged callers still compile.
- [ ] Add a TaskList DOM test for search plus row selection. Import `cleanup/render/screen`, `userEvent`, `afterEach/expect/it/vi`, fixtures, and TaskList in the new jsdom file:

```tsx
it("opens a real task without generating a new identifier", async () => {
  const task = waitingTask();
  const select = vi.fn();
  render(<TaskList tasks={[task]} filter="all" query="" selectedId={null}
    loading={false} canSubmit onQuery={vi.fn()} onSelect={select} onNew={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: /Draft.*Needs review/ }));
  expect(select).toHaveBeenCalledWith(task.id);
});
```

Add parameterized empty-list cases for `tasks=[]`, a nonmatching query, and `filter='closed'` against active tasks; expect headings `No tasks yet`, `No matching tasks`, and `No closed tasks`, respectively. Assert that New task is disabled when `canSubmit=false`. Run the file to observe the missing component failure.
- [ ] Implement TaskList with Input, Button, Skeleton, and semantic grouped sections. Each row is one keyboard-operable button whose accessible name contains title and status; nested download or menu buttons are not permitted. Use the approved columns (status/title/status text/type) and min-width/overflow handling. Render a visible New task action in the list header. A `returnFocusId` focuses the matching row after mount, or the list heading when it is absent. Forward `searchRef` to the search input.
- [ ] Run all three task test files and `npm run build:ui`. Commit with `feat: add grouped task list and navigation model`.

### Task 3: workspace shell and list/detail integration

**Files:** Create `src/components/WorkspaceShell.tsx`, `WorkspaceSidebar.tsx`, and `src/styles/workspace.css`. Modify `src/App.tsx`, `src/App.test.tsx`, `src/styles.css`, `src/components/TaskDetail.tsx` (root landmark only), and generated sidebar helpers. Delete `src/components/Inbox.tsx` after replacing its imports.

**Interfaces:** `WorkspaceShell` props: `{ tasks: Task[]; filter: Filter; task: Task | null; connected: boolean; coordinator: WorkspaceView['coordinator'] | null; detail: boolean; onFilter(filter: Filter): void; onSearch(): void; onBack(): void; children: React.ReactNode }`. Sidebar consumes the navigation/count/connection subset. App remains `App({ api = workspaceApi }: { api?: WorkspaceApi })`; its API boundary is unchanged.

- [ ] Add this navigation flow to existing App tests using their `api`, `task`, and `second` fixtures:

```tsx
it("returns to the originating filtered list and focuses the opened task", async () => {
  const user = userEvent.setup();
  render(<App api={api()} />);
  await screen.findByRole("heading", { name: "All tasks" });
  await user.click(within(screen.getByRole("navigation", { name: "Workspace" }))
    .getByRole("button", { name: /Needs review/ }));
  const row = await screen.findByRole("button", { name: /Review webhook retries.*Needs review/ });
  await user.click(row);
  expect(screen.getByRole("main")).toHaveTextContent("Review webhook retries");
  await user.click(screen.getByRole("button", { name: "Back to needs review" }));
  expect(screen.getByRole("button", { name: /Review webhook retries.*Needs review/ })).toHaveFocus();
});
```

Ensure one `main` landmark belongs to the shell; convert legacy TaskDetail's root to a section during this integration. Add storage denial coverage with `vi.spyOn(Storage.prototype,'getItem').mockImplementation(() => { throw new Error('denied'); })` and the corresponding `setItem` spy; the real list must load and remain usable. Keep the existing missing-selected-record and command-completes-after-selection tests, adapting their navigation to explicitly open task rows.
- [ ] Run `npm test -- --run src/App.test.tsx` and capture the expected new-navigation failures before changing App.
- [ ] Add real shadcn `sidebar`, `sheet`, `separator`, `tooltip`, and `skeleton` components. Configure the generated mobile hook to the spec's below-650px threshold, rather than keeping shadcn's default breakpoint. Use one SidebarProvider and the standard Sheet behavior; do not mount a second independently controlled navigation drawer.
- [ ] Wire App with a reducer and failure-tolerant preference storage:

```tsx
const [navigation, dispatch] = useReducer(navigate, undefined, () => {
  try { return parsePreferences(localStorage.getItem("symphony-workspace-preferences-v1")); }
  catch { return parsePreferences(null); }
});
useEffect(() => {
  try { localStorage.setItem("symphony-workspace-preferences-v1", JSON.stringify(navigation)); }
  catch { /* Presentation preferences are optional. */ }
}, [navigation]);
const selectedTask = tasks.find(task => task.id === navigation.selectedId) ?? null;
```

Remove automatic first-task selection. Show TaskList on the list screen, TaskDetail on the detail screen, and Task unavailable when its saved ID is absent from a loaded view. Keep the existing disconnected, issue, error, and submission notices in one alert area. Initial load is a skeleton only while no view and no error exists. A load error becomes an error state, not a blank list or endless skeleton.
- [ ] Implement `onSearch` by returning to the current list, closing the mobile sidebar, and focusing a stored input ref in an effect after the list mounts. Register Command/Ctrl+K with cleanup. Sidebar filters preserve `query`; successful draft submission clears it and dispatches `submitted`. Selection navigation never occurs inside a command's completion callback. Preserve the existing selected detail during polling and command resolution.
- [ ] Implement the 208px sidebar, location bar, counts, and connected/degraded/disconnected labels. Wrap the view links in `<nav aria-label="Workspace">`, use `aria-current="page"` for the active view, labeled menu/search controls, and a visible Back to the originating view on a task page. Preserve access to the current workspace-help copy via a compact help action. Show New task in list and empty states; it is unavailable while disconnected.
- [ ] Update existing App tests that assumed automatic first selection by explicitly opening a row or seeding legacy preferences. Replace the old split-pane assertion with the list/detail flow. Preserve exact command payload, artifact version, no-demo, conflict, stale-task, pending-review-order, and terminal-output assertions. Add a deferred load/command case asserting that an open feedback textarea is retained on disconnect and all submit controls become disabled; the component-level feedback preservation remains Task 5's responsibility.
- [ ] Run `npm test -- --run src/App.test.tsx src/tasks src/components/NewTaskDialog.test.tsx src/components/TaskList.test.tsx` and `npm run build:ui`. Remove Inbox and its remaining imports only after the new list is wired. Commit with `feat: replace workspace shell and task navigation`.

### Task 4: reusable artifact preview and version list

**Files:** Create `src/components/ArtifactPreview.tsx`, `ArtifactPreview.test.tsx`, and `TaskArtifacts.tsx`. Modify `src/components/ReviewPanel.tsx` and `ReviewPanel.test.tsx` to reuse the extracted viewer.

**Interfaces:** Export `ArtifactPreview({ taskId, artifact }: { taskId: string; artifact: ArtifactRef })` and `TaskArtifacts({ task }: { task: Task })`. Each ArtifactPreview renders a single list item with a versioned download link and a View toggle. Parents supply `<ul>` and key children by task ID, artifact ID, and version. Rendering never fetches an artifact until its preview is opened.

- [ ] Move the existing hostile-text, bounded-read cancellation, invalid UTF-8, and split-codepoint preview tests into `ArtifactPreview.test.tsx`, changing only the component wrapper and props. Leave one reviewed-version integration test in ReviewPanel. Add this cross-identity case with valid `Response` objects:

```tsx
it("does not retain a preview from a previous artifact identity", async () => {
  const ref = { id: "findings", version: 1, digest: "one", path: "artifacts/one" };
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response("First", { headers: { "Content-Type": "text/plain" } }))
    .mockResolvedValueOnce(new Response("Second", { headers: { "Content-Type": "text/plain" } })));
  const view = render(<ul><ArtifactPreview taskId="a" artifact={ref} /></ul>);
  await userEvent.click(screen.getByRole("button", { name: "View findings v1" }));
  expect(await screen.findByText("First")).toBeInTheDocument();
  view.rerender(<ul><ArtifactPreview taskId="b" artifact={{ ...ref, version: 2 }} /></ul>);
  expect(screen.queryByText("First")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "View findings v2" }));
  expect(await screen.findByText("Second")).toBeInTheDocument();
});
```

Use the existing jsdom test preamble and cleanup with `vi.unstubAllGlobals()`.
- [ ] Run `npm test -- --run src/components/ArtifactPreview.test.tsx src/components/ReviewPanel.test.tsx`; the extraction export should initially be missing.
- [ ] Move the existing bounded-reader implementation rather than replacing it with `response.text()`. Keep its 256 KiB limit, abort controller, streaming UTF-8 decode, content-type checks, truncated notice, and version-specific URL. Fix identity reset by using an outer identity-keyed boundary:

```tsx
export function ArtifactPreview({ taskId, artifact }: { taskId: string; artifact: ArtifactRef }) {
  return <ArtifactPreviewContent key={`${taskId}:${artifact.id}:${artifact.version}`}
    taskId={taskId} artifact={artifact} />;
}
```

`ArtifactPreviewContent` is the extracted existing implementation, renamed locally and using `artifact` instead of the ambiguous `ref` prop. Mounting a new identity clears text/open/error state and aborts the prior fetch. Use a `<pre>` for literal text, wrapping/scrolling long lines without allowing page overflow. Keep downloads available after preview failure.
- [ ] Implement TaskArtifacts as an empty state or a list of unique `task.artifacts` entries keyed by ID and version; show each saved version without replacing reviewed references with newer versions. Use real shadcn Buttons for toggles and expose digests through a labeled details/collapsible area. Do not put one interactive element inside another.
- [ ] Run both task test files, `src/App.test.tsx`, and `npm run build:ui`. Commit with `refactor: share bounded artifact previews across task views`.

### Task 5: review cards and workflow controls

**Files:** Modify `src/components/ReviewPanel.tsx`, `ReviewPanel.test.tsx`, `WorkflowJourney.tsx`, `WorkflowJourney.test.tsx`, `StageCard.tsx`, `RunOutput.tsx`; create `src/components/TaskActions.tsx` and `src/styles/task.css`. Keep `useTaskCommand.ts` unchanged unless a failing preservation test proves a necessary fix.

**Interfaces:** Preserve ReviewPanelProps, WorkflowJourneyProps, StageCard's current props, and RunOutputProps. Add `TaskActions({ task, disabled, onAction }: { task: Task; disabled: boolean; onAction(action: HumanAction): Promise<boolean> })`. WorkflowJourney supplies its existing `send` callback and owns its busy/error/recovery state.

- [ ] Add a deliberate-feedback-form test in ReviewPanel tests, and update existing change/reject tests to open the appropriate form before typing:

```tsx
it("opens feedback without sending a decision and retains it across disconnect", async () => {
  const task = waitingTask();
  const command = vi.fn();
  const view = render(<ReviewPanel task={task} review={task.reviews[0]}
    disabled={false} onCommand={command} />);
  expect(screen.queryByLabelText("Feedback")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
  await userEvent.type(screen.getByLabelText("Feedback"), "Keep the source evidence");
  expect(command).not.toHaveBeenCalled();
  view.rerender(<ReviewPanel task={task} review={task.reviews[0]}
    disabled onCommand={command} />);
  expect(screen.getByLabelText("Feedback")).toHaveValue("Keep the source evidence");
  expect(screen.getByRole("button", { name: "Send feedback" })).toBeDisabled();
});
```

Retain the tests for unchanged retry request IDs, fresh IDs after task revision changes, exact approved digest, required reconciliation note, question answer, and final-step completion copy. Add a rejection menu test: opening the menu and choosing Reject task exposes the reason field but never calls `onCommand`; only submitting a nonblank reason sends `kind:'reject'`.
- [ ] Run `npm test -- --run src/components/ReviewPanel.test.tsx src/components/WorkflowJourney.test.tsx` to record the intended form/menu failures.
- [ ] Add shadcn `dropdown-menu` and `collapsible`. Introduce local form mode while retaining the existing command hook and validation:

```tsx
const [mode, setMode] = useState<"changes" | "reject" | null>(null);
const unavailable = disabled || submitting || !waiting;
// Approve continues to bind review.artifacts, never task.artifacts.
const approve = () => send({
  kind: "approve", reviewId: review.id,
  artifactDigests: review.artifacts.map(artifact => artifact.digest),
});
```

Use Request changes to set `mode='changes'`; display a Feedback label and Send feedback submit button. The More review actions dropdown sets `mode='reject'`, displaying Rejection reason and Reject task submit. Require trimmed text for either action. Cancel returns focus to the relevant trigger and closes the form. Do not clear text on errors, pending requests, task revision changes, or disconnect; clear after accepted submission. Questions and reconciliation keep their always-visible labeled fields and existing action kinds. Pause uses Continue. Keep the exact explanatory copy asserted by the existing final-artifact test.
- [ ] Render the approved raised review surface, title, prompt, exact-version artifact rows, controls, and consequence text. Preserve newlines with `white-space: pre-wrap` for brief/review text. Workflow approval must display complete proposed scope in the same Overview before the approval action can be mistaken for approving the old workflow. Reuse the current detailed scope rendering and explicit proposed/approved headings; do not collapse away the distinction.
- [ ] Move task-wide pause/cancel actions into TaskActions, called from WorkflowJourney once. Preserve eligibility checks verbatim: pause only for active triaging/queued/running with no intent; cancel only when nonterminal and not already cancelling. Keep blocked resolution fields and retry beside the blocked message. Use the workflow's single command hook so task menu and step insertion share busy-state exclusion. Remove the old duplicate footer controls.
- [ ] Convert step headers to shadcn Collapsible triggers, keep current-step expansion state and stale labels, and style a compact vertical timeline. Preserve role, permissions, repository, input/output, and completion-check details; run failure/uncertain messages; historical review answers; versioned artifact links; and all insertion eligibility checks. Convert log stream buttons to themed controls without changing polling, byte offsets, tail bounds, or literal-text rendering. Do not introduce forced scrolling.
- [ ] Extend workflow tests to open Task actions before choosing Pause/Cancel. Keep existing stale-step, uncertainty, proposed revision, rejection history, and insertion tests. Add the following terminal condition to the existing test file:

```tsx
it("never exposes task mutations for cancelled tasks with pending history", () => {
  const task = { ...waitingTask(), status: "cancelled" as const };
  render(<WorkflowJourney task={task} disabled={false} onCommand={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Task actions" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Review before this step" })).not.toBeInTheDocument();
});
```

- [ ] Run `npm test -- --run src/components/ReviewPanel.test.tsx src/components/WorkflowJourney.test.tsx src/components/RunOutput.test.tsx src/App.test.tsx` and `npm run build:ui`. Commit with `feat: redesign review cards and workflow controls`.

### Task 6: focused task page, tabs, and responsive properties

**Files:** Modify `src/components/TaskDetail.tsx`, `TaskDetail.test.tsx`, `src/App.tsx`, and `src/styles/task.css`; create `TaskProperties.tsx` and `TaskActivity.tsx`. Add real shadcn Tabs and Badge if not already present.

**Interfaces:** Preserve TaskDetail's existing `{ task: Task; stale: boolean; onBack(): void; onCommand(command: Command): Promise<void> }`, adding optional `backLabel?: string` for the originating view. Export `TaskProperties({ task }: { task: Task })` and `TaskActivity({ task }: { task: Task })`. TaskDetail owns `overview | activity | artifacts` tab state, and App keys it by task ID so switching tasks resets its local view.

- [ ] Extend TaskDetail tests with preserved terminal history and artifact availability in the new tabs. Add `userEvent` and `within` imports to the existing test file:

```tsx
it("keeps terminal review history and saved versions available in separate tabs", async () => {
  const task = { ...waitingTask(), status: "cancelled" as const };
  task.artifacts = [{ id: "findings", version: 1, digest: "one", path: "artifacts/one" }];
  render(<TaskDetail task={task} stale={false} onBack={vi.fn()} onCommand={vi.fn()} />);
  await userEvent.click(screen.getByRole("tab", { name: /Artifacts/ }));
  expect(screen.getByRole("link", { name: "findings · v1" }))
    .toHaveAttribute("href", `/api/tasks/${task.id}/artifacts/findings?version=1`);
  await userEvent.click(screen.getByRole("tab", { name: /Activity/ }));
  expect(screen.getByRole("tabpanel")).toHaveTextContent("workflow review: pending");
  expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
});
```

Add a pending-multiple-reviews case retaining first-review-only actionability. Add a long title, multiline question, and long source path fixture for browser verification in Task 7; unit assertions must check complete text preservation, not guessed browser layout.
- [ ] Run `npm test -- --run src/components/TaskDetail.test.tsx src/App.test.tsx`; confirm missing new tabs are the failure.
- [ ] Compose the dedicated page with a task heading, status/type/version metadata, brief, and Tabs. Keep overview panels mounted while switching tabs (`forceMount` with hidden inactive content) so partially entered feedback and expanded workflow state survive inspection of Activity/Artifacts. Ensure inactive panels are actually hidden from keyboard focus and accessibility queries.

```tsx
<Tabs value={tab} onValueChange={(value) => setTab(value as "overview" | "activity" | "artifacts")}>
  <TabsList aria-label="Task view">
    <TabsTrigger value="overview">Overview</TabsTrigger>
    <TabsTrigger value="activity">Activity</TabsTrigger>
    <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
  </TabsList>
  <TabsContent value="artifacts" forceMount hidden={tab !== "artifacts"}>
    <TaskArtifacts task={task} />
  </TabsContent>
</Tabs>
```

Use the same controlled/hidden pattern for Overview and Activity. Overview wraps existing eligible ReviewPanels and WorkflowJourney and retains blocked/stale/terminal notices. Terminal status suppresses actionable reviews regardless of historic null decisions.
- [ ] Extract TaskActivity from the current TaskDetail event projection without inventing timestamps; display recorded run dates only and retain review prompt/answer/decision text. Add the note `Time not recorded` only where useful for an undated event. Do not sort undated reviews into a fictional chronological sequence.
- [ ] Implement TaskProperties as one reusable definition list with full task ID, source, status, type, current step, and version. Derive the next-step sentence only from an unambiguous human checkpoint `allowsStepId`; `null` means workflow completion checks, not another invented step. A pending workflow proposal can state that approval permits its proposed steps. Omit advice for ambiguous blocked/reconciliation states.
- [ ] Render the properties rail above 950px and a labeled shadcn Collapsible below that width; use mutually exclusive responsive visibility so hidden duplicates are not keyboard-reachable. Below 650px, retain the shell back/menu controls and use 20px content padding. Render active review and long identifiers with `min-width:0`, `overflow-wrap:anywhere`, and local `<pre>` overflow rather than clipping page content.
- [ ] Add a tab-switch preservation test: open Request changes, type Feedback, visit Artifacts, return to Overview, and assert the text remains. In browser verification check arrow-key tab switching and reachable properties on a narrow screen. Run `npm test -- --run src/components/TaskDetail.test.tsx src/App.test.tsx src/components/ReviewPanel.test.tsx` and `npm run build:ui`. Commit with `feat: add focused task pages and artifact tabs`.

### Task 7: final density, responsive verification, and legacy removal

**Files:** Finish `src/styles.css`, `src/styles/tokens.css`, `src/styles/workspace.css`, `src/styles/task.css`; update affected components/tests only for discovered issues. Modify `scripts/preview-fake.mjs` and `README.md`. Create `docs/superpowers/execution/linear-inspired-ui-verification.md`.

**Interfaces:** No production API changes. The preview script may add `SYMPHONY_PREVIEW_EMPTY=1` solely to omit seeding fake task records. Existing `SYMPHONY_PREVIEW_PORT` remains supported. All preview files stay under the script's temporary root and cleanup remains intact.

- [ ] Audit selectors after every component has migrated:

```bash
rg -n 'inbox-panel|app-header|workspace-body|detail-inner|brand-period|demo-label|inbox-footer' src
rg -n 'className=|className:' src/components src/App.tsx
```

Remove unused legacy CSS rather than appending another override layer. Finish `src/styles.css` as imports plus minimal global resets. Preserve the imports required by generated shadcn components. Avoid broad unlayered `button`, `input`, or `svg` rules that override component sizes and colors. Keep reduced-motion styles and visible focus treatment.

- [ ] Apply the approved layout using explicit shared classes/tokens. The following layout rules are the desktop anchor; add the spec's 1150/950/650px adaptations in these same files:

```css
.task-layout { display: grid; grid-template-columns: minmax(0, 1fr) 224px; min-height: 0; }
.task-scroll { min-width: 0; overflow: auto; padding: 30px 36px 40px; }
.task-reading { max-width: 920px; margin-inline: auto; }
.review-panel { padding: 22px; border-radius: 8px; background: var(--card); }
.task-title { font-size: 26px; font-weight: 500; line-height: 1.25; letter-spacing: -.7px; }
.task-row { min-height: 47px; font-size: 14px; }
.task-metadata { font-size: 12px; color: var(--metadata); }
@media (max-width: 649px) {
  .task-scroll { padding: 24px 20px; }
  .task-title { font-size: 24px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
```

Use a 208px noncollapsing desktop sidebar by default. Ensure portalled menus, dialogs, and tooltips inherit the same dark tokens and Geist. Keep icon size around 16px; no default 10px/11px text for meaningful supporting information. Provide control borders/focus contrast independently of passive separators.

- [ ] Extend disposable fixtures with terminal and long-content examples. Guard every current `store.create` seed with `if (!emptyPreview)` after declaring `const emptyPreview = process.env.SYMPHONY_PREVIEW_EMPTY === '1';`. Keep fixture objects available to the fake runner even in empty mode. Add a terminal record after `makeTask` is defined:

```js
const closedTask = makeTask('FAKE completed research', 'done');
closedTask.idea = 'Completed fake work remains available for inspection.';
if (!emptyPreview) await store.create(closedTask, 'seed-closed');
const longContentTask = makeTask('FAKE ' + 'Long task title '.repeat(12), 'waiting-for-human');
longContentTask.source = 'drafts/' + 'long-source-name-'.repeat(16) + '.md';
longContentTask.reviews = [{ id: 'long-question', kind: 'question', workflowVersion: null,
  stepId: '$triage', artifacts: [], prompt: 'First line\nSecond line\n' + 'Details '.repeat(80),
  answer: null, decision: null }];
if (!emptyPreview) await store.create(longContentTask, 'seed-long-content');
```

Do not change the real coordinator, persist fake records in the local workspace, or import preview fixtures in production.

- [ ] Run the complete regression and production build once the implementation is ready:

```bash
npm test -- --run
npm run build
git diff --check
```

All tests and both UI/server builds must pass. If code changes follow a failure, rerun the affected tests and required final checks. Do not waive tests by changing their expectations about command payloads, version binding, or disabled mutations.

- [ ] Start `npm run preview:fake` with a persistent tool session and inspect the actual product at its printed loopback URL through the available browser tools. At 1512px verify sidebar/rail dimensions, Geist loading, 26/14/12px hierarchy, raised review surface, approved density, keyboard focus, and workflow visibility. At an intermediate width verify properties move into their collapsible section. At 390px verify the menu Sheet, filters, search, New task, back control, properties, all review fields, and local artifact/log scrolling. Restore the browser viewport afterward.
- [ ] Exercise the real fake-coordinator flows: approve a workflow, answer a question, review an exact artifact version, request changes, inspect revised scope, pause/continue, cancel, inspect terminal output, and enter a blocked resolution note. Stop the owned preview process while a task is open to check retained content and disabled actions. Restart the same preview command for reconnection checks; task disappearance after a new temporary-root session must yield Task unavailable when restoring a saved task ID.
- [ ] Run `SYMPHONY_PREVIEW_EMPTY=1 SYMPHONY_PREVIEW_PORT=4322 npm run preview:fake` in another owned session. Confirm empty workspace copy, submission entry point, loading/error distinction, and keyboard navigation. Check unmatched search on the populated preview separately. Shut down only the preview sessions started for this work.
- [ ] Record actual test/build output summaries, viewport sizes, inspected states, font/contrast findings, and any limits in `docs/superpowers/execution/linear-inspired-ui-verification.md`. Update README with list/detail navigation, shadcn/Geist location, and the existing build/restart workflow. Preserve its warning to retain `.symphony-local` data. Use a small measured contrast check for essential text and visible controls; correct token values only outside the user's fixed five-color palette if necessary.
- [ ] Commit final files with `feat: complete Symphony UI replacement`. Perform a whole-change review against the spec, especially Review Focus. Fix concrete findings and rerun their affected checks before using `superpowers:finishing-a-development-branch`. Do not push, merge, or alter the running real coordinator as an implicit part of visual verification.

## Coverage and handoff

| Spec requirement | Owning tasks |
| --- | --- |
| Exact palette, Geist, real shadcn primitives | 1, 7 |
| Separate task list/detail, preference compatibility, focus return | 2, 3 |
| All statuses reachable, search/counts/empty states | 2, 3, 7 |
| Exact-version preview/download and bounded literal rendering | 4 |
| All review kinds, revision/idempotency guarantees, recovery and task controls | 5 |
| Overview/Activity/Artifacts, complete properties, terminal history | 6 |
| Mobile navigation, dialog/tab accessibility, typography/density | 1, 3, 6, 7 |
| Offline/degraded/error states and existing coordinator behavior | 3, 5, 7 |
| Obsolete UI removal, tests/build/browser checks, documentation | 7 |

Implementation has not started. Review this plan and choose an execution method first. Recommended: **Native**, because the seven tasks share presentation interfaces and the existing backend/command behavior stays in place. The primary agent can carry those decisions through sequentially, followed by one independent whole-branch review. **Subagent-driven** execution provides a separate implementer/reviewer cycle per task at a higher context cost.
