import { useState } from "react";
import { ArrowLeft, Check, Clock3, GitBranch, X } from "lucide-react";
import type { Command, Task } from "../../shared/contracts";
import { isClosed, statusLabel, typeLabel } from "../tasks/presentation";
import { TypeIcon } from "./Icons";
import ReviewPanel from "./ReviewPanel";
import WorkflowJourney from "./WorkflowJourney";

type Props = { task: Task; stale: boolean; onBack: () => void; onCommand: (command: Command) => Promise<void> };
export default function TaskDetail({ task, stale, onBack, onCommand }: Props) {
  const [tab, setTab] = useState<"journey" | "activity">("journey");
  const pending = isClosed(task) ? [] : task.reviews.filter(review => review.decision === null);
  const events = [
    ...task.reviews.map(review => ({ id: `review-${review.id}`, at: null as string | null, text: `${review.kind} review: ${review.decision ?? "pending"}${review.answer ? ` · ${review.answer}` : ""}` })),
    ...task.runs.map(run => ({ id: `run-${run.id}`, at: run.startedAt, text: `${run.stepId}: ${run.result?.summary ?? run.phase}` })),
  ];
  const lastResult = [...task.runs].reverse().find(run => run.result)?.result;
  return <main className="detail-panel" aria-label="Task details"><div className="detail-scroll"><div className="detail-inner">
    <button className="text-button back-button" onClick={onBack}><ArrowLeft size={15} /> Inbox</button>
    <div className="detail-title-row"><h2 className="detail-title">{task.title}</h2><span className="detail-status"><span className={`status status-${task.status}`}><i />{statusLabel(task)}</span></span></div>
    <div className="detail-properties">
      <span className={`type-label ${task.type}`}><TypeIcon type={task.type} />{typeLabel(task.type)}</span>
      <span className="task-subtitle-id">{task.id}</span>
      <span><span className="property-label">Source</span>{task.source}</span>
      <span><span className="property-label">Workflow</span><GitBranch size={13} />{task.workflow ? `v${task.workflow.version}` : task.proposedWorkflow ? `Proposed v${task.proposedWorkflow.version}` : "Triage"}</span>
    </div>
    {stale && <div className="notice-banner" role="status">Last known task. Reconnecting to the coordinator…</div>}
    {task.blockedReason && <div className="closed-banner"><X size={17} /><div><strong>Blocked</strong><p>{task.blockedReason}</p></div></div>}
    <section className="brief-section"><div className="section-caption"><h3>The brief</h3></div><p>{task.idea}</p></section>
    {pending.map((review, index) => <ReviewPanel key={`${task.id}-${review.id}`} task={task} review={review} disabled={stale || index !== 0} onCommand={onCommand} />)}
    {isClosed(task) && <div className="closed-banner"><Check size={17} /><div><strong>Task {statusLabel(task).toLowerCase()}</strong><p>{task.status === "done" && lastResult?.kind === "completed" ? lastResult.summary : "The task record and partial output remain available for inspection."}</p></div></div>}
    {isClosed(task) && task.artifacts.length > 0 && <section className="task-artifacts"><h3>Saved output</h3><ul>{task.artifacts.map(ref => <li key={`${ref.id}-${ref.version}`}><a href={`/api/tasks/${encodeURIComponent(task.id)}/artifacts/${encodeURIComponent(ref.id)}?version=${ref.version}`} download>{ref.id} · v{ref.version}</a></li>)}</ul></section>}
    <div className="detail-tabs"><div role="tablist" aria-label="Task view"><button role="tab" aria-selected={tab === "journey"} className={tab === "journey" ? "selected" : ""} onClick={() => setTab("journey")}><GitBranch size={15} /> Journey</button><button role="tab" aria-selected={tab === "activity"} className={tab === "activity" ? "selected" : ""} onClick={() => setTab("activity")}><Clock3 size={15} /> Activity <span>{events.length}</span></button></div><span className="workflow-version">{task.workflow ? `Workflow v${task.workflow.version}` : "Awaiting workflow"}</span></div>
    {tab === "journey" ? <WorkflowJourney task={task} disabled={stale} onCommand={onCommand} /> : <section className="activity-view" aria-label="Task activity"><h3>Task activity</h3><ol>{events.map(event => <li key={event.id}><span className="activity-dot"><Check size={12} /></span><div><p>{event.text}</p>{event.at && <span>{new Date(event.at).toLocaleString()}</span>}</div></li>)}</ol></section>}
  </div></div></main>;
}
