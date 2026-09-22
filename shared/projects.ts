export type DraftText = { title: string; description: string };
export type ProjectName = { id: string; name: string; aliases: string[] };
export type CatalogView = {
  generation: string; revision: string;
  state: 'unset' | 'ready' | 'unavailable';
  projects: ProjectName[];
};
export type ResolutionChoices = {
  excludedReferenceIds: string[];
  ambiguities: Record<string, string>;
};
export type NameMatch = {
  key: string; field: 'title' | 'description'; start: number; end: number;
  text: string; projectIds: string[]; role: 'target' | 'reference';
};
export type ResolutionProblem = {
  code: 'root-unavailable' | 'unknown-target' | 'invalid-prefix' |
    'ambiguous-name' | 'invalid-choice';
  message: string; matchKey: string | null;
};
export type ResolutionResult = {
  catalogRevision: string; generation: string;
  targetId: string | null; referenceIds: string[];
  matches: NameMatch[]; problems: ResolutionProblem[];
};
export type ResolutionPreview = ResolutionResult & { revision: string };
export type SnapshotRef = {
  projectId: string; repositoryId: string; commit: string;
  objectFormat: 'sha1' | 'sha256'; manifestDigest: string; snapshotId: string;
};
export type Citation = {
  id: string; repositoryId: string; commit: string; path: string;
  objectId: string; contentDigest: string; startLine: number; endLine: number;
};
export type SourceReport = {
  format: 'source-report-v1'; text: string; citations: Citation[];
};
export type BriefCopy = {
  version: number; digest: string; author: 'generated' | 'human' | 'human-edited';
  source: SnapshotRef; report: SourceReport; createdAt: string;
};
export type BoundProject = {
  projectId: string; repositoryId: string; name: string; ref: string;
  snapshot: SnapshotRef; brief: BriefCopy | null;
};
export type ProjectContext = {
  version: 1; generation: string; resolutionRevision: string;
  targetId: string | null; referenceIds: string[]; projects: BoundProject[];
};
export type ProjectSelection = { projectId: string; ref: string; briefVersion: number };
export type ProjectDraft = {
  text: DraftText; previewRevision: string; catalogRevision: string;
  choices: ResolutionChoices; selections: ProjectSelection[];
};
export type ProjectReadiness = 'discovered' | 'needs-setup' | 'preparing' | 'ready' | 'failed';
export type OperationStatus = {
  id: string; revision: number; kind: 'scan' | 'prepare' | 'verify' | 'brief' | 'submission';
  state: 'queued' | 'running' | 'needs-input' | 'failed' | 'complete';
  message: string; taskId: string | null;
};
export type RootSetting = { projectsRoot: string | null; revision: string; generation: string;
  state: 'unset' | 'ready' | 'unavailable'; message: string | null };
