import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { object, name, string } from "../../shared/validate.js";
import type { Registry } from "./registry.js";
import type { TargetOption } from "../../shared/jira-preparation.js";
export type JiraHandoffConfig = {
  mode: "mock";
  connectionId: string;
  fixturesPath: string;
  projectMappings: Record<string, string>;
};
export async function loadJiraHandoffConfig(
  path: string,
  registry: Registry,
): Promise<JiraHandoffConfig> {
  if (!isAbsolute(path)) throw new Error("Jira config path must be absolute");
  const v = object(JSON.parse(await readFile(path, "utf8")), "jira config");
  if (v.mode !== "mock")
    throw new Error("Only mock Jira/ONA integration is supported");
  for (const key of Object.keys(v))
    if (
      !["mode", "connectionId", "fixturesPath", "projectMappings"].includes(key)
    )
      throw new Error(`Unknown Jira config field ${key}`);
  const fixturesPath = string(v.fixturesPath, "fixturesPath");
  if (!isAbsolute(fixturesPath))
    throw new Error("Jira fixtures path must be absolute");
  const projectMappings = Object.fromEntries(
    Object.entries(object(v.projectMappings, "projectMappings")).map(
      ([key, value]) => {
        const id = name(value, "project mapping");
        if (!registry.projects.some((p) => p.id === id))
          throw new Error(`Unknown mapped project ${id}`);
        return [key, id];
      },
    ),
  );
  return {
    mode: "mock",
    connectionId: name(v.connectionId, "connectionId"),
    fixturesPath,
    projectMappings,
  };
}
export function targetOptions(registry: Registry): TargetOption[] {
  return registry.projects.flatMap((project) =>
    project.repositories.map((repo) => ({
      projectId: project.id,
      repositoryId: repo.id,
      baseBranch: repo.baseRef,
    })),
  );
}
