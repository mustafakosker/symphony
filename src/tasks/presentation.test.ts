import { expect, it } from "vitest";
import { draftTask, waitingTask } from "../../server/testing/fixtures";
import {
  isClosed,
  matchesFilter,
  needsReview,
  statusLabel,
  typeLabel,
} from "./presentation";

it("prioritizes stop intent over status and pending review", () => {
  const task = waitingTask();
  expect(statusLabel({ ...task, intent: "pause" })).toBe("Pausing");
  expect(statusLabel({ ...task, intent: "cancel" })).toBe("Cancelling");
  expect(statusLabel(task)).toBe("Needs review");
  expect(needsReview(task)).toBe(true);
});

it("groups active, review, and closed coordinator states", () => {
  const task = draftTask();
  for (const status of ["triaging", "queued", "running", "blocked"] as const) {
    expect(matchesFilter({ ...task, status }, "active")).toBe(true);
  }
  expect(matchesFilter(waitingTask(), "review")).toBe(true);
  expect(matchesFilter({ ...task, status: "done" }, "active")).toBe(false);
  expect(isClosed({ ...task, status: "cancelled" })).toBe(true);
});

it("keeps free-form task types readable", () => {
  expect(typeLabel("technical-debt")).toBe("Technical debt");
  expect(typeLabel("")).toBe("Task");
});

it("keeps a cancelled task with an historical pending review out of attention counts", () => {
  const task = { ...waitingTask(), status: "cancelled" as const };
  expect(statusLabel(task)).toBe("Cancelled");
  expect(needsReview(task)).toBe(false);
  expect(matchesFilter(task, "review")).toBe(false);
  expect(matchesFilter(task, "closed")).toBe(true);
  expect(task.reviews[0].decision).toBeNull();
});
