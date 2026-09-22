import {
  Check,
  ChevronDown,
  ClipboardCheck,
  Code2,
  Sparkles,
} from "lucide-react";
import type { AgentStep, HumanAction, HumanStep, Task } from "../../shared/contracts";
import RunOutput from "./RunOutput";
import { isClosed } from "../tasks/presentation";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Button } from "./ui/button";
type Props = {
  task: Task;
  step: AgentStep | HumanStep;
  expanded: boolean;
  onToggle: () => void;
  disabled: boolean;
  onCommand: (action: HumanAction) => Promise<boolean>;
};
export default function StageCard({ task, step, expanded, onToggle, disabled, onCommand }: Props) {
  const completed =
    task.completedStepIds.includes(step.id) &&
    !task.staleStepIds.includes(step.id);
  const current = !isClosed(task) && task.currentStepId === step.id && !completed;
  const stale = task.staleStepIds.includes(step.id);
  const runs = task.runs.filter(run => run.stepId === step.id);
  const review = task.reviews.find(
    (item) => !isClosed(task) && item.stepId === step.id && item.decision === null,
  );
  const Icon =
    step.kind === "human"
      ? ClipboardCheck
      : step.role === "implementer"
        ? Code2
        : Sparkles;
  return (
    <Collapsible
      open={expanded}
      onOpenChange={onToggle}
      data-stage={step.id}
      className={`stage-card ${current ? "current" : ""} ${stale ? "stale" : ""} ${review ? "review-card" : ""} ${expanded ? "expanded" : ""}`}
    >
      <CollapsibleTrigger asChild><button
        className="stage-toggle"
      >
        <span className={`stage-marker ${completed ? "complete" : ""}`}>
          {completed ? <Check size={15} /> : <Icon size={16} />}
        </span>
        <span className="stage-label">
          <strong>{step.title}</strong>
          <span>
            {review
              ? "Your review is pending"
              : stale
                ? "Stale; rerun needed"
              : completed
                ? "Completed"
                : current
                  ? "Current step"
                  : "Upcoming"}
          </span>
        </span>
        {review && <span className="review-tag">Your review</span>}
        <ChevronDown size={15} className={expanded ? "rotated" : ""} />
      </button></CollapsibleTrigger>
      <CollapsibleContent className="stage-content" id={`content-${task.id}-${step.id}`}>
          {step.kind === "agent" ? (
            <>
              <p className="stage-description">{step.instructions}</p>
              <div className="muted" aria-label={`${step.title} scope`}>
                <p>Role: {step.role}</p>
                <p>Permitted actions: {step.actions.join(", ") || "none"}</p>
                <p>Repositories: {step.repositories.join(", ") || "none"}</p>
                <p>Inputs: {step.inputs.map(ref => `${ref.id} v${ref.version}`).join(", ") || "none"}</p>
                <p>Outputs: {step.outputs.join(", ") || "none"}</p>
              </div>
              {runs
                .map((run) => (
                  <div key={run.id} className="agent-note">
                    <Sparkles size={17} />
                    <div>
                      <strong>
                        {run.phase === "uncertain" ? "Run needs reconciliation"
                          : run.phase === "launch-intent" ? "Run queued"
                          : run.phase === "running" ? "Run in progress"
                          : run.exitCode !== 0 || run.result?.kind === "failed" ? "Run failed"
                          : run.result?.kind === "blocked" ? "Run blocked"
                          : "Run finished"}
                      </strong>
                      <p>{run.result?.kind === "failed" || run.result?.kind === "blocked" ? run.result.reason : run.result?.summary ?? `Attempt ${run.id}`}</p>
                    </div>
                  </div>
                ))}
              {runs.at(-1) && <RunOutput taskId={task.id} runId={runs.at(-1)!.id} />}
              {task.workflow && (task.status === "queued" || task.status === "running") && !task.intent && !task.reviews.some(item => item.decision === null) && !task.completedStepIds.includes(step.id) && runs.length === 0 && !review && (task.status !== "running" || task.currentStepId !== step.id) && <Button variant="outline" disabled={disabled} onClick={() => void onCommand({ kind: "insert-review", beforeStepId: step.id, title: `Review before ${step.title}` })}>Review before this step</Button>}
              {step.checks.length > 0 && (
                <p className="muted">Checks: {step.checks.join(", ")}</p>
              )}
            </>
          ) : (
            <p className="stage-description">Review after {step.producerStepId}</p>
          )}
          {task.reviews
            .filter((item) => item.stepId === step.id && item.decision !== null)
            .map((item) => (
              <p key={item.id} className="feedback-note">
                {item.decision}: {item.answer || item.prompt}
              </p>
            ))}
          {runs.flatMap(run => run.result?.artifacts ?? []).map(artifact => <a key={`run-${artifact.id}-${artifact.version}`} href={`/api/tasks/${encodeURIComponent(task.id)}/artifacts/${encodeURIComponent(artifact.id)}?version=${artifact.version}`} download className="text-button">{artifact.id} · v{artifact.version}</a>)}
      </CollapsibleContent>
    </Collapsible>
  );
}
