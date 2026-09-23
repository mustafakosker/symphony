import { useEffect, useRef } from "react";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import type { Task } from "../../../shared/contracts";
import type { TargetOption } from "../../../shared/jira-preparation";
import { preparationReady } from "../../../shared/jira-preparation";
import type { PreparationApi } from "../../tasks/preparationApi";
import { usePreparation } from "../../tasks/usePreparation";
import { statusLabel } from "../../tasks/presentation";
import DocumentSlot from "./DocumentSlot";
import HandoffEditor from "./HandoffEditor";
import HandoffReceipt from "./HandoffReceipt";
export default function JiraTaskDetail({
  task,
  connected,
  targets,
  api,
  mutateTask,
  onBack,
  registerLeaveGuard,
}: {
  task: Task;
  connected: boolean;
  targets: TargetOption[];
  api: PreparationApi;
  mutateTask: (operation: () => Promise<Task>) => Promise<Task>;
  onBack: () => void;
  registerLeaveGuard: (guard: (() => Promise<boolean>) | null) => void;
}) {
  const draft = usePreparation({ task, connected, api, mutateTask }),
    p = task.preparation!,
    last = p.attempts.at(-1),
    errorRef = useRef<HTMLDivElement>(null);
  const locked =
    task.status === "done" ||
    task.status === "cancelled" ||
    last?.status === "sending" ||
    last?.status === "unconfirmed";
  const disabled = !connected || locked;
  const hasUploadError = Object.values(draft.uploadError).some(Boolean);
  useEffect(() => {
    registerLeaveGuard(async () => {
      const ok = await draft.flush();
      if (!ok) setTimeout(() => errorRef.current?.focus(), 0);
      return ok;
    });
    return () => registerLeaveGuard(null);
  }, [draft.flush, registerLeaveGuard]);
  useEffect(() => {
    if (!draft.unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft.unsaved]);
  return (
    <main
      className="detail-panel jira-preparation"
      aria-label="Jira task details"
    >
      <div className="detail-scroll">
        <div className="detail-inner">
          <button className="text-button back-button" onClick={onBack}>
            <ArrowLeft size={15} />
            Inbox
          </button>
          <div className="jira-eyebrow">
            JIRA → ONA <span>MOCK INTEGRATION</span>
          </div>
          <div className="detail-title-row">
            <h2 className="detail-title">{p.source.title}</h2>
            <span className={`status status-${task.status}`}>
              <i />
              {statusLabel(task)}
            </span>
          </div>
          <div className="jira-source-meta">
            <a href={p.source.url} target="_blank" rel="noreferrer">
              {p.source.key}
              <ArrowUpRight size={14} />
            </a>
            <span>{p.source.status}</span>
            <span>Updated {new Date(p.source.updatedAt).toLocaleString()}</span>
          </div>
          {!connected && (
            <p className="notice-banner" role="status">
              Last known task. Actions are unavailable while disconnected.
            </p>
          )}
          {!p.matchesQuery && (
            <p className="notice-banner" role="status">
              This issue no longer matches your assigned-open Jira query. Your
              preparation is retained.
            </p>
          )}
          {p.prompt && p.prompt.sourceDigest !== p.sourceDigest && (
            <p className="notice-banner" role="status">
              Jira changed since this draft was prepared. Review the latest
              details and your documents before sending.
            </p>
          )}
          <section className="jira-source">
            <h3>Jira details</h3>
            <pre>{p.source.description || "No description provided."}</pre>
            {p.source.acceptanceCriteria && (
              <>
                <h4>Acceptance criteria</h4>
                <pre>{p.source.acceptanceCriteria}</pre>
              </>
            )}
          </section>
          <HandoffReceipt task={task} />
          {last && last.status !== "accepted" && (
            <div className="jira-handoff-status" role="status">
              <h3>
                {last.status === "sending"
                  ? "Sending to ONA"
                  : last.status === "unconfirmed"
                    ? "Acceptance unconfirmed"
                    : "ONA did not accept this request"}
              </h3>
              <p>
                {last.reason ??
                  "The saved package is being sent. You can return to this task to check its status."}
              </p>
              <p className="jira-request-id">Request: {last.requestId}</p>
              {last.status === "unconfirmed" && (
                <button
                  className="button secondary"
                  disabled={!connected || draft.busy}
                  onClick={() => void draft.reconcile()}
                >
                  Check handoff status
                </button>
              )}
            </div>
          )}
          {draft.error && (
            <div
              ref={errorRef}
              tabIndex={-1}
              className="jira-error"
              role="alert"
            >
              {draft.error}
            </div>
          )}
          <section className="jira-documents">
            <div className="jira-section-heading">
              <h3>Task documents</h3>
              <span>Both required</span>
            </div>
            <div className="jira-document-grid">
              {(["design", "implementation"] as const).map((role) => (
                <DocumentSlot
                  key={role}
                  role={role}
                  selection={p.documents[role]}
                  taskId={task.id}
                  disabled={disabled || draft.busy}
                  error={draft.uploadError[role] ?? null}
                  onUpload={(file) => void draft.upload(role, file)}
                  onRemove={() => void draft.remove(role)}
                  onDiscardError={() => draft.discardUploadError(role)}
                />
              ))}
            </div>
          </section>
          {!p.prompt && !locked ? (
            <div className="jira-prepare">
              <p>
                Attach your design and implementation plan, then prepare an
                editable launch prompt.
              </p>
              <button
                className="button primary"
                disabled={!connected || draft.busy}
                onClick={() => void draft.prepare()}
              >
                Prepare for ONA
              </button>
            </div>
          ) : (
            p.prompt && (
              <HandoffEditor
                promptText={draft.promptText}
                target={draft.target}
                targets={targets}
                disabled={disabled}
                dirty={draft.dirty}
                busy={draft.busy}
                onPrompt={draft.setPromptText}
                onTarget={draft.setTarget}
                onSave={() => void draft.save()}
              />
            )
          )}
          {!locked && (
            <div className="jira-launch-actions">
              <p>
                {draft.dirty
                  ? "Save your edits before sending."
                  : hasUploadError
                    ? "Resolve the failed upload before sending."
                    : "The exact saved prompt and both documents will be sent together."}
              </p>
              <div className="jira-inline-actions">
                <button
                  className="button primary"
                  disabled={
                    !connected ||
                    draft.busy ||
                    draft.dirty ||
                    hasUploadError ||
                    !preparationReady(p)
                  }
                  onClick={() => void draft.send()}
                >
                  Send to ONA <ArrowUpRight size={15} />
                </button>
                {last?.status === "not-accepted" && (
                  <button
                    className="button secondary"
                    disabled={
                      !connected || draft.busy || draft.dirty || hasUploadError
                    }
                    onClick={() => void draft.retry()}
                  >
                    Retry unchanged package
                  </button>
                )}
                <button
                  className="text-button"
                  disabled={!connected || draft.busy}
                  onClick={() => void draft.cancel()}
                >
                  Cancel preparation
                </button>
              </div>
            </div>
          )}
          {task.status === "cancelled" && (
            <p className="notice-banner">
              Preparation cancelled. Saved documents remain available.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
