// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import RunOutput from "./RunOutput";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("reads log chunks by byte offset and renders hostile output as text", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ text: "<script>alert(1)</script>", nextOffset: 25, complete: false }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ text: "done", nextOffset: 29, complete: true }) });
  vi.stubGlobal("fetch", fetcher);
  render(<RunOutput taskId="task-1" runId="run-1" />);
  expect(await screen.findByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
  expect(document.querySelector("script")).toBeNull();
  expect(fetcher.mock.calls[0][0]).toContain("offset=0");
  expect((await screen.findByText(/<script>alert\(1\)<\/script>done/))).toBeInTheDocument();
  expect(fetcher.mock.calls[1][0]).toContain("offset=25");
});

it("shows completed empty output and stops polling that stream", async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: "", nextOffset: 0, complete: true }) });
  vi.stubGlobal("fetch", fetcher);
  render(<RunOutput taskId="task-1" runId="run-1" />);
  expect(await screen.findByText("No output recorded.")).toBeInTheDocument();
  vi.useFakeTimers();
  try {
    await vi.advanceTimersByTimeAsync(2500);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

it("resets output and completion when switching streams", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ text: "stdout text", nextOffset: 11, complete: true }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ text: "", nextOffset: 0, complete: true }) });
  vi.stubGlobal("fetch", fetcher);
  render(<RunOutput taskId="task-1" runId="run-1" />);
  expect(await screen.findByText("stdout text")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "stderr" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("No output recorded.")).toBeInTheDocument();
  expect(screen.queryByText("stdout text")).not.toBeInTheDocument();
  expect(fetcher.mock.calls[1][0]).toContain("stream=stderr&offset=0");
});
