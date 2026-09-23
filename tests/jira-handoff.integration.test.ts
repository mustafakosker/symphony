import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { startApplication, type Application } from "../server/main";
import { controlledRunner } from "../server/testing/fixtures";
import { jiraIssue } from "../server/preparation/testing";
import { createMockOnaAdapter } from "../server/ona/mock";
import type { OnaAdapter } from "../server/ona/adapter";
import type { Task } from "../shared/contracts";
import type {
  FrozenPackage,
  PreparationAction,
} from "../shared/jira-preparation";
const roots: string[] = [],
  apps: Application[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup(uncertain = false) {
  const root = await mkdtemp(join(tmpdir(), "jira-integration-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace"),
    localRoot = join(root, "local");
  await mkdir(join(workspaceRoot, "projects"), { recursive: true });
  await mkdir(join(workspaceRoot, "roles"));
  await mkdir(localRoot);
  await writeFile(
    join(workspaceRoot, "projects/projects.json"),
    JSON.stringify({
      projects: [
        {
          id: "app",
          names: ["App"],
          repositories: [
            {
              id: "web",
              localPath: null,
              mcpProfile: "mock",
              baseRef: "main",
              defaultRef: "main",
            },
          ],
        },
      ],
    }),
  );
  await writeFile(join(workspaceRoot, "roles/roles.json"), '{"roles":[]}');
  const fixturesPath = join(root, "issues.json"),
    jiraHandoffConfigPath = join(root, "handoff.json"),
    configPath = join(root, "config.json");
  await writeFile(fixturesPath, JSON.stringify([jiraIssue()]));
  await writeFile(
    jiraHandoffConfigPath,
    JSON.stringify({
      mode: "mock",
      connectionId: "demo",
      fixturesPath,
      projectMappings: { APP: "app" },
    }),
  );
  const socket = createServer();
  await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((r) => socket.close(() => r()));
  await writeFile(
    configPath,
    JSON.stringify({
      workspaceRoot,
      localRoot,
      jiraHandoffConfigPath,
      codexBinary: process.execPath,
      port,
      allowedOrigin: `http://127.0.0.1:${port}`,
      scanMs: 1000,
      stableMs: 1,
    }),
  );
  const buildDir = join(root, "dist");
  await mkdir(join(buildDir, "assets"), { recursive: true });
  await writeFile(join(buildDir, "index.html"), "<h1>Test</h1>");
  const control = controlledRunner(),
    mock = createMockOnaAdapter({ localRoot });
  const launch = vi.fn(mock.launch);
  const adapter: OnaAdapter = {
    ...mock,
    launch: async (input, signal) => {
      const outcome = await launch(input, signal);
      if (uncertain) throw new Error("Response lost after acceptance");
      return outcome;
    },
  };
  const start = async () => {
    const app = await startApplication({
      configPath,
      buildDir,
      runner: control.runner,
      verifyCapabilities: async () => {},
      onaAdapter: adapter,
    });
    apps.push(app);
    return app;
  };
  let app = await start();
  const post = (path: string, value: unknown) =>
    fetch(app.address + path, {
      method: "POST",
      headers: { Origin: app.address, "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  await post("/api/jira/sync", { requestId: "sync" });
  let task: Task = (await (await fetch(app.address + "/api/workspace")).json())
    .tasks[0];
  const cmd = async (action: PreparationAction, id = crypto.randomUUID()) => {
    const response = await post(`/api/tasks/${task.id}/preparation/commands`, {
      taskId: task.id,
      requestId: id,
      expectedRevision: task.revision,
      action,
    });
    if (response.status === 200) task = await response.json();
    return response;
  };
  const uploadRequest = (
    role: string,
    bytes: Buffer,
    id: string,
    revision: number,
  ) =>
    fetch(`${app.address}/api/tasks/${task.id}/documents/${role}`, {
      method: "POST",
      headers: {
        Origin: app.address,
        "Content-Type": "application/octet-stream",
        "X-Symphony-Request-Id": id,
        "X-Symphony-Expected-Revision": String(revision),
        "X-Symphony-Filename": encodeURIComponent(
          role === "design" ? "café.md" : "plan.txt",
        ),
      },
      body: bytes,
    });
  const design = Buffer.from("\uFEFF# Café\r\n<script>literal</script>\r\n"),
    implementation = Buffer.from("Implement exactly.\n"),
    prompt = " Reviewed prompt\n\nKeep spacing.\r\n";
  const original = task.revision;
  task = await (
    await uploadRequest("design", design, "design", original)
  ).json();
  // Simulate a committed upload whose response was lost; retry its original revision/envelope.
  const replay = await (
    await uploadRequest("design", design, "design", original)
  ).json();
  expect(replay.revision).toBe(task.revision);
  expect(replay.artifacts).toHaveLength(1);
  task = await (
    await uploadRequest(
      "implementation",
      implementation,
      "implementation",
      task.revision,
    )
  ).json();
  expect((await cmd({ kind: "prepare" })).status).toBe(200);
  expect(
    (
      await cmd({
        kind: "save",
        promptText: prompt,
        target: {
          projectId: "app",
          repositoryId: "web",
          branch: "feature/exact",
        },
      })
    ).status,
  ).toBe(200);
  return {
    root,
    workspaceRoot,
    fixturesPath,
    design,
    implementation,
    prompt,
    launch,
    control,
    post,
    cmd,
    get task() {
      return task;
    },
    get app() {
      return app;
    },
    refresh: async () => {
      task = await (await fetch(`${app.address}/api/tasks/${task.id}`)).json();
    },
    restart: async () => {
      await app.close();
      apps.splice(apps.indexOf(app), 1);
      app = await start();
      task = await (await fetch(`${app.address}/api/tasks/${task.id}`)).json();
    },
  };
}
it.each([false, true])(
  "preserves exact reviewed bytes across handoff and restart (lost acceptance response: %s)",
  async (uncertain) => {
    const f = await setup(uncertain);
    expect((await f.cmd({ kind: "send" }, "send")).status).toBe(200);
    expect(f.task.preparation!.attempts[0].status).toBe(
      uncertain ? "unconfirmed" : "accepted",
    );
    await f.restart();
    expect(f.task.status).toBe("done");
    const attempt = f.task.preparation!.attempts[0];
    const get = (ref: { id: string; version: number }) =>
      fetch(
        `${f.app.address}/api/tasks/${f.task.id}/artifacts/${ref.id}?version=${ref.version}`,
      );
    const manifest = (await (
      await get(attempt.packageRef)
    ).json()) as FrozenPackage;
    expect(manifest.requestId).toBe(attempt.receipt!.requestId);
    expect(manifest.jira).toEqual(jiraIssue());
    expect(manifest.target.branch).toBe("feature/exact");
    expect(manifest.prompt.revision).toBe(2);
    expect(
      Buffer.from(
        await (await get(manifest.documents.design.ref)).arrayBuffer(),
      ),
    ).toEqual(f.design);
    expect(
      Buffer.from(
        await (await get(manifest.documents.implementation.ref)).arrayBuffer(),
      ),
    ).toEqual(f.implementation);
    expect(
      Buffer.from(
        await (await get(manifest.prompt.ref)).arrayBuffer(),
      ).toString(),
    ).toBe(f.prompt);
    expect(f.control.starts).toEqual([]);
    expect(f.launch).toHaveBeenCalledTimes(1);
  },
);
it("contains source/save races and refuses corrupted bytes before launch", async () => {
  const f = await setup();
  await writeFile(
    f.fixturesPath,
    JSON.stringify([jiraIssue({ description: "New Jira description" })]),
  );
  const [save] = await Promise.all([
    f.cmd(
      {
        kind: "save",
        promptText: "User update",
        target: f.task.preparation!.target,
      },
      "race-save",
    ),
    f.post("/api/jira/sync", { requestId: "race-sync" }),
  ]);
  expect([200, 409]).toContain(save.status);
  await f.refresh();
  expect(f.task.preparation!.source.description).toBe("New Jira description");
  const ref = f.task.preparation!.documents.design!.ref;
  const path = join(f.workspaceRoot, "active", f.task.id, ref.path);
  expect((await readFile(path)).length).toBe(f.design.length);
  await writeFile(path, "CORRUPTED");
  const response = await f.cmd({ kind: "send" });
  expect(response.status).toBe(409);
  expect((await response.json()).error).toMatch(/artifact digest/);
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.control.starts).toEqual([]);
});
