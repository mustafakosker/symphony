import { useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import type { Command, HumanAction, Review, Task } from "../../shared/contracts";
import { useTaskCommand } from "./useTaskCommand";
import { ArtifactPreview } from "./ArtifactPreview";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import WorkflowScope from "./WorkflowScope";

export type ReviewPanelProps = { task: Task; review: Review; disabled: boolean; onCommand: (command: Command) => Promise<void> };

export default function ReviewPanel({ task, review, disabled, onCommand }: ReviewPanelProps) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"changes" | "reject" | null>(null);
  const changesTrigger = useRef<HTMLButtonElement>(null);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const feedbackField = useRef<HTMLTextAreaElement>(null);
  const { send, submitting, error, setError } = useTaskCommand(task, onCommand);
  const waiting = review.decision === null && task.status === "waiting-for-human";
  const unavailable = disabled || submitting || !waiting;
  const question = review.kind === "question";
  const reconciliation = review.kind === "reconciliation";
  const approval = review.kind === "workflow" || review.kind === "artifact";
  const checkpoint = review.kind === "artifact" ? task.workflow?.steps.find(step => step.kind === "human" && step.id === review.stepId) : null;

  async function submit(action: HumanAction) {
    const accepted = await send(action);
    if (accepted) { setText(""); setMode(null); }
  }
  function openForm(next: "changes" | "reject") {
    setMode(next);
    setError(null);
    requestAnimationFrame(() => feedbackField.current?.focus());
  }
  function cancelForm() {
    const trigger = mode === "changes" ? changesTrigger.current : moreTrigger.current;
    setMode(null);
    setError(null);
    requestAnimationFrame(() => trigger?.focus());
  }
  function submitNote() {
    if (!text.trim()) { setError(mode === "reject" ? "Rejection note required" : "Feedback required"); return; }
    void submit({ kind: mode === "reject" ? "reject" : "changes", reviewId: review.id, text: text.trim() });
  }
  const proposal = review.kind === "workflow" && task.proposedWorkflow?.version === review.workflowVersion ? task.proposedWorkflow : null;
  const scopeUnavailable = review.kind === "workflow" && !proposal;

  return <section className="review-panel task-review" aria-label={`${review.kind} review`}>
    <div className="section-caption"><h3>{question ? "Question for you" : reconciliation ? "Reconciliation needed" : review.kind === "pause" ? "Paused for review" : review.kind === "workflow" ? "Review proposed workflow" : "Review output"}</h3></div>
    <p className="review-prompt">{review.prompt}</p>
    {review.kind === "workflow" && (scopeUnavailable
      ? <p role="status">Matching proposed workflow v{review.workflowVersion} scope is unavailable. Approval is disabled until it can be shown.</p>
      : <p>Proposed workflow v{review.workflowVersion}. Approving allows the proposed steps to start.</p>)}
    {proposal && <div className="review-proposal" aria-label={`Proposed workflow v${proposal.version} scope`}>
      <h4>Proposed workflow v{proposal.version} · scope for approval</h4>
      <WorkflowScope workflow={proposal} />
      {task.workflow && <p>Approved workflow v{task.workflow.version} remains the current history until this proposal is approved.</p>}
    </div>}
    {review.kind === "artifact" && <p>{checkpoint?.kind === "human" && checkpoint.allowsStepId === null
      ? "Approving completes the workflow after its completion checks pass."
      : "Approving allows the next workflow step to start."}</p>}
    {reconciliation && <p>Previous run effects may be uncertain. Check the external state and record how you resolved it before retrying.</p>}
    {review.artifacts.length > 0 && <div className="review-artifacts"><strong>Exact versions under review</strong><ul>{review.artifacts.map(ref => <ArtifactPreview key={`${task.id}:${ref.id}:${ref.version}`} taskId={task.id} artifact={ref} />)}</ul></div>}
    {(question || reconciliation) && <label className="review-label">{question ? "Your answer" : "Resolution note"}<Textarea value={text} onChange={event => { setText(event.target.value); setError(null); }} disabled={unavailable} rows={3} /></label>}
    {approval && <p className="muted review-consequence">Feedback is required to request changes or reject the task.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="stage-actions review-actions">
      {question && <Button disabled={unavailable} onClick={() => { if (!text.trim()) { setError("Answer required"); return; } void submit({ kind: "answer", reviewId: review.id, text: text.trim() }); }}>Send answer</Button>}
      {reconciliation && <Button disabled={unavailable} onClick={() => { if (!text.trim()) { setError("Resolution note required"); return; } void submit({ kind: "answer", reviewId: review.id, text: text.trim() }); }}>Retry</Button>}
      {review.kind === "pause" && <Button disabled={unavailable} onClick={() => void submit({ kind: "approve", reviewId: review.id, artifactDigests: review.artifacts.map(ref => ref.digest) })}>Continue</Button>}
      {approval && <>
        <Button disabled={unavailable || scopeUnavailable} onClick={() => void submit({ kind: "approve", reviewId: review.id, artifactDigests: review.artifacts.map(ref => ref.digest) })}>Approve</Button>
        <Button ref={changesTrigger} variant="outline" disabled={unavailable} onClick={() => openForm("changes")}>Request changes</Button>
        <DropdownMenu modal={false}><DropdownMenuTrigger asChild><Button ref={moreTrigger} variant="ghost" size="icon" disabled={unavailable} aria-label="More review actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end"><DropdownMenuItem variant="destructive" onSelect={() => openForm("reject")}>Reject task</DropdownMenuItem></DropdownMenuContent>
        </DropdownMenu>
      </>}
    </div>
    {approval && mode && <div className="review-feedback-form">
      <label className="review-label">{mode === "reject" ? "Rejection reason" : "Feedback"}<Textarea ref={feedbackField} value={text} onChange={event => { setText(event.target.value); setError(null); }} disabled={unavailable} rows={3} /></label>
      <div className="review-form-actions"><Button disabled={unavailable} variant={mode === "reject" ? "destructive" : "default"} onClick={submitNote}>{mode === "reject" ? "Reject task" : "Send feedback"}</Button><Button variant="ghost" onClick={cancelForm}>Cancel</Button></div>
    </div>}
  </section>;
}
