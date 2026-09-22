import { useEffect, useRef, type Ref } from "react";
import { Plus, Search } from "lucide-react";
import type { Task } from "../../shared/contracts";
import { groupTasks, statusLabel, typeLabel, type Filter } from "../tasks/presentation";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";
import "../styles/workspace.css";

export type TaskListProps = {
  tasks: Task[];
  filter: Filter;
  query: string;
  selectedId: string | null;
  loading: boolean;
  canSubmit: boolean;
  onQuery(query: string): void;
  onSelect(id: string): void;
  onNew(): void;
  searchRef?: Ref<HTMLInputElement>;
  returnFocusId?: string | null;
};

export default function TaskList({
  tasks, filter, query, selectedId, loading, canSubmit,
  onQuery, onSelect, onNew, searchRef, returnFocusId,
}: TaskListProps) {
  const groups = groupTasks(tasks, filter, query);
  const viewName = { all: "All tasks", review: "Needs review", active: "Active", closed: "Closed" }[filter];
  const headingRef = useRef<HTMLHeadingElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (!returnFocusId || loading) return;
    (rowRefs.current.get(returnFocusId) ?? headingRef.current)?.focus();
  }, [returnFocusId, loading]);

  const emptyHeading = tasks.length === 0 ? "No tasks yet"
    : query.trim() ? "No matching tasks"
    : filter === "closed" ? "No closed tasks"
    : filter === "review" ? "No tasks needing review"
    : filter === "active" ? "No active tasks"
    : "No matching tasks";

  return (
    <section className="workspace-task-list" aria-label="Task list">
      <header className="workspace-task-header">
        <div className="workspace-task-heading">
          <h1 ref={headingRef} tabIndex={-1}>{viewName}</h1>
          <Badge variant="outline" aria-label={`${tasks.length} tasks`}>{tasks.length}</Badge>
        </div>
        <Button onClick={onNew} disabled={!canSubmit}>
          <Plus aria-hidden="true" /> New task
        </Button>
      </header>
      <div className="workspace-task-search">
        <Search aria-hidden="true" size={16} />
        <Input
          ref={searchRef}
          aria-label="Search tasks"
          placeholder="Search tasks"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      </div>
      {loading ? (
        <div className="workspace-task-loading" role="status" aria-label="Loading tasks">
          {[0, 1, 2].map((index) => <Skeleton key={index} className="workspace-task-skeleton" />)}
        </div>
      ) : groups.length === 0 ? (
        <div className="workspace-task-empty">
          <h2>{emptyHeading}</h2>
          <p>{tasks.length === 0 ? "Create a task to get started." : "Try another search or view."}</p>
        </div>
      ) : (
        <div className="workspace-task-groups">
          {groups.map((group) => (
            <section key={group.id} aria-labelledby={`task-group-${group.id}`}>
              <h2 id={`task-group-${group.id}`} className="workspace-task-group-heading">
                {group.label} <span>{group.tasks.length}</span>
              </h2>
              <div className="workspace-task-group-rows">
                {group.tasks.map((task) => (
                  <Button
                    key={task.id}
                    variant="ghost"
                    className="workspace-task-row"
                    aria-pressed={selectedId === task.id}
                    ref={(node) => {
                      if (node) rowRefs.current.set(task.id, node);
                      else rowRefs.current.delete(task.id);
                    }}
                    onClick={() => onSelect(task.id)}
                  >
                    <span className={`workspace-task-status-dot workspace-task-status-${task.status}`} aria-hidden="true" />
                    <span className="workspace-task-row-title">{task.title}</span>
                    <span className="workspace-task-row-status">{statusLabel(task)}</span>
                    <Badge variant="outline" className="workspace-task-row-type">{typeLabel(task.type)}</Badge>
                  </Button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
