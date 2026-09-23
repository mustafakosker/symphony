// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import JiraTaskDetail from "./JiraTaskDetail";
import { artifact, jiraTask } from "../../../server/preparation/testing";
import type { PreparationApi } from "../../tasks/preparationApi";
import type { Task } from "../../../shared/contracts";
const targets = [{ projectId: "app", repositoryId: "web", baseBranch: "main" }];
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("prepares documents, edits the exact prompt, and explicitly sends a simulated handoff", async () => {
  const user = userEvent.setup();
  let current = jiraTask(),
    text = "";
  const command: PreparationApi["command"] = vi.fn(async (c) => {
    const p = current.preparation!;
    if (c.action.kind === "prepare") {
      text = "Initial prompt";
      p.prompt = {
        ref: artifact("jira-prompt"),
        revision: 1,
        sourceDigest: p.sourceDigest,
        nonblank: true,
      };
    }
    if (c.action.kind === "save") {
      text = c.action.promptText;
      p.target = c.action.target;
      p.prompt = {
        ref: artifact("jira-prompt", 2),
        revision: 2,
        sourceDigest: p.sourceDigest,
        nonblank: !!text.trim(),
      };
    }
    if (c.action.kind === "send") {
      current.status = "done";
      p.phase = "sent";
      p.attempts = [
        {
          requestId: "request",
          packageRef: artifact("jira-package"),
          payloadDigest: "a".repeat(64),
          dispatch: 1,
          status: "accepted",
          reason: null,
          receipt: {
            requestId: "request",
            receiptId: "mock-1",
            acceptedAt: "2026-09-23T00:00:00Z",
            simulated: true,
          },
        },
      ];
    }
    current = { ...current, revision: current.revision + 1 };
    return current;
  });
  const api: PreparationApi = {
    command,
    sync: vi.fn(),
    detail: async () => ({
      taskId: current.id,
      revision: current.revision,
      promptText: text,
    }),
    upload: async (c, file) => {
      current.preparation!.documents[c.role] = {
        role: c.role,
        filename: file.name,
        size: file.size,
        ref: artifact("jira-" + c.role),
      };
      current = { ...current, revision: current.revision + 1 };
      return current;
    },
  };
  function Harness() {
    const [task, setTask] = useState(current);
    return (
      <JiraTaskDetail
        task={task}
        connected
        targets={targets}
        api={api}
        mutateTask={async (work) => {
          const t = await work();
          setTask({ ...t });
          return t;
        }}
        onBack={vi.fn()}
        registerLeaveGuard={vi.fn()}
      />
    );
  }
  render(<Harness />);
  expect(screen.queryByRole("button", { name: /Brainstorm/i })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Prepare for ONA" }));
  expect(await screen.findByLabelText("Launch prompt")).toHaveValue(
    "Initial prompt",
  );
  await user.upload(
    screen.getByLabelText("Design document"),
    new File(["# Design\n"], "design.md"),
  );
  expect(screen.getByRole("button", { name: "Send to ONA" })).toBeDisabled();
  await user.upload(
    screen.getByLabelText("Implementation plan"),
    new File(["# Plan\n"], "implementation.md"),
  );
  await user.selectOptions(screen.getByLabelText("Repository"), "app/web");
  await user.clear(screen.getByLabelText("Launch prompt"));
  await user.type(
    screen.getByLabelText("Launch prompt"),
    " Exact instructions. ",
  );
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send to ONA" })).toBeEnabled(),
  );
  expect(text).toBe(" Exact instructions. ");
  await user.click(screen.getByRole("button", { name: "Send to ONA" }));
  expect(await screen.findByText("Simulated ONA handoff")).toBeInTheDocument();
  expect(screen.getByText("mock-1")).toBeInTheDocument();
});
it("locks an unconfirmed handoff and offers reconciliation with source notices", async () => {
  const task = jiraTask();
  task.preparation!.matchesQuery = false;
  task.preparation!.attempts = [
    {
      requestId: "existing",
      packageRef: artifact("jira-package"),
      payloadDigest: "a".repeat(64),
      dispatch: 1,
      status: "unconfirmed",
      reason: "Unknown acceptance",
      receipt: null,
    },
  ];
  task.status = "blocked";
  const api: PreparationApi = {
    command: vi.fn(async () => task),
    detail: async () => ({
      taskId: task.id,
      revision: task.revision,
      promptText: "",
    }),
    upload: vi.fn(),
    sync: vi.fn(),
  };
  render(
    <JiraTaskDetail
      task={task}
      connected
      targets={targets}
      api={api}
      mutateTask={(work) => work()}
      onBack={vi.fn()}
      registerLeaveGuard={vi.fn()}
    />,
  );
  expect(screen.getByLabelText("Design document")).toBeDisabled();
  expect(screen.getByText(/no longer matches/i)).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Check handoff status" }),
  );
  expect(api.command).toHaveBeenCalledWith(
    expect.objectContaining({
      action: { kind: "reconcile", handoffRequestId: "existing" },
    }),
  );
});
it("refuses leaving after failed save and focuses the error", async () => {
  const task = jiraTask();
  let guard: (() => Promise<boolean>) | null = null;
  const api: PreparationApi = {
    command: vi.fn(async () => {
      throw new Error("Save unavailable");
    }),
    detail: async () => ({
      taskId: task.id,
      revision: task.revision,
      promptText: "saved",
    }),
    upload: vi.fn(),
    sync: vi.fn(),
  };
  task.preparation!.prompt = {
    ref: artifact("jira-prompt"),
    revision: 1,
    sourceDigest: "a".repeat(64),
    nonblank: true,
  };
  render(
    <JiraTaskDetail
      task={task}
      connected
      targets={targets}
      api={api}
      mutateTask={(work) => work()}
      onBack={vi.fn()}
      registerLeaveGuard={(value) => {
        guard = value;
      }}
    />,
  );
  await userEvent.type(await screen.findByLabelText("Launch prompt"), " new");
  let allowed = true;
  const { act } = await import("@testing-library/react");
  await act(async () => {
    allowed = await guard!();
  });
  expect(allowed).toBe(false);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
});

it("locks the editor immediately and recovers a lost Send through the visible status button", async () => {
  const { act } = await import("@testing-library/react");
  const user = userEvent.setup();
  let current = jiraTask();
  current.preparation!.target = {
    projectId: "app",
    repositoryId: "web",
    branch: "main",
  };
  current.preparation!.prompt = {
    ref: artifact("jira-prompt"),
    revision: 1,
    sourceDigest: "a".repeat(64),
    nonblank: true,
  };
  for (const role of ["design", "implementation"] as const)
    current.preparation!.documents[role] = {
      role,
      filename: role + ".md",
      size: 5,
      ref: artifact("jira-" + role),
    };
  const sent: import("../../../shared/jira-preparation").PreparationCommand[] =
    [];
  let rejectSend!: (e: Error) => void;
  const delayed = new Promise<Task>((_, reject) => {
    rejectSend = reject;
  });
  let update!: (task: Task) => void;
  const api: PreparationApi = {
    sync: vi.fn(),
    upload: vi.fn(),
    detail: async () => ({
      taskId: current.id,
      revision: current.revision,
      promptText: "Reviewed instructions",
    }),
    command: async (c) => {
      sent.push(c);
      if (sent.length === 1) return delayed;
      if (c.action.kind === "reconcile") {
        current = { ...current, status: "done", revision: 4 };
        current.preparation!.attempts[0] = {
          ...current.preparation!.attempts[0],
          status: "accepted",
          reason: null,
          receipt: {
            requestId: current.preparation!.attempts[0].requestId,
            receiptId: "mock-recovered",
            acceptedAt: "2026-09-23T00:00:00Z",
            simulated: true,
          },
        };
      }
      return current;
    },
  };
  function Harness() {
    const [task, setTask] = useState(current);
    update = setTask;
    return (
      <JiraTaskDetail
        task={task}
        connected
        targets={targets}
        api={api}
        mutateTask={async (work) => {
          const t = await work();
          setTask({ ...t });
          return t;
        }}
        onBack={vi.fn()}
        registerLeaveGuard={vi.fn()}
      />
    );
  }
  render(<Harness />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send to ONA" })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "Send to ONA" }));
  expect(screen.getByLabelText("Launch prompt")).toBeDisabled();
  expect(screen.getByLabelText("Branch")).toBeDisabled();
  await user.type(screen.getByLabelText("Launch prompt"), "Do not add this");
  expect(screen.getByLabelText("Launch prompt")).toHaveValue(
    "Reviewed instructions",
  );
  await act(async () => {
    rejectSend(new Error("Response lost"));
  });
  current = {
    ...current,
    revision: 3,
    status: "blocked",
    preparation: {
      ...current.preparation!,
      attempts: [
        {
          requestId: current.id + ":" + sent[0].requestId,
          packageRef: artifact("jira-package"),
          payloadDigest: "a".repeat(64),
          dispatch: 1,
          status: "unconfirmed",
          receipt: null,
          reason: "Unknown",
        },
      ],
    },
  };
  act(() => update(current));
  await user.click(
    screen.getByRole("button", { name: "Check handoff status" }),
  );
  expect(await screen.findByText("mock-recovered")).toBeInTheDocument();
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[2].action.kind).toBe("reconcile");
});
