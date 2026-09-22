# Linear-inspired workspace verification

Verified on 2026-09-22 from the isolated `linear-ui` worktree. All browser mutations used `npm run preview:fake` with disposable temporary roots; no real coordinator task or `.symphony-local` data was changed.

## Regression and build

- `npm test -- --run`: 40 files passed, 1 skipped; 401 tests passed, 1 skipped (402 total). Exit 0.
- `npm run build`: TypeScript and Vite UI build passed (2,022 modules); server TypeScript build passed. Exit 0.
- `git diff --check`: no whitespace errors. Exit 0.
- A focused check after the filtered-count and intake-copy changes passed 34 tests in `TaskList`, `NewTaskDialog`, and `App` before the final full suite.

## Real Chrome checks

The populated fake preview ran on `127.0.0.1:4323`; the independent empty preview ran on `127.0.0.1:4322` with `SYMPHONY_PREVIEW_EMPTY=1`. The final populated check used Chrome at 1512×900, 1100×900, 900×900, and 390×844. Temporary viewport overrides were reset after the checks. Browser tabs and both owned fake preview processes were closed afterward.

At 1512px, computed styles and screenshots showed a 208px near-black sidebar (`#111113`), charcoal main surface (`#19191C`), 224px property rail, 49px location bar, 24px list heading, 26px/500 task title, 18px review heading, 14px rows and body, 12px metadata, a 22px-padded raised review card (`#222226`), 47px rows, 34px New task control, and a 230px search field. `document.fonts.check('14px Geist')` returned true, with computed `Geist, sans-serif` on the title and workspace. The primary New task action was lavender. `document.documentElement.scrollWidth` equaled the 1512px viewport.

At 1100px the sidebar measured 184px and the page did not overflow. At 900px, the property rail was hidden and its accessible Properties collapsible was visible and expandable. At 390px the Sheet menu exposed all four filters and search, New task opened a focus-managed Dialog, Escape returned focus to New task, the header search control focused the list input, and the back control returned to the originating Needs review list. The title computed to 24px; long title, source, and multiline review prompt remained within the 390px document. The list showed its filtered count and 34px New task control. No horizontal page overflow was measured.

The artifact review linked `findings?version=1`, displayed the exact-version preview, and accepted approval. Its long preview had `scrollHeight/clientHeight` 4754/258px at 390px, contained within a 284px pane; the long run output had 2292/260px in a 309px pane. Both had local `overflow: auto`, and page overflow remained zero. The desktop panes likewise capped at 258–260px. Other observed states: populated grouped list, no search matches, revised workflow v2 with approved v1 history and changed repository/completion checks, pending question, running output, blocked recovery, completed/cancelled history, and truly empty list. The empty preview showed “No tasks yet,” an enabled New task action, and Command+K search focus.

Disposable interactions produced visible state changes: workflow approval queued research; answering a question recorded the answer; requesting changes on v1 artifact marked research stale; reviewing a revised proposal exposed its changed scope; pause showed a Continue review, Continue resumed triage, and Cancel moved the task to Closed; a blocked resolution note moved the task out of Blocked; approving a v1 artifact finished its task. The Done fixture was created in an allowed waiting state and moved to Done through a normal store approval event because the store rejects creating a terminal record directly.

Stopping the owned populated preview with a long question open retained the last known task and unsent answer while disabling the answer field, Send answer, and task actions. Restarting the same command with a fresh temporary root, then reloading the saved selected task ID, showed explicit “Task unavailable” and a usable back control. The initial loading skeleton and initial connection-failure screen were covered by component tests but passed too quickly or required an unavailable asset server to inspect reliably in this browser session.

## Contrast and limits

Measured WCAG contrast ratios from the effective tokens: main text `#F0EFED` on panel `#19191C` 15.26:1; secondary `#99989F` on panel 6.14:1; metadata `#8A8992` on panel 5.07:1 and on raised `#222226` 4.58:1. The `#77747F` control border against the panel is 3.83:1; lavender `#A89BE8` against the panel is 7.12:1. These exceed the corresponding 4.5:1 essential text and 3:1 visible control thresholds. Passive separators are not used as control boundaries. Browser review used only the fake coordinator; real deployment, external sync, and CLI profile behavior were outside this visual check.
