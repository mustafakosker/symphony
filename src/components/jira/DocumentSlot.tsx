import { useEffect, useState } from "react";
import type {
  DocumentRole,
  DocumentSelection,
} from "../../../shared/jira-preparation";
export const artifactUrl = (
  taskId: string,
  ref: { id: string; version: number },
) =>
  `/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(ref.id)}?version=${ref.version}`;
export default function DocumentSlot({
  role,
  selection,
  taskId,
  disabled,
  error,
  onUpload,
  onRemove,
  onDiscardError,
}: {
  role: DocumentRole;
  selection: DocumentSelection | null;
  taskId: string;
  disabled: boolean;
  error: string | null;
  onUpload: (file: File) => void;
  onRemove: () => void;
  onDiscardError: () => void;
}) {
  const [preview, setPreview] = useState(false),
    [text, setText] = useState<string | null>(null),
    [previewError, setPreviewError] = useState<string | null>(null);
  const url = selection ? artifactUrl(taskId, selection.ref) : null;
  useEffect(() => {
    setText(null);
    setPreviewError(null);
    if (!preview || !url) return;
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Preview unavailable");
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > 1024 * 1024)
          throw new Error("Preview exceeds 1 MiB");
        if (!controller.signal.aborted)
          setText(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              bytes,
            ),
          );
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setPreviewError(
            cause instanceof Error ? cause.message : "Preview unavailable",
          );
      });
    return () => controller.abort();
  }, [preview, url]);
  const label = role === "design" ? "Design document" : "Implementation plan";
  return (
    <section className="jira-document" aria-label={label + " attachment"}>
      <div className="jira-section-heading">
        <h4>{label}</h4>
        <span>
          {selection ? "Saved · v" + selection.ref.version : "Required"}
        </span>
      </div>
      {selection ? (
        <p className="jira-file-name">
          {selection.filename}{" "}
          <span>{selection.size.toLocaleString()} bytes</span>
        </p>
      ) : (
        <p>Attach a UTF-8 Markdown or text file, up to 1 MiB.</p>
      )}
      <label className="jira-upload-label">
        {selection ? "Replace file" : "Choose file"}
        <input
          type="file"
          aria-label={label}
          accept=".md,.txt"
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onUpload(file);
          }}
        />
      </label>
      {selection && (
        <div className="jira-inline-actions">
          <a href={url!} download={selection.filename}>
            Download v{selection.ref.version}
          </a>
          <button
            className="text-button"
            onClick={() => setPreview((v) => !v)}
            aria-expanded={preview}
          >
            {preview ? "Hide" : "Preview"} {role}
          </button>
          <button
            className="text-button"
            disabled={disabled}
            onClick={onRemove}
          >
            Remove {role}
          </button>
        </div>
      )}
      {error && (
        <div className="jira-error" role="alert">
          {error}
          <button
            className="text-button"
            disabled={disabled}
            onClick={onDiscardError}
          >
            Discard failed replacement
          </button>
        </div>
      )}
      {preview && (
        <div className="jira-preview">
          {previewError ? (
            <p role="alert">{previewError}</p>
          ) : text === null ? (
            <p>Loading preview…</p>
          ) : (
            <pre>{text}</pre>
          )}
        </div>
      )}
    </section>
  );
}
