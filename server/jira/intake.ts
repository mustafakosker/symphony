import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import type { Task } from "../../shared/contracts.js";
import type {
  JiraSnapshot,
  JiraSyncView,
  Target,
} from "../../shared/jira-preparation.js";
import { parseJiraSnapshot } from "../../shared/jira-validation.js";
import { BoundaryError, timestamp } from "../../shared/validate.js";
import type { Registry } from "../config/registry.js";
import type { JiraHandoffConfig } from "../config/jira-handoff.js";
import type { Store } from "../store/task-store.js";
import { confinedPath } from "../store/paths.js";
import { writeAtomic } from "../store/atomic.js";
import type { JiraAdapter } from "./adapter.js";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function jiraTaskId(connectionId: string, issueId: string): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify(["jira-ona-v1", connectionId, issueId]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString("hex");
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    h.slice(12, 16),
    h.slice(16, 20),
    h.slice(20),
  ].join("-");
}
export type JiraIntake = {
  sync(now: Date): Promise<JiraSyncView>;
  tick(now: Date): Promise<void>;
  view(): JiraSyncView;
};
export function createJiraIntake({
  store,
  adapter,
  config,
  registry,
  localRoot,
}: {
  store: Store;
  adapter: JiraAdapter;
  config: JiraHandoffConfig;
  registry: Registry;
  localRoot: string;
}): JiraIntake {
  const view: JiraSyncView = {
    enabled: true,
    simulated: true,
    syncing: false,
    lastSuccessAt: null,
    error: null,
  };
  let pending: Promise<JiraSyncView> | null = null,
    lastAttempt = -Infinity,
    loaded = false;
  const statePath = () => confinedPath(localRoot, "jira-handoff/sync.json");
  async function initialize() {
    if (loaded) return;
    await mkdir(await confinedPath(localRoot, "jira-handoff"), {
      recursive: true,
    });
    const path = await statePath();
    try {
      const saved = JSON.parse(await readFile(path, "utf8"));
      view.lastSuccessAt = timestamp(
        saved.lastSuccessAt,
        "last successful sync",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    loaded = true;
  }
  function newTask(source: JiraSnapshot, now: string): Task {
    const project = registry.projects.find(
      (p) => p.id === config.projectMappings[source.projectKey],
    );
    const repo =
      project?.repositories.length === 1 ? project.repositories[0] : null;
    const target: Target | null =
      repo && project
        ? { projectId: project.id, repositoryId: repo.id, branch: repo.baseRef }
        : null;
    return {
      schemaVersion: 1,
      id: jiraTaskId(source.connectionId, source.issueId),
      revision: 1,
      title: source.title,
      idea: source.description || `# ${source.key}: ${source.title}`,
      type: "jira",
      projectId: target?.projectId ?? null,
      source: source.key,
      status: "waiting-for-human",
      workflow: null,
      proposedWorkflow: null,
      currentStepId: "jira-preparation",
      completedStepIds: [],
      staleStepIds: [],
      generation: 0,
      intent: null,
      reviews: [],
      runs: [],
      artifacts: [],
      approvalBindings: [],
      blockedReason: null,
      queuedAt: null,
      createdAt: now,
      updatedAt: now,
      preparation: {
        mode: "jira-ona",
        source,
        sourceDigest: digest(source),
        matchesQuery: true,
        phase: "inbox",
        documents: { design: null, implementation: null },
        prompt: null,
        target,
        attempts: [],
      },
    };
  }
  async function update(
    id: string,
    source: JiraSnapshot,
    matchesQuery: boolean,
  ) {
    for (let retry = 0; retry < 5; retry++) {
      const task = await store.get(id);
      if (["done", "cancelled", "rejected"].includes(task.status)) return;
      if (
        !task.preparation ||
        task.preparation.source.issueId !== source.issueId ||
        task.preparation.source.connectionId !== source.connectionId
      )
        throw new Error("Jira identity conflicts with stored task");
      const sourceDigest = digest(source);
      if (
        task.preparation.sourceDigest === sourceDigest &&
        task.preparation.matchesQuery === matchesQuery
      )
        return;
      try {
        await store.apply(
          id,
          task.revision,
          `jira-source-${task.revision + 1}`,
          {
            kind: "preparation",
            inputDigest: digest({ source, matchesQuery }),
            change: {
              kind: "source",
              source,
              digest: sourceDigest,
              matchesQuery,
            },
          },
        );
        return;
      } catch (error) {
        if (!(error instanceof BoundaryError) || error.code !== "conflict")
          throw error;
      }
    }
    throw new Error("Jira source changed concurrently; refresh again");
  }
  async function run(now: Date) {
    view.syncing = true;
    lastAttempt = now.getTime();
    try {
      await initialize();
      const batch = await adapter.listAssignedOpen();
      if (typeof batch.complete !== "boolean" || !Array.isArray(batch.issues))
        throw new Error("Invalid Jira snapshot");
      const issues = batch.issues.map(parseJiraSnapshot);
      const ids = new Set<string>();
      for (const issue of issues) {
        if (
          issue.connectionId !== config.connectionId ||
          ids.has(issue.issueId)
        )
          throw new Error("Invalid or duplicate Jira identity");
        if (Buffer.byteLength(JSON.stringify(issue)) > 1024 * 1024)
          throw new Error("Jira issue snapshot exceeds 1 MiB");
        ids.add(issue.issueId);
      }
      const eligible = issues.filter((i) => i.assignedToCurrentUser && i.open);
      const existing = await store.list();
      const byId = new Map(existing.tasks.map((t) => [t.id, t]));
      for (const issue of eligible) {
        const id = jiraTaskId(issue.connectionId, issue.issueId);
        if (byId.has(id)) await update(id, issue, true);
        else {
          const created = await store.create(
            newTask(issue, now.toISOString()),
            `jira-create-${id}`,
          );
          byId.set(id, created);
        }
      }
      if (batch.complete) {
        const present = new Set(eligible.map((i) => i.issueId));
        for (const task of byId.values())
          if (
            task.preparation?.source.connectionId === config.connectionId &&
            !present.has(task.preparation.source.issueId)
          )
            await update(task.id, task.preparation.source, false);
        await writeAtomic(
          await statePath(),
          JSON.stringify({ lastSuccessAt: now.toISOString() }),
        );
        view.lastSuccessAt = now.toISOString();
        view.error = null;
      } else
        view.error =
          "Jira returned an incomplete snapshot; retained previous membership";
    } catch (error) {
      view.error = error instanceof Error ? error.message : "Jira sync failed";
    } finally {
      view.syncing = false;
    }
    return structuredClone(view);
  }
  function sync(now: Date): Promise<JiraSyncView> {
    if (pending) return pending;
    pending = run(now).finally(() => {
      pending = null;
    });
    return pending;
  }
  return {
    sync,
    async tick(now) {
      if (now.getTime() - lastAttempt >= 60000) await sync(now);
    },
    view: () => structuredClone(view),
  };
}
