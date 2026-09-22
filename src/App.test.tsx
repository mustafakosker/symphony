// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkspaceView } from "../shared/contracts";
import { draftTask, waitingTask } from "../server/testing/fixtures";
import App from "./App";
import type { WorkspaceApi } from "./tasks/api";

const task = draftTask();
const second = {
  ...waitingTask(),
  id: "22222222-2222-4222-8222-222222222222",
  title: "Review webhook retries",
  idea: "Handle idempotent events",
  type: "operations",
};
const view: WorkspaceView = {
  tasks: [task, second],
  issues: [],
  coordinator: "ready",
};
const api = (load: WorkspaceApi["load"] = async () => view): WorkspaceApi => ({
  load,
  submit: vi.fn(async () => ({ submissionId: "draft-1" })),
  command: vi.fn(async () => task),
});
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("does not invent work when the coordinator is unavailable", async () => {
  const offline = api(async () => {
    throw new Error("Coordinator unavailable");
  });
  localStorage.setItem("symphony-demo-v1", '{"tasks":[{"title":"Fake"}]}');
  render(<App api={offline} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Coordinator unavailable",
  );
  expect(screen.queryByText("Fake")).not.toBeInTheDocument();
  expect(
    screen.queryByText("Add a daily workspace digest"),
  ).not.toBeInTheDocument();
});

it("filters and searches coordinator tasks while preserving the selected detail", async () => {
  const user = userEvent.setup();
  render(<App api={api()} />);
  expect(
    await screen.findByRole("heading", { name: "Draft" }),
  ).toBeInTheDocument();
  await user.click(
    within(screen.getByLabelText("Filter tasks")).getByRole("button", {
      name: /Needs review/,
    }),
  );
  const inbox = within(
    screen.getByRole("complementary", { name: "Task inbox" }),
  );
  expect(
    inbox.getByRole("button", { name: /Review webhook retries/ }),
  ).toBeInTheDocument();
  expect(
    inbox.queryByRole("button", { name: /^Draft/ }),
  ).not.toBeInTheDocument();
  await user.type(
    screen.getByRole("textbox", { name: "Search tasks" }),
    "missing",
  );
  expect(
    inbox.queryByRole("button", { name: /Review webhook retries/ }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Draft" })).toBeInTheDocument();
});

it("submits a required Markdown brief and waits for coordinator pickup", async () => {
  const user = userEvent.setup();
  const boundary = api();
  render(<App api={boundary} />);
  await screen.findByRole("heading", { name: "Draft" });
  await user.click(screen.getByRole("button", { name: "Closed" }));
  await user.click(screen.getByRole("button", { name: "New task" }));
  await user.click(screen.getByRole("button", { name: "Submit draft" }));
  expect(screen.getByRole("alert")).toHaveTextContent("brief");
  await user.type(
    screen.getByRole("textbox", { name: "Brief" }),
    "Keep the original payload.",
  );
  await user.type(
    screen.getByRole("textbox", { name: /Title hint/ }),
    "Review failed retries",
  );
  await user.click(screen.getByRole("button", { name: "Submit draft" }));
  expect(
    await screen.findByText("Submitted; waiting for pickup"),
  ).toBeInTheDocument();
  expect(boundary.submit).toHaveBeenCalledWith(
    "# Review failed retries\n\nKeep the original payload.",
    expect.any(String),
  );
  expect(screen.getByRole("button", { name: "All tasks" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

it("does not expose demo execution actions", async () => {
  render(<App api={api()} />);
  await screen.findByRole("heading", { name: "Draft" });
  expect(screen.queryByText(/demo|simulated/i)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", {
      name: /Complete demo|Reset demo|Approve plan/i,
    }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel task" })).toBeInTheDocument();
});

it("shows an unavailable selected record without choosing a different task", async () => {
  localStorage.setItem(
    "symphony-workspace-preferences-v1",
    JSON.stringify({
      selectedId: "33333333-3333-4333-8333-333333333333",
      filter: "all",
    }),
  );
  render(<App api={api()} />);
  expect(
    await screen.findByRole("heading", { name: "Task unavailable" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Draft" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Approve|Cancel|Pause/ }),
  ).not.toBeInTheDocument();
});

it("keeps the last known detail on disconnect and disables draft submission", async () => {
  const boundary = api(
    vi
      .fn()
      .mockResolvedValueOnce(view)
      .mockRejectedValue(new Error("Coordinator unavailable")),
  );
  render(<App api={boundary} />);
  await screen.findByRole("heading", { name: "Draft" });
  // A newly mounted client can encounter a disconnect on its next coordinator fetch.
  const original = boundary.load;
  await waitFor(() => expect(original).toHaveBeenCalledTimes(1));
  // Polling runs every two seconds; use a real elapsed interval to exercise the rendered state.
  await waitFor(
    () =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Coordinator unavailable",
      ),
    { timeout: 3500 },
  );
  expect(screen.getByRole("heading", { name: "Draft" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "New task" })).toBeDisabled();
});

it("shows the pending workflow review beside the proposed steps", async () => {
  const proposed: WorkspaceView = {
    tasks: [waitingTask()],
    issues: [],
    coordinator: "ready",
  };
  render(<App api={api(async () => proposed)} />);
  expect(
    await screen.findByRole("heading", { name: "Draft" }),
  ).toBeInTheDocument();
  expect(screen.getByText("Approve proposed workflow?")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Research/ })).toBeInTheDocument();
});

it("shows the artifact version bound to a pending review", async () => {
  const reviewing = waitingTask();
  const ref = {
    id: "findings",
    version: 1,
    digest: "digest-1",
    path: "artifacts/findings.txt",
  };
  reviewing.workflow = reviewing.proposedWorkflow;
  reviewing.proposedWorkflow = null;
  reviewing.currentStepId = "findings";
  reviewing.completedStepIds = ["research"];
  reviewing.artifacts = [ref, { ...ref, version: 2, digest: "digest-2" }];
  reviewing.reviews = [
    {
      id: "artifact-review",
      kind: "artifact",
      workflowVersion: 1,
      stepId: "findings",
      artifacts: [ref],
      prompt: "Check the findings",
      answer: null,
      decision: null,
    },
  ];
  render(
    <App
      api={api(async () => ({
        tasks: [reviewing],
        issues: [],
        coordinator: "ready",
      }))}
    />,
  );
  await screen.findByRole("heading", { name: "Draft" });
  expect(screen.getByRole("link", { name: "findings · v1" })).toHaveAttribute(
    "href",
    `/api/tasks/${reviewing.id}/artifacts/findings?version=1`,
  );
  expect(
    screen.queryByRole("link", { name: "findings · v2" }),
  ).not.toBeInTheDocument();
});

it("closes the draft dialog with Escape without submitting", async () => {
  const user = userEvent.setup();
  const boundary = api();
  render(<App api={boundary} />);
  await screen.findByRole("heading", { name: "Draft" });
  await user.click(screen.getByRole("button", { name: "New task" }));
  const opener = screen.getByRole("button", { name: "New task", hidden: true });
  expect(
    screen.getByRole("dialog", { name: "Submit a draft" }),
  ).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("dialog", { name: "Submit a draft" }),
  ).not.toBeInTheDocument();
  expect(boundary.submit).not.toHaveBeenCalled();
  expect(opener).toHaveFocus();
});

it("wraps keyboard focus inside the open draft dialog", async () => {
  const user = userEvent.setup();
  render(<App api={api()} />);
  await screen.findByRole("heading", { name: "Draft" });
  await user.click(screen.getByRole("button", { name: "New task" }));
  const dialog = screen.getByRole("dialog", { name: "Submit a draft" });
  within(dialog).getByRole("button", { name: "Submit draft" }).focus();
  await user.tab();
  expect(within(dialog).getByRole("button", { name: "Close new task" })).toHaveFocus();
  await user.tab({ shift: true });
  expect(within(dialog).getByRole("button", { name: "Submit draft" })).toHaveFocus();
});

it("uses prospective intake copy before and after a failed POST", async () => {
  const user = userEvent.setup();
  const boundary = api();
  vi.mocked(boundary.submit).mockRejectedValue(new Error("Network lost"));
  render(<App api={boundary} />);
  await screen.findByRole("heading", { name: "Draft" });
  await user.click(screen.getByRole("button", { name: "New task" }));
  expect(
    screen.getByRole("dialog", { name: "Submit a draft" }),
  ).not.toHaveTextContent("Submitted through OneDrive intake");
  await user.type(screen.getByRole("textbox", { name: "Brief" }), "A draft");
  await user.click(screen.getByRole("button", { name: "Submit draft" }));
  const dialog = screen.getByRole("dialog", { name: "Submit a draft" });
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Network lost",
  );
  expect(
    within(dialog).getByRole("button", { name: "Submit draft" }),
  ).toBeDisabled();
  expect(
    screen.queryByText("Submitted; waiting for pickup"),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("dialog", { name: "Submit a draft" }),
  ).not.toHaveTextContent("Submitted through OneDrive intake");
});

it("keeps a newly selected task visible while an earlier task command resolves", async () => {
  const user = userEvent.setup();
  const first = waitingTask();
  let finish!: (value: typeof first) => void;
  let persisted = first;
  const boundary = api(async () => ({ tasks: [persisted, second], issues: [], coordinator: "ready" }));
  vi.mocked(boundary.command).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<App api={boundary} />);
  await screen.findByRole("heading", { name: "Draft" });
  await user.click(screen.getByRole("button", { name: "Approve" }));
  await user.click(within(screen.getByRole("complementary", { name: "Task inbox" })).getByRole("button", { name: /Review webhook retries/ }));
  expect(screen.getByRole("heading", { name: "Review webhook retries" })).toBeInTheDocument();
  persisted = { ...first, status: "queued", revision: 2, reviews: [] };
  finish(persisted);
  const inbox = within(screen.getByRole("complementary", { name: "Task inbox" }));
  await waitFor(() => expect(inbox.getByRole("button", { name: /^Unknown.*Draft.*Queued/s })).toBeInTheDocument());
  expect(screen.getByRole("heading", { name: "Review webhook retries" })).toBeInTheDocument();
  expect(inbox.getByRole("button", { name: /Review webhook retries/ })).toHaveAttribute("aria-pressed", "true");
});

it("disables a later pending review until the first decision is saved", async () => {
  const reviewing = waitingTask();
  reviewing.reviews.push({ ...reviewing.reviews[0], id: "second-review", prompt: "Second decision" });
  render(<App api={api(async () => ({ tasks: [reviewing], issues: [], coordinator: "ready" }))} />);
  await screen.findByRole("heading", { name: "Draft" });
  const panels = screen.getAllByRole("region", { name: "workflow review" });
  expect(within(panels[0]).getByRole("button", { name: "Approve" })).toBeEnabled();
  expect(within(panels[1]).getByRole("button", { name: "Approve" })).toBeDisabled();
});

it("keeps Continue available while a pending pause hides checkpoint insertion", async () => {
  const user = userEvent.setup();
  const paused = waitingTask();
  paused.workflow = paused.proposedWorkflow;
  paused.proposedWorkflow = null;
  paused.currentStepId = "research";
  paused.reviews = [{ id: "pause-review", kind: "pause", workflowVersion: 1,
    stepId: "research", artifacts: [], prompt: "Resume this task?", answer: null, decision: null }];
  const boundary = api(async () => ({ tasks: [paused], issues: [], coordinator: "ready" }));
  render(<App api={boundary} />);
  await screen.findByRole("heading", { name: "Draft" });
  expect(screen.getByRole("button", { name: /Research/ })).toHaveAttribute("aria-expanded", "true");
  expect(screen.queryByRole("button", { name: "Review before this step" })).not.toBeInTheDocument();
  const continueButton = screen.getByRole("button", { name: "Continue" });
  expect(continueButton).toBeEnabled();
  await user.click(continueButton);
  expect(boundary.command).toHaveBeenCalledWith(expect.objectContaining({ taskId: paused.id,
    expectedRevision: paused.revision, action: { kind: "approve", reviewId: "pause-review", artifactDigests: [] } }));
});

it("wraps a long task title and preserves multiline review text", async () => {
  const reviewing = waitingTask();
  reviewing.title = "A".repeat(180);
  reviewing.reviews[0].prompt = "First line\nSecond line";
  render(<App api={api(async () => ({ tasks: [reviewing], issues: [], coordinator: "ready" }))} />);
  expect(await screen.findByRole("heading", { name: reviewing.title })).toBeInTheDocument();
  expect(screen.getByText(/First line\s+Second line/)).toHaveClass("review-prompt");
});

it("routes cancellation through the coordinator and keeps partial output links", async () => {
  const user = userEvent.setup();
  const current = waitingTask();
  current.status = "queued";
  current.reviews = [];
  current.workflow = current.proposedWorkflow;
  current.proposedWorkflow = null;
  current.artifacts = [{ id: "notes", version: 2, digest: "d", path: "artifacts/notes.2.bin" }];
  const cancelled = { ...current, status: "cancelled" as const, revision: 2 };
  let persisted = current;
  const boundary = api(async () => ({ tasks: [persisted], issues: [], coordinator: "ready" }));
  vi.mocked(boundary.command).mockImplementation(async () => { persisted = cancelled; return cancelled; });
  render(<App api={boundary} />);
  await screen.findByRole("heading", { name: "Draft" });
  await user.click(screen.getByRole("button", { name: "Cancel task" }));
  expect(boundary.command).toHaveBeenCalledWith(expect.objectContaining({ taskId: current.id, expectedRevision: 1, action: { kind: "cancel" } }));
  expect(await screen.findByRole("link", { name: "notes · v2" })).toHaveAttribute("href", `/api/tasks/${current.id}/artifacts/notes?version=2`);
});
