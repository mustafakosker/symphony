import { randomUUID } from "node:crypto";
import type { Task } from "../../shared/contracts.js";
import type {
  FrozenPackage,
  HandoffAttempt,
  PreparationCommand,
} from "../../shared/jira-preparation.js";
import { preparationReady } from "../../shared/jira-preparation.js";
import {
  parseFrozenPackage,
  parseOnaReceipt,
  parsePreparationCommand,
} from "../../shared/jira-validation.js";
import { BoundaryError } from "../../shared/validate.js";
import type { Registry } from "../config/registry.js";
import type { Store } from "../store/task-store.js";
import type { OnaAdapter, OnaLaunch, OnaOutcome } from "../ona/adapter.js";
import {
  assertEditable,
  validateInput,
  type PreparationOperations,
} from "./operations.js";
import { validateTarget } from "./drafts.js";
import { validateDocument } from "./documents.js";
export type HandoffService = ReturnType<typeof createHandoffService>;
export function createHandoffService({
  store,
  registry,
  operations,
  adapter,
  timeoutMs = 10000,
  now = () => new Date(),
}: {
  store: Store;
  registry: Registry;
  operations: PreparationOperations;
  adapter: OnaAdapter;
  timeoutMs?: number;
  now?: () => Date;
}) {
  let closed = false;
  const owned = new Map<
    string,
    { controller: AbortController; promise: Promise<Task> }
  >();
  const pending = new Set<Promise<Task>>();
  const failures: unknown[] = [];
  const selection = (p: NonNullable<Task["preparation"]>) => ({
    jira: p.source,
    prompt: p.prompt,
    documents: p.documents,
    target: p.target,
  });
  const decode = (b: Uint8Array) =>
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
  async function hydrate(p: FrozenPackage): Promise<OnaLaunch> {
    validateTarget(registry, p.target);
    const promptText = decode(await store.readArtifact(p.taskId, p.prompt.ref));
    if (!promptText.trim())
      throw new BoundaryError("invalid", "Prompt must not be blank");
    const documents = await Promise.all(
      (["design", "implementation"] as const).map(async (role) => {
        const doc = p.documents[role],
          bytes = await store.readArtifact(p.taskId, doc.ref);
        validateDocument(doc.filename, bytes);
        if (bytes.length !== doc.size)
          throw new BoundaryError(
            "invalid",
            "Document size differs from selection",
          );
        return { role, filename: doc.filename, bytes };
      }),
    );
    return { package: p, promptText, documents };
  }
  async function settle(
    taskId: string,
    attempt: HandoffAttempt,
    outcome: OnaOutcome,
    operationId: string,
    inputDigest: string,
  ): Promise<Task> {
    return operations.serial(taskId, async () => {
      const task = await store.get(taskId),
        last = task.preparation?.attempts.at(-1);
      if (
        !last ||
        last.requestId !== attempt.requestId ||
        last.dispatch !== attempt.dispatch ||
        !["sending", "unconfirmed"].includes(last.status)
      )
        return task;
      if (outcome.kind === "accepted") {
        try {
          const receipt = parseOnaReceipt(outcome.receipt);
          if (receipt.requestId !== last.requestId || !receipt.simulated)
            throw new Error();
        } catch {
          outcome = {
            kind: "unknown",
            reason: "ONA returned an invalid receipt",
          };
        }
      }
      // Jira refreshes use the store directly; retry only revision races, never a changed attempt.
      for (let i = 0; i < 5; i++) {
        const current = await store.get(taskId),
          active = current.preparation?.attempts.at(-1);
        if (
          !active ||
          active.requestId !== attempt.requestId ||
          active.dispatch !== attempt.dispatch ||
          !["sending", "unconfirmed"].includes(active.status)
        )
          return current;
        try {
          return await store.apply(taskId, current.revision, operationId, {
            kind: "preparation",
            inputDigest,
            change: {
              kind: "settle",
              handoffRequestId: attempt.requestId,
              dispatch: attempt.dispatch,
              outcome:
                outcome.kind === "unknown" ? "unconfirmed" : outcome.kind,
              receipt: outcome.kind === "accepted" ? outcome.receipt : null,
              reason: outcome.kind === "accepted" ? null : outcome.reason,
            },
          });
        } catch (error) {
          if (
            !(error instanceof BoundaryError) ||
            error.code !== "conflict" ||
            i === 4
          )
            throw error;
        }
      }
      throw new Error("Could not settle handoff");
    });
  }
  function call(
    taskId: string,
    attempt: HandoffAttempt,
    launch: OnaLaunch | null,
    operationId: string,
    inputDigest: string,
  ): Promise<Task> {
    const key = taskId + ":" + attempt.requestId + ":" + attempt.dispatch;
    const current = owned.get(key);
    if (current) return current.promise;
    const controller = new AbortController();
    if (closed) controller.abort();
    const promise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let outcome: OnaOutcome;
      try {
        controller.signal.throwIfAborted();
        const aborted = new Promise<never>((_, reject) => {
          if (controller.signal.aborted)
            reject(new Error("Handoff interrupted"));
          else
            controller.signal.addEventListener(
              "abort",
              () => reject(new Error("Handoff interrupted")),
              { once: true },
            );
        });
        timer = setTimeout(() => controller.abort(), timeoutMs);
        outcome = await Promise.race([
          launch
            ? adapter.launch(launch, controller.signal)
            : adapter.lookup(attempt.requestId, controller.signal),
          aborted,
        ]);
      } catch {
        outcome = {
          kind: "unknown",
          reason:
            "ONA acceptance is unconfirmed. Check the existing request before retrying.",
        };
      } finally {
        clearTimeout(timer);
      }
      return settle(taskId, attempt, outcome, operationId, inputDigest);
    })();
    owned.set(key, { controller, promise });
    void promise.then(
      () => owned.delete(key),
      (error) => {
        owned.delete(key);
        failures.push(error);
      },
    );
    return promise;
  }
  async function launchCommand(
    input: PreparationCommand,
    kind: "send" | "retry",
  ): Promise<Task> {
    const command = validateInput(() => parsePreparationCommand(input));
    if (command.action.kind !== kind)
      throw new BoundaryError("invalid", `Expected ${kind}`);
    if (closed)
      throw new BoundaryError("unavailable", "Handoff service is closing");
    const inputDigest = operations.digest(command);
    const result = await operations.serial(command.taskId, async () => {
      const prior = await operations.replay(
        command.taskId,
        command.requestId,
        inputDigest,
      );
      if (prior) return { task: prior };
      if (closed)
        throw new BoundaryError("unavailable", "Handoff service is closing");
      const task = await store.get(command.taskId);
      assertEditable(task, command.expectedRevision);
      const p = task.preparation!;
      if (!preparationReady(p))
        throw new BoundaryError(
          "invalid",
          "Save both documents, prompt and target first",
        );
      let frozen: FrozenPackage, attempt: HandoffAttempt;
      if (command.action.kind === "retry") {
        const last = p.attempts.at(-1);
        if (
          !last ||
          last.status !== "not-accepted" ||
          last.requestId !== command.action.handoffRequestId
        )
          throw new BoundaryError(
            "conflict",
            "Only a rejected request can be retried",
          );
        frozen = parseFrozenPackage(
          JSON.parse(
            decode(await store.readArtifact(task.id, last.packageRef)),
          ),
        );
        if (
          operations.digest(selection(p)) !==
          operations.digest({
            jira: frozen.jira,
            prompt: frozen.prompt,
            documents: frozen.documents,
            target: frozen.target,
          })
        )
          throw new BoundaryError(
            "conflict",
            "Package changed; send a new request",
          );
        attempt = {
          ...last,
          dispatch: last.dispatch + 1,
          status: "sending",
          receipt: null,
          reason: null,
        };
      } else {
        frozen = {
          taskId: task.id,
          requestId: `${task.id}:${command.requestId}`,
          createdAt: now().toISOString(),
          jira: p.source,
          prompt: p.prompt!,
          documents: {
            design: p.documents.design!,
            implementation: p.documents.implementation!,
          },
          target: p.target!,
        };
        // Hydrate before publishing any dispatch intent.
        await hydrate(frozen);
        const packageRef = await store.publishArtifact(
          task.id,
          "jira-package",
          Buffer.from(JSON.stringify(frozen)),
        );
        attempt = {
          requestId: frozen.requestId,
          packageRef,
          payloadDigest: operations.digest(frozen),
          dispatch: 1,
          status: "sending",
          receipt: null,
          reason: null,
        };
      }
      const launch = await hydrate(frozen);
      const dispatched = await store.apply(
        task.id,
        task.revision,
        command.requestId,
        {
          kind: "preparation",
          inputDigest,
          change: { kind: "dispatch", attempt },
        },
      );
      return { task: dispatched, attempt, launch };
    });
    if (!result.attempt) return result.task;
    return call(
      command.taskId,
      result.attempt,
      result.launch!,
      `ona-settle-${randomUUID()}`,
      inputDigest,
    );
  }
  function track(work: () => Promise<Task>): Promise<Task> {
    const promise = work();
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  }
  return {
    send: (c: PreparationCommand) => track(() => launchCommand(c, "send")),
    retry: (c: PreparationCommand) => track(() => launchCommand(c, "retry")),
    reconcile: (input: PreparationCommand) =>
      track(async () => {
        const command = validateInput(() => parsePreparationCommand(input)),
          inputDigest = operations.digest(command);
        if (command.action.kind !== "reconcile")
          throw new BoundaryError("invalid", "Expected reconciliation");
        if (closed)
          throw new BoundaryError("unavailable", "Handoff service is closing");
        const result = await operations.serial(command.taskId, async () => {
          const prior = await operations.replay(
            command.taskId,
            command.requestId,
            inputDigest,
          );
          if (prior) return { task: prior };
          const task = await store.get(command.taskId),
            attempt = task.preparation?.attempts.at(-1);
          if (
            task.revision !== command.expectedRevision ||
            !attempt ||
            command.action.kind !== "reconcile" ||
            attempt.requestId !== command.action.handoffRequestId ||
            attempt.status !== "unconfirmed"
          )
            throw new BoundaryError(
              "conflict",
              "No matching unconfirmed handoff",
            );
          return { task, attempt };
        });
        return result.attempt
          ? call(
              command.taskId,
              result.attempt,
              null,
              command.requestId,
              inputDigest,
            )
          : result.task;
      }),
    async recover() {
      for (const task of (await store.list()).tasks) {
        const attempt = task.preparation?.attempts.at(-1);
        if (attempt && ["sending", "unconfirmed"].includes(attempt.status))
          await call(
            task.id,
            attempt,
            null,
            `ona-recover-${randomUUID()}`,
            operations.digest(attempt),
          );
      }
    },
    async close() {
      closed = true;
      for (const entry of owned.values()) entry.controller.abort();
      const results = await Promise.allSettled([
        ...pending,
        ...[...owned.values()].map((v) => v.promise),
      ]);
      if (failures.length) throw failures[0];
      const failed = results.find((r) => r.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
  };
}
