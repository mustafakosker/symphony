import { useEffect, useRef, useState } from "react";
import type {
  CatalogSnapshot,
  DraftText,
  ProjectDraft,
  ProjectSelection as Selection,
  ResolutionChoices,
  ResolutionPreview,
} from "../../shared/projects";
import type { ProjectApi, ProjectDetail } from "../projects/api";
import { Button } from "./ui/button";
export default function ProjectSelection({
  api,
  text,
  onChange,
  onOpenSettings,
}: {
  api: ProjectApi;
  text: DraftText;
  onChange(value: ProjectDraft | null): void;
  onOpenSettings(): void;
}) {
  const [choices, setChoices] = useState<ResolutionChoices>({
      excludedReferenceIds: [],
      ambiguities: {},
    }),
    [preview, setPreview] = useState<ResolutionPreview | null>(null),
    [catalog, setCatalog] = useState<CatalogSnapshot | null>(null),
    [details, setDetails] = useState<ProjectDetail[]>([]),
    [selections, setSelections] = useState<Selection[]>([]),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0);
  const sequence = useRef(0),
    notify = useRef(onChange);
  notify.current = onChange;
  useEffect(() => {
    setChoices({ excludedReferenceIds: [], ambiguities: {} });
  }, [text.title, text.description]);
  useEffect(() => {
    const current = ++sequence.current,
      c = new AbortController();
    setPreview(null);
    setDetails([]);
    setError("");
    notify.current(null);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const [p, cat] = await Promise.all([
            api.resolve(text, choices, c.signal),
            api.catalog(c.signal),
          ]);
          const ids = [...(p.targetId ? [p.targetId] : []), ...p.referenceIds],
            d = await Promise.all(ids.map((id) => api.detail(id, c.signal)));
          if (c.signal.aborted || sequence.current !== current) return;
          setPreview(p);
          setCatalog(cat);
          setDetails(d);
          setSelections(
            d.map(({ project: p, briefs }) => ({
              projectId: p.id,
              ref: p.defaultRef ?? "",
              briefVersion: briefs.at(-1)?.version ?? 0,
            })),
          );
        } catch (e) {
          if (!c.signal.aborted && sequence.current === current)
            setError(e instanceof Error ? e.message : String(e));
        }
      })();
    }, 250);
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [api, text.title, text.description, choices, reload]);
  const ready =
    !!preview &&
    !preview.problems.length &&
    details.every(
      (d) =>
        d.project.readiness === "ready" &&
        selections.some(
          (s) =>
            s.projectId === d.project.id &&
            d.project.branches.includes(s.ref) &&
            d.briefs.some((b) => b.version === s.briefVersion),
        ),
    );
  useEffect(() => {
    notify.current(
      ready && preview
        ? {
            text,
            choices,
            previewRevision: preview.revision,
            catalogRevision: preview.catalogRevision,
            selections,
          }
        : null,
    );
  }, [ready, preview, text.title, text.description, choices, selections]);
  const name = (id: string) =>
    catalog?.projects.find((p) => p.id === id)?.name ?? id;
  const row = (id: string) => {
    const d = details.find((d) => d.project.id === id),
      selection = selections.find((s) => s.projectId === id);
    return (
      <div key={id} className="project-selection-row">
        <strong>{name(id)}</strong>
        {d && selection && (
          <>
            <label>
              Branch for {name(id)}
              <select
                value={selection.ref}
                onChange={(e) =>
                  setSelections((v) =>
                    v.map((s) =>
                      s.projectId === id ? { ...s, ref: e.target.value } : s,
                    ),
                  )
                }
              >
                <option value="">Select branch</option>
                {d.project.branches.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </label>
            <label>
              Brief for {name(id)}
              <select
                value={selection.briefVersion}
                onChange={(e) =>
                  setSelections((v) =>
                    v.map((s) =>
                      s.projectId === id
                        ? { ...s, briefVersion: Number(e.target.value) }
                        : s,
                    ),
                  )
                }
              >
                <option value={0}>Select saved brief</option>
                {d.briefs.map((b) => (
                  <option key={b.version} value={b.version}>
                    Version {b.version}
                  </option>
                ))}
              </select>
            </label>
            {d.project.readiness !== "ready" && (
              <span>
                {d.project.readiness.replace("-", " ")} — prepare in Projects
              </span>
            )}
          </>
        )}
        {preview?.referenceIds.includes(id) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Remove ${name(id)} reference`}
            onClick={() =>
              setChoices({
                ...choices,
                excludedReferenceIds: [...choices.excludedReferenceIds, id],
              })
            }
          >
            Remove
          </Button>
        )}
      </div>
    );
  };
  return (
    <section className="project-selection" aria-label="Project matching">
      <div className="project-heading">
        <strong>Connected projects</strong>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={onOpenSettings}
        >
          Projects & settings
        </Button>
      </div>
      {!preview && !error && <p role="status">Matching projects…</p>}
      {error && <p role="alert">{error}</p>}
      {preview && (
        <>
          <div aria-label="Future change target">
            <span className="project-muted">Future change target</span>
            {preview.targetId ? (
              row(preview.targetId)
            ) : (
              <p>No target. Use [project-name] at the start of the title.</p>
            )}
          </div>
          <div aria-label="Reference projects">
            <span className="project-muted">Reference projects</span>
            {preview.referenceIds.length ? (
              preview.referenceIds.map(row)
            ) : (
              <p>No reference projects matched.</p>
            )}
          </div>
          {preview.problems.map((p, i) => (
            <div key={i} role="alert">
              {p.message}
              {p.code === "ambiguous-name" && p.matchKey && (
                <select
                  aria-label={`Resolve ${p.matchKey}`}
                  value={choices.ambiguities[p.matchKey] ?? ""}
                  onChange={(e) =>
                    setChoices({
                      ...choices,
                      ambiguities: {
                        ...choices.ambiguities,
                        [p.matchKey!]: e.target.value,
                      },
                    })
                  }
                >
                  <option value="">Choose project</option>
                  {preview.matches
                    .find((m) => m.key === p.matchKey)
                    ?.projectIds.map((id) => (
                      <option value={id} key={id}>
                        {name(id)}
                      </option>
                    ))}
                </select>
              )}
            </div>
          ))}
          {!!preview.matches.length && (
            <details>
              <summary>Why these projects?</summary>
              {preview.matches.map((m) => (
                <p key={m.key}>
                  “{m.text}” in {m.field} → {m.projectIds.map(name).join(" / ")}
                </p>
              ))}
            </details>
          )}
          {!!choices.excludedReferenceIds.length && (
            <Button
              variant="ghost"
              type="button"
              size="sm"
              onClick={() =>
                setChoices({ ...choices, excludedReferenceIds: [] })
              }
            >
              Restore removed references
            </Button>
          )}
          {!ready && !preview.problems.length && (
            <p role="status">
              Prepare every matched project and select a branch and saved brief.
            </p>
          )}
        </>
      )}
      <Button
        variant="ghost"
        size="sm"
        type="button"
        onClick={() => setReload((n) => n + 1)}
      >
        Refresh matches
      </Button>
      <p className="project-muted">
        Investigation only. Source copies stay read-only.
      </p>
    </section>
  );
}
