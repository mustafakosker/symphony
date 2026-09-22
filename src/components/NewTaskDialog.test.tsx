// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NewTaskDialog from "./NewTaskDialog";

afterEach(cleanup);

it("retains a draft after a failed submission and permits retry", async () => {
  const user = userEvent.setup();
  const submit = vi
    .fn()
    .mockRejectedValueOnce(new Error("Save failed"))
    .mockResolvedValueOnce(undefined);
  const close = vi.fn();
  render(<NewTaskDialog open onClose={close} onSubmit={submit} canSubmit />);
  await user.type(screen.getByLabelText("Brief"), "Investigate onboarding");
  await user.click(screen.getByRole("button", { name: "Submit draft" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
  expect(screen.getByLabelText("Brief")).toHaveValue("Investigate onboarding");
  expect(close).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Submit draft" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(submit).toHaveBeenNthCalledWith(2, "Investigate onboarding");
});

it("describes coordinator intake and returns focus after Escape", async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>New task</button>
        <NewTaskDialog
          open={open}
          onClose={() => setOpen(false)}
          onSubmit={async () => {}}
          canSubmit
        />
      </>
    );
  }
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole("button", { name: "New task" }));
  expect(
    screen.getByRole("dialog", { name: "Submit a draft" }),
  ).toHaveAccessibleDescription(
    "Add a Markdown brief for the coordinator to pick up.",
  );
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "New task" })).toHaveFocus(),
  );
});
