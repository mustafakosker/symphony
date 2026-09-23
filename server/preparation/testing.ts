import { draftTask } from "../testing/fixtures.js";
import type { Task, ArtifactRef } from "../../shared/contracts.js";
import type {
  JiraSnapshot,
  JiraPreparation,
} from "../../shared/jira-preparation.js";

export function jiraIssue(overrides: Partial<JiraSnapshot> = {}): JiraSnapshot {
  return {
    connectionId: "demo",
    issueId: "10001",
    key: "APP-1",
    url: "https://jira.example.test/browse/APP-1",
    projectKey: "APP",
    title: "Make search faster",
    description: "Improve search latency.",
    acceptanceCriteria: "Search under 100ms",
    status: "Open",
    assignedToCurrentUser: true,
    open: true,
    updatedAt: "2026-09-23T10:00:00Z",
    ...overrides,
  };
}
export function jiraTask(overrides: Partial<Task> = {}): Task {
  const preparation: JiraPreparation = {
    mode: "jira-ona",
    source: jiraIssue(),
    sourceDigest: "a".repeat(64),
    matchesQuery: true,
    phase: "inbox",
    documents: { design: null, implementation: null },
    prompt: null,
    target: null,
    attempts: [],
  };
  return {
    ...draftTask(),
    type: "jira",
    title: "Make search faster",
    source: "APP-1",
    status: "waiting-for-human",
    currentStepId: "jira-preparation",
    queuedAt: null,
    preparation,
    ...overrides,
  };
}
export function artifact(id = "jira-design", version = 1): ArtifactRef {
  return {
    id,
    version,
    digest: "a".repeat(64),
    path: `artifacts/${id}.${version}.bin`,
  };
}
