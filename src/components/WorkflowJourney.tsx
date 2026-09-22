import { useEffect, useState } from "react";
import type { AgentStep, Command, Task } from "../../shared/contracts";
import { isClosed } from "../tasks/presentation";
import StageCard from "./StageCard";
import { useTaskCommand } from "./useTaskCommand";
export type WorkflowJourneyProps = { task: Task; disabled: boolean; onCommand: (command: Command) => Promise<void> };
const triage: AgentStep = { kind: "agent", id: "$triage", title: "Triage", role: "triage", instructions: "The coordinator examines the draft and proposes a workflow.", inputs: [], repositories: [], actions: ["read"], outputs: ["workflow proposal"], checks: [] };
export default function WorkflowJourney({ task, disabled, onCommand }: WorkflowJourneyProps) {
  const steps = task.workflow?.steps ?? [triage, ...(task.proposedWorkflow?.steps ?? [])];
  const [expanded, setExpanded] = useState<string[]>([task.currentStepId]);
  const [note, setNote] = useState("");
  const { send, submitting, error, setError } = useTaskCommand(task, onCommand);
  useEffect(() => setExpanded([task.currentStepId]), [task.id, task.currentStepId]);
  const completed = steps.filter(step => task.completedStepIds.includes(step.id) && !task.staleStepIds.includes(step.id)).length;
  const terminal = isClosed(task);
  const proposalPending = !terminal && task.reviews.some(review => review.kind === "workflow" && review.decision === null && review.workflowVersion === task.proposedWorkflow?.version);
  const active = ["triaging", "queued", "running"].includes(task.status);
  return <section aria-label="Workflow journey">
    {task.workflow && task.proposedWorkflow && <section className="review-panel" aria-label={`Proposed workflow v${task.proposedWorkflow.version}`}>
      <h3>Proposed workflow v{task.proposedWorkflow.version} · {proposalPending ? "awaiting approval" : "saved history"}</h3>
      <p>Completion checks: {task.proposedWorkflow.completionChecks.join(", ") || "none"}</p>
      <ol>{task.proposedWorkflow.steps.map(step => <li key={step.id}>
        <strong>{step.title}</strong>
        {step.kind === "agent" ? <>
          <p>{step.instructions}</p><p>Role: {step.role}</p>
          <p>Permitted actions: {step.actions.join(", ") || "none"}</p>
          <p>Repositories: {step.repositories.join(", ") || "none"}</p>
          <p>Inputs: {step.inputs.map(ref => `${ref.id} v${ref.version} (${ref.digest})`).join(", ") || "none"}</p>
          <p>Outputs: {step.outputs.join(", ") || "none"}</p><p>Checks: {step.checks.join(", ") || "none"}</p>
        </> : <><p>Review after {step.producerStepId}</p><p>Artifacts: {step.artifactIds.join(", ") || "all producer artifacts"}</p>
          <p>Allows next: {step.allowsStepId ?? "workflow completion"}</p></>}
      </li>)}</ol>
      <p>{proposalPending ? "Approval applies to this proposal. The approved workflow history follows." : "Saved proposal for inspection. The approved workflow history follows."}</p>
    </section>}
    {task.workflow && task.proposedWorkflow && <h3>Approved workflow v{task.workflow.version} · history</h3>}
    <div className="journey-heading"><div><h3>Workflow</h3><p>Steps and reviews from the coordinator.</p></div><span>{completed} <span>/ {steps.length} steps</span></span></div>
    {(task.workflow ?? task.proposedWorkflow) && <p className="muted">Completion checks: {(task.workflow ?? task.proposedWorkflow)!.completionChecks.join(", ") || "none"}</p>}
    <div className="progress-track" aria-label={`${completed} of ${steps.length} steps completed`}>{steps.map(step => <span key={step.id} className={task.completedStepIds.includes(step.id) && !task.staleStepIds.includes(step.id) ? "complete" : task.currentStepId === step.id ? "current" : ""} />)}</div>
    {task.intent === "pause" && <p role="status" className="notice-banner">Pause requested. The coordinator is stopping the current run before review.</p>}
    {task.intent === "cancel" && <p role="status" className="notice-banner">Cancellation requested. The coordinator is stopping the current run.</p>}
    {task.status === "blocked" && <div className="closed-banner"><div><strong>Blocked</strong><p>{task.blockedReason}</p><p>{task.intent ? "Confirm the process tree has ended and reconcile external effects. The resolution note settles the pending stop request." : "Check any external effects before retrying."}</p><label className="review-label">Resolution note<textarea value={note} onChange={event => { setNote(event.target.value); setError(null); }} disabled={disabled || submitting} /></label><button className="button secondary" disabled={disabled || submitting} onClick={() => { if (!note.trim()) { setError("Resolution note required"); return; } void send({ kind: "retry", text: note.trim() }).then(accepted => { if (accepted) setNote(""); }); }}>{task.intent ? "Confirm stop reconciliation" : "Retry"}</button></div></div>}
    <div className="journey">{steps.map(step => <StageCard key={`${task.id}-${step.id}`} task={task} step={step} expanded={expanded.includes(step.id)} onToggle={() => setExpanded(values => values.includes(step.id) ? values.filter(id => id !== step.id) : [...values, step.id])} disabled={disabled || submitting} onCommand={send} />)}</div>
    {!terminal && <div className="task-footer">
      {active && !task.intent && <button className="text-button" disabled={disabled || submitting} onClick={() => void send({ kind: "pause" })}>Pause for review</button>}
      {task.intent !== "cancel" && <button className="text-button danger" disabled={disabled || submitting} onClick={() => void send({ kind: "cancel" })}>Cancel task</button>}
    </div>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
