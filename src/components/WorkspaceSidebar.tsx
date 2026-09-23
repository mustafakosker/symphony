import { Archive, CircleDot, Inbox, ListTodo, Search } from "lucide-react";
import type { Task, WorkspaceView } from "../../shared/contracts";
import { isClosed, matchesFilter, needsReview, type Filter } from "../tasks/presentation";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarSeparator, useSidebar,
} from "./ui/sidebar";
import { Button } from "./ui/button";

type Props = {
  screen?: string;
  onScreen?(screen: "projects" | "settings"): void;
  tasks: Task[];
  filter: Filter;
  connected: boolean;
  coordinator: WorkspaceView["coordinator"] | null;
  onFilter(filter: Filter): void;
  onSearch(): void;
};

const views = [
  { filter: "all", label: "All tasks", Icon: Inbox },
  { filter: "review", label: "Needs review", Icon: CircleDot },
  { filter: "active", label: "Active", Icon: ListTodo },
  { filter: "closed", label: "Closed", Icon: Archive },
] as const;

export default function WorkspaceSidebar({ screen,onScreen,tasks, filter, connected, coordinator, onFilter, onSearch }: Props) {
  const { setOpenMobile } = useSidebar();
  const counts: Record<Filter, number> = {
    all: tasks.length,
    review: tasks.filter(needsReview).length,
    active: tasks.filter(task => matchesFilter(task, "active")).length,
    closed: tasks.filter(isClosed).length,
  };
  return <Sidebar className="workspace-sidebar">
    <SidebarHeader className="workspace-sidebar-header">
      <div className="workspace-identity"><span className="workspace-identity-mark">S</span><span>Symphony</span></div>
      <span className="workspace-identity-caption">Personal workspace</span>
      <Button variant="ghost" className="workspace-sidebar-search" onClick={() => { setOpenMobile(false); onSearch(); }} aria-label="Search tasks">
        <Search aria-hidden="true" size={16} /> Search <kbd>⌘ K</kbd>
      </Button>
    </SidebarHeader>
    <SidebarSeparator />
    <SidebarContent>
      <SidebarGroup>
        <nav aria-label="Workspace">
          <SidebarMenu>
            {views.map(({ filter: view, label, Icon }) => <SidebarMenuItem key={view}>
              <SidebarMenuButton isActive={filter === view && !["projects","settings"].includes(screen??"")} aria-current={filter === view && !["projects","settings"].includes(screen??"") ? "page" : undefined}
                onClick={() => { onFilter(view); setOpenMobile(false); }}>
                <Icon aria-hidden="true" size={16} /> <span>{label}</span><span className="workspace-sidebar-count">{counts[view]}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>)}
          {onScreen && (["projects","settings"] as const).map(destination=><SidebarMenuItem key={destination}><SidebarMenuButton isActive={screen===destination} aria-current={screen===destination?"page":undefined} onClick={()=>{onScreen(destination);setOpenMobile(false);}}>{destination==="projects"?"Projects":"Settings"}</SidebarMenuButton></SidebarMenuItem>)}
          </SidebarMenu>
        </nav>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter className="workspace-sidebar-footer">
      <span className={`workspace-connection-dot ${connected ? coordinator === "degraded" ? "degraded" : "connected" : "disconnected"}`} />
      <span>Coordinator {connected ? coordinator === "degraded" ? "Degraded" : "Connected" : "Disconnected"}</span>
    </SidebarFooter>
  </Sidebar>;
}
