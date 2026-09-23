import { expect, it, vi, afterEach } from "vitest";
import { projectApi } from "./api";
afterEach(() => vi.unstubAllGlobals());
it("sends only project settings with a revision and request receipt", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ revision: "new" }) });
  vi.stubGlobal("fetch", fetch);
  await projectApi.saveSettings({
    projectsRoot: "/copies",
    expectedRevision: "old",
    requestId: "one",
  });
  expect(fetch).toHaveBeenCalledWith(
    "/api/settings/projects",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        projectsRoot: "/copies",
        expectedRevision: "old",
        requestId: "one",
      }),
    }),
  );
});
