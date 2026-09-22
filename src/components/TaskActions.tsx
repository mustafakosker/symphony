import { MoreHorizontal } from "lucide-react";
import type { HumanAction, Task } from "../../shared/contracts";
import { isClosed } from "../tasks/presentation";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

export type TaskActionsProps = {
  task: Task;
  disabled: boolean;
  onAction: (action: HumanAction) => Promise<boolean>;
};

export default function TaskActions({ task, disabled, onAction }: TaskActionsProps) {
  const pause = ["triaging", "queued", "running"].includes(task.status) && !task.intent;
  const cancel = !isClosed(task) && task.intent !== "cancel";
  if (!pause && !cancel) return null;
  return <DropdownMenu modal={false}>
    <DropdownMenuTrigger asChild><Button variant="outline" size="sm" disabled={disabled} aria-label="Task actions"><MoreHorizontal />Task actions</Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      {pause && <DropdownMenuItem onSelect={() => void onAction({ kind: "pause" })}>Pause for review</DropdownMenuItem>}
      {cancel && <DropdownMenuItem variant="destructive" onSelect={() => void onAction({ kind: "cancel" })}>Cancel task</DropdownMenuItem>}
    </DropdownMenuContent>
  </DropdownMenu>;
}
