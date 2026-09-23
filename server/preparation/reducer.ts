import type { ArtifactRef, Task } from "../../shared/contracts.js";
import type { PreparationEvent } from "../../shared/jira-preparation.js";
import { preparationReady } from "../../shared/jira-preparation.js";
import { TransitionConflict } from "../domain/transition-conflict.js";

export function reducePreparation(
  task: Task,
  event: PreparationEvent,
  now: string,
): Task {
  if (
    !task.preparation ||
    ["done", "cancelled", "rejected"].includes(task.status)
  )
    throw new TransitionConflict("Task is immutable");
  const next = structuredClone(task),
    p = next.preparation!,
    c = event.change;
  const last = p.attempts.at(-1);
  const locked = last?.status === "sending" || last?.status === "unconfirmed";
  if (locked && c.kind !== "settle" && c.kind !== "source")
    throw new TransitionConflict("Resolve the pending handoff first");
  const publish = (ref: ArtifactRef) => {
    const prior = next.artifacts.find(
      (a) => a.id === ref.id && a.version === ref.version,
    );
    if (prior && (prior.digest !== ref.digest || prior.path !== ref.path))
      throw new TransitionConflict("Artifact version changed");
    if (!prior) next.artifacts.push(ref);
  };
  switch (c.kind) {
    case "source":
      p.source = c.source;
      p.sourceDigest = c.digest;
      p.matchesQuery = c.matchesQuery;
      next.title = c.source.title;
      next.source = c.source.key;
      break;
    case "draft":
      p.prompt = c.prompt;
      p.target = c.target;
      next.projectId = c.target?.projectId ?? null;
      publish(c.prompt.ref);
      p.phase = "preparing";
      break;
    case "document":
      if (c.document && c.document.role !== c.role)
        throw new TransitionConflict("Document role mismatch");
      p.documents[c.role] = c.document;
      if (c.document) publish(c.document.ref);
      p.phase = "preparing";
      break;
    case "cancel":
      next.status = "cancelled";
      next.blockedReason = null;
      next.updatedAt = now;
      return next;
    case "dispatch": {
      if (!preparationReady(p))
        throw new TransitionConflict(
          "Save both documents, prompt and target first",
        );
      const a = c.attempt;
      if (a.status !== "sending" || a.receipt || a.reason)
        throw new TransitionConflict("Invalid dispatch");
      const existing = p.attempts.find((v) => v.requestId === a.requestId);
      if (existing) {
        if (
          existing !== last ||
          existing.status !== "not-accepted" ||
          a.dispatch !== existing.dispatch + 1 ||
          a.payloadDigest !== existing.payloadDigest ||
          JSON.stringify(a.packageRef) !== JSON.stringify(existing.packageRef)
        )
          throw new TransitionConflict(
            "Retry must bind the original rejected package",
          );
        p.attempts[p.attempts.length - 1] = a;
      } else {
        if ((last && last.status !== "not-accepted") || a.dispatch !== 1)
          throw new TransitionConflict("A handoff is already pending");
        p.attempts.push(a);
      }
      publish(a.packageRef);
      break;
    }
    case "settle": {
      if (
        !last ||
        last.requestId !== c.handoffRequestId ||
        last.dispatch !== c.dispatch ||
        !["sending", "unconfirmed"].includes(last.status)
      )
        throw new TransitionConflict("Handoff outcome is stale");
      if (
        (c.outcome === "accepted") !== !!c.receipt ||
        (c.receipt && c.receipt.requestId !== last.requestId)
      )
        throw new TransitionConflict("Receipt does not match handoff");
      last.status = c.outcome;
      last.receipt = c.receipt;
      last.reason = c.reason;
      break;
    }
    default:
      throw new TransitionConflict("Unknown preparation change");
  }
  const active = p.attempts.at(-1);
  next.status =
    active?.status === "accepted"
      ? "done"
      : active?.status === "sending"
        ? "running"
        : active?.status === "unconfirmed" || active?.status === "not-accepted"
          ? "blocked"
          : "waiting-for-human";
  next.blockedReason =
    next.status === "blocked"
      ? (active!.reason ?? "Handoff requires attention")
      : null;
  p.phase =
    next.status === "done"
      ? "sent"
      : preparationReady(p)
        ? "ready"
        : p.phase === "inbox"
          ? "inbox"
          : "preparing";
  next.updatedAt = now;
  return next;
}
