import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import type {
  CatalogView,
  DraftText,
  ResolutionChoices,
  ResolutionPreview,
  ProjectDraft,
  ProjectContext,
  OperationStatus,
  ProjectRecord,
  BriefCopy,
  SnapshotRef,
} from "../../shared/projects.js";
import {
  resolveProjects,
  resolutionPayload,
} from "../../shared/project-resolution.js";
import { parseProjectContext } from "../../shared/project-validation.js";
import { BoundaryError } from "../../shared/validate.js";
import { confinedPath } from "../store/paths.js";
import { writeAtomic } from "../store/atomic.js";
import type { ProjectCatalog } from "./catalog.js";
import type { BriefService } from "./briefs.js";
import { resolveSourceCommit, type SnapshotService } from "./snapshots.js";
const hash = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
export function previewResolution(
  text: DraftText,
  catalog: CatalogView,
  choices: ResolutionChoices,
): ResolutionPreview {
  return {
    ...resolveProjects(text, catalog, choices),
    revision: hash(resolutionPayload(text, catalog, choices)),
  };
}
export type BindingService = {
  begin(input: ProjectDraft, requestId: string): Promise<OperationStatus>;
  advance(id: string): Promise<OperationStatus>;
  getContext(id: string): Promise<ProjectContext | null>;
  status(id: string): Promise<OperationStatus>;
  retry(id: string, requestId: string): Promise<OperationStatus>;
  tick(): Promise<void>;
};
type Selected = {
  project: ProjectRecord;
  ref: string;
  brief: BriefCopy;
  resolved?: { commit: string; objectFormat: "sha1" | "sha256" };
  snapshot?: SnapshotRef;
};
type Record = {
  retries?: string[];
  status: OperationStatus;
  digest: string;
  input: ProjectDraft;
  preview: ResolutionPreview;
  selected: Selected[];
  context: ProjectContext | null;
};
export async function createProjectBinding(deps: {
  catalog: ProjectCatalog;
  snapshots: SnapshotService;
  briefs: BriefService;
  localRoot: string;
}): Promise<BindingService> {
  const root = await confinedPath(deps.localRoot, "projects/bindings");
  await mkdir(root, { recursive: true });
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>) => {
    const p = queue.catch(() => {}).then(fn);
    queue = p;
    return p;
  };
  const path = (id: string) => {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new BoundaryError("invalid", "Invalid binding ID");
    return confinedPath(root, `${id}.json`);
  };
  const load = async (id: string): Promise<Record> => {
    try {
      return JSON.parse(await readFile(await path(id), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        throw new BoundaryError("missing", "Submission is unavailable");
      throw e;
    }
  };
  const save = async (r: Record) =>
    writeAtomic(await path(r.status.id), JSON.stringify(r));
  async function advance(id: string) {
    const r = await load(id);
    if (r.context || r.status.state === "failed") return r.status;
    try {
      for (const s of r.selected) {
        if (!s.resolved) {
          s.resolved = await resolveSourceCommit(s.project, s.ref);
          r.status.state = "running";
          r.status.revision++;
          await save(r);
          return r.status;
        }
        if (!s.snapshot) {
          await deps.snapshots.importCommit(s.project, s.resolved);
          s.snapshot = await deps.snapshots.materialize(s.project, s.resolved);
          await save(r);
          return r.status;
        }
      }
      let entries = 0,
        bytes = 0;
      for (const s of r.selected) {
        const m = await deps.snapshots.verify(s.snapshot!);
        entries += m.entries.length;
        bytes += m.totalBytes;
      }
      if (entries > 100000 || bytes > 1073741824)
        throw new BoundaryError(
          "invalid",
          "Combined project snapshots exceed task limits",
        );
      const context: ProjectContext = {
        version: 1,
        generation: r.preview.generation,
        resolutionRevision: r.preview.revision,
        targetId: r.preview.targetId,
        referenceIds: r.preview.referenceIds,
        projects: r.selected.map((s) => ({
          projectId: s.project.id,
          repositoryId: s.project.repositoryId,
          name: s.project.name,
          ref: s.ref,
          snapshot: s.snapshot!,
          brief: s.brief,
        })),
      };
      if (Buffer.byteLength(JSON.stringify(context)) > 1024 * 1024)
        throw new BoundaryError(
          "invalid",
          "Combined project context exceeds 1 MiB",
        );
      r.context = parseProjectContext(context, "task");
      r.status.state = "complete";
      r.status.message = "Project context pinned";
      r.status.revision++;
      await save(r);
    } catch (e) {
      r.status.state = "failed";
      r.status.message =
        e instanceof Error ? e.message : "Project binding failed";
      r.status.revision++;
      await save(r);
    }
    return r.status;
  }
  return {
    begin: (input, requestId) =>
      serial(async () => {
        if (!requestId)
          throw new BoundaryError("invalid", "Request ID required");
        const id = hash(requestId),
          digest = hash(input);
        let prior: Record | null = null;
        try {
          prior = await load(id);
        } catch (e) {
          if (!(e instanceof BoundaryError && e.code === "missing")) throw e;
        }
        if (prior) {
          if (prior.digest !== digest)
            throw new BoundaryError(
              "conflict",
              "Submission request has different content",
            );
          return prior.status;
        }
        const catalog = await deps.catalog.read(),
          preview = previewResolution(input.text, catalog, input.choices);
        if (
          preview.revision !== input.previewRevision ||
          catalog.revision !== input.catalogRevision
        )
          throw new BoundaryError(
            "conflict",
            "Project matches changed; review the draft again",
          );
        if (preview.problems.length)
          throw new BoundaryError("invalid", preview.problems[0].message);
        const ids = [
          ...(preview.targetId ? [preview.targetId] : []),
          ...preview.referenceIds,
        ];
        if (
          input.selections.length !== ids.length ||
          new Set(input.selections.map((s) => s.projectId)).size !==
            ids.length ||
          input.selections.some((s) => !ids.includes(s.projectId))
        )
          throw new BoundaryError(
            "invalid",
            "Project selection differs from matched projects",
          );
        const selected: Selected[] = [];
        for (const id of ids) {
          const project = catalog.records.find((p) => p.id === id)!,
            selection = input.selections.find((s) => s.projectId === id)!;
          if (
            project.readiness !== "ready" ||
            !project.branches.includes(selection.ref)
          )
            throw new BoundaryError(
              "conflict",
              `${project.name} needs preparation or an available branch`,
            );
          selected.push({
            project,
            ref: selection.ref,
            brief: await deps.briefs.get(id, selection.briefVersion),
          });
        }
        const r: Record = {
          status: {
            id,
            revision: 1,
            kind: "submission",
            state: "queued",
            message: "Preparing project context",
            taskId: null,
          },
          digest,
          input,
          preview,
          selected,
          context: null,
        };
        await save(r);
        return r.status;
      }),
    retry: (id, requestId) =>
      serial(async () => {
        if (!requestId)
          throw new BoundaryError("invalid", "Retry request ID required");
        const r = await load(id),
          key = hash(requestId);
        if (r.retries?.includes(key)) return r.status;
        if (r.status.state !== "failed")
          throw new BoundaryError(
            "conflict",
            "Only a failed binding can be retried",
          );
        r.retries = [...(r.retries ?? []), key];
        r.status.state = "queued";
        r.status.message = "Retrying original pinned commits";
        r.status.revision++;
        await save(r);
        return r.status;
      }),
    advance: (id) => serial(() => advance(id)),
    getContext: (id) => serial(async () => (await load(id)).context),
    status: (id) => serial(async () => (await load(id)).status),
    tick: () =>
      serial(async () => {
        for (const name of await readdir(root))
          if (/^[a-f0-9]{64}\.json$/.test(name))
            await advance(name.slice(0, -5));
      }),
  };
}
