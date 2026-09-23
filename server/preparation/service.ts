import type {
  PreparationCommand,
  UploadCommand,
} from "../../shared/jira-preparation.js";
import { parsePreparationCommand } from "../../shared/jira-validation.js";
import { BoundaryError } from "../../shared/validate.js";
import type { Task } from "../../shared/contracts.js";
import type { Store } from "../store/task-store.js";
import type { Registry } from "../config/registry.js";
import type { OnaAdapter } from "../ona/adapter.js";
import {
  createPreparationOperations,
  assertEditable,
  validateInput,
} from "./operations.js";
import { createDocumentService } from "./documents.js";
import { createDraftService } from "./drafts.js";
import { createHandoffService } from "./handoff.js";
export type PreparationService = ReturnType<typeof createPreparationService>;
export function createPreparationService({
  store,
  registry,
  adapter,
}: {
  store: Store;
  registry: Registry;
  adapter: OnaAdapter;
  localRoot: string;
}) {
  const operations = createPreparationOperations(store),
    documents = createDocumentService(store, operations),
    drafts = createDraftService(store, registry, operations),
    handoff = createHandoffService({ store, registry, adapter, operations });
  let closed = false;
  const pending = new Set<Promise<Task>>();
  function track(work: () => Promise<Task>) {
    if (closed)
      return Promise.reject(
        new BoundaryError("unavailable", "Preparation service is closing"),
      );
    const promise = work();
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  }
  return {
    detail: drafts.detail,
    recover: handoff.recover,
    upload: (command: UploadCommand, bytes: Uint8Array) =>
      track(() => documents.upload(command, bytes)),
    command: (value: PreparationCommand) =>
      track(async () => {
        const command = validateInput(() => parsePreparationCommand(value));
        switch (command.action.kind) {
          case "prepare":
            return drafts.prepare(command);
          case "save":
            return drafts.save(command);
          case "remove-document":
            return documents.remove(command);
          case "send":
            return handoff.send(command);
          case "retry":
            return handoff.retry(command);
          case "reconcile":
            return handoff.reconcile(command);
          case "cancel":
            return operations.serial(command.taskId, async () => {
              const inputDigest = operations.digest(command),
                prior = await operations.replay(
                  command.taskId,
                  command.requestId,
                  inputDigest,
                );
              if (prior) return prior;
              const task = await store.get(command.taskId);
              assertEditable(task, command.expectedRevision);
              return store.apply(task.id, task.revision, command.requestId, {
                kind: "preparation",
                inputDigest,
                change: { kind: "cancel" },
              });
            });
        }
      }),
    async close() {
      closed = true;
      await handoff.close();
      await Promise.allSettled([...pending]);
    },
  };
}
