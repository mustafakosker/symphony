import ProjectSettings from "./components/ProjectSettings";
import ProjectsPage from "./components/ProjectsPage";
import {projectApi,type ProjectApi} from "./projects/api";
import { useEffect, useReducer, useRef, useState } from "react";
import { Command } from "lucide-react";
import NewTaskDialog from "./components/NewTaskDialog";
import TaskDetail from "./components/TaskDetail";
import TaskList from "./components/TaskList";
import WorkspaceShell from "./components/WorkspaceShell";
import { navigate, parsePreferences } from "./tasks/navigation";
import { workspaceApi, type WorkspaceApi } from "./tasks/api";
import { useWorkspace } from "./tasks/useWorkspace";

const PREF_KEY = "symphony-workspace-preferences-v1";

export default function App({ api = workspaceApi, projects: providedProjects }: { api?: WorkspaceApi; projects?:ProjectApi }) {
  const projects=providedProjects??projectApi;
  const workspace = useWorkspace(api);
  const [navigation, dispatch] = useReducer(navigate, undefined, () => {
    try { return parsePreferences(localStorage.getItem(PREF_KEY)); }
    catch { return parsePreferences(null); }
  });
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [searchPending, setSearchPending] = useState(false);
  const [returnFocusId, setReturnFocusId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const tasks = workspace.view?.tasks ?? [];
  const selectedTask = tasks.find(task => task.id === navigation.selectedId) ?? null;
  const detail = navigation.screen === "detail";
  const missing = detail && navigation.selectedId !== null && workspace.view !== null && selectedTask === null;
  const loading = workspace.view === null && workspace.error === null;

  useEffect(() => {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(navigation)); }
    catch { /* Presentation preferences are optional. */ }
  }, [navigation]);

  useEffect(() => {
    if (searchPending && !detail && searchRef.current) {
      searchRef.current.focus();
      setSearchPending(false);
    }
  }, [searchPending, detail, workspace.view]);

  const onSearch = () => {
    dispatch({ type: "back" });
    setReturnFocusId(null);
    setSearchPending(true);
  };
  return <>
    <WorkspaceShell screen={navigation.screen} onScreen={screen=>dispatch({type:"screen",screen})} tasks={tasks} filter={navigation.filter} task={selectedTask}
      connected={workspace.connected} coordinator={workspace.view?.coordinator ?? null}
      detail={detail} onFilter={filter => { dispatch({ type: "filter", filter }); setReturnFocusId(null); }}
      onSearch={onSearch} onBack={() => { dispatch({ type: "back" }); setReturnFocusId(navigation.selectedId); }}>
      <div className="workspace-alerts" aria-label="Workspace notices">
        {!workspace.connected && <div className="notice-banner error" role="alert">
          {workspace.error ?? "Connecting to the coordinator…"}
          {workspace.view && " Showing the last known workspace; actions are unavailable."}
        </div>}
        {workspace.connected && workspace.error && <div className="notice-banner error" role="alert">{workspace.error}</div>}
        {workspace.submissionId && <div className="notice-banner" role="status">Submitted; waiting for pickup</div>}
        {workspace.view?.issues.map(issue => <div key={issue.id} className="notice-banner" role="status">{issue.message}{issue.id.startsWith("intake-")&&<button className="underline ml-3" onClick={()=>dispatch({type:"screen",screen:"projects"})}>Review pending drafts</button>}</div>)}
      </div>
      {navigation.screen === "settings" ? <ProjectSettings api={projects}/> : navigation.screen === "projects" ? <ProjectsPage api={projects} onOpenSettings={()=>dispatch({type:"screen",screen:"settings"})}/> : detail ? selectedTask ? <TaskDetail projects={projects} key={selectedTask.id} task={selectedTask} stale={!workspace.connected} onCommand={workspace.act} />
        : missing ? <section className="workspace-state"><Command size={28} /><h1>Task unavailable</h1><p>The selected task is no longer in the coordinator view. Return to the list to choose another task.</p></section>
        : loading ? <section className="workspace-state"><h1>Loading task…</h1></section>
        : <section className="workspace-state"><h1>Unable to load task</h1><p>Try again when the coordinator is available.</p></section>
      : !workspace.view && workspace.error ? <section className="workspace-state"><h1>Unable to load tasks</h1><p>{workspace.error}</p></section>
      : <TaskList tasks={tasks} filter={navigation.filter} query={query} selectedId={navigation.selectedId}
          loading={loading} canSubmit={workspace.connected} searchRef={searchRef} returnFocusId={returnFocusId}
          onQuery={setQuery} onSelect={id => { dispatch({ type: "select", id }); setReturnFocusId(null); }}
          onNew={() => setCreating(true)} />}
    </WorkspaceShell>
    <NewTaskDialog projects={providedProjects ?? (api===workspaceApi?projectApi:undefined)} open={creating} onClose={() => setCreating(false)} canSubmit={workspace.connected}
      onSubmit={async (markdown,projectDraft) => { await workspace.submit(markdown,projectDraft); setQuery(""); dispatch({ type: "submitted" }); setReturnFocusId(null); }} />
  </>;
}
