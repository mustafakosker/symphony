// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { waitingTask } from "../../server/testing/fixtures";
import { TaskProperties } from "./TaskProperties";

afterEach(cleanup);

it("omits next-step advice when reconciliation must be resolved first", () => {
  const task = waitingTask();
  task.workflow = task.proposedWorkflow;
  task.proposedWorkflow = null;
  task.currentStepId = "findings";
  task.reviews = [
    { ...task.reviews[0], kind: "reconciliation", id: "reconcile" },
    { ...task.reviews[0], kind: "artifact", id: "artifact", stepId: "findings" },
  ];
  render(<TaskProperties task={task} />);
  expect(screen.queryByRole("heading", { name: "Next up" })).not.toBeInTheDocument();
});
