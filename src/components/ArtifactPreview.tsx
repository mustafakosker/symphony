import ReportArtifact from "./ReportArtifact";
import type { ProjectApi } from "../projects/api";
import { useEffect, useState } from "react";
import type { ArtifactRef } from "../../shared/contracts";
import { Button } from "./ui/button";

export function ArtifactPreview({
  taskId,
  artifact,
  reportApi,
}: {
  taskId: string;
  artifact: ArtifactRef;
  reportApi?: ProjectApi;
}) {
  if (reportApi)
    return (
      <ReportArtifact
        key={`${taskId}:${artifact.id}:${artifact.version}`}
        taskId={taskId}
        artifact={artifact}
        api={reportApi}
      />
    );
  return (
    <ArtifactPreviewContent
      key={`${taskId}:${artifact.id}:${artifact.version}`}
      taskId={taskId}
      artifact={artifact}
    />
  );
}

function ArtifactPreviewContent({
  taskId,
  artifact,
}: {
  taskId: string;
  artifact: ArtifactRef;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifact.id)}?version=${artifact.version}`;
  useEffect(() => {
    if (!open || text !== null) return;
    setError(null);
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(`Artifact unavailable (${response.status})`);
        if (!response.headers.get("Content-Type")?.startsWith("text/plain"))
          throw new Error("Download this artifact to inspect it.");
        if (!response.body)
          throw new Error("Download this artifact to inspect it.");
        const reader = response.body.getReader();
        const limit = 256 * 1024;
        const chunks: Uint8Array[] = [];
        let length = 0;
        let truncated = false;
        try {
          while (length <= limit) {
            const next = await reader.read();
            if (next.done) break;
            const take = Math.min(next.value.length, limit + 1 - length);
            chunks.push(next.value.subarray(0, take));
            length += take;
            if (length > limit) {
              truncated = true;
              break;
            }
          }
        } finally {
          if (truncated || controller.signal.aborted)
            await reader.cancel().catch(() => {});
          else reader.releaseLock();
        }
        const bytes = new Uint8Array(Math.min(length, limit));
        let offset = 0;
        for (const chunk of chunks) {
          const count = Math.min(chunk.length, bytes.length - offset);
          bytes.set(chunk.subarray(0, count), offset);
          offset += count;
        }
        let preview: string;
        try {
          preview = new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
            stream: truncated,
          });
        } catch {
          throw new Error(
            "Download this artifact to inspect it. Preview is not valid UTF-8 text.",
          );
        }
        if (!controller.signal.aborted)
          setText(
            preview +
              (truncated
                ? "\n\nPreview truncated; download the artifact for the full content."
                : ""),
          );
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : "Artifact unavailable",
          );
      }
    })();
    return () => controller.abort();
  }, [open, text, url]);
  return (
    <li className="artifact-item">
      <a href={url} download>
        {artifact.id} · v{artifact.version}
      </a>
      <details className="artifact-digest">
        <summary aria-label={`Digest for ${artifact.id} v${artifact.version}`}>
          Digest
        </summary>
        <code>{artifact.digest}</code>
      </details>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        View {artifact.id} v{artifact.version}
      </Button>
      {open && (
        <>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {!error && (
            <pre className="artifact-preview">
              {text ?? "Loading artifact…"}
            </pre>
          )}
        </>
      )}
    </li>
  );
}
