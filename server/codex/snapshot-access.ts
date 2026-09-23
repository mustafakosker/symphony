import { join } from "node:path";
import type {
  ProjectContext,
  SnapshotLimits,
  SnapshotRef,
} from "../../shared/projects.js";
import type { Settings } from "../config/settings.js";
import type { SnapshotService } from "../projects/snapshots.js";
export type SnapshotAccess = {
  kind: "snapshot";
  repository: string;
  snapshot: SnapshotRef;
  snapshotPath: string;
};
export function snapshotLimits(settings: Settings): SnapshotLimits {
  return {
    entries: settings.projectSnapshotMaxEntries ?? 100000,
    totalBytes: settings.projectSnapshotMaxBytes ?? 1073741824,
    fileBytes: settings.projectSnapshotMaxFileBytes ?? 67108864,
    timeoutMs: settings.projectGitTimeoutMs ?? 120000,
  };
}
export async function resolveSnapshotAccess(
  context: ProjectContext,
  repositoryIds: string[],
  snapshots: SnapshotService,
): Promise<SnapshotAccess[]> {
  if (new Set(repositoryIds).size !== repositoryIds.length)
    throw new Error("Duplicate selected repository");
  const access: SnapshotAccess[] = [];
  for (const repository of repositoryIds) {
    const project = context.projects.find((p) => p.repositoryId === repository);
    if (!project) throw new Error("Assignment selected an unbound repository");
    await snapshots.verify(project.snapshot);
    access.push({
      kind: "snapshot",
      repository,
      snapshot: project.snapshot,
      snapshotPath: join(await snapshots.path(project.snapshot), "files"),
    });
  }
  return access;
}
