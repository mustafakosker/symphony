// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { workspaceApi } from "./api";
import type { Command } from "../../shared/contracts";

afterEach(() => vi.unstubAllGlobals());
it("uses same-origin coordinator routes and keeps request identity", async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => ({
    ok: true,
    status: init?.method === "POST" ? 202 : 200,
    json: async () =>
      init?.method === "POST"
        ? { submissionId: "draft-1" }
        : { tasks: [], issues: [], coordinator: "ready" },
  }));
  vi.stubGlobal("fetch", fetcher);
  await workspaceApi.load();
  await workspaceApi.submit("# New\n\nBrief", "draft-request-1");
  expect(fetcher).toHaveBeenCalledWith(
    "/api/workspace",
    expect.objectContaining({ cache: "no-store" }),
  );
  expect(fetcher).toHaveBeenCalledWith(
    "/api/drafts",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        markdown: "# New\n\nBrief",
        requestId: "draft-request-1",
      }),
    }),
  );
});
it("exposes conflict without resending a stale decision", async () => {
  const fetcher = vi.fn(async () => ({
    ok: false,
    status: 409,
    json: async () => ({
      error: "Task revision has changed",
      operationId: "op-1",
    }),
  }));
  vi.stubGlobal("fetch", fetcher);
  const command: Command = {
    requestId: "decision-1",
    taskId: "11111111-1111-4111-8111-111111111111",
    expectedRevision: 2,
    action: { kind: "approve", reviewId: "r1", artifactDigests: [] },
  };
  await expect(workspaceApi.command(command)).rejects.toMatchObject({
    status: 409,
    message: "Task revision has changed",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
