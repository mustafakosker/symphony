import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import type { ConnectedTask } from "../../shared/contracts.js";
import type {
  OperationStatus,
  ProjectRecord,
  SnapshotRef,
  SourceReport,
} from "../../shared/projects.js";
import { parseSourceReport } from "../../shared/source-report.js";
import { BoundaryError } from "../../shared/validate.js";
import type { Store } from "../store/task-store.js";
import { confinedPath } from "../store/paths.js";
import { writeAtomic } from "../store/atomic.js";
import type { SnapshotService } from "./snapshots.js";
import type { BriefService } from "./briefs.js";
export type BriefJobs = {
  enqueue(
    project: ProjectRecord,
    snapshot: SnapshotRef,
    requestId: string,
  ): Promise<OperationStatus>;
  reconcile(): Promise<void>;
  status(id: string): Promise<OperationStatus>;
  candidate(id: string): Promise<SourceReport | null>;
  source(id: string): Promise<SnapshotRef>;
};
type Job = {
  failure?: string;
  id: string;
  requestDigest: string;
  task: ConnectedTask;
  reconciled: boolean;
  candidate: SourceReport | null;
};
type State = { jobs: Record<string, Job>; requests: Record<string, string> };
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function createBriefTask(
  project: ProjectRecord,
  snapshot: SnapshotRef,
): ConnectedTask {
  const id = randomUUID(),
    at = new Date().toISOString();
  const step = {
    kind: "agent" as const,
    id: "generate-brief",
    title: "Describe project context",
    role: "researcher" as const,
    instructions:
      "Inspect documentation, manifests, representative entry points and test configuration. Describe purpose, architecture, conventions, discovered validation commands and inspection limits. Return source-report-v1 with citations. Do not run project commands; label commands Not run.",
    inputs: [],
    repositories: [project.repositoryId],
    actions: ["read" as const],
    outputs: ["project-brief"],
    checks: ["project-brief"],
  };
  return {
    schemaVersion: 2,
    purpose: "project-brief",
    id,
    revision: 1,
    title: `Brief: ${project.name}`,
    idea: step.instructions,
    type: "project-brief",
    projectId: null,
    source: `project-library/${project.id}`,
    status: "queued",
    workflow: {
      version: 1,
      steps: [step],
      completionChecks: ["project-brief"],
    },
    proposedWorkflow: null,
    currentStepId: step.id,
    completedStepIds: [],
    staleStepIds: [],
    generation: 0,
    intent: null,
    reviews: [],
    runs: [],
    artifacts: [],
    approvalBindings: [],
    blockedReason: null,
    queuedAt: at,
    createdAt: at,
    updatedAt: at,
    projectContext: {
      version: 1,
      generation: project.generation,
      resolutionRevision: hash([project.id, snapshot]),
      targetId: null,
      referenceIds: [project.id],
      projects: [
        {
          projectId: project.id,
          repositoryId: project.repositoryId,
          name: project.name,
          ref: project.defaultRef ?? "detached",
          snapshot,
          brief: null,
        },
      ],
    },
  };
}
export function createBriefJobs({
  store,
  briefs,
  snapshots,
  localRoot,
}: {
  store: Store;
  briefs: BriefService;
  snapshots: SnapshotService;
  localRoot: string;
}): BriefJobs {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.catch(() => {}).then(fn);
    queue = p;
    return p;
  };
  async function statePath() {
    const root = await confinedPath(localRoot, "projects/brief-jobs");
    await mkdir(root, { recursive: true });
    return confinedPath(root, "state.json");
  }
  async function load(): Promise<State> {
    try {
      return JSON.parse(await readFile(await statePath(), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { jobs: {}, requests: {} };
      throw e;
    }
  }
  const save = async (state: State) =>
    writeAtomic(await statePath(), `${JSON.stringify(state)}\n`);
  function find(state: State, id: string) {
    if (!Object.hasOwn(state.jobs, id))
      throw new BoundaryError("missing", "Brief operation is unavailable");
    return state.jobs[id];
  }
  async function status(job: Job): Promise<OperationStatus> {
    if (job.failure)
      return {
        id: job.id,
        revision: 1,
        kind: "brief",
        taskId: null,
        state: "failed",
        message: job.failure,
      };
    const task = await store.get(job.task.id);
    return {
      id: job.id,
      revision: task.revision + (job.reconciled ? 1 : 0),
      kind: "brief",
      taskId: null,
      state: job.reconciled
        ? "complete"
        : task.status === "done"
          ? "running"
          : task.status === "blocked" || task.status === "cancelled"
            ? "failed"
            : task.status === "waiting-for-human"
              ? "needs-input"
              : task.status === "running"
                ? "running"
                : "queued",
      message: job.reconciled
        ? job.candidate
          ? "Generated candidate ready to review"
          : "Project brief saved"
        : (task.blockedReason ??
          (task.status === "waiting-for-human"
            ? (task.reviews.at(-1)?.prompt ?? "Brief needs input")
            : "Preparing project brief")),
    };
  }
  return {
    enqueue: (project, snapshot, requestId) =>
      serial(async () => {
        await snapshots.verify(snapshot);
        const state = await load(),
          key = hash(requestId),
          digest = hash([project.id, snapshot]);
        if (state.requests[key]) {
          const job = find(state, state.requests[key]);
          if (job.requestDigest !== digest)
            throw new BoundaryError("conflict", "Brief request ID reused");
          await store.create(job.task, `brief:${job.id}`);
          return status(job);
        }
        const task = createBriefTask(project, snapshot),
          job: Job = {
            id: randomUUID(),
            requestDigest: digest,
            task,
            reconciled: false,
            candidate: null,
          };
        state.jobs[job.id] = job;
        state.requests[key] = job.id;
        await save(state);
        await store.create(task, `brief:${job.id}`);
        return status(job);
      }),
    reconcile: () =>
      serial(async () => {
        const state = await load();
        for (const job of Object.values(state.jobs)) {
          if (job.reconciled || job.failure) continue;
          try {
            await store.create(job.task, `brief:${job.id}`);
            const task = await store.get(job.task.id);
            if (task.status !== "done") continue;
            const artifact = task.artifacts.find(
              (a) => a.id === "project-brief",
            );
            if (!artifact) continue;
            const report = parseSourceReport(
                JSON.parse(
                  Buffer.from(
                    await store.readArtifact(task.id, artifact),
                  ).toString("utf8"),
                ),
              ),
              source = job.task.projectContext.projects[0].snapshot;
            try {
              await briefs.save({
                projectId: source.projectId,
                expectedVersion: null,
                requestId: `generated-${job.id}`,
                author: "generated",
                source,
                report,
              });
            } catch (e) {
              if (!(e instanceof BoundaryError) || e.code !== "conflict")
                throw e;
              job.candidate = report;
            }
            job.reconciled = true;
            await save(state);
          } catch (error) {
            job.failure =
              error instanceof Error
                ? error.message
                : "Internal brief job unavailable";
            await save(state);
          }
        }
      }),
    status: (id) => serial(async () => status(find(await load(), id))),
    candidate: (id) => serial(async () => find(await load(), id).candidate),
    source: (id) =>
      serial(
        async () =>
          find(await load(), id).task.projectContext.projects[0].snapshot,
      ),
  };
}
