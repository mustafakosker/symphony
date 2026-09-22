// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ArtifactPreview } from "./ArtifactPreview";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows hostile text literally after fetching the requested version", async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, headers: { get: () => "text/plain; charset=utf-8" },
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("<img src=x onerror=alert(1)>")); controller.close(); } }) });
  vi.stubGlobal("fetch", fetcher);
  render(<ul><ArtifactPreview taskId="task" artifact={{ id: "report", version: 3, digest: "digest", path: "artifacts/report.3.bin" }} /></ul>);
  expect(fetcher).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "View report v3" }));
  expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  expect(document.querySelector("img")).toBeNull();
  expect(fetcher.mock.calls[0][0]).toContain("/artifacts/report?version=3");
});

it("cancels an oversized preview after the bounded read", async () => {
  let delivered = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { delivered++; controller.enqueue(new Uint8Array(64 * 1024).fill(65)); },
    cancel() { cancelled = true; },
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, headers: { get: () => "text/plain; charset=utf-8" }, body,
    text: async () => { throw new Error("unbounded text read"); } }));
  render(<ul><ArtifactPreview taskId="task" artifact={{ id: "large", version: 1, digest: "digest", path: "artifacts/large.1.bin" }} /></ul>);
  await userEvent.click(screen.getByRole("button", { name: "View large v1" }));
  expect(await screen.findByText(/Preview truncated/)).toBeInTheDocument();
  expect(delivered).toBeLessThanOrEqual(6);
  expect(cancelled).toBe(true);
});

it("offers download when preview bytes are invalid UTF-8", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, headers: { get: () => "text/plain; charset=utf-8" },
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0xff, 0x00])); controller.close(); } }) }));
  render(<ul><ArtifactPreview taskId="task" artifact={{ id: "binary", version: 1, digest: "digest", path: "artifacts/binary.1.bin" }} /></ul>);
  await userEvent.click(screen.getByRole("button", { name: "View binary v1" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Download this artifact");
  expect(screen.getByRole("link", { name: "binary · v1" })).toBeInTheDocument();
});

it("keeps a valid UTF-8 preview when the byte cap splits a character", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, headers: { get: () => "text/plain; charset=utf-8" },
    body: new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(256 * 1024 - 1).fill(65));
      controller.enqueue(new Uint8Array([0xc3, 0xa9, 66]));
      controller.close();
    } }) }));
  render(<ul><ArtifactPreview taskId="task" artifact={{ id: "unicode", version: 1, digest: "digest", path: "artifacts/unicode.1.bin" }} /></ul>);
  await userEvent.click(screen.getByRole("button", { name: "View unicode v1" }));
  expect(await screen.findByText(/Preview truncated/)).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("does not retain a preview from a previous artifact identity", async () => {
  const ref = { id: "findings", version: 1, digest: "one", path: "artifacts/one" };
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response("First", { headers: { "Content-Type": "text/plain" } }))
    .mockResolvedValueOnce(new Response("Second", { headers: { "Content-Type": "text/plain" } })));
  const view = render(<ul><ArtifactPreview taskId="a" artifact={ref} /></ul>);
  await userEvent.click(screen.getByRole("button", { name: "View findings v1" }));
  expect(await screen.findByText("First")).toBeInTheDocument();
  view.rerender(<ul><ArtifactPreview taskId="b" artifact={{ ...ref, version: 2 }} /></ul>);
  expect(screen.queryByText("First")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "View findings v2" }));
  expect(await screen.findByText("Second")).toBeInTheDocument();
});

it("shows a successful preview after retrying a failed fetch", async () => {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }))
    .mockResolvedValueOnce(new Response("Recovered", { headers: { "Content-Type": "text/plain" } })));
  render(<ul><ArtifactPreview taskId="task" artifact={{ id: "report", version: 1, digest: "digest", path: "artifacts/report" }} /></ul>);
  const viewButton = screen.getByRole("button", { name: "View report v1" });
  await userEvent.click(viewButton);
  expect(await screen.findByRole("alert")).toHaveTextContent("Artifact unavailable (503)");
  await userEvent.click(viewButton);
  await userEvent.click(viewButton);
  expect(await screen.findByText("Recovered")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
