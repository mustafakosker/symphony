# Jira to ONA verification

Verified 2026-09-23 in `.worktrees/jira-to-ona`, branch `codex/jira-to-ona`, with Node 22.23.2. Main checkout, the other tab's worktree, live settings, and live data were not changed.

## Automated evidence

- Baseline: 364 tests passed, 1 skipped; build passed.
- Feature tasks used failing tests before implementation; final scoped suites passed for contracts, replay/reducer, intake/configuration, document/draft services, ONA handoff/recovery, HTTP/lifecycle, client state, and UI.
- `npm test -- --run`: **48 files passed, 1 skipped; 421 tests passed, 1 skipped** (37.88 seconds).
- `npm run build`: UI and server TypeScript checks and Vite build passed.
- Full HTTP integration checks upload response replay, exact BOM/CRLF/Unicode bytes, exact reviewed prompt, frozen repository/branch and Jira snapshot, acceptance-response loss/restart recovery, source/save races, corrupted bytes preventing launch, and zero `Runner.start` calls.
- The first parallel full-suite run exposed an over-tight 20 ms deadline in ordinary mock-success tests. Success cases now use 2 seconds; the deliberate timeout case retains 20 ms. Production timeout remains 10 seconds.

## Browser evidence

Started `SYMPHONY_PREVIEW_PORT=4323 npm run preview:jira` using disposable local/workspace roots and the fake runner; stopped only this preview afterward. Tested Chrome at 1440×1000 and 390×844 and reset the viewport afterward.

- Inspected inbox, ready, incomplete, accepted, and unconfirmed states.
- Inspected desktop two-column and narrow one-column document slots; corrected new panels to match the existing dark theme.
- Literal `<script>` text stayed text in document preview; Unicode filename remained readable.
- Edited the full prompt, used keyboard Tab navigation, observed autosave, reloaded, and verified exact edited text restored.
- Explicit Send produced a bound simulated receipt and locked editing; frozen-package inspection exposed the selected document versions and sent prompt version.
- Checked an unconfirmed handoff: editing was disabled; explicit reconciliation recovered its original receipt.
- Browser file-chooser upload was blocked by the Chrome extension's file-URL permission. No browser permissions were changed. File uploads, failed replacement, navigation while uploading, and exact-byte downloads are verified by component/HTTP/integration tests; the manual file-chooser check remains unverified.

## Scope and decisions

This is mock-only verification. No real Jira query, ONA environment, Codex implementation, or GitLab merge request was executed. PR handling, links, PDFs, and Word attachments are excluded.

The file-review exclusion is centralized in `model.selectReview` rather than `adapter.scan`, protecting every export path. If that placement proves unsuitable, the guard can be relocated without changing the intended behavior.
