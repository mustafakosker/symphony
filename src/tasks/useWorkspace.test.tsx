// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { draftTask } from "../../server/testing/fixtures";
import type { Command, WorkspaceView } from "../../shared/contracts";
import { ApiError, type WorkspaceApi } from "./api";
import { useWorkspace } from "./useWorkspace";

const base: WorkspaceView = {
  tasks: [draftTask()],
  issues: [],
  coordinator: "ready",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const command: Command = {
  requestId: "decision-1",
  taskId: base.tasks[0].id,
  expectedRevision: 1,
  action: { kind: "pause" },
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("keeps a newer refresh when an older response arrives last", async () => {
  const old = deferred<WorkspaceView>();
  let calls = 0;
  const api: WorkspaceApi = {
    load: async () => (++calls === 1 ? old.promise : base),
    submit: vi.fn(),
    command: vi.fn(),
  };
  const { result } = renderHook(() => useWorkspace(api));
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.view?.tasks[0].title).toBe("Draft");
  await act(async () => {
    old.resolve({ ...base, tasks: [{ ...base.tasks[0], title: "Old" }] });
    await old.promise;
  });
  expect(result.current.view?.tasks[0].title).toBe("Draft");
});

it("preserves last known task and marks the view disconnected", async () => {
  let available = true;
  const api: WorkspaceApi = {
    load: async () => {
      if (!available) throw new Error("Coordinator unavailable");
      return base;
    },
    submit: vi.fn(),
    command: vi.fn(),
  };
  const { result } = renderHook(() => useWorkspace(api));
  await waitFor(() => expect(result.current.connected).toBe(true));
  available = false;
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.view?.tasks[0].title).toBe("Draft");
  expect(result.current.connected).toBe(false);
  await expect(result.current.act(command)).rejects.toThrow(
    "Coordinator unavailable",
  );
});

it("retains a 409 decision message after refreshing and never retries it", async () => {
  const api: WorkspaceApi = {
    load: vi.fn(async () => base),
    submit: vi.fn(),
    command: vi.fn(async () => {
      throw new ApiError("Task revision has changed", 409);
    }),
  };
  const { result } = renderHook(() => useWorkspace(api));
  await waitFor(() => expect(result.current.connected).toBe(true));
  await act(async () => {
    await expect(result.current.act(command)).rejects.toThrow(
      "Task revision has changed",
    );
  });
  expect(result.current.error).toMatch(/Review the refreshed task/);
  expect(api.command).toHaveBeenCalledTimes(1);
  expect(api.load).toHaveBeenCalledTimes(2);
});

it("keeps the submitted request ID on transport retry and clears pickup only for its source", async () => {
  let response: WorkspaceView = base;
  const sent: string[] = [];
  const api: WorkspaceApi = {
    load: async () => response,
    command: vi.fn(),
    submit: async (_markdown, id) => {
      sent.push(id);
      if (sent.length === 1) throw new Error("Network lost");
      return { submissionId: "33333333-3333-4333-8333-333333333333" };
    },
  };
  const { result } = renderHook(() => useWorkspace(api));
  await waitFor(() => expect(result.current.connected).toBe(true));
  await act(async () => {
    await expect(result.current.submit("# Brief")).rejects.toThrow(
      "Network lost",
    );
  });
  expect(result.current.connected).toBe(false);
  expect(result.current.view?.tasks[0].title).toBe("Draft");
  await expect(result.current.submit("# Brief")).rejects.toThrow(
    "Coordinator unavailable",
  );
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.connected).toBe(true);
  await act(async () => {
    await result.current.submit("# Brief");
  });
  expect(sent[0]).toBe(sent[1]);
  expect(result.current.submissionId).toBe(
    "33333333-3333-4333-8333-333333333333",
  );
  response = {
    ...base,
    tasks: [
      ...base.tasks,
      {
        ...base.tasks[0],
        id: "44444444-4444-4444-8444-444444444444",
        source: "drafts/unrelated.md",
      },
    ],
  };
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.submissionId).toBe(
    "33333333-3333-4333-8333-333333333333",
  );
  response = {
    ...base,
    tasks: [
      {
        ...base.tasks[0],
        source: "drafts/33333333-3333-4333-8333-333333333333.md",
      },
    ],
  };
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.submissionId).toBeNull();
});

it("keeps a persisted command result when the following refresh disconnects", async () => {
  const updated = { ...base.tasks[0], revision: 2, title: "Paused task" };
  let calls = 0;
  const api: WorkspaceApi = {
    load: async () => {
      if (++calls > 1) throw new Error("Disconnected");
      return base;
    },
    submit: vi.fn(),
    command: async () => updated,
  };
  const { result } = renderHook(() => useWorkspace(api));
  await waitFor(() => expect(result.current.connected).toBe(true));
  await act(async () => {
    await result.current.act(command);
  });
  expect(result.current.view?.tasks[0].title).toBe("Paused task");
  expect(result.current.connected).toBe(false);
});

it("lets a slow automatic poll settle before starting another", async () => {
  vi.useFakeTimers();
  const first = deferred<WorkspaceView>();
  const second = deferred<WorkspaceView>();
  const load = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const api: WorkspaceApi = { load, submit: vi.fn(), command: vi.fn() };
  const { result } = renderHook(() => useWorkspace(api));
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => {
    first.resolve(base);
    await first.promise;
  });
  expect(result.current.connected).toBe(true);
  expect(result.current.view?.tasks[0].title).toBe("Draft");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => {
    second.resolve(base);
    await second.promise;
  });
});

it("disconnects after command transport loss but preserves the task and command identity", async () => {
  const sent: Command[] = [];
  let fail = true;
  const api: WorkspaceApi = {
    load: async () => base,
    submit: vi.fn(),
    command: async (value) => {
      sent.push(value);
      if (fail) throw new Error("Network lost");
      return { ...base.tasks[0], revision: 2 };
    },
  };
  const { result } = renderHook(() => useWorkspace(api));
  await waitFor(() => expect(result.current.connected).toBe(true));
  await act(async () => {
    await expect(result.current.act(command)).rejects.toThrow("Network lost");
  });
  expect(result.current.connected).toBe(false);
  expect(result.current.view?.tasks[0].revision).toBe(1);
  await expect(result.current.act(command)).rejects.toThrow(
    "Coordinator unavailable",
  );
  expect(sent).toHaveLength(1);
  await act(async () => {
    await result.current.refresh();
  });
  fail = false;
  await act(async () => {
    await result.current.act(command);
  });
  expect(sent).toEqual([command, command]);
});

it("keeps HTTP validation and conflict responses connected", async () => {
  const api: WorkspaceApi = {
    load: async () => base,
    submit: async () => {
      throw new ApiError("Invalid draft", 400);
    },
    command: async () => {
      throw new ApiError("Task revision has changed", 409);
    },
  };
  const { result } = renderHook(() => useWorkspace(api));
  await waitFor(() => expect(result.current.connected).toBe(true));
  await act(async () => {
    await expect(result.current.submit("Brief")).rejects.toThrow(
      "Invalid draft",
    );
  });
  expect(result.current.connected).toBe(true);
  await act(async () => {
    await expect(result.current.act(command)).rejects.toThrow(
      "Task revision has changed",
    );
  });
  expect(result.current.connected).toBe(true);
});

it("retains the stale-decision warning if its refresh also disconnects", async () => {
  let calls = 0;
  const api: WorkspaceApi = {
    load: async () => {
      if (++calls > 1) throw new Error("Network lost");
      return base;
    },
    submit: vi.fn(),
    command: async () => {
      throw new ApiError("Task revision has changed", 409);
    },
  };
  const { result } = renderHook(() => useWorkspace(api));
  await waitFor(() => expect(result.current.connected).toBe(true));
  await act(async () => {
    await expect(result.current.act(command)).rejects.toThrow(
      "Task revision has changed",
    );
  });
  expect(result.current.connected).toBe(false);
  expect(result.current.error).toMatch(/Review the refreshed task/);
});

it("continues polling after an explicit refresh supersedes a stalled GET", async () => {
  vi.useFakeTimers();
  const stalled = deferred<WorkspaceView>();
  const signals: (AbortSignal | undefined)[] = [];
  let calls = 0;
  const api: WorkspaceApi = {
    load: async (signal) => {
      signals.push(signal);
      calls++;
      if (calls === 1) return stalled.promise; // Deliberately ignores abort.
      return {
        ...base,
        tasks: [{ ...base.tasks[0], title: calls === 2 ? "Manual" : "Polled" }],
      };
    },
    submit: vi.fn(),
    command: vi.fn(),
  };
  const { result } = renderHook(() => useWorkspace(api));
  expect(calls).toBe(1);
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.view?.tasks[0].title).toBe("Manual");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(calls).toBe(3);
  expect(result.current.view?.tasks[0].title).toBe("Polled");
  expect(signals[0]?.aborted).toBe(true);
  await act(async () => {
    stalled.resolve({ ...base, tasks: [{ ...base.tasks[0], title: "Old" }] });
    await stalled.promise;
  });
  expect(result.current.view?.tasks[0].title).toBe("Polled");
});
