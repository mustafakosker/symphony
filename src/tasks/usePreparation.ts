import { useEffect, useRef, useState } from "react";
import type { Task } from "../../shared/contracts";
import type {
  DocumentRole,
  PreparationAction,
  PreparationCommand,
  Target,
  UploadCommand,
} from "../../shared/jira-preparation";
import { ApiError } from "./api";
import type { PreparationApi } from "./preparationApi";
type Pending =
  | { kind: "command"; command: PreparationCommand; generation: number }
  | { kind: "upload"; command: UploadCommand; file: File };
export function usePreparation({
  task,
  connected,
  api,
  mutateTask,
}: {
  task: Task;
  connected: boolean;
  api: PreparationApi;
  mutateTask: (operation: () => Promise<Task>) => Promise<Task>;
}) {
  const [promptText, setText] = useState(""),
    [target, setTargetState] = useState<Target | null>(
      task.preparation?.target ?? null,
    );
  const [visibleRevision, setVisibleRevision] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [uploadError, setUploadError] = useState<
      Partial<Record<DocumentRole, string>>
    >({});
  const state = useRef({
    id: task.id,
    task,
    text: "",
    target: task.preparation?.target ?? null,
    dirty: false,
    generation: 0,
    visibleRevision: null as number | null,
    editRevision: null as number | null,
    rebaseOnRetry: false,
    autoBlocked: false,
  });
  const pending = useRef<Pending | null>(null),
    running = useRef<Promise<boolean> | null>(null),
    errors = useRef<Partial<Record<DocumentRole, string>>>({});
  const live = useRef(true);
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  if (
    state.current.id === task.id &&
    task.revision >= state.current.task.revision
  )
    state.current.task = task;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (state.current.id !== task.id) {
      state.current = {
        id: task.id,
        task,
        text: "",
        target: task.preparation?.target ?? null,
        dirty: false,
        generation: 0,
        visibleRevision: null as number | null,
        editRevision: null as number | null,
        rebaseOnRetry: false,
        autoBlocked: false,
      };
      pending.current = null;
      running.current = null;
      errors.current = {};
      setVisibleRevision(null);
      setText("");
      setTargetState(state.current.target);
      setDirty(false);
      setBusy(false);
      setError(null);
      setUploadError({});
    }
    const controller = new AbortController(),
      id = task.id,
      revision = task.revision;
    void api
      .detail(id, controller.signal)
      .then((detail) => {
        const s = state.current;
        if (
          !live.current ||
          controller.signal.aborted ||
          s.id !== id ||
          detail.taskId !== id ||
          detail.revision !== revision ||
          s.task.revision !== revision
        )
          return;
        if (!s.dirty && !pending.current) {
          s.visibleRevision = detail.revision;
          setVisibleRevision(detail.revision);
          s.text = detail.promptText;
          s.target = s.task.preparation?.target ?? null;
          setText(s.text);
          setTargetState(s.target);
        }
      })
      .catch((cause) => {
        if (
          live.current &&
          !controller.signal.aborted &&
          state.current.id === id
        )
          setError(
            cause instanceof Error ? cause.message : "Could not load prompt",
          );
      });
    return () => controller.abort();
  }, [task.id, task.revision, api]);
  function editingLocked() {
    const p = pending.current;
    const task = state.current.task;
    return (
      ["done", "cancelled"].includes(task.status) ||
      ["sending", "unconfirmed"].includes(
        task.preparation?.attempts.at(-1)?.status ?? "",
      ) ||
      (p?.kind === "command" &&
        ["send", "retry", "reconcile", "cancel"].includes(
          p.command.action.kind,
        ))
    );
  }
  function beginEdit() {
    const s = state.current;
    if (!s.dirty) s.editRevision = s.visibleRevision ?? s.task.revision;
    return s;
  }
  function setPromptText(value: string) {
    if (editingLocked()) return;
    const s = beginEdit();
    s.text = value;
    s.generation++;
    s.dirty = true;
    setText(value);
    setDirty(true);
  }
  function setTarget(value: Target | null) {
    if (editingLocked()) return;
    const s = beginEdit();
    s.target = value;
    s.generation++;
    s.dirty = true;
    setTargetState(value);
    setDirty(true);
  }
  function updateUpload(role: DocumentRole, message?: string) {
    errors.current = { ...errors.current, [role]: message };
    setUploadError(errors.current);
  }
  function execute(next: () => Pending): Promise<boolean> {
    if (running.current) return Promise.resolve(false);
    if (!connectedRef.current) {
      setError("Coordinator unavailable. Your edits are retained.");
      return Promise.resolve(false);
    }
    const id = state.current.id;
    let p: Pending;
    try {
      p = pending.current ?? next();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action unavailable");
      return Promise.resolve(false);
    }
    pending.current = p;
    setBusy(true);
    setError(null);
    const promise = (async () => {
      try {
        const updated = await mutateTask(() =>
          p.kind === "upload"
            ? api.upload(p.command, p.file)
            : api.command(p.command),
        );
        if (!live.current || state.current.id !== id) return false;
        const s = state.current;
        if (updated.revision >= s.task.revision) s.task = updated;
        pending.current = null;
        s.autoBlocked = false;
        if (p.kind === "command" && p.command.action.kind === "save") {
          s.rebaseOnRetry = false;
          if (p.generation === s.generation) {
            s.dirty = false;
            s.editRevision = null;
            setDirty(false);
          } else {
            // Edits typed while this save was in flight are based on that save's successor.
            s.editRevision = p.command.expectedRevision + 1;
          }
        }
        if (
          p.kind === "upload" ||
          (p.kind === "command" &&
            ["save", "prepare", "remove-document"].includes(
              p.command.action.kind,
            ))
        ) {
          s.visibleRevision = null;
          setVisibleRevision(null);
          const detail = await api.detail(id);
          if (
            live.current &&
            state.current.id === id &&
            detail.taskId === id &&
            detail.revision === s.task.revision &&
            !s.dirty &&
            !pending.current
          ) {
            s.text = detail.promptText;
            s.target = s.task.preparation?.target ?? null;
            s.visibleRevision = detail.revision;
            setVisibleRevision(detail.revision);
            setText(s.text);
            setTargetState(s.target);
          }
        }
        if (p.kind === "upload") updateUpload(p.command.role);
        return true;
      } catch (cause) {
        if (live.current && state.current.id === id) {
          const message =
            cause instanceof Error ? cause.message : "Action failed";
          setError(
            cause instanceof ApiError && cause.status === 409
              ? `${message}. Review the refreshed task, then retry explicitly.`
              : message,
          );
          state.current.autoBlocked = true;
          if (
            p.kind === "command" &&
            p.command.action.kind === "save" &&
            cause instanceof ApiError &&
            cause.status === 409
          )
            state.current.rebaseOnRetry = true;
          if (p.kind === "upload") updateUpload(p.command.role, message);
          // Transport failures retain the complete envelope. Definitive validation/conflict failures release it.
          if (cause instanceof ApiError && cause.status < 500)
            pending.current = null;
        }
        return false;
      } finally {
        if (live.current && state.current.id === id) {
          running.current = null;
          setBusy(false);
        }
      }
    })();
    running.current = promise;
    return promise;
  }
  function command(action: PreparationAction): Pending {
    return {
      kind: "command",
      generation: state.current.generation,
      command: {
        taskId: state.current.id,
        requestId: crypto.randomUUID(),
        expectedRevision:
          action.kind === "save"
            ? (state.current.editRevision ?? state.current.task.revision)
            : state.current.task.revision,
        action,
      },
    };
  }
  function save(explicit = true) {
    if (state.current.rebaseOnRetry) {
      if (!explicit) return Promise.resolve(false);
      state.current.editRevision = state.current.task.revision;
      state.current.rebaseOnRetry = false;
    }
    const p = pending.current;
    if (p && (p.kind !== "command" || p.command.action.kind !== "save")) {
      setError("Retry the pending action before saving changes.");
      return Promise.resolve(false);
    }
    if (!state.current.dirty && !p) return Promise.resolve(true);
    return execute(() =>
      command({
        kind: "save",
        promptText: state.current.text,
        target: state.current.target,
      }),
    );
  }
  async function flush() {
    const p = pending.current;
    if (
      p?.kind === "command" &&
      ["send", "retry", "reconcile"].includes(p.command.action.kind)
    )
      return true;
    if (running.current && !(await running.current)) return false;
    if (Object.values(errors.current).some(Boolean)) {
      setError("Resolve or discard the failed upload before leaving.");
      return false;
    }
    while (state.current.dirty) {
      if (!(await save(false))) return false;
    }
    return !pending.current;
  }
  function action(kind: "prepare" | "send" | "retry" | "reconcile" | "cancel") {
    if (
      (kind === "send" || kind === "retry") &&
      (state.current.dirty || Object.values(errors.current).some(Boolean))
    )
      return Promise.resolve(false);
    if (
      pending.current &&
      (pending.current.kind !== "command" ||
        pending.current.command.action.kind !== kind)
    ) {
      setError("Retry the pending action first.");
      return Promise.resolve(false);
    }
    if (
      (kind === "send" || kind === "retry") &&
      !pending.current &&
      state.current.visibleRevision !== state.current.task.revision
    ) {
      setError(
        "Wait for the current saved prompt and target to load before sending.",
      );
      return Promise.resolve(false);
    }
    return execute(() => {
      const last = state.current.task.preparation?.attempts.at(-1);
      if ((kind === "retry" || kind === "reconcile") && !last)
        throw new Error("No handoff to check");
      return command(
        kind === "retry" || kind === "reconcile"
          ? { kind, handoffRequestId: last!.requestId }
          : { kind },
      );
    });
  }
  async function reconcile() {
    const retained = pending.current;
    if (
      retained?.kind === "command" &&
      ["send", "retry"].includes(retained.command.action.kind)
    ) {
      const expectedRequest =
        retained.command.action.kind === "retry"
          ? retained.command.action.handoffRequestId
          : `${retained.command.taskId}:${retained.command.requestId}`;
      if (!(await execute(() => retained))) return false;
      const latest = state.current.task.preparation?.attempts.at(-1);
      if (!latest || latest.requestId !== expectedRequest) {
        setError(
          "The recovered handoff no longer matches this request. Review the refreshed task.",
        );
        return false;
      }
      if (latest.status === "accepted" || latest.status === "not-accepted")
        return true;
      if (latest.status === "sending") {
        setError(
          "ONA is still processing the saved request. Check again after it settles.",
        );
        return false;
      }
    }
    return action("reconcile");
  }
  async function upload(role: DocumentRole, file: File) {
    if (pending.current?.kind === "upload") {
      if (pending.current.command.role !== role) {
        setError("Retry the pending upload first.");
        return false;
      }
      return execute(() => pending.current!);
    }
    if (!(await flush())) return false;
    return execute(() => ({
      kind: "upload",
      file,
      command: {
        taskId: state.current.id,
        requestId: crypto.randomUUID(),
        expectedRevision: state.current.task.revision,
        role,
        filename: file.name,
      },
    }));
  }
  async function remove(role: DocumentRole) {
    if (!(await flush())) return false;
    return execute(() => command({ kind: "remove-document", role }));
  }
  function discardUploadError(role: DocumentRole) {
    updateUpload(role);
    if (
      pending.current?.kind === "upload" &&
      pending.current.command.role === role
    )
      pending.current = null;
    setError(null);
  }
  useEffect(() => {
    if (!dirty || busy || !connected || error || state.current.autoBlocked)
      return;
    const timer = window.setTimeout(() => void save(false), 500);
    return () => window.clearTimeout(timer);
  });
  const unsaved =
    dirty ||
    Object.values(uploadError).some(Boolean) ||
    pending.current?.kind === "upload";
  return {
    promptText,
    target,
    snapshotReady: visibleRevision === task.revision && !dirty,
    editingLocked: editingLocked(),
    dirty,
    busy,
    error,
    uploadError,
    unsaved,
    setPromptText,
    setTarget,
    prepare: () => action("prepare"),
    save,
    upload,
    discardUploadError,
    remove,
    send: () => action("send"),
    retry: () => action("retry"),
    reconcile,
    cancel: () => action("cancel"),
    flush,
  };
}
