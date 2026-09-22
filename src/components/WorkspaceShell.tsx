import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, CircleHelp, Search, X } from "lucide-react";
import type { Task, WorkspaceView } from "../../shared/contracts";
import type { Filter } from "../tasks/presentation";
import WorkspaceSidebar from "./WorkspaceSidebar";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from "./ui/sidebar";
import { TooltipProvider } from "./ui/tooltip";
import "../styles/workspace.css";

type Props = {
  tasks: Task[];
  filter: Filter;
  task: Task | null;
  connected: boolean;
  coordinator: WorkspaceView["coordinator"] | null;
  detail: boolean;
  onFilter(filter: Filter): void;
  onSearch(): void;
  onBack(): void;
  children: ReactNode;
};

const viewNames: Record<Filter, string> = {
  all: "All tasks", review: "Needs review", active: "Active", closed: "Closed",
};

const keepDesktopNavigationOpen = () => {};

function SearchShortcut({ onSearch }: { onSearch(): void }) {
  const { setOpenMobile } = useSidebar();
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpenMobile(false);
        onSearch();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [onSearch, setOpenMobile]);
  return null;
}

export default function WorkspaceShell({ tasks, filter, task, connected, coordinator, detail, onFilter, onSearch, onBack, children }: Props) {
  const [help, setHelp] = useState(false);
  return <TooltipProvider><SidebarProvider className="workspace-shell" open onOpenChange={keepDesktopNavigationOpen}>
    <SearchShortcut onSearch={onSearch} />
    <WorkspaceSidebar tasks={tasks} filter={filter} connected={connected} coordinator={coordinator} onFilter={onFilter} onSearch={onSearch} />
    <SidebarInset className="workspace-inset">
      <header className="workspace-location-bar">
        <SidebarTrigger aria-label="Open workspace menu" className="workspace-menu-trigger" />
        <span className="workspace-location-name">Personal workspace</span>
        <Separator orientation="vertical" className="workspace-location-separator" />
        <span className="workspace-location-current">{detail ? task?.title ?? "Task unavailable" : viewNames[filter]}</span>
        <span className="workspace-location-spacer" />
        <Button variant="ghost" size="icon" aria-label="Search tasks" onClick={onSearch}><Search size={17} /></Button>
        <Button variant="ghost" size="icon" aria-label="About this workspace" onClick={() => setHelp(value => !value)}><CircleHelp size={17} /></Button>
      </header>
      {help && <div className="workspace-help" role="note">
        <p><strong>Task workspace.</strong> Add a Markdown draft here or place one in OneDrive. The coordinator picks it up, runs workflow steps, and pauses for your reviews in this workspace.</p>
        <Button variant="ghost" size="icon-sm" aria-label="Close workspace information" onClick={() => setHelp(false)}><X size={15} /></Button>
      </div>}
      <main className="workspace-main">
        {detail && <div className="workspace-back-bar"><Button variant="ghost" onClick={onBack} aria-label={`Back to ${viewNames[filter].toLowerCase()}`}><ArrowLeft size={16} /> Back to {viewNames[filter].toLowerCase()}</Button></div>}
        {children}
      </main>
    </SidebarInset>
  </SidebarProvider></TooltipProvider>;
}
