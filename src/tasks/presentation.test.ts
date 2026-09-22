import { expect, it } from "vitest";
import { draftTask, waitingTask } from "../../server/testing/fixtures";
import {
  groupTasks,
  isClosed,
  matchesFilter,
  needsReview,
  statusLabel,
  typeLabel,
} from "./presentation";

it("keeps blocked and review-less waiting tasks reachable", () => {
  const blocked = { ...draftTask(), id: "blocked", status: "blocked" as const };
  const waiting = { ...waitingTask(), id: "waiting", reviews: [] };
  expect(groupTasks([blocked, waiting], "all", "").map(group => [group.id, group.tasks[0].id]))
    .toEqual([["active", "blocked"], ["waiting", "waiting"]]);
  expect(groupTasks([blocked, waiting], "active", "")[0].tasks).toEqual([blocked]);
});

it("groups in priority order while preserving task order and omitting empty groups", () => {
  const first = { ...waitingTask(), id: "first" };
  const second = { ...waitingTask(), id: "second" };
  const active = { ...draftTask(), id: "active", status: "running" as const };
  const closed = { ...draftTask(), id: "closed", status: "done" as const };
  expect(groupTasks([closed, second, active, first], "all", "").map(group => [group.id, group.tasks.map(task => task.id)]))
    .toEqual([["review", ["second", "first"]], ["active", ["active"]], ["closed", ["closed"]]]);
});

it("searches title, idea, type, and source without case sensitivity", () => {
  const task = { ...draftTask(), title: "Alpha", idea: "Research beta", type: "gamma", source: "delta.md" };
  for (const query of ["ALPHA", "BeTa", "GAMMA", "DELTA.MD"]) {
    expect(groupTasks([task], "all", query)[0].tasks).toEqual([task]);
  }
  expect(groupTasks([task], "all", "missing")).toEqual([]);
});

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
