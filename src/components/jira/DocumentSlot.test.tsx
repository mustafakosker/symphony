// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import DocumentSlot from "./DocumentSlot";
import { artifact } from "../../../server/preparation/testing";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("previews HTML as literal text and keeps the saved download after replacement fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () =>
        new TextEncoder().encode("<script>alert(1)</script>").buffer,
    })),
  );
  const discard = vi.fn();
  render(
    <DocumentSlot
      role="design"
      selection={{
        role: "design",
        filename: "café.md",
        size: 25,
        ref: artifact(),
      }}
      taskId="task"
      disabled={false}
      error="Replacement failed"
      onUpload={vi.fn()}
      onRemove={vi.fn()}
      onDiscardError={discard}
    />,
  );
  expect(screen.getByRole("link", { name: /Download/ })).toHaveAttribute(
    "href",
    expect.stringContaining("version=1"),
  );
  await userEvent.click(screen.getByRole("button", { name: "Preview design" }));
  expect(
    await screen.findByText("<script>alert(1)</script>"),
  ).toBeInTheDocument();
  expect(document.querySelector("script")).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Discard failed replacement" }),
  );
  expect(discard).toHaveBeenCalledOnce();
});
