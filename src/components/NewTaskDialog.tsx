import { useEffect, useRef, useState } from "react";
import { ArrowRight, X } from "lucide-react";
type Props = {
  open: boolean;
  onClose: () => void;
  onSubmit: (markdown: string) => Promise<void>;
  canSubmit: boolean;
};
export default function NewTaskDialog({
  open,
  onClose,
  onSubmit,
  canSubmit,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [brief, setBrief] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setBrief("");
      setTitle("");
      setError("");
      ref.current?.showModal();
      ref.current?.querySelector("textarea")?.focus();
    } else {
      ref.current?.close();
      opener.current?.focus();
      opener.current = null;
    }
  }, [open]);
  const submit = async () => {
    if (!brief.trim()) {
      setError("Add a brief before submitting.");
      return;
    }
    const markdown = title.trim()
      ? `# ${title.trim()}\n\n${brief.trim()}`
      : brief.trim();
    setBusy(true);
    try {
      await onSubmit(markdown);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Submission failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={ref}
      className="task-dialog"
      aria-labelledby="new-task-title"
      onCancel={onClose}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key === "Tab") {
          const focusable = [...(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled])') ?? [])];
          const first = focusable[0], last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="dialog-heading">
          <span className="eyebrow">SOMETHING STARTS HERE</span>
          <button
            className="icon-button"
            type="button"
            aria-label="Close new task"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <h2 id="new-task-title">Submit a draft</h2>
        <p className="muted">
          The coordinator picks up your Markdown draft from OneDrive.
        </p>
        <label htmlFor="task-title">
          Title hint <span className="muted">· optional</span>
        </label>
        <input
          id="task-title"
          maxLength={250}
          placeholder="A short name for this idea"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <label htmlFor="task-brief">Brief</label>
        <textarea
          id="task-brief"
          rows={7}
          required
          placeholder="What should happen? What would a good outcome look like?"
          value={brief}
          onChange={(event) => {
            setBrief(event.target.value);
            setError("");
          }}
        />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-footer">
          <span>Your draft will enter OneDrive intake after submission.</span>
          <button
            className="button primary"
            type="submit"
            disabled={busy || !canSubmit}
          >
            Submit draft <ArrowRight size={15} />
          </button>
        </div>
      </form>
    </dialog>
  );
}
