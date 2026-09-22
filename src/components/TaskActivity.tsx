import type { Task } from "../../shared/contracts";

export function TaskActivity({ task }: { task: Task }) {
  return <section className="activity-view" aria-label="Task activity">
    <h3>Task activity</h3>
    {task.reviews.length === 0 && task.runs.length === 0 && <p>No activity recorded yet.</p>}
    {task.reviews.length > 0 && <ol aria-label="Reviews">{task.reviews.map(review => <li key={review.id} className="activity-item">
      <strong>{review.kind} review: {review.decision ?? "pending"}</strong>
      <span className="activity-undated">Time not recorded</span>
      <p className="activity-prompt">{review.prompt}</p>
      {review.answer && <p>Answer: {review.answer}</p>}
    </li>)}</ol>}
    {task.runs.length > 0 && <ol aria-label="Runs">{task.runs.map(run => <li key={run.id} className="activity-item">
      <strong>{run.stepId}: {run.result?.summary ?? run.phase}</strong>
      <time dateTime={run.startedAt}>{new Date(run.startedAt).toLocaleString()}</time>
      {run.reconciliationNote && <p>{run.reconciliationNote}</p>}
    </li>)}</ol>}
  </section>;
}
