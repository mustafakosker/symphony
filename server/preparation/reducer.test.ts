import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reduceTask, eligibleStep } from "../domain/workflow";
import { openStore } from "../store/task-store";
import { artifact, jiraTask } from "./testing";
import type { Task } from "../../shared/contracts";
import type {
  PreparationChange,
  PreparationEvent,
} from "../../shared/jira-preparation";
const event = (change: PreparationChange): PreparationEvent => ({
  kind: "preparation",
  inputDigest: "a".repeat(64),
  change,
});
const apply = (task: Task, change: PreparationChange) =>
  reduceTask(task, event(change), "2026-09-23T11:00:00Z");
function ready() {
  let task = jiraTask();
  for (const role of ["design", "implementation"] as const)
    task = apply(task, {
      kind: "document",
      role,
      document: {
        role,
        filename: `${role}.md`,
        size: 10,
        ref: artifact(`jira-${role}`),
      },
    });
  return apply(task, {
    kind: "draft",
    prompt: {
      ref: artifact("jira-prompt"),
      revision: 1,
      sourceDigest: "a".repeat(64),
      nonblank: true,
    },
    target: { projectId: "app", repositoryId: "web", branch: "main" },
  });
}
const dispatch = {
  requestId: "handoff-1",
  packageRef: artifact("jira-package"),
  payloadDigest: "a".repeat(64),
  dispatch: 1,
  status: "sending" as const,
  receipt: null,
  reason: null,
};
it("prepares both documents and retains history after removal", () => {
  const task = ready();
  expect(task.preparation!.phase).toBe("ready");
  const removed = apply(task, {
    kind: "document",
    role: "design",
    document: null,
  });
  expect(removed.preparation!.phase).toBe("preparing");
  expect(removed.artifacts).toContainEqual(artifact("jira-design"));
  expect(task.preparation!.documents.design).not.toBeNull();
});
it("rejects generic commands for preparation tasks", () => {
  const task = jiraTask();
  expect(eligibleStep(task)).toBeNull();
  expect(() =>
    reduceTask(
      task,
      {
        kind: "human",
        command: {
          taskId: task.id,
          requestId: "wrong",
          expectedRevision: 1,
          action: { kind: "cancel" },
        },
      },
      task.updatedAt,
    ),
  ).toThrow();
});
it("locks sending and unconfirmed packages and binds acceptance to the original dispatch", () => {
  let task = apply(ready(), { kind: "dispatch", attempt: dispatch });
  expect(task.status).toBe("running");
  expect(() => apply(task, { kind: "cancel" })).toThrow();
  expect(() =>
    apply(task, { kind: "document", role: "design", document: null }),
  ).toThrow();
  task = apply(task, {
    kind: "settle",
    handoffRequestId: "handoff-1",
    dispatch: 1,
    outcome: "unconfirmed",
    receipt: null,
    reason: "Timed out",
  });
  expect(task.status).toBe("blocked");
  expect(() => apply(task, { kind: "dispatch", attempt: dispatch })).toThrow();
  expect(() =>
    apply(task, {
      kind: "settle",
      handoffRequestId: "wrong",
      dispatch: 1,
      outcome: "not-accepted",
      receipt: null,
      reason: "No",
    }),
  ).toThrow();
  task = apply(task, {
    kind: "settle",
    handoffRequestId: "handoff-1",
    dispatch: 1,
    outcome: "accepted",
    reason: null,
    receipt: {
      requestId: "handoff-1",
      receiptId: "receipt-1",
      acceptedAt: task.updatedAt,
      simulated: true,
    },
  });
  expect(task.status).toBe("done");
  expect(task.preparation!.phase).toBe("sent");
  expect(() => apply(task, { kind: "cancel" })).toThrow();
});
it("retries only a definitively rejected identical package with the next dispatch", () => {
  let task = apply(ready(), { kind: "dispatch", attempt: dispatch });
  task = apply(task, {
    kind: "settle",
    handoffRequestId: "handoff-1",
    dispatch: 1,
    outcome: "not-accepted",
    reason: "Rejected",
    receipt: null,
  });
  expect(() =>
    apply(task, {
      kind: "dispatch",
      attempt: { ...dispatch, payloadDigest: "b".repeat(64), dispatch: 2 },
    }),
  ).toThrow();
  task = apply(task, {
    kind: "dispatch",
    attempt: { ...dispatch, dispatch: 2 },
  });
  expect(task.preparation!.attempts).toHaveLength(1);
  expect(() =>
    apply(task, {
      kind: "settle",
      handoffRequestId: "handoff-1",
      dispatch: 1,
      outcome: "not-accepted",
      reason: "Old",
      receipt: null,
    }),
  ).toThrow();
});
let roots: string[] = [];
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots = [];
});
it("recovers bound selections and operation receipts without adding versions on replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "jira-store-"));
  roots.push(root);
  let store = await openStore(root);
  const task = await store.create(jiraTask(), "create");
  const ref = await store.publishArtifact(
    task.id,
    "jira-design",
    Buffer.from("# Design"),
  );
  const change = event({
    kind: "document",
    role: "design",
    document: { role: "design", filename: "design.md", size: 8, ref },
  });
  await store.apply(task.id, 1, "upload", change);
  store = await openStore(root);
  expect((await store.get(task.id)).preparation!.documents.design!.ref).toEqual(
    ref,
  );
  expect((await store.operation(task.id, "upload"))!.event).toEqual(change);
  expect((await store.apply(task.id, 1, "upload", change)).revision).toBe(2);
  await expect(
    store.apply(task.id, 2, "upload", {
      ...change,
      inputDigest: "b".repeat(64),
    }),
  ).rejects.toThrow();
  await writeFile(join(root, "active", task.id, ref.path), "corrupt");
  store = await openStore(root);
  expect((await store.list()).issues.length).toBeGreaterThan(0);
});
