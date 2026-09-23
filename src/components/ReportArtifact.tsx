import { useEffect, useRef, useState } from "react";
import type { ArtifactRef } from "../../shared/contracts";
import type {
  SourceReport,
  SourcePreview as Source,
} from "../../shared/projects";
import type { ProjectApi } from "../projects/api";
import { SourceReportView } from "./SourceReport";
import SourcePreview from "./SourcePreview";
import { Button } from "./ui/button";
export default function ReportArtifact({
  taskId,
  artifact,
  api,
}: {
  taskId: string;
  artifact: ArtifactRef;
  api: ProjectApi;
}) {
  const [open, setOpen] = useState(false),
    [report, setReport] = useState<SourceReport | null>(null),
    [error, setError] = useState(""),
    [source, setSource] = useState<Source | null>(null),
    request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!open) return;
    const c = new AbortController();
    api
      .report(taskId, artifact.id, artifact.version, c.signal)
      .then((v) => {
        if (!c.signal.aborted) setReport(v);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(String(e));
      });
    return () => c.abort();
  }, [open, taskId, artifact.id, artifact.version, api]);
  return (
    <li className="artifact-item">
      <a
        download
        href={`/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifact.id)}?version=${artifact.version}`}
      >
        {artifact.id} · v{artifact.version}
      </a>
      <details className="artifact-digest">
        <summary>Digest</summary>
        <code>{artifact.digest}</code>
      </details>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        View {artifact.id} v{artifact.version}
      </Button>
      {open && (
        <>
          {report ? (
            <SourceReportView
              report={report}
              onCitation={(id) => {
                request.current?.abort();
                const c = new AbortController();
                request.current = c;
                setError("");
                api
                  .citation(taskId, artifact.id, artifact.version, id, c.signal)
                  .then((v) => {
                    if (!c.signal.aborted) setSource(v);
                  })
                  .catch((e) => {
                    if (!c.signal.aborted) setError(String(e));
                  });
              }}
            />
          ) : (
            !error && <p>Loading report…</p>
          )}
          {error && <p role="alert">Source report unavailable: {error}</p>}
        </>
      )}
      <SourcePreview source={source} onClose={() => setSource(null)} />
    </li>
  );
}
