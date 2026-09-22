import type {
  CatalogView,
  DraftText,
  NameMatch,
  ResolutionChoices,
  ResolutionResult,
} from "./projects.js";
export const normalizeProjectName = (value: string): string =>
  value.trim().normalize("NFC").toLocaleLowerCase("en");
export const isNameCharacter = (value: string): boolean =>
  /[\p{L}\p{M}\p{N}_-]/u.test(value);
const emptyChoices = (): ResolutionChoices => ({
  excludedReferenceIds: [],
  ambiguities: {},
});
function mappedText(value: string) {
  let text = "";
  const boundaries = new Map<number, number>([[0, 0]]);
  for (const item of new Intl.Segmenter("en", {
    granularity: "grapheme",
  }).segment(value)) {
    boundaries.set(text.length, item.index);
    text += item.segment.normalize("NFC").toLocaleLowerCase("en");
    boundaries.set(text.length, item.index + item.segment.length);
  }
  return { text, boundaries };
}
export function deriveDraftText(markdown: string, filename: string): DraftText {
  const lines = markdown.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim().length > 0);
  const heading = first < 0 ? null : /^#\s+(.+?)\s*$/.exec(lines[first]);
  return heading
    ? { title: heading[1], description: lines.slice(first + 1).join("\n") }
    : { title: filename.replace(/\.md$/, ""), description: markdown };
}
export function resolutionPayload(
  draft: DraftText,
  catalog: CatalogView,
  choices: ResolutionChoices,
): string {
  return JSON.stringify([
    draft.title,
    draft.description,
    catalog.generation,
    catalog.revision,
    [...choices.excludedReferenceIds].sort(),
    Object.entries(choices.ambiguities).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}
export function resolveProjects(
  draft: DraftText,
  catalog: CatalogView,
  choices = emptyChoices(),
): ResolutionResult {
  const result: ResolutionResult = {
    generation: catalog.generation,
    catalogRevision: catalog.revision,
    targetId: null,
    referenceIds: [],
    matches: [],
    problems: [],
  };
  const problem = (
    code: ResolutionResult["problems"][number]["code"],
    message: string,
    matchKey: string | null = null,
  ) => result.problems.push({ code, message, matchKey });
  if (catalog.state === "unavailable") {
    problem("root-unavailable", "Projects root is unavailable");
    return result;
  }
  const names = new Map<string, Set<string>>();
  for (const project of catalog.projects)
    for (const name of [project.name, ...project.aliases]) {
      const key = normalizeProjectName(name);
      if (!key) continue;
      if (!names.has(key)) names.set(key, new Set());
      names.get(key)!.add(project.id);
    }
  const excluded = new Set(choices.excludedReferenceIds);
  const usedChoices = new Set<string>();
  const potentialReferences = new Set<string>();
  function select(match: NameMatch): string | null {
    const choice = Object.hasOwn(choices.ambiguities, match.key)
      ? choices.ambiguities[match.key]
      : undefined;
    if (choice !== undefined) {
      usedChoices.add(match.key);
      if (match.projectIds.length < 2 || !match.projectIds.includes(choice)) {
        problem(
          "invalid-choice",
          "Project choice no longer matches this mention",
          match.key,
        );
        return null;
      }
      return choice;
    }
    if (match.projectIds.length === 1) return match.projectIds[0];
    if (
      match.role === "reference" &&
      match.projectIds.every((id) => excluded.has(id))
    )
      return null;
    problem(
      "ambiguous-name",
      `Choose the project meant by “${match.text}”`,
      match.key,
    );
    return null;
  }
  const leading = draft.title.length - draft.title.trimStart().length;
  let titleOffset = 0;
  if (draft.title.slice(leading).startsWith("[")) {
    const prefix = /^\[([^\[\]]+)\]/.exec(draft.title.slice(leading));
    if (!prefix || !prefix[1].trim())
      problem("invalid-prefix", "Use one leading [project-name]");
    else {
      titleOffset = leading + prefix[0].length;
      if (draft.title.slice(titleOffset).trimStart().startsWith("["))
        problem("invalid-prefix", "Only one future change target is allowed");
      const ids = [
        ...(names.get(normalizeProjectName(prefix[1])) ?? []),
      ].sort();
      const match: NameMatch = {
        key: `title:${leading}:${titleOffset}`,
        field: "title",
        start: leading,
        end: titleOffset,
        text: prefix[0],
        projectIds: ids,
        role: "target",
      };
      result.matches.push(match);
      if (!ids.length)
        problem(
          "unknown-target",
          `Project “${prefix[1].trim()}” was not found under the projects root`,
          match.key,
        );
      else result.targetId = select(match);
    }
  }
  for (const field of ["title", "description"] as const) {
    const offset = field === "title" ? titleOffset : 0;
    const mapped = mappedText(draft[field].slice(offset));
    const candidates: NameMatch[] = [];
    for (const [name, ids] of names) {
      let at = mapped.text.indexOf(name);
      while (at !== -1) {
        const end = at + name.length;
        const startOriginal = mapped.boundaries.get(at),
          endOriginal = mapped.boundaries.get(end);
        const before =
          Array.from(mapped.text.slice(Math.max(0, at - 2), at)).at(-1) ?? "";
        const after = Array.from(mapped.text.slice(end, end + 2))[0] ?? "";
        if (
          startOriginal !== undefined &&
          endOriginal !== undefined &&
          !isNameCharacter(before) &&
          !isNameCharacter(after)
        ) {
          const start = offset + startOriginal,
            finish = offset + endOriginal;
          const existing = candidates.find(
            (candidate) =>
              candidate.start === start && candidate.end === finish,
          );
          if (existing)
            existing.projectIds = [
              ...new Set([...existing.projectIds, ...ids]),
            ].sort();
          else
            candidates.push({
              key: `${field}:${start}:${finish}`,
              field,
              start,
              end: finish,
              text: draft[field].slice(start, finish),
              projectIds: [...ids].sort(),
              role: "reference",
            });
        }
        at = mapped.text.indexOf(name, at + 1);
      }
    }
    const accepted: NameMatch[] = [];
    for (const match of candidates.sort(
      (a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start,
    )) {
      if (
        !accepted.some(
          (other) => match.start < other.end && other.start < match.end,
        )
      )
        accepted.push(match);
    }
    for (const match of accepted.sort((a, b) => a.start - b.start)) {
      result.matches.push(match);
      match.projectIds.forEach((id) => potentialReferences.add(id));
      const selected = select(match);
      if (
        selected &&
        selected !== result.targetId &&
        !excluded.has(selected) &&
        !result.referenceIds.includes(selected)
      )
        result.referenceIds.push(selected);
    }
  }
  for (const key of Object.keys(choices.ambiguities))
    if (!usedChoices.has(key))
      problem("invalid-choice", "An ambiguity choice is stale", key);
  for (const id of excluded)
    if (id === result.targetId || !potentialReferences.has(id))
      problem("invalid-choice", "An excluded reference no longer matches");
  return result;
}
