import {
  ArrowUpRight,
  Inbox as InboxIcon,
  Plus,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import type { Task } from "../../shared/contracts";
import {
  matchesFilter,
  needsReview,
  statusLabel,
  typeLabel,
} from "../tasks/presentation";
import { TypeIcon } from "./Icons";
export type Filter = "all" | "review" | "active" | "closed";
export type InboxProps = {
  tasks: Task[];
  selectedId: string | null;
  query: string;
  filter: Filter;
  onSelect: (id: string) => void;
  onQuery: (query: string) => void;
  onFilter: (filter: Filter) => void;
  onNew: () => void;
  canSubmit: boolean;
};
export default function Inbox({
  tasks,
  selectedId,
  query,
  filter,
  onSelect,
  onQuery,
  onFilter,
  onNew,
  canSubmit,
}: InboxProps) {
  const visible = tasks.filter(
    (task) =>
      matchesFilter(task, filter) &&
      `${task.title} ${task.idea} ${task.type} ${task.source}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const reviews = tasks.filter(needsReview).length;
  return (
    <aside className="inbox-panel" aria-label="Task inbox">
      <div className="inbox-heading">
        <div>
          <h1>
            Inbox <span className="count">{tasks.length}</span>
          </h1>
        </div>
        <button
          className="icon-button new-task"
          aria-label="New task"
          onClick={onNew}
          disabled={!canSubmit}
        >
          <Plus size={20} />
        </button>
      </div>
      <div className="search-box">
        <Search size={16} />
        <input
          aria-label="Search tasks"
          placeholder="Search your tasks…"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      </div>
      <div className="inbox-filters" aria-label="Filter tasks">
        {(["all", "review", "active", "closed"] as Filter[]).map((value) => (
          <button
            key={value}
            aria-pressed={filter === value}
            className={filter === value ? "selected" : ""}
            onClick={() => onFilter(value)}
          >
            {
              {
                all: "All tasks",
                review: "Needs review",
                active: "Active",
                closed: "Closed",
              }[value]
            }
            {value === "review" && reviews > 0 && <span>{reviews}</span>}
          </button>
        ))}
      </div>
      <div className="list-caption">
        <span>
          {
            {
              all: "ALL TASKS",
              review: "WAITING FOR YOU",
              active: "IN PROGRESS",
              closed: "COMPLETED & CLOSED",
            }[filter]
          }
        </span>
        <span>
          {visible.length} <SlidersHorizontal size={12} />
        </span>
      </div>
      <div className="task-list">
        {visible.map((task) => (
          <button
            key={task.id}
            className={`task-row ${selectedId === task.id ? "selected" : ""}`}
            aria-pressed={selectedId === task.id}
            onClick={() => onSelect(task.id)}
          >
            <div className="row-meta">
              <span className={`type-label ${task.type}`}>
                <TypeIcon type={task.type} />
                {typeLabel(task.type)}
              </span>
              <span className="task-id">{task.source}</span>
            </div>
            <div className="task-title">{task.title}</div>
            <div className="task-excerpt">{task.idea}</div>
            <div className="row-bottom">
              <span className={`status status-${task.status}`}>
                <i />
                {statusLabel(task)}
              </span>
              {needsReview(task) ? (
                <span className="review-dot" title="Needs your review" />
              ) : (
                <span className="row-arrow">
                  <ArrowUpRight size={13} />
                </span>
              )}
            </div>
          </button>
        ))}
        {visible.length === 0 && (
          <div className="empty-state">
            <InboxIcon size={28} />
            <h3>No tasks here</h3>
            <p>Try another search or submit a new draft.</p>
            <button
              className="button secondary"
              onClick={onNew}
              disabled={!canSubmit}
            >
              Submit a draft
            </button>
          </div>
        )}
      </div>
      <div className="inbox-footer">
        <span className="tiny-logo">s</span>
        <div>
          <strong>Your work in one place.</strong>
          <span>Drafts arrive from OneDrive or this workspace.</span>
        </div>
      </div>
    </aside>
  );
}
