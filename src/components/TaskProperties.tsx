import type { Task } from "../../shared/contracts";
import { statusLabel, typeLabel } from "../tasks/presentation";

function nextStep(task: Task): string | null {
  if (task.status === "blocked" || task.status === "cancelled" || task.status === "rejected" || task.status === "done") return null;
  const pending = task.reviews.filter(review => review.decision === null);
  if (pending.length !== 1) return null;
  const review = pending[0];
  if (review.kind === "workflow" && task.proposedWorkflow && review.workflowVersion === task.proposedWorkflow.version) return "Approval permits the proposed workflow steps to start.";
  if (review.kind !== "artifact" || review.stepId !== task.currentStepId) return null;
  const checkpoint = task.workflow?.steps.find(step => step.kind === "human" && step.id === review?.stepId);
  if (checkpoint?.kind !== "human") return null;
  if (checkpoint.allowsStepId === null) return "Approval starts workflow completion checks.";
  const allowed = task.workflow?.steps.find(step => step.id === checkpoint.allowsStepId);
  return allowed ? `Approval permits ${allowed.title} to start.` : null;
}

export function TaskProperties({ task }: { task: Task }) {
  const current = (task.workflow ?? task.proposedWorkflow)?.steps.find(step => step.id === task.currentStepId);
  const version = task.workflow ? `Version ${task.workflow.version}` : task.proposedWorkflow ? `Proposed version ${task.proposedWorkflow.version}` : "Awaiting workflow";
  const next = nextStep(task);
  return <div className="task-property-content">
    <h2>Properties</h2>
    <dl>
      <div><dt>Status</dt><dd>{statusLabel(task)}</dd></div>
      <div><dt>Type</dt><dd>{typeLabel(task.type)}</dd></div>
      <div><dt>Workflow</dt><dd>{version}</dd></div>
      <div><dt>Current step</dt><dd>{current?.title ?? (task.currentStepId === "$triage" ? "Triage" : task.currentStepId)}</dd></div>
      <div><dt>Source</dt><dd>{task.source}</dd></div>
      <div><dt>Task ID</dt><dd>{task.id}</dd></div>
    </dl>
    {next && <section className="task-next-up"><h2>Next up</h2><p>{next}</p></section>}
  </div>;
}
