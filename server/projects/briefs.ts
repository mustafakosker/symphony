import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import type {
  BriefCopy,
  SnapshotRef,
  SourceReport,
} from "../../shared/projects.js";
import { parseBriefCopy } from "../../shared/project-validation.js";
import { parseSourceReport } from "../../shared/source-report.js";
import { BoundaryError } from "../../shared/validate.js";
import { confinedPath } from "../store/paths.js";
import { writeAtomic } from "../store/atomic.js";
import type { SnapshotService } from "./snapshots.js";
import { validateSourceReport } from "./citations.js";
export type BriefSave = {
  projectId: string;
  expectedVersion: number | null;
  requestId: string;
  author: BriefCopy["author"];
  source: SnapshotRef;
  report: SourceReport;
};
export type BriefService = {
  current(projectId: string): Promise<BriefCopy | null>;
  get(projectId: string, version: number): Promise<BriefCopy>;
  history(projectId: string): Promise<BriefCopy[]>;
  save(input: BriefSave): Promise<BriefCopy>;
};
type State = {
  versions: BriefCopy[];
  requests: Record<string, { digest: string; version: number }>;
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function openBriefs(
  localRoot: string,
  snapshots: SnapshotService,
): Promise<BriefService> {
  const root = await confinedPath(localRoot, "projects/briefs");
  await mkdir(root, { recursive: true });
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.catch(() => {}).then(fn);
    queue = p;
    return p;
  };
  async function path(id: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id))
      throw new BoundaryError("invalid", "Invalid project ID");
    return confinedPath(root, `${id}.json`);
  }
  async function load(id: string): Promise<State> {
    try {
      const state: State = JSON.parse(await readFile(await path(id), "utf8"));
      state.versions = state.versions.map((raw) => {
        const v = parseBriefCopy(raw);
        if (
          v.source.projectId !== id ||
          v.digest !== hash({ source: v.source, report: v.report })
        )
          throw new Error("Brief content digest or source changed");
        return v;
      });
      return state;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { versions: [], requests: {} };
      throw e;
    }
  }
  return {
    current: (id) =>
      serial(async () => (await load(id)).versions.at(-1) ?? null),
    get: (id, version) =>
      serial(async () => {
        const v = (await load(id)).versions.find((v) => v.version === version);
        if (!v)
          throw new BoundaryError("missing", "Brief version is unavailable");
        return v;
      }),
    history: (id) => serial(async () => (await load(id)).versions),
    save: (input) =>
      serial(async () => {
        const report = parseSourceReport(input.report),
          state = await load(input.projectId),
          key = hash(input.requestId),
          digest = hash({ ...input, report });
        if (state.requests[key]) {
          if (state.requests[key].digest !== digest)
            throw new BoundaryError("conflict", "Brief request ID reused");
          return state.versions.find(
            (v) => v.version === state.requests[key].version,
          )!;
        }
        if ((state.versions.at(-1)?.version ?? null) !== input.expectedVersion)
          throw new BoundaryError(
            "conflict",
            "Brief changed; retain your text and reload",
          );
        if (
          input.source.projectId !== input.projectId ||
          input.source.repositoryId !== input.projectId
        )
          throw new BoundaryError(
            "invalid",
            "Brief source belongs to a different project",
          );
        if (
          !["generated", "human", "human-edited"].includes(input.author) ||
          !input.requestId
        )
          throw new BoundaryError("invalid", "Invalid brief author or request");
        await snapshots.verify(input.source);
        await validateSourceReport(report, [input.source], snapshots, {
          textBytes: 128 * 1024,
          citations: 256,
        });
        const version: BriefCopy = {
          version: state.versions.length + 1,
          digest: hash({ source: input.source, report }),
          author: input.author,
          source: input.source,
          report,
          createdAt: new Date().toISOString(),
        };
        state.versions.push(version);
        state.requests[key] = { digest, version: version.version };
        await writeAtomic(
          await path(input.projectId),
          `${JSON.stringify(state)}\n`,
        );
        return structuredClone(version);
      }),
  };
}
