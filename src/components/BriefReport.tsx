import { useEffect, useRef, useState } from "react";
import type { BriefCopy, SourcePreview as Source } from "../../shared/projects";
import type { ProjectApi } from "../projects/api";
import { SourceReportView } from "./SourceReport";
import SourcePreview from "./SourcePreview";
export default function BriefReport({
  brief,
  api,
}: {
  brief: BriefCopy;
  api: ProjectApi;
}) {
  const [source, setSource] = useState<Source | null>(null),
    [error, setError] = useState(""),
    request = useRef<AbortController | null>(null);
  useEffect(
    () => () => request.current?.abort(),
    [brief.version, brief.source.projectId],
  );
  return (
    <>
      <SourceReportView
        report={brief.report}
        onCitation={(id) => {
          request.current?.abort();
          const c = new AbortController();
          request.current = c;
          setError("");
          api
            .briefCitation(brief.source.projectId, brief.version, id, c.signal)
            .then((v) => {
              if (!c.signal.aborted) setSource(v);
            })
            .catch((e) => {
              if (!c.signal.aborted) setError(String(e));
            });
        }}
      />
      {error && <p role="alert">Source unavailable: {error}</p>}
      <SourcePreview source={source} onClose={() => setSource(null)} />
    </>
  );
}
