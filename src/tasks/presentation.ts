import type { Task } from "../../shared/contracts";

export type Filter = "all" | "review" | "active" | "closed";
export type TaskGroup = {
  id: "review" | "active" | "waiting" | "closed";
  label: string;
  tasks: Task[];
};

export function groupTasks(tasks: Task[], filter: Filter, query: string): TaskGroup[] {
  const groups: TaskGroup[] = [
    { id: "review", label: "Needs review", tasks: [] },
    { id: "active", label: "Active", tasks: [] },
    { id: "waiting", label: "Waiting", tasks: [] },
    { id: "closed", label: "Closed", tasks: [] },
  ];
  const search = query.toLowerCase();
  for (const task of tasks) {
    if (!matchesFilter(task, filter)) continue;
    if (!`${task.title} ${task.idea} ${task.type} ${task.source}`.toLowerCase().includes(search)) continue;
    const group = needsReview(task) ? groups[0]
      : isClosed(task) ? groups[3]
      : matchesFilter(task, "active") ? groups[1]
      : groups[2];
    group.tasks.push(task);
  }
  return groups.filter((group) => group.tasks.length > 0);
}

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
  filter: Filter,
): boolean {
  if (filter === "review") return needsReview(task);
  if (filter === "closed") return isClosed(task);
  if (filter === "active")
    return ["triaging", "queued", "running", "blocked"].includes(task.status);
  return true;
}
