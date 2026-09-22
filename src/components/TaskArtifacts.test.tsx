// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { waitingTask } from "../../server/testing/fixtures";
import { TaskArtifacts } from "./TaskArtifacts";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows an empty state when no artifacts have been saved", () => {
  const task = waitingTask();
  task.artifacts = [];
  render(<TaskArtifacts task={task} />);
  expect(screen.getByText("No saved output yet.")).toBeInTheDocument();
});

it("lists each saved version once and exposes its exact digest without fetching", () => {
  const task = waitingTask();
  const old = { id: "findings", version: 1, digest: "old-digest", path: "artifacts/old" };
  task.artifacts = [old, { ...old, version: 2, digest: "new-digest", path: "artifacts/new" }, old];
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(<TaskArtifacts task={task} />);
  expect(screen.getAllByRole("link")).toHaveLength(2);
  expect(screen.getByRole("link", { name: "findings · v1" })).toHaveAttribute("href", `/api/tasks/${task.id}/artifacts/findings?version=1`);
  expect(screen.getByRole("link", { name: "findings · v2" })).toHaveAttribute("href", `/api/tasks/${task.id}/artifacts/findings?version=2`);
  expect(screen.getByText("old-digest")).toBeInTheDocument();
  expect(screen.getByText("new-digest")).toBeInTheDocument();
  expect(fetcher).not.toHaveBeenCalled();
});
