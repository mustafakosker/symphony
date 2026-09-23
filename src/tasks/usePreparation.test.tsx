// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { jiraTask } from "../../server/preparation/testing";
import type { Task } from "../../shared/contracts";
import type {
  PreparationDetail,
  PreparationCommand,
} from "../../shared/jira-preparation";
import { ApiError } from "./api";
import { usePreparation } from "./usePreparation";
import type { PreparationApi } from "./preparationApi";
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (v: Error) => void;
  const promise = new Promise<T>((y, n) => {
    resolve = y;
    reject = n;
  });
  return { resolve, reject, promise };
}
const mutateTask = (operation: () => Promise<Task>) => operation();
function apiFor(task: Task): PreparationApi {
  return {
    detail: async () => ({
      taskId: task.id,
      revision: task.revision,
      promptText: "saved",
    }),
    command: async () => ({ ...task, revision: task.revision + 1 }),
    upload: vi.fn(),
    sync: vi.fn(),
  };
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("preserves typing across late detail responses and Jira refresh", async () => {
  const task = jiraTask(),
    detail = deferred<PreparationDetail>(),
    api = { ...apiFor(task), detail: vi.fn(() => detail.promise) };
  const { result, rerender } = renderHook(
    ({ task }) => usePreparation({ task, connected: true, api, mutateTask }),
    { initialProps: { task } },
  );
  act(() => result.current.setPromptText("my words"));
  await act(async () =>
    detail.resolve({ taskId: task.id, revision: 1, promptText: "old" }),
  );
  rerender({ task: { ...task, revision: 2, title: "Refreshed" } });
  expect(result.current.promptText).toBe("my words");
  expect(result.current.dirty).toBe(true);
});
it("replays the entire save envelope after response loss even when polling advances", async () => {
  const task = jiraTask(),
    sent: PreparationCommand[] = [];
  let fail = true;
  const api = {
    ...apiFor(task),
    command: async (c: PreparationCommand) => {
      sent.push(c);
      if (fail) throw new Error("Network lost");
      return { ...task, revision: 2 };
    },
  };
  const { result, rerender } = renderHook(
    ({ task }) => usePreparation({ task, connected: true, api, mutateTask }),
    { initialProps: { task } },
  );
  await waitFor(() => expect(result.current.promptText).toBe("saved"));
  act(() => result.current.setPromptText(" exact "));
  await act(async () => {
    expect(await result.current.save()).toBe(false);
  });
  rerender({ task: { ...task, revision: 2 } });
  fail = false;
  await act(async () => {
    expect(await result.current.save()).toBe(true);
  });
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
});
it("keeps typing during a save dirty and flushes it afterward", async () => {
  const task = jiraTask(),
    gate = deferred<Task>(),
    sent: PreparationCommand[] = [];
  const api = {
    ...apiFor(task),
    command: async (c: PreparationCommand) => {
      sent.push(c);
      return sent.length === 1 ? gate.promise : { ...task, revision: 3 };
    },
  };
  const { result } = renderHook(() =>
    usePreparation({ task, connected: true, api, mutateTask }),
  );
  await waitFor(() => expect(result.current.promptText).toBe("saved"));
  act(() => result.current.setPromptText("first"));
  let saving!: Promise<boolean>;
  act(() => {
    saving = result.current.save();
  });
  act(() => result.current.setPromptText("second"));
  await act(async () => {
    gate.resolve({ ...task, revision: 2 });
    await saving;
  });
  expect(result.current.dirty).toBe(true);
  expect(result.current.promptText).toBe("second");
  await act(async () => {
    await result.current.flush();
  });
  expect(sent[1].expectedRevision).toBe(2);
  expect(result.current.dirty).toBe(false);
});
it("requires explicit save after a conflict and retains upload errors until discard", async () => {
  const task = jiraTask();
  const api = {
    ...apiFor(task),
    command: vi.fn(async (): Promise<Task> => {
      throw new ApiError("Changed", 409);
    }),
    upload: vi.fn(async () => {
      throw new ApiError("Wrong file", 400);
    }),
  };
  const { result, rerender } = renderHook(
    ({ task }) => usePreparation({ task, connected: true, api, mutateTask }),
    { initialProps: { task } },
  );
  await waitFor(() => expect(result.current.promptText).toBe("saved"));
  act(() => result.current.setPromptText("mine"));
  await act(async () => {
    await result.current.save();
  });
  rerender({ task: { ...task, revision: 2 } });
  await new Promise((r) => setTimeout(r, 550));
  expect(api.command).toHaveBeenCalledTimes(1);
  expect(result.current.promptText).toBe("mine");
  api.command.mockImplementation(async () => ({ ...task, revision: 3 }));
  await act(async () => {
    await result.current.save();
  });
  await act(async () => {
    await result.current.upload("design", new File(["x"], "x.md"));
  });
  expect(result.current.uploadError.design).toBeTruthy();
  await act(async () => {
    expect(await result.current.send()).toBe(false);
  });
  act(() => result.current.discardUploadError("design"));
  expect(result.current.uploadError.design).toBeUndefined();
});
it("aborts old detail on task switch, blocks disconnect and duplicate send", async () => {
  const task = jiraTask(),
    gate = deferred<Task>(),
    signals: AbortSignal[] = [];
  const api = {
    ...apiFor(task),
    detail: async (id: string, signal?: AbortSignal) => {
      signals.push(signal!);
      return { taskId: id, revision: 1, promptText: "saved" };
    },
    command: vi.fn(() => gate.promise),
  };
  const { result, rerender } = renderHook(
    ({ task, connected }) =>
      usePreparation({ task, connected, api, mutateTask }),
    { initialProps: { task, connected: true } },
  );
  await waitFor(() => expect(result.current.promptText).toBe("saved"));
  let sending!: Promise<boolean>;
  act(() => {
    sending = result.current.send();
  });
  await act(async () => {
    expect(await result.current.send()).toBe(false);
    gate.resolve({ ...task, revision: 2 });
    await sending;
  });
  expect(api.command).toHaveBeenCalledTimes(1);
  rerender({
    task: { ...task, id: "22222222-2222-4222-8222-222222222222" },
    connected: false,
  });
  expect(signals[0].aborted).toBe(true);
  await act(async () => {
    expect(await result.current.send()).toBe(false);
  });
});

it("keeps the edit base when another tab is polled before autosave", async () => {
  const task = jiraTask(),
    sent: PreparationCommand[] = [];
  const api = {
    ...apiFor(task),
    command: async (c: PreparationCommand) => {
      sent.push(c);
      throw new ApiError("Task revision has changed", 409);
    },
  };
  const { result, rerender } = renderHook(
    ({ task }) => usePreparation({ task, connected: true, api, mutateTask }),
    { initialProps: { task } },
  );
  await waitFor(() => expect(result.current.promptText).toBe("saved"));
  act(() => result.current.setPromptText("tab A unsaved edit"));
  rerender({ task: { ...task, revision: 2 } });
  await act(async () => {
    await result.current.save();
  });
  expect(sent[0].expectedRevision).toBe(1);
  expect(result.current.promptText).toBe("tab A unsaved edit");
  await act(async () => {
    expect(await result.current.flush()).toBe(false);
  });
  expect(sent).toHaveLength(1);
  await act(async () => {
    await result.current.save();
  });
  expect(sent[1].expectedRevision).toBe(2);
  expect(sent[1].requestId).not.toBe(sent[0].requestId);
});
it("blocks Send until the displayed prompt is loaded for the current task revision", async () => {
  const task = jiraTask(),
    first = deferred<PreparationDetail>(),
    next = deferred<PreparationDetail>();
  const api = {
    ...apiFor(task),
    detail: vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(() => next.promise),
    command: vi.fn(async () => ({ ...task, revision: 3 })),
  };
  const { result, rerender } = renderHook(
    ({ task }) => usePreparation({ task, connected: true, api, mutateTask }),
    { initialProps: { task } },
  );
  await act(async () => {
    expect(await result.current.send()).toBe(false);
  });
  expect(api.command).not.toHaveBeenCalled();
  await act(async () =>
    first.resolve({
      taskId: task.id,
      revision: 1,
      promptText: "visible old prompt",
    }),
  );
  rerender({ task: { ...task, revision: 2 } });
  await act(async () => {
    expect(await result.current.send()).toBe(false);
  });
  expect(api.command).not.toHaveBeenCalled();
  await act(async () =>
    next.resolve({
      taskId: task.id,
      revision: 2,
      promptText: "visible new prompt",
    }),
  );
  await act(async () => {
    expect(await result.current.send()).toBe(true);
  });
  expect(api.command).toHaveBeenCalledWith(
    expect.objectContaining({ expectedRevision: 2 }),
  );
});
it("refreshes the displayed draft after a lost-save replay returns a newer server draft", async () => {
  const task = jiraTask();
  let fail = true;
  const api = {
    ...apiFor(task),
    detail: async () => ({
      taskId: task.id,
      revision: fail ? 1 : 3,
      promptText: fail ? "saved" : "newer remote draft",
    }),
    command: async () => {
      if (fail) throw new Error("Response lost");
      return { ...task, revision: 3 };
    },
  };
  const { result } = renderHook(() =>
    usePreparation({ task, connected: true, api, mutateTask }),
  );
  await waitFor(() => expect(result.current.promptText).toBe("saved"));
  act(() => result.current.setPromptText("my submitted draft"));
  await act(async () => {
    await result.current.save();
  });
  fail = false;
  await act(async () => {
    await result.current.save();
  });
  expect(result.current.promptText).toBe("newer remote draft");
  expect(result.current.dirty).toBe(false);
});
it("locks setters immediately during Send but allows navigation after the saved handoff", async () => {
  const task = jiraTask(),
    gate = deferred<Task>(),
    api = { ...apiFor(task), command: vi.fn(() => gate.promise) };
  const { result } = renderHook(() =>
    usePreparation({ task, connected: true, api, mutateTask }),
  );
  await waitFor(() => expect(result.current.promptText).toBe("saved"));
  let sending!: Promise<boolean>;
  act(() => {
    sending = result.current.send();
  });
  act(() => {
    result.current.setPromptText("too late");
    result.current.setTarget({
      projectId: "other",
      repositoryId: "repo",
      branch: "new",
    });
  });
  expect(result.current.promptText).toBe("saved");
  expect(result.current.dirty).toBe(false);
  await act(async () => {
    gate.resolve({ ...task, revision: 3, status: "done" });
    await sending;
    expect(await result.current.flush()).toBe(true);
  });
  expect(api.command).toHaveBeenCalledTimes(1);
});
it("replays a lost Send envelope before reconciling the matching unconfirmed request", async () => {
  const task = jiraTask();
  let calls = 0;
  const sent: PreparationCommand[] = [];
  const uncertain = {
    ...task,
    revision: 3,
    status: "blocked" as const,
    preparation: {
      ...task.preparation!,
      attempts: [
        {
          requestId: task.id + ":send-original",
          packageRef: {
            id: "jira-package",
            version: 1,
            digest: "a".repeat(64),
            path: "artifacts/jira-package.1.bin",
          },
          payloadDigest: "a".repeat(64),
          dispatch: 1,
          status: "unconfirmed" as const,
          receipt: null,
          reason: "unknown",
        },
      ],
    },
  };
  const api = {
    ...apiFor(task),
    command: async (c: PreparationCommand) => {
      sent.push(c);
      if (++calls === 1) throw new Error("Response lost");
      return c.action.kind === "reconcile"
        ? { ...uncertain, revision: 4, status: "done" as const }
        : uncertain;
    },
  };
  const { result, rerender } = renderHook(
    ({ task }) => usePreparation({ task, connected: true, api, mutateTask }),
    { initialProps: { task } },
  );
  await waitFor(() => expect(result.current.promptText).toBe("saved"));
  await act(async () => {
    await result.current.send();
  });
  uncertain.preparation.attempts[0].requestId =
    task.id + ":" + sent[0].requestId;
  rerender({ task: uncertain });
  await act(async () => {
    expect(await result.current.reconcile()).toBe(true);
  });
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[2].action).toEqual({
    kind: "reconcile",
    handoffRequestId: uncertain.preparation.attempts[0].requestId,
  });
});
