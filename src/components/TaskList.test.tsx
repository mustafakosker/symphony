// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { draftTask, waitingTask } from "../../server/testing/fixtures";
import TaskList from "./TaskList";

afterEach(cleanup);

it("opens a real task without generating a new identifier", async () => {
  const task = waitingTask();
  const select = vi.fn();
  render(<TaskList tasks={[task]} filter="all" query="" selectedId={null}
    loading={false} canSubmit onQuery={vi.fn()} onSelect={select} onNew={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: /Draft.*Needs review/ }));
  expect(select).toHaveBeenCalledWith(task.id);
});

it.each([
  { tasks: [], filter: "all" as const, query: "", heading: "No tasks yet" },
  { tasks: [draftTask()], filter: "all" as const, query: "missing", heading: "No matching tasks" },
  { tasks: [draftTask()], filter: "closed" as const, query: "", heading: "No closed tasks" },
])("shows $heading for its empty condition", ({ tasks, filter, query, heading }) => {
  render(<TaskList tasks={tasks} filter={filter} query={query} selectedId={null}
    loading={false} canSubmit onQuery={vi.fn()} onSelect={vi.fn()} onNew={vi.fn()} />);
  expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
});

it("prevents a new task while submission is unavailable", () => {
  render(<TaskList tasks={[]} filter="all" query="" selectedId={null}
    loading={false} canSubmit={false} onQuery={vi.fn()} onSelect={vi.fn()} onNew={vi.fn()} />);
  expect(screen.getByRole("button", { name: "New task" })).toBeDisabled();
});

it("forwards search input and restores focus to a returning row", async () => {
  const task = draftTask();
  const onQuery = vi.fn();
  const searchRef = createRef<HTMLInputElement>();
  render(<TaskList tasks={[task]} filter="all" query="" selectedId={task.id}
    loading={false} canSubmit onQuery={onQuery} onSelect={vi.fn()} onNew={vi.fn()}
    searchRef={searchRef} returnFocusId={task.id} />);
  const row = screen.getByRole("button", { name: /Draft.*Triaging/ });
  expect(row).toHaveFocus();
  await userEvent.type(searchRef.current!, "new");
  expect(onQuery).toHaveBeenCalledWith("n");
});

it("restores focus to the list heading if the previous row is unavailable", () => {
  render(<TaskList tasks={[]} filter="all" query="" selectedId={null}
    loading={false} canSubmit onQuery={vi.fn()} onSelect={vi.fn()} onNew={vi.fn()}
    returnFocusId="missing" />);
  expect(screen.getByRole("heading", { name: "Tasks" })).toHaveFocus();
});

it("shows loading placeholders without claiming the list is empty", () => {
  render(<TaskList tasks={[]} filter="all" query="" selectedId={null}
    loading canSubmit onQuery={vi.fn()} onSelect={vi.fn()} onNew={vi.fn()} />);
  expect(screen.queryByRole("heading", { name: "No tasks yet" })).not.toBeInTheDocument();
  expect(screen.getByRole("status", { name: "Loading tasks" })).toBeInTheDocument();
});
