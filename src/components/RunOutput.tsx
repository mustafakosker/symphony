import { useEffect, useState } from "react";
import { Button } from "./ui/button";
export type RunOutputProps = { taskId: string; runId: string };
type Chunk = { text: string; nextOffset: number; complete: boolean };
const TAIL = 64 * 1024;
export default function RunOutput({ taskId, runId }: RunOutputProps) {
  const [stream, setStream] = useState<"stdout" | "stderr">("stdout");
  const [output, setOutput] = useState("");
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let offset = 0;
    setOutput("");
    setComplete(false);
    setError(null);
    async function poll() {
      try {
        const url = `/api/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/log?stream=${stream}&offset=${offset}`;
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(`Log unavailable (${response.status})`);
        const chunk = await response.json() as Chunk;
        if (!active) return;
        if (chunk.nextOffset < offset || chunk.nextOffset === offset && chunk.text) throw new Error("Invalid log offset");
        const progressed = chunk.nextOffset > offset;
        offset = chunk.nextOffset;
        setOutput(current => (current + chunk.text).slice(-TAIL));
        if (chunk.complete) { setComplete(true); return; }
        timer = window.setTimeout(poll, progressed ? 0 : 2000);
        return;
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Log unavailable");
      }
      if (active) timer = window.setTimeout(poll, 2000);
    }
    void poll();
    return () => { active = false; window.clearTimeout(timer); };
  }, [taskId, runId, stream]);
  return <section className="terminal-block" aria-label="Run output">
    <div><strong>Run output</strong><span className="log-streams"><Button size="xs" variant={stream === "stdout" ? "secondary" : "ghost"} aria-pressed={stream === "stdout"} onClick={() => setStream("stdout")}>stdout</Button><Button size="xs" variant={stream === "stderr" ? "secondary" : "ghost"} aria-pressed={stream === "stderr"} onClick={() => setStream("stderr")}>stderr</Button></span></div>
    {error && <p role="alert" className="error">{error}</p>}
    <pre className="run-log" aria-live="polite">{output || (complete ? "No output recorded." : "Waiting for output…")}</pre>
  </section>;
}
