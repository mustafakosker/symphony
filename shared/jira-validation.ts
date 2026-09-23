import type { Task, ArtifactRef } from "./contracts.js";
import type {
  DocumentRole,
  DocumentSelection,
  FrozenPackage,
  HandoffAttempt,
  JiraPreparation,
  JiraSnapshot,
  OnaReceipt,
  PreparationAction,
  PreparationCommand,
  PromptSelection,
  Target,
  UploadCommand,
} from "./jira-preparation.js";
import { preparationReady } from "./jira-preparation.js";
import {
  object,
  string,
  nullable,
  integer,
  choice,
  array,
  unique,
  fsId,
  name,
  timestamp,
  artifact,
} from "./validate.js";

const digest = (v: unknown, field: string): string => {
  const value = string(v, field);
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new Error(`${field} must be SHA-256`);
  return value;
};
const bool = (v: unknown, field: string): boolean => {
  if (typeof v !== "boolean") throw new Error(`${field} must be boolean`);
  return v;
};
export function parseTarget(v: unknown): Target | null {
  if (v === null) return null;
  const o = object(v, "target");
  const branch = string(o.branch, "target.branch");
  if (branch.length > 255 || /[\0\r\n]/.test(branch))
    throw new Error("Invalid target branch");
  return {
    projectId: name(o.projectId, "target.projectId"),
    repositoryId: name(o.repositoryId, "target.repositoryId"),
    branch,
  };
}
export function parseJiraSnapshot(value: unknown): JiraSnapshot {
  const v = object(value, "jira");
  const url = string(v.url, "jira.url");
  if (!["https:", "http:"].includes(new URL(url).protocol))
    throw new Error("Invalid Jira URL");
  return {
    connectionId: name(v.connectionId, "jira.connectionId"),
    issueId: string(v.issueId, "jira.issueId"),
    key: string(v.key, "jira.key"),
    url,
    projectKey: string(v.projectKey, "jira.projectKey"),
    title: string(v.title, "jira.title"),
    description: string(v.description, "jira.description", false),
    acceptanceCriteria: nullable(
      v.acceptanceCriteria,
      "jira.acceptanceCriteria",
      (x, f) => string(x, f, false),
    ),
    status: string(v.status, "jira.status"),
    assignedToCurrentUser: bool(v.assignedToCurrentUser, "jira.assigned"),
    open: bool(v.open, "jira.open"),
    updatedAt: timestamp(v.updatedAt, "jira.updatedAt"),
  };
}
export function parseDocument(
  value: unknown,
  role: DocumentRole,
): DocumentSelection {
  const v = object(value, role);
  if (v.role !== role) throw new Error("Document role mismatch");
  const filename = string(v.filename, "filename");
  if (
    [...filename].length > 255 ||
    /[\u0000-\u001f\u007f/\\]/u.test(filename) ||
    !/\.(md|txt)$/i.test(filename)
  )
    throw new Error("Invalid filename");
  const size = integer(v.size, "size", 1);
  if (size > 1024 * 1024) throw new Error("Document too large");
  const ref = artifact(v.ref, "document.ref");
  if (ref.id !== `jira-${role}`)
    throw new Error("Document artifact role mismatch");
  return { role, filename, size, ref };
}
function prompt(value: unknown): PromptSelection {
  const v = object(value, "prompt");
  const ref = artifact(v.ref, "prompt.ref");
  if (ref.id !== "jira-prompt") throw new Error("Invalid prompt artifact");
  return {
    ref,
    revision: integer(v.revision, "prompt.revision", 1),
    sourceDigest: digest(v.sourceDigest, "prompt.sourceDigest"),
    nonblank: bool(v.nonblank, "prompt.nonblank"),
  };
}
export function parseOnaReceipt(value: unknown): OnaReceipt {
  const v = object(value, "receipt");
  return {
    requestId: string(v.requestId, "receipt.requestId"),
    receiptId: string(v.receiptId, "receipt.receiptId"),
    acceptedAt: timestamp(v.acceptedAt, "receipt.acceptedAt"),
    simulated: bool(v.simulated, "receipt.simulated"),
  };
}
function attempt(value: unknown): HandoffAttempt {
  const v = object(value, "attempt");
  const requestId = string(v.requestId, "attempt.requestId");
  const status = choice(v.status, "attempt.status", [
    "sending",
    "unconfirmed",
    "not-accepted",
    "accepted",
  ] as const);
  const receipt = v.receipt === null ? null : parseOnaReceipt(v.receipt);
  if (
    (status === "accepted") !== (receipt !== null) ||
    (receipt && receipt.requestId !== requestId)
  )
    throw new Error("Receipt binding mismatch");
  const packageRef = artifact(v.packageRef, "packageRef");
  if (packageRef.id !== "jira-package")
    throw new Error("Invalid package artifact");
  return {
    requestId,
    packageRef,
    payloadDigest: digest(v.payloadDigest, "payloadDigest"),
    dispatch: integer(v.dispatch, "dispatch", 1),
    status,
    receipt,
    reason: nullable(v.reason, "attempt.reason", string),
  };
}
export function parseJiraPreparation(value: unknown): JiraPreparation {
  const v = object(value, "preparation");
  if (v.mode !== "jira-ona") throw new Error("Unknown preparation mode");
  const docs = object(v.documents, "documents");
  const attempts = array(v.attempts, "attempts", attempt);
  unique(
    attempts.map((a) => a.requestId),
    "attempt IDs",
  );
  if (attempts.slice(0, -1).some((a) => a.status !== "not-accepted"))
    throw new Error("Unresolved earlier handoff");
  return {
    mode: "jira-ona",
    source: parseJiraSnapshot(v.source),
    sourceDigest: digest(v.sourceDigest, "sourceDigest"),
    matchesQuery: bool(v.matchesQuery, "matchesQuery"),
    phase: choice(v.phase, "phase", [
      "inbox",
      "preparing",
      "ready",
      "sent",
    ] as const),
    documents: {
      design:
        docs.design === null ? null : parseDocument(docs.design, "design"),
      implementation:
        docs.implementation === null
          ? null
          : parseDocument(docs.implementation, "implementation"),
    },
    prompt: v.prompt === null ? null : prompt(v.prompt),
    target: parseTarget(v.target),
    attempts,
  };
}
export function validatePreparationTask(task: Task): void {
  const p = task.preparation!;
  if (
    task.currentStepId !== "jira-preparation" ||
    task.workflow ||
    task.proposedWorkflow ||
    task.intent ||
    task.runs.length ||
    task.reviews.length ||
    task.approvalBindings.length ||
    task.completedStepIds.length ||
    task.staleStepIds.length ||
    task.queuedAt ||
    ["queued", "triaging", "rejected"].includes(task.status)
  )
    throw new Error("Preparation cannot execute a generic workflow");
  const refs: ArtifactRef[] = [
    p.documents.design?.ref,
    p.documents.implementation?.ref,
    p.prompt?.ref,
    ...p.attempts.map((a) => a.packageRef),
  ].filter((v): v is ArtifactRef => !!v);
  for (const ref of refs)
    if (
      !task.artifacts.some(
        (a) =>
          a.id === ref.id &&
          a.version === ref.version &&
          a.digest === ref.digest &&
          a.path === ref.path,
      )
    )
      throw new Error("Preparation artifact is not published");
  const latest = p.attempts.at(-1);
  const expected =
    latest?.status === "accepted"
      ? "done"
      : latest?.status === "sending"
        ? "running"
        : latest?.status === "unconfirmed" || latest?.status === "not-accepted"
          ? "blocked"
          : "waiting-for-human";
  if (task.status !== "cancelled" && task.status !== expected)
    throw new Error("Preparation status mismatch");
  if ((p.phase === "sent") !== (task.status === "done"))
    throw new Error("Preparation phase mismatch");
  if (p.phase === "ready" && !preparationReady(p))
    throw new Error("Preparation is not ready");
  if (task.status === "cancelled" && latest && latest.status !== "not-accepted")
    throw new Error("Cannot cancel pending handoff");
}
export function parsePreparationCommand(value: unknown): PreparationCommand {
  const v = object(value, "command");
  const a = object(v.action, "action");
  const kind = choice(a.kind, "action.kind", [
    "prepare",
    "save",
    "remove-document",
    "send",
    "retry",
    "reconcile",
    "cancel",
  ] as const);
  let action: PreparationAction;
  if (kind === "save")
    action = {
      kind,
      promptText: string(a.promptText, "promptText", false),
      target: parseTarget(a.target),
    };
  else if (kind === "remove-document")
    action = {
      kind,
      role: choice(a.role, "role", ["design", "implementation"] as const),
    };
  else if (kind === "retry" || kind === "reconcile")
    action = {
      kind,
      handoffRequestId: string(a.handoffRequestId, "handoffRequestId"),
    };
  else action = { kind };
  return {
    requestId: name(v.requestId, "requestId"),
    taskId: fsId(v.taskId, "taskId"),
    expectedRevision: integer(v.expectedRevision, "expectedRevision", 1),
    action,
  };
}
export function parseUploadCommand(value: unknown): UploadCommand {
  const v = object(value, "upload");
  return {
    requestId: name(v.requestId, "requestId"),
    taskId: fsId(v.taskId, "taskId"),
    expectedRevision: integer(v.expectedRevision, "expectedRevision", 1),
    role: choice(v.role, "role", ["design", "implementation"] as const),
    filename: string(v.filename, "filename"),
  };
}
export function parseFrozenPackage(value: unknown): FrozenPackage {
  const v = object(value, "package"),
    docs = object(v.documents, "documents");
  const target = parseTarget(v.target);
  if (!target) throw new Error("Missing target");
  return {
    taskId: fsId(v.taskId, "taskId"),
    requestId: string(v.requestId, "requestId"),
    createdAt: timestamp(v.createdAt, "createdAt"),
    jira: parseJiraSnapshot(v.jira),
    prompt: prompt(v.prompt),
    documents: {
      design: parseDocument(docs.design, "design"),
      implementation: parseDocument(docs.implementation, "implementation"),
    },
    target,
  };
}
