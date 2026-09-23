import { useCallback, useEffect, useRef, useState } from "react";
import type { Command, Task, WorkspaceView } from "../../shared/contracts";
import { ApiError, workspaceApi, type WorkspaceApi } from "./api";

function isUnavailable(cause: unknown): boolean {
  return !(cause instanceof ApiError) || cause.status >= 500;
}

export function useWorkspace(api: WorkspaceApi = workspaceApi): {
  view: WorkspaceView | null;
  connected: boolean;
  error: string | null;
  refresh(): Promise<void>;
  submit(markdown: string): Promise<void>;
  act(command: Command): Promise<void>;
  mutateTask(operation: () => Promise<Task>): Promise<Task>;
  submissionId: string | null;
} {
  const [view, setView] = useState<WorkspaceView | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const latestRequest = useRef(0);
  const mutationGeneration = useRef(0);
  const mutationInFlight = useRef(false);
  const retainConflict = useRef(false);
  const mounted = useRef(false);
  const activeLoad = useRef<AbortController | null>(null);
  const pendingSubmission = useRef<{
    markdown: string;
    requestId: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    const generation = ++latestRequest.current;
    const mutation = mutationGeneration.current;
    activeLoad.current?.abort();
    const controller = new AbortController();
    activeLoad.current = controller;
    try {
      const loaded = await api.load(controller.signal);
      if (
        mounted.current &&
        generation === latestRequest.current &&
        mutation === mutationGeneration.current &&
        !mutationInFlight.current
      ) {
        setView(current => current ? { ...loaded, tasks: loaded.tasks.map(task => { const prior = current.tasks.find(t => t.id === task.id); return prior && prior.revision > task.revision ? prior : task; }) } : loaded);
        setConnected(true);
        setSubmissionId((current) =>
          current &&
          loaded.tasks.some((task) => task.source === `drafts/${current}.md`)
            ? null
            : current,
        );
        if (!retainConflict.current) setError(null);
      }
    } catch (cause) {
      if (
        mounted.current &&
        !controller.signal.aborted &&
        generation === latestRequest.current
      ) {
        setConnected(false);
        setError((current) =>
          retainConflict.current && current
            ? current
            : cause instanceof Error
              ? cause.message
              : "Coordinator unavailable",
        );
      }
    } finally {
      if (activeLoad.current === controller) activeLoad.current = null;
    }
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    const poll = () => {
      if (!mutationInFlight.current && activeLoad.current === null)
        void refresh();
    };
    poll();
    const interval = window.setInterval(poll, 2000);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
      activeLoad.current?.abort();
      activeLoad.current = null;
    };
  }, [refresh]);

  const submit = useCallback(
    async (markdown: string) => {
      if (!connected) throw new Error("Coordinator unavailable");
      ++mutationGeneration.current;
      ++latestRequest.current;
      activeLoad.current?.abort();
      activeLoad.current = null;
      mutationInFlight.current = true;
      const pending = pendingSubmission.current;
      const requestId =
        pending?.markdown === markdown
          ? pending.requestId
          : crypto.randomUUID();
      pendingSubmission.current = { markdown, requestId };
      try {
        const receipt = await api.submit(markdown, requestId);
        pendingSubmission.current = null;
        if (mounted.current) setSubmissionId(receipt.submissionId);
        if (mounted.current) setError(null);
      } catch (cause) {
        if (mounted.current) {
          if (isUnavailable(cause)) setConnected(false);
          setError(
            cause instanceof Error ? cause.message : "Submission failed",
          );
        }
        throw cause;
      } finally {
        ++mutationGeneration.current;
        mutationInFlight.current = false;
      }
    },
    [api, connected],
  );

  const mutateTask = useCallback(
    async (operation: () => Promise<Task>) => {
      if (!connected) throw new Error("Coordinator unavailable");
      ++mutationGeneration.current;
      ++latestRequest.current;
      activeLoad.current?.abort();
      activeLoad.current = null;
      mutationInFlight.current = true;
      retainConflict.current = false;
      try {
        const updated = await operation();
        if (mounted.current) {
          setView((current) =>
            current
              ? {
                  ...current,
                  tasks: current.tasks.map((task) =>
                    task.id === updated.id && updated.revision >= task.revision ? updated : task,
                  ),
                }
              : current,
          );
          setError(null);
        }
        ++mutationGeneration.current;
        mutationInFlight.current = false;
        await refresh();
        return updated;
      } catch (cause) {
        ++mutationGeneration.current;
        mutationInFlight.current = false;
        retainConflict.current =
          cause instanceof ApiError && cause.status === 409;
        if (mounted.current) {
          if (isUnavailable(cause)) setConnected(false);
          const message =
            cause instanceof Error ? cause.message : "Command failed";
          setError(
            cause instanceof ApiError && cause.status === 409
              ? `${message}. Review the refreshed task before deciding again.`
              : message,
          );
        }
        if (cause instanceof ApiError && cause.status === 409) await refresh();
        throw cause;
      }
    },
    [connected, refresh],
  );
  const act = useCallback(async (command: Command) => { await mutateTask(() => api.command(command)); }, [api, mutateTask]);
  return { view, connected, error, refresh, submit, act, mutateTask, submissionId };
}
