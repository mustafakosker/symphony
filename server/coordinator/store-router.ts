import type { Store } from "../store/task-store.js";
import { BoundaryError } from "../../shared/validate.js";
export function createStoreRouter(primary: Store, projectJobs: Store): Store {
  async function exists(store: Store, id: string) {
    try {
      await store.get(id);
      return true;
    } catch (error) {
      if (error instanceof BoundaryError && error.code === "missing")
        return false;
      throw error;
    }
  }
  async function owner(id: string): Promise<Store> {
    const [a, b] = await Promise.all([
      exists(primary, id),
      exists(projectJobs, id),
    ]);
    if (a && b)
      throw new BoundaryError(
        "conflict",
        "Duplicate task ID across primary and project job stores",
      );
    if (a) return primary;
    if (b) return projectJobs;
    throw new BoundaryError("missing", "Task does not exist");
  }
  return {
    create: async (task, operation) => {
      const target =
          task.schemaVersion === 2 && task.purpose === "project-brief"
            ? projectJobs
            : primary,
        other = target === primary ? projectJobs : primary;
      if (await exists(other, task.id))
        throw new BoundaryError("conflict", "Duplicate task ID across stores");
      return target.create(task, operation);
    },
    get: async (id) => (await owner(id)).get(id),
    list: async () => {
      const [a, b] = await Promise.all([primary.list(), projectJobs.list()]);
      const ids = new Set(a.tasks.map((t) => t.id));
      if (b.tasks.some((t) => ids.has(t.id)))
        throw new BoundaryError("conflict", "Duplicate task IDs across stores");
      return {
        tasks: [...a.tasks, ...b.tasks],
        issues: [
          ...a.issues,
          ...b.issues.map((i) => ({ ...i, id: `project-job-${i.id}` })),
        ],
        coordinator: a.coordinator,
      };
    },
    apply: async (id, revision, operation, event) =>
      (await owner(id)).apply(id, revision, operation, event),
    recover: async () => {
      const [a, b] = await Promise.all([
        primary.recover(),
        projectJobs.recover(),
      ]);
      return [...a, ...b.map((i) => ({ ...i, id: `project-job-${i.id}` }))];
    },
    publishArtifact: async (id, name, bytes) =>
      (await owner(id)).publishArtifact(id, name, bytes),
    readArtifact: async (id, ref) => (await owner(id)).readArtifact(id, ref),
    readRunLog: async (id, run, offset, maxBytes, stream) =>
      (await owner(id)).readRunLog(id, run, offset, maxBytes, stream),
    publishWorkflow: async (id, workflow) =>
      (await owner(id)).publishWorkflow(id, workflow),
    publishRunFiles: async (id, run, files) =>
      (await owner(id)).publishRunFiles(id, run, files),
  };
}
