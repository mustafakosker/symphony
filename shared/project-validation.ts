import type {
  BriefCopy,
  Citation,
  ProjectContext,
  SnapshotRef,
  SourceReport,
} from "./projects.js";
export function exactObject(
  value: unknown,
  keys: string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    throw new Error("Unexpected or missing context fields");
  return v;
}
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const safe = (v: unknown): v is string =>
  str(v) && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v);
const hex = (v: unknown, n: number): v is string =>
  str(v) && new RegExp(`^[a-f0-9]{${n}}$`).test(v);
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
export function parseSnapshotRef(value: unknown): SnapshotRef {
  const v = exactObject(value, [
    "projectId",
    "repositoryId",
    "commit",
    "objectFormat",
    "manifestDigest",
    "snapshotId",
  ]);
  if (
    !safe(v.projectId) ||
    !safe(v.repositoryId) ||
    !["sha1", "sha256"].includes(String(v.objectFormat)) ||
    !hex(v.commit, v.objectFormat === "sha1" ? 40 : 64) ||
    !hex(v.manifestDigest, 64) ||
    !hex(v.snapshotId, 64)
  )
    throw new Error("Invalid snapshot identity");
  return structuredClone(value) as SnapshotRef;
}
export function parseCitation(value: unknown): Citation {
  const v = exactObject(value, [
    "id",
    "repositoryId",
    "commit",
    "path",
    "objectId",
    "contentDigest",
    "startLine",
    "endLine",
  ]);
  if (
    !safe(v.id) ||
    !safe(v.repositoryId) ||
    !str(v.path) ||
    v.path.startsWith("/") ||
    v.path.includes("\\") ||
    v.path.split("/").some((p) => !p || p === "." || p === "..") ||
    !(hex(v.commit, 40) || hex(v.commit, 64)) ||
    !hex(v.objectId, String(v.commit).length) ||
    !hex(v.contentDigest, 64) ||
    !integer(v.startLine) ||
    !integer(v.endLine) ||
    Number(v.startLine) > Number(v.endLine) ||
    Number(v.endLine) - Number(v.startLine) >= 1000
  )
    throw new Error("Invalid source citation path, identity or lines");
  return structuredClone(value) as Citation;
}
export function parseReport(
  value: unknown,
  maxBytes = 1024 * 1024,
): SourceReport {
  const v = exactObject(value, ["format", "text", "citations"]);
  if (
    v.format !== "source-report-v1" ||
    !str(v.text) ||
    !v.text.trim() ||
    new TextEncoder().encode(v.text).length > maxBytes ||
    !Array.isArray(v.citations) ||
    v.citations.length > 256
  )
    throw new Error("Invalid source report or report limits exceeded");
  const citations = v.citations.map(parseCitation);
  if (new Set(citations.map((c) => c.id)).size !== citations.length)
    throw new Error("Duplicate citation ID");
  return { format: "source-report-v1", text: v.text, citations };
}
export function parseBriefCopy(value: unknown): BriefCopy {
  const v = exactObject(value, [
    "version",
    "digest",
    "author",
    "source",
    "report",
    "createdAt",
  ]);
  if (
    !integer(v.version) ||
    !hex(v.digest, 64) ||
    !["generated", "human", "human-edited"].includes(String(v.author)) ||
    !str(v.createdAt) ||
    !Number.isFinite(Date.parse(v.createdAt))
  )
    throw new Error("Invalid brief metadata");
  return {
    version: Number(v.version),
    digest: v.digest,
    author: v.author as BriefCopy["author"],
    source: parseSnapshotRef(v.source),
    report: parseReport(v.report, 128 * 1024),
    createdAt: v.createdAt,
  };
}
export function parseProjectContext(
  value: unknown,
  purpose: "task" | "project-brief",
): ProjectContext {
  const v = exactObject(value, [
    "version",
    "generation",
    "resolutionRevision",
    "targetId",
    "referenceIds",
    "projects",
  ]);
  if (
    v.version !== 1 ||
    !safe(v.generation) ||
    !hex(v.resolutionRevision, 64) ||
    (v.targetId !== null && !safe(v.targetId)) ||
    !Array.isArray(v.referenceIds) ||
    v.referenceIds.some((id) => !safe(id)) ||
    !Array.isArray(v.projects) ||
    !v.projects.length
  )
    throw new Error("Invalid project context");
  const projects = v.projects.map((value) => {
    const p = exactObject(value, [
      "projectId",
      "repositoryId",
      "name",
      "ref",
      "snapshot",
      "brief",
    ]);
    if (
      !safe(p.projectId) ||
      !safe(p.repositoryId) ||
      !str(p.name) ||
      !str(p.ref)
    )
      throw new Error("Invalid bound project");
    const snapshot = parseSnapshotRef(p.snapshot),
      brief = p.brief === null ? null : parseBriefCopy(p.brief);
    if (
      snapshot.projectId !== p.projectId ||
      snapshot.repositoryId !== p.repositoryId ||
      (brief &&
        (brief.source.projectId !== p.projectId ||
          brief.source.repositoryId !== p.repositoryId))
    )
      throw new Error("Project and snapshot identities differ");
    if (purpose === "task" && !brief)
      throw new Error("Task project has no saved brief");
    return {
      projectId: p.projectId,
      repositoryId: p.repositoryId,
      name: p.name,
      ref: p.ref,
      snapshot,
      brief,
    };
  });
  const ids = projects.map((p) => p.projectId),
    selected = [
      ...(v.targetId === null ? [] : [v.targetId as string]),
      ...(v.referenceIds as string[]),
    ];
  if (
    new Set(ids).size !== ids.length ||
    new Set(projects.map((p) => p.repositoryId)).size !== projects.length ||
    new Set(selected).size !== selected.length ||
    selected.length !== ids.length ||
    selected.some((id) => !ids.includes(id))
  )
    throw new Error("Duplicate or unbound project selection");
  if (
    purpose === "project-brief" &&
    (v.targetId !== null || projects.length !== 1)
  )
    throw new Error("A brief job has exactly one reference project");
  return {
    version: 1,
    generation: v.generation,
    resolutionRevision: v.resolutionRevision,
    targetId: v.targetId as string | null,
    referenceIds: v.referenceIds as string[],
    projects,
  };
}
