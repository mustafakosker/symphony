import { expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  createProjectFixture,
  createRepository,
  treeDigest,
  git,
} from "../testing/projects.js";
import { startApplication } from "../main.js";
import type { Assignment, Runner } from "../codex/adapter.js";
import type { Task } from "../../shared/contracts.js";
it.each([true, false])(
  "investigates pinned projects through public APIs (target=%s)",
  async (target) => {
    const f = await createProjectFixture();
    let app: Awaited<ReturnType<typeof startApplication>> | undefined;
    try {
      const shop = await createRepository(f.root, "shop", {
        "README.md": "Committed shop architecture\nTest commands Not run\n",
      });
      await createRepository(f.root, "payments", {
        "README.md": "Committed payment architecture\n",
      });
      await writeFile(
        join(shop.path, "README.md"),
        "Dirty content must stay out",
      );
      await writeFile(join(shop.path, "secret-untracked"), "UNTRACKED");
      const before = await treeDigest(f.root);
      const buildDir = join(f.base, "dist");
      await mkdir(join(buildDir, "assets"), { recursive: true });
      await writeFile(join(buildDir, "index.html"), "Preview");
      await mkdir(join(f.workspace, "roles"), { recursive: true });
      await mkdir(join(f.workspace, "projects"), { recursive: true });
      await writeFile(
        join(f.workspace, "roles/roles.json"),
        JSON.stringify({
          roles: ["triage", "researcher"].map((role) => ({
            role,
            instructions: "Read only",
            skills: [],
            cliProfile: "fake",
            actions: ["read"],
          })),
        }),
      );
      await writeFile(
        join(f.workspace, "projects/projects.json"),
        '{"projects":[]}',
      );
      const net = createServer();
      await new Promise<void>((r) => net.listen(0, "127.0.0.1", r));
      const port = (net.address() as { port: number }).port;
      await new Promise<void>((r) => net.close(() => r()));
      await writeFile(
        f.configPath,
        JSON.stringify({
          workspaceRoot: f.workspace,
          localRoot: f.local,
          codexBinary: process.execPath,
          projectsRoot: f.root,
          port,
          allowedOrigin: `http://127.0.0.1:${port}`,
          scanMs: 10,
          stableMs: 1,
          stopGraceMs: 10,
        }),
      );
      const starts: Assignment[] = [];
      const runner: Runner = {
        probe: async () => ({ version: "fake-integration" }),
        start: async (a) => {
          starts.push(a);
          let result: any;
          if (a.step.id === "$triage") {
            result = {
              kind: "propose_workflow_change",
              taskId: a.task.id,
              attemptId: a.run.id,
              summary: "Plan",
              artifacts: [],
              title: a.task.title,
              taskType: "feature",
              projectId: null,
              reason: "Investigate",
              workflow: {
                version: 1,
                steps: [
                  {
                    kind: "agent",
                    id: "research",
                    title: "Investigation, design and plan",
                    role: "researcher",
                    instructions: "Read source. Commands Not run.",
                    inputs: [],
                    repositories: a.step.repositories,
                    actions: ["read"],
                    outputs: ["findings"],
                    checks: ["findings"],
                  },
                ],
                completionChecks: ["findings"],
              },
            };
          } else {
            const citations = [];
            for (const [i, access] of (a.snapshotAccess ?? []).entries()) {
              const manifest = JSON.parse(
                  await readFile(
                    join(access.snapshotPath, "../manifest.json"),
                    "utf8",
                  ),
                ),
                entry = manifest.entries.find(
                  (x: any) => x.path === "README.md",
                );
              expect(
                await readFile(join(access.snapshotPath, "README.md"), "utf8"),
              ).toContain("Committed");
              citations.push({
                id: `source-${i}`,
                repositoryId: access.repository,
                commit: access.snapshot.commit,
                path: "README.md",
                objectId: entry.objectId,
                contentDigest: entry.contentDigest,
                startLine: 1,
                endLine: 1,
              });
            }
            const report = {
              format: "source-report-v1",
              text: citations
                .map((c) => `Architecture [cite:${c.id}]. Commands Not run.`)
                .join("\n"),
              citations,
            };
            result = {
              kind: "completed",
              taskId: a.task.id,
              attemptId: a.run.id,
              summary: "Read-only findings",
              artifacts: [],
              evidence: { [a.step.outputs[0]]: JSON.stringify(report) },
            };
          }
          return {
            pid: process.pid,
            processStartedAt: new Date().toISOString(),
            completion: Promise.resolve({
              code: 0,
              signal: null,
              error: null,
              result,
            }),
            stop: async () => {},
          };
        },
      };
      app = await startApplication({
        configPath: f.configPath,
        buildDir,
        runner,
        verifyCapabilities: async () => {},
        verifyProjectAccess: async () => {},
      });
      const base = app.address,
        get = async (path: string) => {
          const r = await fetch(base + path);
          expect(r.status).toBe(200);
          return r.json();
        },
        post = async (path: string, value: unknown) => {
          const r = await fetch(base + path, {
            method: "POST",
            headers: { Origin: base, "Content-Type": "application/json" },
            body: JSON.stringify(value),
          });
          expect(r.status, await r.clone().text()).toBeLessThan(300);
          return r.json();
        };
      await expect
        .poll(async () => (await get("/api/projects")).records.length, {
          timeout: 10000,
        })
        .toBe(2);
      let records = (await get("/api/projects")).records;
      for (const p of records)
        await post(`/api/projects/${p.id}/prepare`, {
          ref: "main",
          requestId: `prepare-${p.id}`,
        });
      await expect
        .poll(
          async () =>
            (await get("/api/projects")).records.every(
              (p: any) => p.readiness === "ready",
            ),
          { timeout: 15000 },
        )
        .toBe(true);
      expect((await get("/api/workspace")).tasks).toHaveLength(0);
      const text = {
          title: target ? "[shop] Checkout" : "Investigate checkout",
          description: "Compare shop and payments",
        },
        choices = { excludedReferenceIds: [], ambiguities: {} },
        preview = await post("/api/projects/resolve", { text, choices });
      records = (await get("/api/projects")).records;
      const selections = await Promise.all(
        records.map(async (p: any) => ({
          projectId: p.id,
          ref: "main",
          briefVersion: (await get(`/api/projects/${p.id}`)).briefs.at(-1)
            .version,
        })),
      );
      await post("/api/drafts", {
        markdown: `# ${text.title}\n\n${text.description}`,
        requestId: "task-one",
        projectDraft: {
          text,
          choices,
          selections,
          previewRevision: preview.revision,
          catalogRevision: preview.catalogRevision,
        },
      });
      await expect
        .poll(async () => (await get("/api/workspace")).tasks[0]?.status, {
          timeout: 15000,
        })
        .toBe("waiting-for-human");
      let task: Task = (await get("/api/workspace")).tasks[0];
      expect(task.schemaVersion).toBe(2);
      if (task.schemaVersion !== 2)
        throw new Error("Expected connected context");
      const shopId = records.find((p: any) => p.name === "shop").id;
      expect(task.projectContext.targetId).toBe(target ? shopId : null);
      expect(task.projectContext.referenceIds).toHaveLength(target ? 1 : 2);
      expect(
        task.projectContext.projects.find((p) => p.projectId === shopId)
          ?.snapshot.commit,
      ).toBe(shop.commit);
      await post(`/api/tasks/${task.id}/commands`, {
        taskId: task.id,
        expectedRevision: task.revision,
        requestId: "approve",
        action: {
          kind: "approve",
          reviewId: task.reviews.at(-1)!.id,
          artifactDigests: [],
        },
      });
      await expect
        .poll(async () => (await get(`/api/tasks/${task.id}`)).status, {
          timeout: 15000,
        })
        .toBe("done");
      task = await get(`/api/tasks/${task.id}`);
      const artifact = task.artifacts[0],
        report = await get(
          `/api/tasks/${task.id}/artifacts/${artifact.id}/report?version=${artifact.version}`,
        );
      expect(report.citations).toHaveLength(2);
      const citation = await get(
        `/api/tasks/${task.id}/artifacts/${artifact.id}/citations/${report.citations[0].id}?version=${artifact.version}`,
      );
      expect(citation.lines[0]).toContain("Committed");
      expect(starts.every((a) => a.step.actions.join(",") === "read")).toBe(
        true,
      );
      expect(await treeDigest(f.root)).toBe(before);
      const internal = starts.find(
        (a) => a.task.schemaVersion === 2 && a.task.purpose === "project-brief",
      )!;
      expect(
        (await fetch(base + `/api/tasks/${internal.task.id}`)).status,
      ).toBe(404);
      await app.close();
      app = undefined;
      await git(shop.path, [
        "commit",
        "--allow-empty",
        "-m",
        "External update",
      ]);
      const afterUpdate = await treeDigest(f.root);
      app = await startApplication({
        configPath: f.configPath,
        buildDir,
        runner,
        verifyCapabilities: async () => {},
        verifyProjectAccess: async () => {},
      });
      expect(
        (await get(`/api/tasks/${task.id}`)).projectContext.projects.find(
          (p: any) => p.projectId === shopId,
        ).snapshot.commit,
      ).toBe(shop.commit);
      expect(
        (
          await get(
            `/api/tasks/${task.id}/artifacts/${artifact.id}/citations/${report.citations[0].id}?version=${artifact.version}`,
          )
        ).lines[0],
      ).toContain("Committed");
      expect(await treeDigest(f.root)).toBe(afterUpdate);
    } finally {
      await app?.close();
      await f.dispose();
    }
  },
  30000,
);
