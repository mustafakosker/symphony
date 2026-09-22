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
  expect(screen.getByText(/Proposed workflow v1/)).toBeInTheDocument();
});

it("requires feedback, retains it on failure, and reuses the request ID only for an unchanged retry", async () => {
  const task = waitingTask();
  const onCommand = vi.fn().mockRejectedValue(new Error("Network lost"));
  render(<ReviewPanel task={task} review={task.reviews[0]} disabled={false} onCommand={onCommand} />);
  await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
  expect(onCommand).not.toHaveBeenCalled();
  await userEvent.type(screen.getByLabelText("Feedback"), "Please add checks");
  await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Network lost");
  expect(screen.getByLabelText("Feedback")).toHaveValue("Please add checks");
  await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
  await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2));
  expect(onCommand.mock.calls[1][0].requestId).toBe(onCommand.mock.calls[0][0].requestId);
  await userEvent.type(screen.getByLabelText("Feedback"), " again");
  await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
  await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(3));
  expect(onCommand.mock.calls[2][0].requestId).not.toBe(onCommand.mock.calls[0][0].requestId);
});

it("keeps feedback after a revision conflict and binds a new command to the refreshed revision", async () => {
  const task = waitingTask();
  const onCommand = vi.fn().mockRejectedValue(new Error("Task revision has changed"));
  const view = render(<ReviewPanel task={task} review={task.reviews[0]} disabled={false} onCommand={onCommand} />);
  await userEvent.type(screen.getByLabelText("Feedback"), "Keep this feedback");
  await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
  await screen.findByRole("alert");
  view.rerender(<ReviewPanel task={{ ...task, revision: 2 }} review={task.reviews[0]} disabled={false} onCommand={onCommand} />);
  expect(screen.getByLabelText("Feedback")).toHaveValue("Keep this feedback");
  await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
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

it("shows text artifacts as text after fetching their reviewed version", async () => {
  const task = waitingTask();
  task.reviews[0].artifacts = [{ id: "report", version: 3, digest: "digest", path: "artifacts/report.3.bin" }];
  const fetcher = vi.fn().mockResolvedValue({ ok: true, headers: { get: () => "text/plain; charset=utf-8" },
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("<img src=x onerror=alert(1)>")); controller.close(); } }) });
  vi.stubGlobal("fetch", fetcher);
  render(<ReviewPanel task={task} review={task.reviews[0]} disabled={false} onCommand={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "View report v3" }));
  expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  expect(document.querySelector("img")).toBeNull();
  expect(fetcher.mock.calls[0][0]).toContain("/artifacts/report?version=3");
  vi.unstubAllGlobals();
});

it("cancels an oversized preview after the bounded read", async () => {
  const task = waitingTask();
  task.reviews[0].artifacts = [{ id: "large", version: 1, digest: "digest", path: "artifacts/large.1.bin" }];
  let delivered = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { delivered++; controller.enqueue(new Uint8Array(64 * 1024).fill(65)); },
    cancel() { cancelled = true; },
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, headers: { get: () => "text/plain; charset=utf-8" }, body,
    text: async () => { throw new Error("unbounded text read"); } }));
  render(<ReviewPanel task={task} review={task.reviews[0]} disabled={false} onCommand={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "View large v1" }));
  expect(await screen.findByText(/Preview truncated/)).toBeInTheDocument();
  expect(delivered).toBeLessThanOrEqual(6); // Streams may prefetch one chunk.
  expect(cancelled).toBe(true);
});

it("offers download when preview bytes are invalid UTF-8", async () => {
  const task = waitingTask();
  task.reviews[0].artifacts = [{ id: "binary", version: 1, digest: "digest", path: "artifacts/binary.1.bin" }];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, headers: { get: () => "text/plain; charset=utf-8" },
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0xff, 0x00])); controller.close(); } }) }));
  render(<ReviewPanel task={task} review={task.reviews[0]} disabled={false} onCommand={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "View binary v1" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Download this artifact");
  expect(screen.getByRole("link", { name: "binary · v1" })).toBeInTheDocument();
});

it("keeps a valid UTF-8 preview when the byte cap splits a character", async () => {
  const task = waitingTask();
  task.reviews[0].artifacts = [{ id: "unicode", version: 1, digest: "digest", path: "artifacts/unicode.1.bin" }];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, headers: { get: () => "text/plain; charset=utf-8" },
    body: new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(256 * 1024 - 1).fill(65));
      controller.enqueue(new Uint8Array([0xc3, 0xa9, 66]));
      controller.close();
    } }) }));
  render(<ReviewPanel task={task} review={task.reviews[0]} disabled={false} onCommand={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "View unicode v1" }));
  expect(await screen.findByText(/Preview truncated/)).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it('visibly requires a rejection note and sends only validated feedback', async () => {
  const task = waitingTask(); const onCommand = vi.fn().mockResolvedValue(undefined);
  render(<ReviewPanel task={task} review={task.reviews[0]} disabled={false} onCommand={onCommand} />);
  await userEvent.click(screen.getByRole('button', { name: 'Reject task' }));
  expect(onCommand).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Rejection note required');
  await userEvent.type(screen.getByLabelText('Feedback'), 'Out of scope');
  await userEvent.click(screen.getByRole('button', { name: 'Reject task' }));
  expect(onCommand.mock.calls[0][0].action).toMatchObject({ kind: 'reject', text: 'Out of scope' });
});
