import { useEffect, useState } from "react";
import type { Task } from "../../../shared/contracts";
import type { FrozenPackage } from "../../../shared/jira-preparation";
import { artifactUrl } from "./DocumentSlot";
export default function HandoffReceipt({ task }: { task: Task }) {
  const attempt = task.preparation?.attempts.at(-1),
    receipt = attempt?.receipt;
  const [open, setOpen] = useState(false),
    [frozen, setFrozen] = useState<FrozenPackage | null>(null),
    [error, setError] = useState<string | null>(null);
  const url = attempt ? artifactUrl(task.id, attempt.packageRef) : null;
  useEffect(() => {
    if (!open || !url || !receipt) return;
    const controller = new AbortController();
    setError(null);
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Frozen package unavailable");
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > 1024 * 1024)
          throw new Error("Frozen package too large");
        const p = JSON.parse(new TextDecoder().decode(bytes)) as FrozenPackage;
        if (p.taskId !== task.id || p.requestId !== receipt.requestId)
          throw new Error("Frozen package does not match receipt");
        if (!controller.signal.aborted) setFrozen(p);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Frozen package unavailable",
          );
      });
    return () => controller.abort();
  }, [open, url, receipt, task.id]);
  if (
    !attempt ||
    attempt.status !== "accepted" ||
    !receipt ||
    receipt.requestId !== attempt.requestId
  )
    return null;
  return (
    <section className="jira-receipt" aria-label="ONA receipt">
      <span className="jira-eyebrow">SENT TO ONA</span>
      <h3>{receipt.simulated ? "Simulated ONA handoff" : "ONA handoff"}</h3>
      <p>
        Your reviewed package was accepted.{" "}
        {receipt.simulated &&
          "This mock handoff did not start an environment or open a merge request."}
      </p>
      <dl>
        <dt>Receipt</dt>
        <dd>{receipt.receiptId}</dd>
        <dt>Request</dt>
        <dd>{receipt.requestId}</dd>
        <dt>Accepted</dt>
        <dd>{new Date(receipt.acceptedAt).toLocaleString()}</dd>
      </dl>
      <div className="jira-inline-actions">
        <a href={url!} download>
          Download frozen package
        </a>
        <button
          className="text-button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          Inspect sent package
        </button>
      </div>
      {open &&
        (error ? (
          <p role="alert">{error}</p>
        ) : frozen ? (
          <div>
            <p>
              {frozen.jira.key} · {frozen.target.projectId} /{" "}
              {frozen.target.repositoryId} · {frozen.target.branch}
            </p>
            <ul>
              <li>
                <a href={artifactUrl(task.id, frozen.prompt.ref)} download>
                  Exact sent prompt
                </a>
              </li>
              {(["design", "implementation"] as const).map((role) => (
                <li key={role}>
                  <a
                    href={artifactUrl(task.id, frozen.documents[role].ref)}
                    download
                  >
                    {frozen.documents[role].filename} · v
                    {frozen.documents[role].ref.version}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p>Loading package…</p>
        ))}
    </section>
  );
}
