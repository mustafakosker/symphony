import { expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import {
  createProjectFixture,
  createRepository,
  treeDigest,
} from "../testing/projects.js";
import { loadSettings } from "../config/settings.js";
import { openStore } from "../store/task-store.js";
import { openProjectServices } from "./service.js";
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
