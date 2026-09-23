// Disposable mock-only preview. No live settings, repository access, or Codex launches.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStore } from "../dist-server/server/store/task-store.js";
import { startApplication } from "../dist-server/server/main.js";
import { createJiraIntake } from "../dist-server/server/jira/intake.js";
import { createMockJiraAdapter } from "../dist-server/server/jira/mock.js";
import { createMockOnaAdapter } from "../dist-server/server/ona/mock.js";
import { createPreparationService } from "../dist-server/server/preparation/service.js";
import { createPreparationOperations } from "../dist-server/server/preparation/operations.js";
import { createHandoffService } from "../dist-server/server/preparation/handoff.js";
const root = await mkdtemp(join(tmpdir(), "symphony-jira-preview-"));
let app;
try {
  const workspaceRoot = join(root, "workspace"),
    localRoot = join(root, "local");
  await mkdir(join(workspaceRoot, "projects"), { recursive: true });
  await mkdir(join(workspaceRoot, "roles"));
  await mkdir(localRoot);
  const registry = {
    projects: [
      {
        id: "product",
        names: ["Product"],
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
    roles: [],
  };
  await writeFile(
    join(workspaceRoot, "projects/projects.json"),
    JSON.stringify({ projects: registry.projects }),
  );
  await writeFile(join(workspaceRoot, "roles/roles.json"), '{"roles":[]}');
  const titles = [
    "Improve search latency",
    "Clarify export behavior",
    "Add keyboard navigation",
    "Polish notification settings",
    "Refresh the account page",
    "Update activity filters",
  ];
  const issues = titles.map((title, index) => ({
    connectionId: "demo",
    issueId: String(10001 + index),
    key: `APP-${index + 1}`,
    url: `https://jira.example.test/browse/APP-${index + 1}`,
    projectKey: "APP",
    title,
    description: `${title}.\n\nUse the attached design and implementation plan to guide this change. Review the exact launch prompt and repository before sending to ONA.`,
    acceptanceCriteria:
      "Preserve existing behavior.\nAdd the checks specified in the implementation plan.",
    status: "Open",
    assignedToCurrentUser: true,
    open: true,
    updatedAt: new Date().toISOString(),
  }));
  const fixturesPath = join(root, "issues.json"),
    jiraHandoffConfigPath = join(root, "jira-handoff.json"),
    configPath = join(root, "config.json");
  await writeFile(fixturesPath, JSON.stringify(issues));
  const config = {
    mode: "mock",
    connectionId: "demo",
    fixturesPath,
    projectMappings: { APP: "product" },
  };
  await writeFile(jiraHandoffConfigPath, JSON.stringify(config));
  const port = Number(process.env.SYMPHONY_PREVIEW_PORT ?? 4323);
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
      stableMs: 100,
    }),
  );
  const store = await openStore(workspaceRoot),
    intake = createJiraIntake({
      store,
      registry,
      config,
      localRoot,
      adapter: createMockJiraAdapter(config),
    });
  await intake.sync(new Date());
  const mock = createMockOnaAdapter({ localRoot }),
    preparation = createPreparationService({
      store,
      registry,
      adapter: mock,
      localRoot,
    });
  const tasks = (await store.list()).tasks.sort((a, b) =>
    a.source.localeCompare(b.source),
  );
  let uncertainId;
  for (let index = 1; index < tasks.length; index++) {
    let task = tasks[index];
    const command = async (action) => {
      task = await preparation.command({
        taskId: task.id,
        expectedRevision: task.revision,
        requestId: crypto.randomUUID(),
        action,
      });
    };
    await command({ kind: "prepare" });
    for (const role of index === 1 ? ["design"] : ["design", "implementation"])
      task = await preparation.upload(
        {
          taskId: task.id,
          expectedRevision: task.revision,
          requestId: crypto.randomUUID(),
          role,
          filename: role === "design" ? "café-design.md" : "implementation.txt",
        },
        Buffer.from(
          role === "design"
            ? "\uFEFF# Design\r\n\r\nMake the interaction clear.\r\n<script>This is literal text.</script>\r\n"
            : "# Implementation\n\n1. Update the behavior.\n2. Run relevant tests.\n3. Open a GitLab merge request.\n",
        ),
      );
    if (index === 3) await command({ kind: "send" });
    if (index === 4 || index === 5) {
      const handoff = createHandoffService({
        store,
        registry,
        operations: createPreparationOperations(store),
        adapter: createMockOnaAdapter({
          localRoot,
          scenario: index === 4 ? "accept-then-timeout" : "reject",
        }),
        timeoutMs: 20,
      });
      task = await handoff.send({
        taskId: task.id,
        expectedRevision: task.revision,
        requestId: crypto.randomUUID(),
        action: { kind: "send" },
      });
      if (index === 4) uncertainId = task.preparation.attempts[0].requestId;
      await handoff.close();
    }
  }
  await preparation.close();
  // Leave one uncertainty visible at startup; an explicit subsequent check reads its durable receipt.
  let firstLookup = true;
  const onaAdapter = {
    ...mock,
    async lookup(id, signal) {
      if (id === uncertainId && firstLookup) {
        firstLookup = false;
        return {
          kind: "unknown",
          reason:
            "Simulated lost response. Check the recorded handoff to reconcile.",
        };
      }
      return mock.lookup(id, signal);
    },
  };
  const runner = {
    async probe() {
      return { version: "jira-preview-no-agent" };
    },
    async start() {
      throw new Error("Jira preparation must never start Codex");
    },
  };
  app = await startApplication({
    configPath,
    buildDir: resolve("dist"),
    runner,
    onaAdapter,
    verifyCapabilities: async () => {},
  });
  console.log(`JIRA MOCK PREVIEW ${app.address}\nTemporary data: ${root}`);
  console.log(
    "APP-1 Inbox · APP-2 Missing plan · APP-3 Ready · APP-4 Accepted · APP-5 Unconfirmed · APP-6 Rejected",
  );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    await rm(root, { recursive: true, force: true });
  };
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(
      signal,
      () =>
        void close().then(
          () => process.exit(0),
          (error) => {
            console.error(error);
            process.exitCode = 1;
          },
        ),
    );
} catch (error) {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
  throw error;
}
