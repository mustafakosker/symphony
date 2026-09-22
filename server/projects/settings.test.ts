import { afterEach, expect, it, vi } from "vitest";
import {
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createProjectFixture } from "../testing/projects.js";
import { loadSettings } from "../config/settings.js";
import { openProjectSettings } from "./settings.js";
import * as atomic from "../store/atomic.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup() {
  const f = await createProjectFixture();
  cleanups.push(f.dispose);
  await writeFile(
    f.configPath,
    JSON.stringify({
      workspaceRoot: f.workspace,
      localRoot: f.local,
      codexBinary: process.execPath,
      concurrency: 2,
    }),
  );
  const settings = await loadSettings(f.configPath),
    service = await openProjectSettings(f.configPath, settings);
  return { ...f, settings, service };
}
it("saves a canonical root durably without changing other settings", async () => {
  const f = await setup();
  const before = await f.service.read();
  expect(before.state).toBe("unset");
  const alias = join(f.base, "alias");
  await symlink(f.root, alias);
  const saved = await f.service.save({
    projectsRoot: alias,
    expectedRevision: before.revision,
    requestId: "save-1",
  });
  expect(saved).toMatchObject({
    projectsRoot: await realpath(f.root),
    state: "ready",
  });
  expect(
    await (await openProjectSettings(f.configPath, f.settings)).read(),
  ).toEqual(saved);
  expect(JSON.parse(await readFile(f.configPath, "utf8")).concurrency).toBe(2);
  expect(
    await f.service.save({
      projectsRoot: alias,
      expectedRevision: before.revision,
      requestId: "save-1",
    }),
  ).toEqual(saved);
  await expect(
    f.service.save({
      projectsRoot: null,
      expectedRevision: before.revision,
      requestId: "save-1",
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(
    f.service.save({
      projectsRoot: null,
      expectedRevision: before.revision,
      requestId: "save-2",
    }),
  ).rejects.toMatchObject({ code: "conflict" });
});
it.each(["workspace", "local", "ancestor", "missing", "relative", "file"])(
  "rejects invalid %s roots without changing the saved value",
  async (kind) => {
    const f = await setup();
    await writeFile(join(f.base, "file"), "not a folder");
    const values: Record<string, string> = {
      workspace: f.workspace,
      local: f.local,
      ancestor: f.base,
      missing: join(f.base, "missing"),
      relative: "relative",
      file: join(f.base, "file"),
    };
    const before = await f.service.read();
    await expect(
      f.service.save({
        projectsRoot: values[kind],
        expectedRevision: before.revision,
        requestId: kind,
      }),
    ).rejects.toThrow();
    expect(await f.service.read()).toEqual(before);
  },
);
it("rejects child overlaps and a configuration stored inside the root", async () => {
  const f = await setup();
  const child = join(f.local, "child");
  await mkdir(child);
  const before = await f.service.read();
  await expect(
    f.service.save({
      projectsRoot: child,
      expectedRevision: before.revision,
      requestId: "child",
    }),
  ).rejects.toThrow(/overlap/);
  const config = join(f.root, "config.json");
  await writeFile(config, await readFile(f.configPath));
  const svc = await openProjectSettings(config, f.settings);
  await expect(
    svc.save({
      projectsRoot: f.root,
      expectedRevision: (await svc.read()).revision,
      requestId: "inside",
    }),
  ).rejects.toThrow(/overlap/);
});
it("reports a disappeared root as unavailable and preserves existing startup compatibility", async () => {
  const f = await setup();
  expect(f.settings.projectsRoot).toBeNull();
  const saved = await f.service.save({
    projectsRoot: f.root,
    expectedRevision: (await f.service.read()).revision,
    requestId: "root",
  });
  await rm(f.root, { recursive: true });
  const loaded = await loadSettings(f.configPath);
  const result = await (await openProjectSettings(f.configPath, loaded)).read();
  expect(result).toMatchObject({
    state: "unavailable",
    generation: saved.generation,
  });
});
it("recovers a crash after config replacement without duplicating the root generation", async () => {
  const f = await setup();
  const original = atomic.writeAtomic;
  let replaced = false;
  vi.spyOn(atomic, "writeAtomic").mockImplementation(async (path, bytes) => {
    if (replaced && path !== f.configPath)
      throw new Error("Crash after config write");
    await original(path, bytes);
    if (path === f.configPath) replaced = true;
  });
  await expect(
    f.service.save({
      projectsRoot: f.root,
      expectedRevision: (await f.service.read()).revision,
      requestId: "crash",
    }),
  ).rejects.toThrow(/Crash/);
  vi.restoreAllMocks();
  const svc = await openProjectSettings(f.configPath, f.settings),
    recovered = await svc.read();
  expect(recovered.state).toBe("ready");
  expect(
    await (await openProjectSettings(f.configPath, f.settings)).read(),
  ).toEqual(recovered);
});
it("rejects nonpositive snapshot limits and relative root syntax", async () => {
  const f = await setup(),
    doc = JSON.parse(await readFile(f.configPath, "utf8"));
  for (const change of [
    { projectSnapshotMaxBytes: 0 },
    { projectGitTimeoutMs: -1 },
    { projectsRoot: "relative" },
  ]) {
    await writeFile(f.configPath, JSON.stringify({ ...doc, ...change }));
    await expect(loadSettings(f.configPath)).rejects.toThrow();
  }
});
it("canonicalizes a configured alias once and detects later redirection", async () => {
  const f = await setup();
  const alias = join(f.base, "alias");
  await symlink(f.root, alias);
  const doc = JSON.parse(await readFile(f.configPath, "utf8"));
  await writeFile(
    f.configPath,
    JSON.stringify({ ...doc, projectsRoot: alias }),
  );
  const service = await openProjectSettings(f.configPath, f.settings);
  expect(await service.read()).toMatchObject({
    state: "ready",
    projectsRoot: f.root,
  });
  await rm(alias);
  const other = join(f.base, "other");
  await mkdir(other);
  await symlink(other, alias);
  expect(await service.read()).toMatchObject({
    state: "unavailable",
    projectsRoot: f.root,
  });
});
