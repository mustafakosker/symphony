import { createHash } from "node:crypto";
import type { Task } from "../../shared/contracts.js";
import { BoundaryError } from "../../shared/validate.js";
import type { Store } from "../store/task-store.js";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const digest = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const bytesDigest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export type PreparationOperations = {
  serial<T>(taskId: string, work: () => Promise<T>): Promise<T>;
  replay(
    taskId: string,
    requestId: string,
    inputDigest: string,
  ): Promise<Task | null>;
  digest(value: unknown): string;
};
export function createPreparationOperations(
  store: Store,
): PreparationOperations {
  const queues = new Map<string, Promise<void>>();
  return {
    digest,
    serial<T>(taskId: string, work: () => Promise<T>): Promise<T> {
      const result = (queues.get(taskId) ?? Promise.resolve()).then(work);
      const barrier = result.then(
        () => undefined,
        () => undefined,
      );
      queues.set(taskId, barrier);
      void barrier.then(() => {
        if (queues.get(taskId) === barrier) queues.delete(taskId);
      });
      return result;
    },
    async replay(taskId, requestId, inputDigest) {
      const prior = await store.operation(taskId, requestId);
      if (!prior) return null;
      if (
        prior.event.kind !== "preparation" ||
        prior.event.inputDigest !== inputDigest
      )
        throw new BoundaryError(
          "conflict",
          "Request ID was used with different content",
        );
      return store.get(taskId);
    },
  };
}
export function assertEditable(task: Task, expectedRevision: number): void {
  if (!task.preparation)
    throw new BoundaryError("invalid", "Task is not a Jira handoff");
  if (task.revision !== expectedRevision)
    throw new BoundaryError("conflict", "Task revision has changed");
  if (["done", "cancelled", "rejected"].includes(task.status))
    throw new BoundaryError("conflict", "Task is immutable");
  const status = task.preparation.attempts.at(-1)?.status;
  if (status === "sending" || status === "unconfirmed")
    throw new BoundaryError("conflict", "Resolve the pending handoff first");
}
export function validateInput<T>(parser: () => T): T {
  try {
    return parser();
  } catch (error) {
    if (error instanceof BoundaryError) throw error;
    throw new BoundaryError(
      "invalid",
      error instanceof Error ? error.message : "Invalid preparation request",
    );
  }
}
