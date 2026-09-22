// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { waitingTask } from "../../server/testing/fixtures";
import TaskDetail from "./TaskDetail";

afterEach(cleanup);

it("shows terminal cancellation while retaining its historical review in activity", () => {
  const task = { ...waitingTask(), status: "cancelled" as const };
  render(<TaskDetail task={task} stale={false} onBack={vi.fn()} onCommand={vi.fn()} />);
  expect(screen.getByText("Cancelled")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "workflow review" })).not.toBeInTheDocument();
  expect(screen.getByText(/Task cancelled/)).toBeInTheDocument();
});
