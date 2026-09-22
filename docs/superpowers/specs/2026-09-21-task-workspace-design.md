# Task automation workspace prototype

## Purpose

Build an interactive sample UI for capturing rough ideas, bugs, and external work items and following their progress from draft to a production outcome. The user selected an inbox on the left and a task journey on the right. The immediate deliverable is a frontend prototype using mock data; the coordinator loop and real integrations are future work.

Success means a user can immediately identify tasks needing attention, understand what the coordinator has done, and approve or request changes at a human review step.

## Layout and appearance

Use a compact dark desktop workspace with charcoal backgrounds, clear typography, subtle borders, and restrained violet, amber, and green status colors. Following visual feedback, use the full detail-panel width with compact horizontal padding and reduced header, brief, inbox-row, and stage spacing. A narrow header shows the workspace name and a clearly labeled demo coordinator status.

The left panel contains a New task button, search, All / Needs review / Active / Closed filters, and a scrollable task list. Each row shows title, task type, current stage, and review attention when applicable. Selecting a row updates the right panel.

The right panel shows task title, type, source, editable draft description, and a vertical stage journey. The current stage is expanded by default. Completed and upcoming stages remain visible and can be inspected. On small screens, show the inbox first and open task details with a Back to inbox control.

## Task journey

The default stages are Draft, Agent analysis, Plan review, Implementation, Result review, and Done. Task type (Idea, Bug, or Jira) is independent of stage. Rejected and Canceled are separate terminal outcomes, not mandatory steps.

- Draft: edit the rough brief and select Start analysis.
- Agent analysis: explicitly simulate the coordinator reading the brief and preparing a plan. A Complete demo analysis action advances to Plan review.
- Plan review: show the proposed plan. Approve plan advances to Implementation; Request changes requires a note and returns to Agent analysis; Reject ends the task.
- Implementation: show sample activity and command output. Complete demo implementation advances to Result review.
- Result review: show sample changes, verification, and release outcome. Approve result advances to Done; Request changes requires a note and returns to Implementation.
- Done: show a completed summary, including a clearly labeled simulated production outcome.

Cancel is available on any nonterminal task. Terminal tasks remain inspectable with editing and transition actions disabled. All transitions append an activity entry; review feedback remains visible through subsequent stages. Only actions valid for the current stage are offered.

## Stage content and extensibility cues

Each stage contains a short summary, activity entries, and relevant sample artifacts such as a proposed plan or command output. Optional read-only prompt, command, and integration chips illustrate how a stage could be configured later. Do not build a workflow editor, plugin framework, or integration settings for this prototype.

All generated plans, logs, verification results, and production outcomes are visibly marked as demo content. No real command execution, deployment, Jira connection, or agent work is implied.

## Interactions and sample data

Seed several realistic tasks spanning idea, bug, and Jira types, including drafts, both review stages, active implementation, and a completed task. Seed data should demonstrate the journey without requiring the user to create a task first.

New task opens a small form with required title, type, and optional rough description. Submission creates and selects a Draft task. Search matches titles and descriptions; filters combine with search. Show helpful empty states and inline validation errors.

Persist tasks, selected task, and activity locally in the browser. Provide a Reset demo action with confirmation. If stored data is unreadable, fall back to seed data; if persistence is unavailable, keep the UI usable in memory and display a concise notice.

## Implementation boundaries

Use React, TypeScript, Vite, and Tailwind CSS for a standalone frontend in this currently empty workspace, as approved by the user. This stack applies to the sample UI, not the eventual coordinator service.

Keep the app shell, inbox, task detail/journey, task form, and stage content as focused components. Put task types, seed fixtures, allowed transitions, and local persistence in separate modules. State updates flow through shared task actions so list badges, journey stages, and activity stay consistent.

Backend services, authentication, real automation, custom stage editing, and production deployment are outside this prototype's scope.

## Verification

Verify task creation, search and filtering, both approval paths, request-changes loops, rejection, cancellation, and persistence after refresh. Check invalid transitions are prevented and review notes survive a loop. Run TypeScript and the production build, and inspect the UI at desktop and narrow viewport sizes. Check keyboard access, visible focus, labeled inputs, and readable status contrast.
