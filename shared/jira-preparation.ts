import type { ArtifactRef } from "./contracts.js";

export type DocumentRole = "design" | "implementation";
export type Target = {
  projectId: string;
  repositoryId: string;
  branch: string;
};
export type JiraSnapshot = {
  connectionId: string;
  issueId: string;
  key: string;
  url: string;
  projectKey: string;
  title: string;
  description: string;
  acceptanceCriteria: string | null;
  status: string;
  assignedToCurrentUser: boolean;
  open: boolean;
  updatedAt: string;
};
export type DocumentSelection = {
  role: DocumentRole;
  filename: string;
  size: number;
  ref: ArtifactRef;
};
export type PromptSelection = {
  ref: ArtifactRef;
  revision: number;
  sourceDigest: string;
  nonblank: boolean;
};
export type OnaReceipt = {
  requestId: string;
  receiptId: string;
  acceptedAt: string;
  simulated: boolean;
};
export type FrozenPackage = {
  taskId: string;
  requestId: string;
  createdAt: string;
  jira: JiraSnapshot;
  prompt: PromptSelection;
  documents: { design: DocumentSelection; implementation: DocumentSelection };
  target: Target;
};
export type HandoffAttempt = {
  requestId: string;
  packageRef: ArtifactRef;
  payloadDigest: string;
  dispatch: number;
  status: "sending" | "unconfirmed" | "not-accepted" | "accepted";
  receipt: OnaReceipt | null;
  reason: string | null;
};
export type JiraPreparation = {
  mode: "jira-ona";
  source: JiraSnapshot;
  sourceDigest: string;
  matchesQuery: boolean;
  phase: "inbox" | "preparing" | "ready" | "sent";
  documents: Record<DocumentRole, DocumentSelection | null>;
  prompt: PromptSelection | null;
  target: Target | null;
  attempts: HandoffAttempt[];
};
export type PreparationAction =
  | { kind: "prepare" }
  | { kind: "save"; promptText: string; target: Target | null }
  | { kind: "remove-document"; role: DocumentRole }
  | { kind: "send" }
  | { kind: "retry"; handoffRequestId: string }
  | { kind: "reconcile"; handoffRequestId: string }
  | { kind: "cancel" };
export type PreparationCommand = {
  requestId: string;
  taskId: string;
  expectedRevision: number;
  action: PreparationAction;
};
export type UploadCommand = {
  requestId: string;
  taskId: string;
  expectedRevision: number;
  role: DocumentRole;
  filename: string;
};
export type PreparationChange =
  | {
      kind: "source";
      source: JiraSnapshot;
      digest: string;
      matchesQuery: boolean;
    }
  | { kind: "draft"; prompt: PromptSelection; target: Target | null }
  | { kind: "document"; role: DocumentRole; document: DocumentSelection | null }
  | { kind: "dispatch"; attempt: HandoffAttempt }
  | {
      kind: "settle";
      handoffRequestId: string;
      dispatch: number;
      outcome: "accepted" | "not-accepted" | "unconfirmed";
      receipt: OnaReceipt | null;
      reason: string | null;
    }
  | { kind: "cancel" };
export type PreparationEvent = {
  kind: "preparation";
  inputDigest: string;
  change: PreparationChange;
};
export type JiraSyncView = {
  enabled: boolean;
  simulated: true;
  syncing: boolean;
  lastSuccessAt: string | null;
  error: string | null;
};
export type TargetOption = {
  projectId: string;
  repositoryId: string;
  baseBranch: string;
};
export type PreparationDetail = {
  taskId: string;
  revision: number;
  promptText: string;
};

export function preparationReady(value: JiraPreparation): boolean {
  return Boolean(
    value.documents.design &&
    value.documents.implementation &&
    value.prompt?.nonblank &&
    value.target?.projectId &&
    value.target.repositoryId &&
    value.target.branch.trim(),
  );
}
