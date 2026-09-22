import { useRef, useState } from "react";
import type { Command, HumanAction, Task } from "../../shared/contracts";

export function useTaskCommand(task: Task, onCommand: (command: Command) => Promise<void>) {
  const identity = useRef<{ signature: string; requestId: string } | null>(null);
  const busy = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send(action: HumanAction): Promise<boolean> {
    if (busy.current) return false;
    const signature = JSON.stringify({ taskId: task.id, revision: task.revision, action });
    if (identity.current?.signature !== signature) {
      identity.current = { signature, requestId: crypto.randomUUID() };
    }
    const command: Command = {
      requestId: identity.current.requestId,
      taskId: task.id,
      expectedRevision: task.revision,
      action,
    };
    busy.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onCommand(command);
      identity.current = null;
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Command failed");
      return false;
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  }
  return { send, submitting, error, setError };
}
