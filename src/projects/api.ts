import type {
  BriefCopy,
  CatalogSnapshot,
  DraftText,
  OperationStatus,
  ProjectDraft,
  ProjectEdit,
  ProjectRecord,
  ResolutionChoices,
  ResolutionPreview,
  RootSetting,
  SnapshotRef,
  SourcePreview,
  SourceReport,
} from "../../shared/projects";
import { ApiError } from "../tasks/api";
export type ProjectDetail = { project: ProjectRecord; briefs: BriefCopy[] };
export type ProjectOperation = OperationStatus & {
  projectId?: string;
  candidate?: SourceReport | null;
  source?: SnapshotRef;
  snapshot?: SnapshotRef;
};
export type ProjectSubmission = {
  operation?: OperationStatus;
  submissionId: string;
  revision: number;
  filename: string;
  markdown: string;
  message: string;
  preview: ResolutionPreview;
  draft: ProjectDraft | null;
  operationId: string | null;
  ready: boolean;
};
export type ProjectApi = {
  retryOperation(id: string, requestId: string): Promise<OperationStatus>;
  settings(signal?: AbortSignal): Promise<RootSetting>;
  saveSettings(input: {
    projectsRoot: string | null;
    expectedRevision: string;
    requestId: string;
  }): Promise<RootSetting>;
  catalog(signal?: AbortSignal): Promise<CatalogSnapshot>;
  rescan(requestId: string): Promise<OperationStatus>;
  resolve(
    text: DraftText,
    choices: ResolutionChoices,
    signal?: AbortSignal,
  ): Promise<ResolutionPreview>;
  detail(id: string, signal?: AbortSignal): Promise<ProjectDetail>;
  edit(input: ProjectEdit): Promise<ProjectRecord>;
  prepare(id: string, ref: string, requestId: string): Promise<OperationStatus>;
  verify(id: string, requestId: string): Promise<OperationStatus>;
  brief(id: string, version: number, signal?: AbortSignal): Promise<BriefCopy>;
  saveBrief(input: {
    projectId: string;
    expectedVersion: number | null;
    requestId: string;
    author: BriefCopy["author"];
    source: SnapshotRef;
    report: SourceReport;
  }): Promise<BriefCopy>;
  generateBrief(
    id: string,
    ref: string,
    requestId: string,
  ): Promise<OperationStatus>;
  operation(id: string, signal?: AbortSignal): Promise<ProjectOperation>;
  operations(signal?: AbortSignal): Promise<ProjectOperation[]>;
  submissions(signal?: AbortSignal): Promise<ProjectSubmission[]>;
  submission(id: string, signal?: AbortSignal): Promise<ProjectSubmission>;
  resolveSubmission(
    id: string,
    revision: number,
    input: ProjectDraft,
    requestId: string,
  ): Promise<OperationStatus>;
  report(
    taskId: string,
    id: string,
    version: number,
    signal?: AbortSignal,
  ): Promise<SourceReport>;
  citation(
    taskId: string,
    id: string,
    version: number,
    citation: string,
    signal?: AbortSignal,
  ): Promise<SourcePreview>;
  briefCitation(
    id: string,
    version: number,
    citation: string,
    signal?: AbortSignal,
  ): Promise<SourcePreview>;
};
const e = encodeURIComponent;
async function request<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    `/api/${path}`,
    body === undefined
      ? { signal, cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(
      value.error ?? "Project service unavailable",
      response.status,
      value.operationId,
    );
  return value;
}
export const projectApi: ProjectApi = {
  retryOperation: (id, requestId) =>
    request(`project-operations/${e(id)}/retry`, { requestId }),
  settings: (s) => request("settings/projects", undefined, s),
  saveSettings: (v) => request("settings/projects", v),
  catalog: (s) => request("projects", undefined, s),
  rescan: (requestId) => request("projects/rescan", { requestId }),
  resolve: (text, choices, s) =>
    request("projects/resolve", { text, choices }, s),
  detail: (id, s) => request(`projects/${e(id)}`, undefined, s),
  edit: ({ projectId, ...body }) => request(`projects/${e(projectId)}`, body),
  prepare: (id, ref, requestId) =>
    request(`projects/${e(id)}/prepare`, { ref, requestId }),
  verify: (id, requestId) => request(`projects/${e(id)}/verify`, { requestId }),
  brief: (id, v, s) => request(`projects/${e(id)}/briefs/${v}`, undefined, s),
  saveBrief: ({ projectId, ...body }) =>
    request(`projects/${e(projectId)}/briefs`, body),
  generateBrief: (id, ref, requestId) =>
    request(`projects/${e(id)}/briefs/generate`, { ref, requestId }),
  operation: (id, s) => request(`project-operations/${e(id)}`, undefined, s),
  operations: (s) => request("project-operations", undefined, s),
  submissions: (s) => request("project-submissions", undefined, s),
  submission: (id, s) => request(`project-submissions/${e(id)}`, undefined, s),
  resolveSubmission: (id, expectedRevision, projectDraft, requestId) =>
    request(`project-submissions/${e(id)}/resolve`, {
      expectedRevision,
      projectDraft,
      requestId,
    }),
  report: (task, id, v, s) =>
    request(
      `tasks/${e(task)}/artifacts/${e(id)}/report?version=${v}`,
      undefined,
      s,
    ),
  citation: (task, id, v, c, s) =>
    request(
      `tasks/${e(task)}/artifacts/${e(id)}/citations/${e(c)}?version=${v}`,
      undefined,
      s,
    ),
  briefCitation: (id, v, c, s) =>
    request(`projects/${e(id)}/briefs/${v}/citations/${e(c)}`, undefined, s),
};
