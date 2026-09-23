// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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

function ReopeningHarness({
  onSubmit,
}: {
  onSubmit: (markdown: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>New task</button>
      <NewTaskDialog
        open={open}
        onClose={() => setOpen(false)}
        onSubmit={onSubmit}
        canSubmit
      />
    </>
  );
}

it("keeps a reopened draft when an earlier submission succeeds", async () => {
  const user = userEvent.setup();
  let resolve!: () => void;
  const submit = vi.fn(
    () =>
      new Promise<void>((finish) => {
        resolve = finish;
      }),
  );
  render(<ReopeningHarness onSubmit={submit} />);

  await user.click(screen.getByRole("button", { name: "New task" }));
  await user.type(screen.getByLabelText("Brief"), "Old draft");
  await user.click(screen.getByRole("button", { name: "Submit draft" }));
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "New task" }));
  await user.type(screen.getByLabelText("Brief"), "New draft");

  await act(async () => resolve());
  expect(
    screen.getByRole("dialog", { name: "Submit a draft" }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Brief")).toHaveValue("New draft");
  expect(screen.getByRole("button", { name: "Submit draft" })).toBeEnabled();
  expect(submit).toHaveBeenCalledTimes(1);
});

it("blocks a second submission and isolates an earlier failure from a reopened draft", async () => {
  const user = userEvent.setup();
  let reject!: (error: Error) => void;
  const submit = vi.fn(
    () =>
      new Promise<void>((_finish, fail) => {
        reject = fail;
      }),
  );
  render(<ReopeningHarness onSubmit={submit} />);

  await user.click(screen.getByRole("button", { name: "New task" }));
  await user.type(screen.getByLabelText("Brief"), "Old draft");
  await user.click(screen.getByRole("button", { name: "Submit draft" }));
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "New task" }));
  await user.type(screen.getByLabelText("Brief"), "New draft");
  expect(screen.getByRole("button", { name: "Submit draft" })).toBeDisabled();
  expect(submit).toHaveBeenCalledTimes(1);

  await act(async () => reject(new Error("Old failure")));
  expect(
    screen.getByRole("dialog", { name: "Submit a draft" }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Brief")).toHaveValue("New draft");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Submit draft" })).toBeEnabled();
});
it('keeps title and brief while project settings are open',async()=>{
 const user=userEvent.setup(),projects={resolve:async()=>({generation:'unset',catalogRevision:'r',revision:'p',targetId:null,referenceIds:[],matches:[],problems:[]}),catalog:async()=>({projects:[],records:[],ineligible:[],scannedAt:''}),settings:async()=>({state:'unset',projectsRoot:null,revision:'r'}),operations:async()=>[],submissions:async()=>[]} as unknown as import('../projects/api').ProjectApi;
 render(<NewTaskDialog open canSubmit onClose={()=>{}} onSubmit={async()=>{}} projects={projects}/>);await user.type(screen.getByLabelText(/Title hint/),'Investigate checkout');await user.type(screen.getByLabelText('Brief'),'Keep this context');await user.click(screen.getByText('Projects & settings'));await user.click(await screen.findByText('Global settings'));await user.click(screen.getByText('Back to draft'));expect(screen.getByLabelText(/Title hint/)).toHaveValue('Investigate checkout');expect(screen.getByLabelText('Brief')).toHaveValue('Keep this context');
});
