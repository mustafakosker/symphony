import type { Task } from "../../shared/contracts";

export function needsReview(task: Task): boolean {
  return task.status === "waiting-for-human" && task.reviews.some((review) => review.decision === null);
}
export function isClosed(task: Task): boolean {
  return (
    task.status === "done" ||
    task.status === "rejected" ||
    task.status === "cancelled"
  );
}
export function statusLabel(task: Task): string {
  if (isClosed(task)) return { done: "Done", rejected: "Rejected", cancelled: "Cancelled" }[task.status as "done" | "rejected" | "cancelled"];
  if (task.intent === "cancel") return "Cancelling";
  if (task.intent === "pause") return "Pausing";
  if (needsReview(task)) return "Needs review";
  return {
    triaging: "Triaging",
    queued: "Queued",
    running: "Running",
    "waiting-for-human": "Waiting for you",
    blocked: "Blocked",
    done: "Done",
    rejected: "Rejected",
    cancelled: "Cancelled",
  }[task.status];
}
export function typeLabel(type: string): string {
  return type
    ? type.replace(/[-_]/g, " ").replace(/^./, (letter) => letter.toUpperCase())
    : "Task";
}
export function matchesFilter(
  task: Task,
  filter: "all" | "review" | "active" | "closed",
): boolean {
  if (filter === "review") return needsReview(task);
  if (filter === "closed") return isClosed(task);
  if (filter === "active")
    return ["triaging", "queued", "running", "blocked"].includes(task.status);
  return true;
}
