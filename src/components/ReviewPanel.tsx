import { useState } from "react";
import type { Command, HumanAction, Review, Task } from "../../shared/contracts";
import { useTaskCommand } from "./useTaskCommand";
import { ArtifactPreview } from "./ArtifactPreview";
export type ReviewPanelProps = { task: Task; review: Review; disabled: boolean; onCommand: (command: Command) => Promise<void> };
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
    {review.artifacts.length > 0 && <div className="review-artifacts"><strong>Exact versions under review</strong><ul>{review.artifacts.map(ref => <ArtifactPreview key={`${task.id}:${ref.id}:${ref.version}`} taskId={task.id} artifact={ref} />)}</ul></div>}
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
