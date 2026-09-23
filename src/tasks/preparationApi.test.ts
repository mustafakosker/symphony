// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { preparationApi } from "./preparationApi";
afterEach(() => vi.unstubAllGlobals());
it("sends raw File bytes and encoded metadata, preserving prompt whitespace", async () => {
  const fetcher = vi.fn(async (_url: string, _options: RequestInit) => ({
    ok: true,
    json: async () => ({}),
  }));
  vi.stubGlobal("fetch", fetcher);
  const file = new File(["\uFEFF# Café\r\n"], "café.md");
  await preparationApi.upload(
    {
      taskId: "task",
      requestId: "upload",
      expectedRevision: 3,
      role: "design",
      filename: file.name,
    },
    file,
  );
  expect(fetcher.mock.calls[0][1].body).toBe(file);
  expect(fetcher.mock.calls[0][1].headers).toMatchObject({
    "X-Symphony-Filename": encodeURIComponent(file.name),
    "X-Symphony-Expected-Revision": "3",
    "X-Symphony-Request-Id": "upload",
  });
  await preparationApi.command({
    taskId: "task",
    requestId: "save",
    expectedRevision: 3,
    action: { kind: "save", promptText: " exact\r\n", target: null },
  });
  expect(
    JSON.parse(fetcher.mock.calls[1][1].body as string).action.promptText,
  ).toBe(" exact\r\n");
});
