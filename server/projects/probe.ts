import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  realpath,
  mkdir,
  readFile,
  readdir,
  lstat,
  readlink,
  writeFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSettings } from "../config/settings.js";
import { loadRegistry } from "../config/registry.js";
import { createCodexRunner, type Assignment } from "../codex/adapter.js";
import { verifySnapshotProfile } from "../codex/snapshot-capability.js";
import {
  resolveSnapshotAccess,
  snapshotLimits,
} from "../codex/snapshot-access.js";
import { openSnapshots } from "./snapshots.js";
import { runGit } from "./git.js";
import { createBriefTask } from "./brief-jobs.js";
import type { ProjectRecord } from "../../shared/projects.js";
export type ProbeObservation = {
  cliVersion: string;
  scopes: string[];
  policyDigests: Record<string, string>;
  readText: string | null;
  expectedText: string;
  writeAttempts: Array<{
    location: "source" | "snapshot" | "task-store" | "job-store";
    attempted: boolean;
    denied: boolean;
  }>;
  combinedScopeVerified: boolean;
  toolPolicyVerified: boolean;
  citationsResolve: boolean;
  beforeDigest: string;
  afterDigest: string;
  limitations: string[];
};
export function evaluateProjectProbe(o: ProbeObservation) {
  const denied = (
    location: ProbeObservation["writeAttempts"][number]["location"],
  ) =>
    o.writeAttempts.some(
      (a) => a.location === location && a.attempted && a.denied,
    );
  const checks = {
    committedSnapshotReadable: o.readText === o.expectedText,
    sourceWriteDenied: denied("source"),
    snapshotWriteDenied: denied("snapshot"),
    taskStoreWriteDenied: denied("task-store"),
    jobStoreWriteDenied: denied("job-store"),
    combinedScopeVerified: o.combinedScopeVerified,
    toolPolicyVerified: o.toolPolicyVerified,
    citationsResolve: o.citationsResolve,
    sourceUnchanged: o.beforeDigest === o.afterDigest,
  };
  return {
    checks,
    passed: Object.values(checks).every(Boolean) && o.limitations.length === 0,
  };
}
async function digestTree(root: string) {
  const h = createHash("sha256");
  async function walk(path: string) {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name),
        s = await lstat(child);
      h.update(child.slice(root.length) + s.mode);
      if (s.isSymbolicLink()) h.update(await readlink(child));
      else if (s.isDirectory()) await walk(child);
      else h.update(await readFile(child));
    }
  }
  await walk(root);
  return h.digest("hex");
}
/** Only probe-owned fixtures are inspected. Missing scoped host policy remains an explicit failure. */
export async function runProjectProbe(
  configPath: string,
): Promise<ProbeObservation> {
  const host = await loadSettings(configPath),
    runner = createCodexRunner(host),
    base = await realpath(
      await mkdtemp(join(tmpdir(), "symphony-host-probe-")),
    ),
    owned: string[] = [];
  const observation: ProbeObservation = {
    cliVersion: "unavailable",
    scopes: [],
    policyDigests: {},
    readText: null,
    expectedText: `COMMITTED-${randomUUID()}`,
    writeAttempts: ["source", "snapshot", "task-store", "job-store"].map(
      (location) => ({
        location:
          location as ProbeObservation["writeAttempts"][number]["location"],
        attempted: false,
        denied: false,
      }),
    ),
    combinedScopeVerified: false,
    toolPolicyVerified: false,
    citationsResolve: false,
    beforeDigest: "",
    afterDigest: "",
    limitations: [],
  };
  try {
    observation.cliVersion = (await runner.probe()).version;
    const registry = await loadRegistry(host.workspaceRoot),
      role = registry.roles.find((r) => r.role === "researcher");
    if (!role)
      throw new Error(
        "No researcher role configured for host snapshot verification",
      );
    const sources = join(base, "sources");
    await mkdir(sources);
    const snapshots = await openSnapshots(host.localRoot, snapshotLimits(host));
    const projects = [];
    for (let n = 0; n < 2; n++) {
      const id = `probe-${randomUUID()}`,
        source = join(sources, `probe-${n}`);
      await mkdir(source);
      await runGit(source, ["init", "-q", "-b", "main"]);
      await writeFile(
        join(source, "sentinel.txt"),
        observation.expectedText + "\n",
      );
      await runGit(source, ["add", "sentinel.txt"]);
      await runGit(source, [
        "-c",
        "user.name=Symphony Probe",
        "-c",
        "user.email=probe@example.invalid",
        "commit",
        "-qm",
        "Disposable committed sentinel",
      ]);
      const commit = (await runGit(source, ["rev-parse", "HEAD"]))
        .toString()
        .trim();
      await writeFile(join(source, "sentinel.txt"), "DIRTY sentinel");
      await writeFile(join(source, "untracked.txt"), "UNTRACKED sentinel");
      const p: ProjectRecord = {
        id,
        repositoryId: id,
        name: `probe-${n}`,
        aliases: [],
        sourcePath: source,
        gitDir: join(source, ".git"),
        displayName: `probe-${n}`,
        defaultRef: "main",
        branches: ["main"],
        observedCommit: commit,
        generation: "probe",
        revision: "probe",
        readiness: "discovered",
        error: null,
        lastScannedAt: new Date().toISOString(),
      };
      owned.push(
        join(host.localRoot, "projects/snapshots", id),
        join(host.localRoot, "projects/objects", id),
      );
      await snapshots.importCommit(p, { commit, objectFormat: "sha1" });
      const snapshot = await snapshots.materialize(p, {
        commit,
        objectFormat: "sha1",
      });
      projects.push({ project: p, snapshot });
      observation.scopes.push(join(host.localRoot, "projects/snapshots", id));
    }
    observation.beforeDigest = await digestTree(sources);
    if (host.verifiedProfilesPath)
      observation.policyDigests[host.verifiedProfilesPath] = createHash(
        "sha256",
      )
        .update(await readFile(host.verifiedProfilesPath))
        .digest("hex");
    for (const selected of [[projects[0]], projects]) {
      const task = createBriefTask(selected[0].project, selected[0].snapshot);
      if (selected.length > 1) {
        task.projectContext.projects = selected.map(
          ({ project: p, snapshot }) => ({
            projectId: p.id,
            repositoryId: p.id,
            name: p.name,
            ref: "main",
            snapshot,
            brief: null,
          }),
        );
        task.projectContext.referenceIds = selected.map((p) => p.project.id);
      }
      const step = task.workflow!.steps[0];
      if (step.kind !== "agent") throw new Error("Invalid probe workflow");
      step.repositories = selected.map((p) => p.project.id);
      const access = await resolveSnapshotAccess(
        task.projectContext,
        step.repositories,
        snapshots,
      );
      // The production verifier must authorize the exact disposable scopes before any launch.
      await verifySnapshotProfile(
        host,
        { task, step, role, snapshotAccess: access },
        observation.cliVersion,
      );
      const cwd = join(host.localRoot, "project-probes", task.id);
      owned.push(cwd);
      await mkdir(cwd, { recursive: true });
      const at = new Date().toISOString();
      const assignment: Assignment = {
        task,
        step: {
          ...step,
          instructions: `Read sentinel.txt from each assigned snapshot. Return its literal contents in completed.evidence.probeRead. Do not inspect any other source paths. These are disposable host probe fixtures.`,
        },
        role,
        cwd,
        outputDir: cwd,
        schemaPath: join(cwd, "schema.json"),
        materials: [],
        snapshotAccess: access,
        run: {
          id: randomUUID(),
          stepId: step.id,
          workflowVersion: 1,
          generation: 0,
          phase: "launch-intent",
          pid: null,
          processStartedAt: null,
          runtimeVersion: observation.cliVersion,
          inputRefs: [],
          repos: selected.map((p) => ({
            repository: p.project.id,
            rule: "main",
            commit: p.snapshot.commit,
            selectedCommits: [p.snapshot.commit],
          })),
          startedAt: at,
          endedAt: null,
          exitCode: null,
          retryCount: 0,
          nextRetryAt: null,
          result: null,
        },
      };
      const running = await runner.start(assignment, () => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const exit = await Promise.race([
          running.completion,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => {
                void running
                  .stop()
                  .finally(() => reject(new Error("Probe timed out")));
              },
              Math.min(host.runTimeoutMs, 60000),
            );
          }),
        ]);
        if (exit.error || exit.code !== 0)
          throw new Error(exit.error ?? "Probe launch failed");
        if (exit.result?.kind === "completed")
          observation.readText = exit.result.evidence.probeRead ?? null;
      } finally {
        clearTimeout(timer);
      }
    }
    observation.limitations.push(
      "No installed host probe provider records attempted write denials, combined read-scope isolation, external-tool policy, and returned citation validation. Read-only runner completion alone cannot verify these checks.",
    );
    observation.afterDigest = await digestTree(sources);
  } catch (e) {
    observation.limitations.push(e instanceof Error ? e.message : String(e));
    if (observation.beforeDigest)
      observation.afterDigest = await digestTree(join(base, "sources"));
  } finally {
    await rm(base, { recursive: true, force: true });
    for (const path of owned) await rm(path, { recursive: true, force: true });
  }
  return observation;
}
