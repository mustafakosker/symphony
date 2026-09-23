import { expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import {
  createProjectFixture,
  createRepository,
  treeDigest,
} from "../testing/projects.js";
import { loadSettings } from "../config/settings.js";
import { openStore } from "../store/task-store.js";
import { openProjectServices } from "./service.js";
// These integration fixtures spawn real Git commands and sync durable files.
vi.setConfig({ testTimeout: 15000 });
it("prepares owned snapshots, fails closed without host evidence, and replays operations after restart", async () => {
  const f = await createProjectFixture();
  try {
    await createRepository(f.root, "shop", { a: "A" });
    await writeFile(
      f.configPath,
      JSON.stringify({
        workspaceRoot: f.workspace,
        localRoot: f.local,
        codexBinary: process.execPath,
        projectsRoot: f.root,
      }),
    );
    const settings = await loadSettings(f.configPath),
      store = await openStore(f.workspace),
      before = await treeDigest(f.root);
    const s = await openProjectServices(f.configPath, settings, store);
    await s.rescan("scan");
    await s.tick();
    await s.close();
    const p = (await s.catalog.read()).records[0];
    expect(p.name).toBe("shop");
    const op = await s.prepare(p.id, "main", "prepare");
    for (let n = 0; n < 5; n++) {
      await s.tick();
      await s.close();
    }
    expect(await s.operation(op.id)).toMatchObject({ state: "needs-input" });
    expect((await s.catalog.get(p.id)).readiness).toBe("needs-setup");
    expect((await store.list()).tasks).toHaveLength(0);
    expect(await treeDigest(f.root)).toBe(before);
    const reopened = await openProjectServices(f.configPath, settings, store);
    expect(await reopened.prepare(p.id, "main", "prepare")).toMatchObject({
      id: op.id,
    });
    await expect(
      reopened.prepare(p.id, "other", "prepare"),
    ).rejects.toMatchObject({ code: "conflict" });
  } finally {
    await f.dispose();
  }
});

async function readyFixture(overrides: Record<string, number> = {}) {
  const f = await createProjectFixture();
  await createRepository(f.root, "shop", { a: "123456" });
  await createRepository(f.root, "payments", { a: "123456" });
  await writeFile(
    f.configPath,
    JSON.stringify({
      workspaceRoot: f.workspace,
      localRoot: f.local,
      codexBinary: process.execPath,
      projectsRoot: f.root,
      ...overrides,
    }),
  );
  const host = await loadSettings(f.configPath),
    store = await openStore(f.workspace);
  const s = await openProjectServices(f.configPath, host, store);
  await s.rescan("initial");
  await s.tick();
  await s.close();
  const { resolveSourceCommit } = await import("./snapshots.js");
  for (const p of (await s.catalog.read()).records) {
    const resolved = await resolveSourceCommit(p, "main");
    await s.snapshots.importCommit(p, resolved);
    const source = await s.snapshots.materialize(p, resolved);
    await s.briefs.save({
      projectId: p.id,
      source,
      expectedVersion: null,
      requestId: p.id,
      author: "human",
      report: {
        format: "source-report-v1",
        text: "Original brief",
        citations: [],
      },
    });
    await s.catalog.setReadiness(p.id, "ready", null);
  }
  return { ...f, host, store, s };
}
const choices = { excludedReferenceIds: [], ambiguities: {} };
async function projectDraft(
  s: Awaited<ReturnType<typeof readyFixture>>["s"],
  text: { title: string; description: string },
) {
  const preview = await s.resolve(text, choices);
  return {
    text,
    choices,
    previewRevision: preview.revision,
    catalogRevision: preview.catalogRevision,
    selections: [
      ...(preview.targetId ? [preview.targetId] : []),
      ...preview.referenceIds,
    ].map((projectId) => ({ projectId, ref: "main", briefVersion: 1 })),
  };
}
it("rescans before accepting a preview and never silently binds a replacement repository", async () => {
  const f = await readyFixture();
  try {
    const input = await projectDraft(f.s, {
      title: "[shop] Investigate",
      description: "",
    });
    const { rm } = await import("node:fs/promises"),
      { join } = await import("node:path");
    await rm(join(f.root, "shop"), { recursive: true });
    await createRepository(f.root, "shop", {
      different: "Replacement repository",
    });
    await expect(
      f.s.draftGate.prepare({
        submissionId: "new",
        requestId: "new",
        filename: "new.md",
        markdown: "# [shop] Investigate\n\n",
        projectDraft: input,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  } finally {
    await f.s.close();
    await f.dispose();
  }
});
it("discovers new children on restart under the same configured root", async () => {
  const f = await readyFixture();
  try {
    await f.s.close();
    await createRepository(f.root, "new-project", { a: "New" });
    const restarted = await openProjectServices(f.configPath, f.host, f.store);
    await restarted.tick();
    await restarted.close();
    expect(
      (await restarted.catalog.read()).records.map((p) => p.name),
    ).toContain("new-project");
  } finally {
    await f.dispose();
  }
});
it.each([false, true])(
  "publishes optional-empty-title submissions (connected=%s)",
  async (connected) => {
    const f = await readyFixture();
    try {
      const { createIntake } = await import("../intake/intake.js");
      const intake = createIntake(f.workspace, f.store, 0, {}, { projectGate: f.s.draftGate });
      const text = {
        title: "",
        description: connected ? "Investigate shop" : "Investigate behavior",
      };
      await intake.submit(
        text.description,
        "empty-title",
        await projectDraft(f.s, text),
      );
      for (let n = 0; n < 8; n++) {
        await f.s.tick();
        await f.s.close();
        await intake.scan(n + 1);
      }
      const tasks = (await f.store.list()).tasks;
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title.trim()).not.toBe("");
      expect(tasks[0].idea).toBe(text.description);
      expect(tasks[0].schemaVersion).toBe(connected ? 2 : 1);
      if (tasks[0].schemaVersion === 2)
        expect(tasks[0].projectContext.targetId).toBeNull();
    } finally {
      await f.s.close();
      await f.dispose();
    }
  },
);
it.each([{ projectSnapshotMaxBytes: 10 }, { projectSnapshotMaxEntries: 1 }])(
  "enforces configured limits across the whole binding: %j",
  async (limits) => {
    const f = await readyFixture(limits);
    try {
      const op = await f.s.binding.begin(
        await projectDraft(f.s, {
          title: "Investigate",
          description: "shop and payments",
        }),
        "limits",
      );
      for (let n = 0; n < 8; n++) await f.s.binding.advance(op.id);
      expect(await f.s.binding.status(op.id)).toMatchObject({
        state: "failed",
        message: expect.stringMatching(/Combined.*limits/),
      });
      expect(await f.s.binding.getContext(op.id)).toBeNull();
    } finally {
      await f.s.close();
      await f.dispose();
    }
  },
);
it("honors raised aggregate limits without allocating gigabyte fixtures", async () => {
  const f = await readyFixture();
  try {
    const { createProjectBinding } = await import("./binding.js");
    const binding = await createProjectBinding({
      catalog: f.s.catalog,
      briefs: f.s.briefs,
      localRoot: f.local,
      limits: { entries: 200000, totalBytes: 2 * 1024 ** 3 },
      snapshots: {
        ...f.s.snapshots,
        verify: async (ref) => {
          const actual = await f.s.snapshots.verify(ref);
          // Exercise the aggregate accounting with verified-manifest scale, without huge disk fixtures.
          return {
            ...actual,
            totalBytes: 600000000,
            entries: Array(60000).fill(actual.entries[0]),
          };
        },
      },
    });
    const op = await binding.begin(
      await projectDraft(f.s, {
        title: "Investigate",
        description: "shop and payments",
      }),
      "raised-limits",
    );
    for (let n = 0; n < 8; n++) await binding.advance(op.id);
    expect(await binding.status(op.id)).toMatchObject({ state: "complete" });
  } finally {
    await f.s.close();
    await f.dispose();
  }
});
it.each(["ui", "filesystem"])(
  "preserves legacy prefix intake with an unset root: %s",
  async (kind) => {
    const f = await createProjectFixture();
    try {
      await writeFile(
        f.configPath,
        JSON.stringify({
          workspaceRoot: f.workspace,
          localRoot: f.local,
          codexBinary: process.execPath,
        }),
      );
      const host = await loadSettings(f.configPath),
        store = await openStore(f.workspace),
        s = await openProjectServices(f.configPath, host, store);
      const { createIntake } = await import("../intake/intake.js"),
        { mkdir } = await import("node:fs/promises"),
        { join } = await import("node:path");
      const intake = createIntake(f.workspace, store, 0, {}, { projectGate: s.draftGate });
      const text = {
          title: "[legacy-project] Investigate",
          description: "Legacy context",
        },
        markdown = `# ${text.title}\n\n${text.description}`;
      if (kind === "ui")
        await intake.submit(markdown, "legacy", await projectDraft(s, text));
      else {
        await mkdir(join(f.workspace, "drafts"), { recursive: true });
        await writeFile(join(f.workspace, "drafts", "legacy.md"), markdown);
      }
      await intake.scan(1);
      await intake.scan(2);
      const tasks = (await store.list()).tasks;
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ schemaVersion: 1, idea: markdown });
      expect(await s.draftGate.list()).toEqual([]);
      await s.close();
    } finally {
      await f.dispose();
    }
  },
);
