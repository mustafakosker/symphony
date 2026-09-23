import type { JiraSnapshot } from "../../shared/jira-preparation.js";
export type JiraBatch = { complete: boolean; issues: JiraSnapshot[] };
export type JiraAdapter = { listAssignedOpen(): Promise<JiraBatch> };
