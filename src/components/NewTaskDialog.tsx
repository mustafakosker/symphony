import { useEffect, useRef, useState } from "react";
import { ArrowRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

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
  const opener = useRef<HTMLElement | null>(null);
  const briefField = useRef<HTMLTextAreaElement>(null);
  const wasOpen = useRef(false);
  const session = useRef(0);
  const inFlight = useRef(false);
  const [brief, setBrief] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open !== wasOpen.current) session.current += 1;
    if (open && !wasOpen.current) {
      setBrief("");
      setTitle("");
      setError("");
    }
    wasOpen.current = open;
  }, [open]);

  const requestClose = () => {
    session.current += 1;
    onClose();
  };

  const submit = async () => {
    if (inFlight.current) return;
    if (!brief.trim()) {
      setError("Add a brief before submitting.");
      return;
    }
    const markdown = title.trim()
      ? `# ${title.trim()}\n\n${brief.trim()}`
      : brief.trim();
    const submittedSession = session.current;
    inFlight.current = true;
    setBusy(true);
    try {
      await onSubmit(markdown);
      if (session.current === submittedSession) requestClose();
    } catch (cause) {
      if (session.current === submittedSession) {
        setError(cause instanceof Error ? cause.message : "Submission failed");
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
    >
      <DialogContent
        className="draft-dialog"
        showCloseButton={false}
        aria-describedby="draft-description"
        onOpenAutoFocus={(event) => {
          opener.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          event.preventDefault();
          briefField.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          opener.current?.focus();
          opener.current = null;
        }}
      >
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="draft-dialog-heading">
            <span className="eyebrow">SOMETHING STARTS HERE</span>
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              aria-label="Close new task"
              onClick={requestClose}
            >
              <X size={18} />
            </Button>
          </div>
          <DialogTitle>Submit a draft</DialogTitle>
          <DialogDescription id="draft-description">
            Add a Markdown brief for the coordinator to pick up.
          </DialogDescription>
          <Label htmlFor="draft-title">
            Title hint <span className="text-muted-foreground">· optional</span>
          </Label>
          <Input
            id="draft-title"
            maxLength={250}
            placeholder="A short name for this idea"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Label htmlFor="draft-brief">Brief</Label>
          <Textarea
            ref={briefField}
            id="draft-brief"
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
          <div className="draft-dialog-footer">
            <span>The coordinator will pick up your submitted draft.</span>
            <Button type="submit" disabled={busy || !canSubmit}>
              Submit draft <ArrowRight size={15} />
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
