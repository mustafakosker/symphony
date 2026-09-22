// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { waitingTask } from "../../server/testing/fixtures";
import ReviewPanel from "./ReviewPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("answers a question without approving the workflow", async () => {
  const task = waitingTask();
  task.reviews[0] = { ...task.reviews[0], kind: "question", prompt: "Which repository?" };
  const onCommand = vi.fn().mockResolvedValue(undefined);
  render(<ReviewPanel task={task} review={task.reviews[0]} disabled={false} onCommand={onCommand} />);
  await userEvent.type(screen.getByLabelText("Your answer"), "sales-api");
  await userEvent.click(screen.getByRole("button", { name: "Send answer" }));
  expect(onCommand.mock.calls[0][0]).toMatchObject({ taskId: task.id, expectedRevision: task.revision,
    action: { kind: "answer", reviewId: task.reviews[0].id, text: "sales-api" } });
  expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
});

it("approves the exact reviewed artifact digest and workflow revision", async () => {
  const task = waitingTask();
  const ref = { id: "findings", version: 1, digest: "first-digest", path: "artifacts/findings.1.bin" };
  task.reviews[0].artifacts = [ref];
  task.artifacts = [ref, { ...ref, version: 2, digest: "newer-digest" }];
  const onCommand = vi.fn().mockResolvedValue(undefined);
  render(<ReviewPanel task={task} review={task.reviews[0]} disabled={false} onCommand={onCommand} />);
  expect(screen.getByRole("link", { name: "findings · v1" })).toHaveAttribute("href", `/api/tasks/${task.id}/artifacts/findings?version=1`);
  await userEvent.click(screen.getByRole("button", { name: "Approve" }));
  expect(onCommand.mock.calls[0][0]).toMatchObject({ taskId: task.id, expectedRevision: 1,
    action: { kind: "approve", reviewId: "workflow-review", artifactDigests: ["first-digest"] } });
  expect(screen.getByRole("heading", { name: /Proposed workflow v1 · scope for approval/ })).toBeInTheDocument();
});

it("requires feedback, retains it on failure, and reuses the request ID only for an unchanged retry", async () => {
  const task = waitingTask();
  const onCommand = vi.fn().mockRejectedValue(new Error("Network lost"));
  render(<ReviewPanel task={task} review={task.reviews[0]} disabled={false} onCommand={onCommand} />);
  await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
  expect(onCommand).not.toHaveBeenCalled();
  await userEvent.type(screen.getByLabelText("Feedback"), "Please add checks");
  await userEvent.click(screen.getByRole("button", { name: "Send feedback" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Network lost");
  expect(screen.getByLabelText("Feedback")).toHaveValue("Please add checks");
  await userEvent.click(screen.getByRole("button", { name: "Send feedback" }));
  await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2));
  expect(onCommand.mock.calls[1][0].requestId).toBe(onCommand.mock.calls[0][0].requestId);
  await userEvent.type(screen.getByLabelText("Feedback"), " again");
  await userEvent.click(screen.getByRole("button", { name: "Send feedback" }));
  await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(3));
  expect(onCommand.mock.calls[2][0].requestId).not.toBe(onCommand.mock.calls[0][0].requestId);
});

it("keeps feedback after a revision conflict and binds a new command to the refreshed revision", async () => {
  const task = waitingTask();
  const onCommand = vi.fn().mockRejectedValue(new Error("Task revision has changed"));
  const view = render(<ReviewPanel task={task} review={task.reviews[0]} disabled={false} onCommand={onCommand} />);
  await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
  await userEvent.type(screen.getByLabelText("Feedback"), "Keep this feedback");
  await userEvent.click(screen.getByRole("button", { name: "Send feedback" }));
  await screen.findByRole("alert");
  view.rerender(<ReviewPanel task={{ ...task, revision: 2 }} review={task.reviews[0]} disabled={false} onCommand={onCommand} />);
  expect(screen.getByLabelText("Feedback")).toHaveValue("Keep this feedback");
  await userEvent.click(screen.getByRole("button", { name: "Send feedback" }));
  await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2));
  expect(onCommand.mock.calls[1][0].expectedRevision).toBe(2);
  expect(onCommand.mock.calls[1][0].requestId).not.toBe(onCommand.mock.calls[0][0].requestId);
});

it("offers Continue for a pause and requires a note to reconcile", async () => {
  const task = waitingTask();
  const onCommand = vi.fn().mockResolvedValue(undefined);
  task.reviews[0].kind = "pause";
  const view = render(<ReviewPanel task={task} review={task.reviews[0]} disabled={false} onCommand={onCommand} />);
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(onCommand.mock.calls[0][0].action.kind).toBe("approve");
  task.reviews[0].kind = "reconciliation";
  view.rerender(<ReviewPanel task={task} review={task.reviews[0]} disabled={false} onCommand={onCommand} />);
  expect(screen.getByText(/effects may be uncertain/i)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(onCommand).toHaveBeenCalledTimes(1);
  await userEvent.type(screen.getByLabelText("Resolution note"), "Checked external state");
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(onCommand.mock.calls[1][0].action).toMatchObject({ kind: "answer", reviewId: task.reviews[0].id, text: "Checked external state" });
});

it("explains that terminal artifact approval can complete the task", () => {
  const task = waitingTask();
  task.workflow = task.proposedWorkflow;
  task.proposedWorkflow = null;
  task.reviews[0] = { ...task.reviews[0], kind: "artifact", stepId: "findings" };
  render(<ReviewPanel task={task} review={task.reviews[0]} disabled={false} onCommand={vi.fn()} />);
  expect(screen.getByText(/Approving completes the workflow after its completion checks pass/)).toBeInTheDocument();
});

it('opens rejection from the menu and sends only a nonblank reason', async () => {
  const task = waitingTask(); const onCommand = vi.fn().mockResolvedValue(undefined);
  const user = userEvent.setup();
  render(<ReviewPanel task={task} review={task.reviews[0]} disabled={false} onCommand={onCommand} />);
  screen.getByRole('button', { name: 'More review actions' }).focus();
  await user.keyboard('{Enter}');
  await user.click(screen.getByRole('menuitem', { name: 'Reject task' }));
  expect(onCommand).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Rejection reason')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Reject task' }));
  expect(onCommand).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Rejection note required');
  await user.type(screen.getByLabelText('Rejection reason'), 'Out of scope');
  await user.click(screen.getByRole('button', { name: 'Reject task' }));
  expect(onCommand.mock.calls[0][0].action).toMatchObject({ kind: 'reject', text: 'Out of scope' });
});

it('opens feedback without sending a decision and retains it across disconnect', async () => {
  const task = waitingTask();
  const onCommand = vi.fn();
  const view = render(<ReviewPanel task={task} review={task.reviews[0]} disabled={false} onCommand={onCommand} />);
  expect(screen.queryByLabelText('Feedback')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Request changes' }));
  await userEvent.type(screen.getByLabelText('Feedback'), 'Keep the source evidence');
  expect(onCommand).not.toHaveBeenCalled();
  view.rerender(<ReviewPanel task={task} review={task.reviews[0]} disabled onCommand={onCommand} />);
  expect(screen.getByLabelText('Feedback')).toHaveValue('Keep the source evidence');
  expect(screen.getByRole('button', { name: 'Send feedback' })).toBeDisabled();
});
