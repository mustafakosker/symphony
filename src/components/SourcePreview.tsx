import { useEffect, useRef } from "react";
import type { SourcePreview as Source } from "../../shared/projects";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
export default function SourcePreview({
  source,
  onClose,
}: {
  source: Source | null;
  onClose(): void;
}) {
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (source)
      opener.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
  }, [source]);
  return (
    <Dialog
      open={source !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="source-dialog"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          opener.current?.focus();
        }}
      >
        <DialogTitle>{source?.path ?? "Cited source"}</DialogTitle>
        <DialogDescription>
          {source?.repositoryId} · {source?.commit} · lines {source?.startLine}–
          {source?.endLine}
        </DialogDescription>
        <pre aria-label="Cited source" className="source-preview">
          {source?.lines.map((line, i) => {
            const n = source.firstLine + i;
            return (
              <span
                key={n}
                data-highlighted={n >= source.startLine && n <= source.endLine}
              >
                <span aria-hidden="true" className="source-line-number">
                  {n}{" "}
                </span>
                {line}
                {"\n"}
              </span>
            );
          })}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
