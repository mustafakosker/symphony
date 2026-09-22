// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { waitingTask } from "../../server/testing/fixtures";
import TaskDetail from "./TaskDetail";

afterEach(cleanup);

it("shows terminal cancellation while retaining its historical review in activity", () => {
  const task = { ...waitingTask(), status: "cancelled" as const };
  render(<TaskDetail task={task} stale={false} onBack={vi.fn()} onCommand={vi.fn()} />);
  expect(screen.getByText("Cancelled", { selector: "[data-slot=badge]" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "workflow review" })).not.toBeInTheDocument();
  expect(screen.getByText(/Task cancelled/)).toBeInTheDocument();
});

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

it("keeps only the first of multiple pending reviews actionable", () => {
  const task = waitingTask();
  task.reviews.push({ ...task.reviews[0], id: "second-review", prompt: "Second decision" });
  render(<TaskDetail task={task} stale={false} onBack={vi.fn()} onCommand={vi.fn()} />);
  const panels = screen.getAllByRole("region", { name: "workflow review" });
  expect(within(panels[0]).getByRole("button", { name: "Approve" })).toBeEnabled();
  expect(within(panels[1]).getByRole("button", { name: "Approve" })).toBeDisabled();
});

it("preserves unsent feedback when inspecting other tabs", async () => {
  const task = waitingTask();
  render(<TaskDetail task={task} stale={false} onBack={vi.fn()} onCommand={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Feedback" }), "Keep this draft");
  await userEvent.click(screen.getByRole("tab", { name: /Artifacts/ }));
  expect(screen.queryByRole("textbox", { name: "Feedback" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: /Overview/ }));
  expect(screen.getByRole("textbox", { name: "Feedback" })).toHaveValue("Keep this draft");
});

it("shows recorded review details and full long source in properties", async () => {
  const task = waitingTask();
  task.source = `drafts/${"nested/".repeat(40)}idea.md`;
  task.reviews[0] = { ...task.reviews[0], prompt: "First line\nSecond line", answer: "Needs evidence", decision: "changes" };
  render(<TaskDetail task={task} stale={false} onBack={vi.fn()} onCommand={vi.fn()} />);
  expect(screen.getByText(task.source)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: /Activity/ }));
  const panel = screen.getByRole("tabpanel");
  expect(panel).toHaveTextContent("First line Second line");
  expect(panel).toHaveTextContent("Needs evidence");
  expect(panel).toHaveTextContent("changes");
});
