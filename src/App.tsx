import { useEffect, useState } from "react";
import { ArrowUpRight, CircleHelp, Command, Sparkles, X } from "lucide-react";
import Inbox, { type Filter } from "./components/Inbox";
import NewTaskDialog from "./components/NewTaskDialog";
import TaskDetail from "./components/TaskDetail";
import { needsReview } from "./tasks/presentation";
import { workspaceApi, type WorkspaceApi } from "./tasks/api";
import { useWorkspace } from "./tasks/useWorkspace";

const PREF_KEY = "symphony-workspace-preferences-v1";
function preferences(): { selectedId: string | null; filter: Filter } {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PREF_KEY) ?? "null");
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return {
        selectedId:
          typeof record.selectedId === "string" ? record.selectedId : null,
        filter: ["all", "review", "active", "closed"].includes(
          String(record.filter),
        )
          ? (record.filter as Filter)
          : "all",
      };
    }
  } catch {
    /* UI preferences are optional. */
  }
  return { selectedId: null, filter: "all" };
}
export default function App({ api = workspaceApi }: { api?: WorkspaceApi }) {
  const workspace = useWorkspace(api);
  const [initial] = useState(preferences);
  const [selectedId, setSelectedId] = useState(initial.selectedId);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>(initial.filter);
  const [creating, setCreating] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [help, setHelp] = useState(false);
  const tasks = workspace.view?.tasks ?? [];
  useEffect(() => {
    if (!selectedId && tasks.length) setSelectedId(tasks[0].id);
  }, [selectedId, tasks]);
  useEffect(() => {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({ selectedId, filter }));
    } catch {
      /* Optional preference persistence. */
    }
  }, [selectedId, filter]);
  const task = tasks.find((item) => item.id === selectedId);
  const missing = !!selectedId && !!workspace.view && !task;
  const reviewCount = tasks.filter(needsReview).length;
  return (
    <div className="app-shell">
      <header className="app-header">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            setMobileDetail(false);
          }}
          aria-label="Symphony home"
        >
          <span className="brand-mark">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>
            symphony<span className="brand-period">.</span>
          </span>
        </a>
        <div className="header-divider" />
        <span className="workspace-name">
          Personal workspace <span className="workspace-chevron">⌄</span>
        </span>
        <span className="header-spacer" />
        <span className="coordinator-status">
          <span className={workspace.connected ? "green-dot" : "amber-dot"} />
          Coordinator{" "}
          {workspace.connected
            ? workspace.view?.coordinator === "degraded"
              ? "Degraded"
              : "Connected"
            : "Disconnected"}
        </span>
        <div className="workspace-bar-right">
          <span className="review-summary">
            <span className="amber-dot" />
            {reviewCount} awaiting your review
          </span>
          <button
            className="icon-button"
            aria-label="About this workspace"
            onClick={() => setHelp((value) => !value)}
          >
            <CircleHelp size={17} />
          </button>
        </div>
        <span className="avatar" title="Your workspace">
          MK
        </span>
      </header>
      {help && (
        <div className="help-banner">
          <Sparkles size={17} />
          <p>
            <strong>Task workspace.</strong> Add a Markdown draft here or place
            one in OneDrive. The coordinator picks it up, runs workflow steps,
            and pauses for your reviews in this workspace.
          </p>
          <button
            className="icon-button"
            aria-label="Close workspace information"
            onClick={() => setHelp(false)}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {!workspace.connected && (
        <div className="notice-banner error" role="alert">
          {workspace.error ?? "Connecting to the coordinator…"}{" "}
          {workspace.view &&
            "Showing the last known workspace; actions are unavailable."}
        </div>
      )}
      {workspace.connected && workspace.error && (
        <div className="notice-banner error" role="alert">
          {workspace.error}
        </div>
      )}
      {workspace.submissionId && (
        <div className="notice-banner" role="status">
          Submitted; waiting for pickup
        </div>
      )}
      {workspace.view?.issues.map((issue) => (
        <div key={issue.id} className="notice-banner" role="status">
          {issue.message}
        </div>
      ))}
      <div className={`workspace-body ${mobileDetail ? "show-detail" : ""}`}>
        <Inbox
          tasks={tasks}
          selectedId={selectedId}
          query={query}
          filter={filter}
          onSelect={(id) => {
            setSelectedId(id);
            setMobileDetail(true);
          }}
          onQuery={setQuery}
          onFilter={setFilter}
          onNew={() => setCreating(true)}
          canSubmit={workspace.connected}
        />
        {task ? (
          <TaskDetail
            key={task.id}
            task={task}
            stale={!workspace.connected}
            onBack={() => setMobileDetail(false)}
            onCommand={workspace.act}
          />
        ) : (
          <main className="empty-state" aria-label="Task details">
            <Command size={32} />
            <h2>
              {missing
                ? "Task unavailable"
                : workspace.connected
                  ? "A little space for your next idea."
                  : "Waiting for coordinator"}
            </h2>
            <p>
              {missing
                ? "The selected task is no longer in the coordinator view. Select another task to continue."
                : "Submit a Markdown draft to get started."}
            </p>
            {!missing && (
              <button
                className="button primary"
                onClick={() => setCreating(true)}
                disabled={!workspace.connected}
              >
                Submit a draft <ArrowUpRight size={15} />
              </button>
            )}
          </main>
        )}
      </div>
      <NewTaskDialog
        open={creating}
        onClose={() => setCreating(false)}
        onSubmit={async (markdown) => {
          await workspace.submit(markdown);
          setQuery("");
          setFilter("all");
        }}
        canSubmit={workspace.connected}
      />
    </div>
  );
}
