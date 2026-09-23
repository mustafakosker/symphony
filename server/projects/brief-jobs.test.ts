import { expect, it } from "vitest";
import { join } from "node:path";
import { createProjectFixture, createRepository } from "../testing/projects.js";
import { controlledRunner, draftTask } from "../testing/fixtures.js";
import { openStore } from "../store/task-store.js";
import { createCoordinator } from "../coordinator/coordinator.js";
import { createStoreRouter } from "../coordinator/store-router.js";
import { scanRoot } from "./discovery.js";
import { openProjectCatalog } from "./catalog.js";
import { openSnapshots, resolveSourceCommit } from "./snapshots.js";
import { openBriefs } from "./briefs.js";
import { createBriefJobs } from "./brief-jobs.js";
import type { Settings } from "../config/settings.js";
it("shares coordinator capacity, saves the first generated brief once, and retains regeneration as a candidate", async () => {
  const f = await createProjectFixture();
  let coordinator: ReturnType<typeof createCoordinator> | undefined;
  try {
    await createRepository(f.root, "shop", { a: "A" });
    const root = {
      projectsRoot: f.root,
      generation: "g1",
      revision: "r1",
      state: "ready" as const,
      message: null,
    };
    const cat = await openProjectCatalog(f.local),
      p = (await cat.reconcile(root, await scanRoot(root, { timeoutMs: 5000 })))
        .records[0];
    const snapshots = await openSnapshots(f.local, {
        entries: 100,
        totalBytes: 10000,
        fileBytes: 10000,
        timeoutMs: 5000,
      }),
      resolved = await resolveSourceCommit(p, "main");
    await snapshots.importCommit(p, resolved);
    const snapshot = await snapshots.materialize(p, resolved);
    const primary = await openStore(f.workspace),
      jobStore = await openStore(join(f.local, "projects/jobs")),
      briefs = await openBriefs(f.local, snapshots);
    const jobs = createBriefJobs({
      store: jobStore,
      briefs,
      snapshots,
      localRoot: f.local,
    });
    const first = await jobs.enqueue(p, snapshot, "first");
    expect((await jobs.enqueue(p, snapshot, "first")).id).toBe(first.id);
    const ordinary = draftTask();
    await primary.create(ordinary, "ordinary");
    const control = controlledRunner();
    coordinator = createCoordinator({
      store: createStoreRouter(primary, jobStore),
      runner: control.runner,
      settings: {
        localRoot: f.local,
        workspaceRoot: f.workspace,
        concurrency: 1,
      } as Settings,
      intake: {
        scan: async () => {},
        issues: async () => [],
        submit: async () => ({ submissionId: "unused" }),
      },
      registry: {
        projects: [],
        roles: [
          {
            role: "triage",
            instructions: "Read",
            skills: [],
            cliProfile: "triage",
            actions: ["read"],
          },
          {
            role: "researcher",
            instructions: "Read",
            skills: [],
            cliProfile: "researcher",
            actions: ["read"],
          },
        ],
      },
    });
    await coordinator.tick(new Date());
    expect(control.starts).toHaveLength(1);
    expect(control.starts[0].task.id).toBe(ordinary.id);
    control.finish(control.starts[0].run.id, {
      code: 1,
      signal: null,
      result: null,
      error: "End ordinary fixture",
    });
    await expect
      .poll(async () => (await primary.get(ordinary.id)).status)
      .toBe("blocked");
    await expect
      .poll(
        async () => {
          await coordinator!.tick(new Date());
          return control.starts.length;
        },
        { timeout: 5000 },
      )
      .toBe(2);
    const run = control.starts[1];
    control.finish(run.run.id, {
      code: 0,
      signal: null,
      error: null,
      result: {
        kind: "completed",
        taskId: run.task.id,
        attemptId: run.run.id,
        summary: "Brief",
        artifacts: [],
        evidence: {
          "project-brief": JSON.stringify({
            format: "source-report-v1",
            text: "Initial architecture. Commands Not run.",
            citations: [],
          }),
        },
      },
    });
    await expect
      .poll(async () => (await jobStore.get(run.task.id)).status)
      .toBe("done");
    await jobs.reconcile();
    await jobs.reconcile();
    expect(await briefs.history(p.id)).toHaveLength(1);
    expect((await jobs.status(first.id)).state).toBe("complete");
    const edited = await briefs.save({
      projectId: p.id,
      expectedVersion: 1,
      requestId: "edit",
      author: "human-edited",
      source: snapshot,
      report: { format: "source-report-v1", text: "Human edit", citations: [] },
    });
    const second = await jobs.enqueue(p, snapshot, "second");
    await coordinator.tick(new Date());
    const next = control.starts[2];
    control.finish(next.run.id, {
      code: 0,
      signal: null,
      error: null,
      result: {
        kind: "completed",
        taskId: next.task.id,
        attemptId: next.run.id,
        summary: "New",
        artifacts: [],
        evidence: {
          "project-brief": JSON.stringify({
            format: "source-report-v1",
            text: "Candidate",
            citations: [],
          }),
        },
      },
    });
    await expect
      .poll(async () => (await jobStore.get(next.task.id)).status)
      .toBe("done");
    await jobs.reconcile();
    expect((await jobs.candidate(second.id))?.text).toBe("Candidate");
    expect(await briefs.current(p.id)).toEqual(edited);
    const bad = await jobs.enqueue(p, snapshot, "broken-store-record");
    const scoped = createBriefJobs({
      store: Object.assign(Object.create(jobStore), {
        get: async () => {
          throw new Error("Corrupt internal job");
        },
      }),
      briefs,
      snapshots,
      localRoot: f.local,
    });
    await expect(scoped.reconcile()).resolves.toBeUndefined();
    expect((await scoped.status(bad.id)).state).toBe("failed");
    expect((await primary.list()).tasks.map((t) => t.id)).toEqual([
      ordinary.id,
    ]);
  } finally {
    await coordinator?.shutdown();
    await f.dispose();
  }
});
