import { useEffect, useState } from "react";
import type { ArtifactRef, Command, HumanAction, Review, Task } from "../../shared/contracts";
import { useTaskCommand } from "./useTaskCommand";
export type ReviewPanelProps = { task: Task; review: Review; disabled: boolean; onCommand: (command: Command) => Promise<void> };
function ArtifactPreview({ taskId, ref }: { taskId: string; ref: ArtifactRef }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(ref.id)}?version=${ref.version}`;
  useEffect(() => {
    if (!open || text !== null) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`Artifact unavailable (${response.status})`);
        if (!response.headers.get("Content-Type")?.startsWith("text/plain")) throw new Error("Download this artifact to inspect it.");
        if (!response.body) throw new Error("Download this artifact to inspect it.");
        const reader = response.body.getReader();
        const limit = 256 * 1024;
        const chunks: Uint8Array[] = [];
        let length = 0;
        let truncated = false;
        try {
          while (length <= limit) {
            const next = await reader.read();
            if (next.done) break;
            const take = Math.min(next.value.length, limit + 1 - length);
            chunks.push(next.value.subarray(0, take));
            length += take;
            if (length > limit) { truncated = true; break; }
          }
        } finally {
          if (truncated || controller.signal.aborted) await reader.cancel().catch(() => {});
          else reader.releaseLock();
        }
        const bytes = new Uint8Array(Math.min(length, limit));
        let offset = 0;
        for (const chunk of chunks) {
          const count = Math.min(chunk.length, bytes.length - offset);
          bytes.set(chunk.subarray(0, count), offset);
          offset += count;
        }
        let preview: string;
        try { preview = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated }); }
        catch { throw new Error("Download this artifact to inspect it. Preview is not valid UTF-8 text."); }
        if (!controller.signal.aborted) setText(preview + (truncated ? "\n\nPreview truncated; download the artifact for the full content." : ""));
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Artifact unavailable");
      }
    })();
    return () => controller.abort();
  }, [open, text, url]);
  return <li><a href={url} download>{ref.id} · v{ref.version}</a><span title={ref.digest}>Digest {ref.digest}</span><button className="text-button" aria-expanded={open} onClick={() => setOpen(value => !value)}>View {ref.id} v{ref.version}</button>{open && <>{error && <p role="alert" className="error">{error}</p>}<pre className="artifact-preview">{text ?? "Loading artifact…"}</pre></>}</li>;
}
export default function ReviewPanel({ task, review, disabled, onCommand }: ReviewPanelProps) {
  const [text, setText] = useState("");
  const { send, submitting, error, setError } = useTaskCommand(task, onCommand);
  const waiting = review.decision === null && task.status === "waiting-for-human";
  const unavailable = disabled || submitting || !waiting;
  const question = review.kind === "question";
  const reconciliation = review.kind === "reconciliation";
  const approval = review.kind === "workflow" || review.kind === "artifact";
  const checkpoint = review.kind === "artifact" ? task.workflow?.steps.find(step => step.kind === "human" && step.id === review.stepId) : null;
  const noteLabel = question ? "Your answer" : reconciliation ? "Resolution note" : "Feedback";
  async function submit(action: HumanAction) {
    const accepted = await send(action);
    if (accepted) setText("");
  }
  return <section className="review-panel" aria-label={`${review.kind} review`}>
    <div className="section-caption"><h3>{question ? "Question for you" : reconciliation ? "Reconciliation needed" : review.kind === "pause" ? "Paused for review" : review.kind === "workflow" ? "Review proposed workflow" : "Review output"}</h3></div>
    <p className="review-prompt">{review.prompt}</p>
    {review.kind === "workflow" && <p>Proposed workflow v{review.workflowVersion}. Approving allows the proposed steps to start.</p>}
    {review.kind === "artifact" && <p>{checkpoint?.kind === "human" && checkpoint.allowsStepId === null
      ? "Approving completes the workflow after its completion checks pass."
      : "Approving allows the next workflow step to start."}</p>}
    {reconciliation && <p>Previous run effects may be uncertain. Check the external state and record how you resolved it before retrying.</p>}
    {review.artifacts.length > 0 && <div className="review-artifacts"><strong>Exact versions under review</strong><ul>{review.artifacts.map(ref => <ArtifactPreview key={`${ref.id}-${ref.version}`} taskId={task.id} ref={ref} />)}</ul></div>}
    {(question || reconciliation || approval) && <label className="review-label">{noteLabel}<textarea value={text} onChange={event => { setText(event.target.value); setError(null); }} disabled={disabled || submitting || !waiting} rows={3} /></label>}
    {approval && <p className="muted">Feedback is required to request changes or reject the task.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="stage-actions">
      {question && <button className="button primary" disabled={unavailable} onClick={() => { if (!text.trim()) { setError("Answer required"); return; } void submit({ kind: "answer", reviewId: review.id, text: text.trim() }); }}>Send answer</button>}
      {reconciliation && <button className="button primary" disabled={unavailable} onClick={() => { if (!text.trim()) { setError("Resolution note required"); return; } void submit({ kind: "answer", reviewId: review.id, text: text.trim() }); }}>Retry</button>}
      {review.kind === "pause" && <button className="button primary" disabled={unavailable} onClick={() => void submit({ kind: "approve", reviewId: review.id, artifactDigests: review.artifacts.map(ref => ref.digest) })}>Continue</button>}
      {approval && <>
        <button className="button primary" disabled={unavailable} onClick={() => void submit({ kind: "approve", reviewId: review.id, artifactDigests: review.artifacts.map(ref => ref.digest) })}>Approve</button>
        <button className="button secondary" disabled={unavailable} onClick={() => { if (!text.trim()) { setError("Feedback required"); return; } void submit({ kind: "changes", reviewId: review.id, text: text.trim() }); }}>Request changes</button>
        <button className="button secondary" disabled={unavailable} onClick={() => { if (!text.trim()) { setError("Rejection note required"); return; } void submit({ kind: "reject", reviewId: review.id, text: text.trim() }); }}>Reject task</button>
      </>}
    </div>
  </section>;
}
