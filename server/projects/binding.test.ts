import { expect, it } from "vitest";
import {
  createProjectFixture,
  createRepository,
  git,
} from "../testing/projects.js";
import { scanRoot } from "./discovery.js";
import { openProjectCatalog } from "./catalog.js";
import { openSnapshots, resolveSourceCommit } from "./snapshots.js";
import { openBriefs } from "./briefs.js";
import { createProjectBinding, previewResolution } from "./binding.js";
it.each([1, 2, 3])(
  "replays the durable stage %i without resolving a moving ref again",
  async (stage) => {
    const f = await createProjectFixture();
    try {
      const repo = await createRepository(f.root, "shop", { a: "A" }),
        catalog = await openProjectCatalog(f.local);
      await catalog.reconcile(
        {
          projectsRoot: f.root,
          generation: "g",
          revision: "r",
          state: "ready",
          message: null,
        },
        await scanRoot(
          {
            projectsRoot: f.root,
            generation: "g",
            revision: "r",
            state: "ready",
            message: null,
          },
          { timeoutMs: 5000 },
        ),
      );
      const p = (await catalog.read()).records[0],
        snapshots = await openSnapshots(f.local, {
          entries: 100,
          totalBytes: 10000,
          fileBytes: 10000,
          timeoutMs: 5000,
        });
      const resolved = await resolveSourceCommit(p, "main");
      await snapshots.importCommit(p, resolved);
      const source = await snapshots.materialize(p, resolved),
        briefs = await openBriefs(f.local, snapshots);
      await briefs.save({
        projectId: p.id,
        expectedVersion: null,
        requestId: "brief",
        author: "human",
        source,
        report: {
          format: "source-report-v1",
          text: "Saved brief",
          citations: [],
        },
      });
      await catalog.setReadiness(p.id, "ready", null);
      const deps = { catalog, snapshots, briefs, localRoot: f.local },
        binding = await createProjectBinding(deps),
        text = { title: "[shop] Change", description: "Investigate" },
        choices = { excludedReferenceIds: [], ambiguities: {} };
      const preview = previewResolution(text, await catalog.read(), choices),
        input = {
          text,
          choices,
          previewRevision: preview.revision,
          catalogRevision: preview.catalogRevision,
          selections: [{ projectId: p.id, ref: "main", briefVersion: 1 }],
        };
      const op = await binding.begin(input, "submit");
      for (let n = 0; n < stage; n++) await binding.advance(op.id);
      if (stage === 1) {
        const failing = await createProjectBinding({
          ...deps,
          snapshots: {
            ...snapshots,
            importCommit: async () => {
              throw new Error("Temporary source unavailable");
            },
          },
        });
        expect((await failing.advance(op.id)).state).toBe("failed");
        await binding.retry(op.id, "retry-original");
      }
      await git(repo.path, [
        "commit",
        "--allow-empty",
        "-m",
        "Moved during acceptance",
      ]);
      await briefs.save({
        projectId: p.id,
        expectedVersion: 1,
        requestId: "edit",
        author: "human-edited",
        source,
        report: {
          format: "source-report-v1",
          text: "New version",
          citations: [],
        },
      });
      if (stage >= 2) {
        const { rm } = await import("node:fs/promises");
        await rm(repo.path, { recursive: true, force: true });
      }
      const resumed = await createProjectBinding(deps);
      for (let n = 0; n < 5; n++) await resumed.advance(op.id);
      const context = await binding.getContext(op.id);
      expect(context?.targetId).toBe(p.id);
      expect(context?.projects[0].snapshot.commit).toBe(source.commit);
      expect(context?.projects[0].brief?.version).toBe(1);
      const reopened = await createProjectBinding(deps);
      expect(await reopened.begin(input, "submit")).toMatchObject({
        state: "complete",
      });
      await reopened.advance(op.id);
      expect(await reopened.getContext(op.id)).toEqual(context);
      await expect(
        reopened.begin(
          { ...input, text: { ...text, title: "Changed" } },
          "submit",
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        reopened.begin({ ...input, previewRevision: "stale" }, "new"),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await f.dispose();
    }
  },
);
