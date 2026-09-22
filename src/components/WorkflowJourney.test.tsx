// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { waitingTask } from "../../server/testing/fixtures";
import type { AgentStep } from "../../shared/contracts";
import WorkflowJourney from "./WorkflowJourney";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("inserts review ahead of an upcoming agent step and exposes task controls", async () => {
  const task = waitingTask();
  task.workflow = task.proposedWorkflow;
  task.proposedWorkflow = null;
  task.reviews = [];
  task.status = "queued";
  task.currentStepId = "research";
  const onCommand = vi.fn().mockResolvedValue(undefined);
  render(<WorkflowJourney task={task} disabled={false} onCommand={onCommand} />);
  await userEvent.click(screen.getByRole("button", { name: "Review before this step" }));
  expect(onCommand.mock.calls[0][0]).toMatchObject({ taskId: task.id, expectedRevision: task.revision,
    action: { kind: "insert-review", beforeStepId: "research" } });
  expect(screen.getByRole("button", { name: "Pause for review" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel task" })).toBeInTheDocument();
});

it("hides checkpoint insertion while a decision or stop intent is pending", async () => {
  const task = waitingTask();
  task.workflow = task.proposedWorkflow;
  task.proposedWorkflow = null;
  task.currentStepId = "research";
  const onCommand = vi.fn();
  const view = render(<WorkflowJourney task={task} disabled={false} onCommand={onCommand} />);
  expect(screen.getByRole("button", { name: /Research/ })).toHaveAttribute("aria-expanded", "true");
  expect(screen.queryByRole("button", { name: "Review before this step" })).not.toBeInTheDocument();
  const running = { ...task, status: "running" as const, reviews: [], intent: "pause" as const };
  view.rerender(<WorkflowJourney task={running} disabled={false} onCommand={onCommand} />);
  expect(screen.queryByRole("button", { name: "Review before this step" })).not.toBeInTheDocument();
  expect(onCommand).not.toHaveBeenCalled();
});

it("marks stale steps, explains pause requested, and hides terminal actions", async () => {
  const task = waitingTask();
  task.workflow = task.proposedWorkflow;
  task.proposedWorkflow = null;
  task.reviews = [];
  task.staleStepIds = ["research"];
  task.intent = "pause";
  const view = render(<WorkflowJourney task={task} disabled={false} onCommand={vi.fn()} />);
  expect(screen.getByText("Stale; rerun needed")).toBeInTheDocument();
  expect(screen.getByText(/Pause requested/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel task" })).toBeInTheDocument();
  task.status = "done";
  task.intent = null;
  view.rerender(<WorkflowJourney task={task} disabled={false} onCommand={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Cancel task" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Research/ }));
  expect(screen.queryByRole("button", { name: "Review before this step" })).not.toBeInTheDocument();
});

it("shows a failed run as failed with its reported reason", async () => {
  const task = waitingTask();
  task.workflow = task.proposedWorkflow;
  task.proposedWorkflow = null;
  task.reviews = [];
  task.currentStepId = "research";
  task.status = "blocked";
  task.blockedReason = "Process exited 1";
  task.runs = [{ id: "33333333-3333-4333-8333-333333333333", stepId: "research", workflowVersion: 1,
    generation: 0, phase: "ended", pid: null, processStartedAt: null, runtimeVersion: "test",
    inputRefs: [], repos: [], startedAt: task.createdAt, endedAt: task.updatedAt,
    exitCode: 1, retryCount: 0, nextRetryAt: null,
    result: { kind: "failed", taskId: task.id, attemptId: "33333333-3333-4333-8333-333333333333", summary: "Checks failed", artifacts: [], reason: "Broken build", retryable: false } }];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: "", nextOffset: 0, complete: true }) }));
  render(<WorkflowJourney task={task} disabled={false} onCommand={vi.fn()} />);
  expect(screen.getByText("Run failed")).toBeInTheDocument();
  expect(screen.getByText(/Broken build/)).toBeInTheDocument();
  vi.unstubAllGlobals();
});

it("shows the approved step scope and completion conditions", async () => {
  const task = waitingTask();
  task.proposedWorkflow!.steps[0] = { ...(task.proposedWorkflow!.steps[0] as AgentStep),
    role: "researcher", actions: ["read"], repositories: ["repo-a"],
    inputs: [{ id: "brief", version: 2, digest: "digest", path: "artifacts/brief.2.bin" }],
    outputs: ["findings"] };
  render(<WorkflowJourney task={task} disabled={false} onCommand={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: /Research/ }));
  const scope = within(screen.getByLabelText("Research scope"));
  expect(scope.getByText(/Role: researcher/)).toBeInTheDocument();
  expect(scope.getByText(/Permitted actions: read/)).toBeInTheDocument();
  expect(scope.getByText(/Repositories: repo-a/)).toBeInTheDocument();
  expect(scope.getByText(/Inputs: brief v2/)).toBeInTheDocument();
  expect(scope.getByText(/Outputs: findings/)).toBeInTheDocument();
  expect(screen.getByText(/Completion checks: findings/)).toBeInTheDocument();
});

it('shows proposed revision scope over approved workflow history', () => {
  const task = waitingTask(); task.workflow = structuredClone(task.proposedWorkflow);
  task.proposedWorkflow!.version = 2;
  task.proposedWorkflow!.completionChecks = ['NEW_CHECK'];
  task.proposedWorkflow!.steps[0] = { ...(task.proposedWorkflow!.steps[0] as AgentStep), title: 'NEW_PROPOSED_STEP', actions: ['write-local'], repositories: ['new-repo'] };
  render(<WorkflowJourney task={task} disabled={false} onCommand={vi.fn()} />);
  expect(screen.getByText('NEW_PROPOSED_STEP')).toBeVisible();
  expect(screen.getByText(/Completion checks: NEW_CHECK/)).toBeVisible();
  expect(screen.getByText(/Permitted actions: write-local/)).toBeVisible();
  expect(screen.getByText(/Repositories: new-repo/)).toBeVisible();
  expect(screen.getByText(/Approved workflow v1/)).toBeVisible();
});

it('labels rejected revision proposals as saved history without suggesting pending approval', () => {
  const task = waitingTask(); task.workflow = structuredClone(task.proposedWorkflow);
  task.proposedWorkflow!.version = 2; task.status = 'rejected'; task.reviews[0].decision = 'reject';
  render(<WorkflowJourney task={task} disabled={false} onCommand={vi.fn()} />);
  expect(screen.queryByText(/awaiting approval/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Approval applies to this proposal/)).not.toBeInTheDocument();
  expect(screen.getByText(/Proposed workflow v2 · saved history/)).toBeVisible();
});
