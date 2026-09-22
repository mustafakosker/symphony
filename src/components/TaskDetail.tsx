import TaskProjectContext from "./TaskProjectContext";
import {projectApi,type ProjectApi} from "../projects/api";
import { useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import type { Command, Task } from "../../shared/contracts";
import { isClosed, statusLabel, typeLabel } from "../tasks/presentation";
import { Badge } from "./ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { TaskActivity } from "./TaskActivity";
import { TaskArtifacts } from "./TaskArtifacts";
import { TaskProperties } from "./TaskProperties";
import ReviewPanel from "./ReviewPanel";
import WorkflowJourney from "./WorkflowJourney";

type Tab = "overview" | "activity" | "artifacts";
type Props = { projects?:ProjectApi; task: Task; stale: boolean; onBack?: () => void; backLabel?: string; onCommand: (command: Command) => Promise<void> };

export default function TaskDetail({ projects=projectApi,task, stale, onCommand }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const pending = isClosed(task) ? [] : task.reviews.filter(review => review.decision === null);
  const lastResult = [...task.runs].reverse().find(run => run.result)?.result;
  const version = task.workflow ? `Workflow v${task.workflow.version}` : task.proposedWorkflow ? `Proposed v${task.proposedWorkflow.version}` : "Awaiting workflow";

  return <section className="detail-panel" aria-label="Task details"><div className="task-detail-layout">
    <div className="detail-scroll"><div className="detail-inner">
      <div className="task-topline"><Badge variant="outline" className={`task-status-badge status-${task.status}`}>{statusLabel(task)}</Badge><span>{typeLabel(task.type)}</span><span aria-hidden="true">·</span><span>{version}</span></div>
      <h1 className="detail-title">{task.title}</h1>
      <p className="task-description">{task.idea}</p>
      <div className="task-properties-mobile"><Collapsible><CollapsibleTrigger className="task-properties-trigger">Properties <ChevronDown size={16} /></CollapsibleTrigger><CollapsibleContent><TaskProperties task={task} /></CollapsibleContent></Collapsible></div>
      <Tabs value={tab} onValueChange={value => setTab(value as Tab)}>
        <TabsList className="detail-tabs" aria-label="Task view">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="activity">Activity <span>{task.reviews.length + task.runs.length}</span></TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts <span>{task.artifacts.length}</span></TabsTrigger>
        </TabsList>
        <div hidden={tab !== "overview"}><TabsContent value="overview" forceMount>
          {stale && <div className="notice-banner" role="status">Last known task. Reconnecting to the coordinator…</div>}
          {task.blockedReason && <div className="closed-banner"><X size={17} /><div><strong>Blocked</strong><p>{task.blockedReason}</p></div></div>}
          {pending.map((review, index) => <ReviewPanel key={`${task.id}-${review.id}`} task={task} review={review} disabled={stale || index !== 0} onCommand={onCommand} />)}
          {isClosed(task) && <div className="closed-banner"><Check size={17} /><div><strong>Task {statusLabel(task).toLowerCase()}</strong><p>{task.status === "done" && lastResult?.kind === "completed" ? lastResult.summary : "The task record and partial output remain available for inspection."}</p></div></div>}
          {task.schemaVersion===2&&<TaskProjectContext task={task} api={projects}/>}
          <WorkflowJourney task={task} disabled={stale} onCommand={onCommand} />
        </TabsContent></div>
        <div hidden={tab !== "activity"}><TabsContent value="activity" forceMount><TaskActivity task={task} /></TabsContent></div>
        <div hidden={tab !== "artifacts"}><TabsContent value="artifacts" forceMount><TaskArtifacts task={task} api={projects} /></TabsContent></div>
      </Tabs>
    </div></div>
    <aside className="task-properties-rail" aria-label="Task properties"><TaskProperties task={task} /></aside>
  </div></section>;
}
