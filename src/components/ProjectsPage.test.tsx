// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
afterEach(cleanup);
import ProjectsPage from "./ProjectsPage";
import type { ProjectApi } from "../projects/api";
it("directs an unset library to global settings without offering clone actions", async () => {
  const api = {
    settings: vi.fn().mockResolvedValue({ state: "unset" }),
    catalog: vi
      .fn()
      .mockResolvedValue({ records: [], ineligible: [], scannedAt: "" }),
    operations: vi.fn().mockResolvedValue([]),
  } as unknown as ProjectApi;
  render(<ProjectsPage api={api} onOpenSettings={() => {}} />);
  expect(await screen.findByText("Set projects root")).toBeVisible();
  expect(screen.queryByText(/clone repository/i)).toBeNull();
});
it("reloads a stale brief for comparison without discarding an active edit", async () => {
  const source = { projectId: "shop", commit: "a".repeat(40) },
    one = {
      version: 1,
      author: "human",
      source,
      report: {
        format: "source-report-v1",
        text: "Original brief",
        citations: [],
      },
    },
    two = {
      ...one,
      version: 2,
      report: { ...one.report, text: "Changed elsewhere" },
    },
    project = {
      id: "shop",
      name: "shop",
      displayName: "shop",
      aliases: [],
      branches: ["main"],
      defaultRef: "main",
      readiness: "ready",
      revision: "p1",
    },
    detail = vi
      .fn()
      .mockResolvedValueOnce({ project, briefs: [one] })
      .mockResolvedValue({ project, briefs: [one, two] });
  const api = {
    settings: async () => ({ state: "ready" }),
    catalog: async () => ({
      records: [project],
      ineligible: [],
      scannedAt: "",
    }),
    operations: async () => [],
    submissions: async () => [],
    detail,
    saveBrief: vi.fn().mockRejectedValue(new Error("Brief changed")),
  } as unknown as ProjectApi;
  render(<ProjectsPage api={api} onOpenSettings={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: /shop/ }));
  fireEvent.click(await screen.findByText("Edit brief"));
  fireEvent.change(screen.getByLabelText("Brief text"), {
    target: { value: "Keep my edit" },
  });
  fireEvent.click(screen.getByText("Save brief version"));
  await screen.findByText("Brief changed");
  fireEvent.click(screen.getByText("Reload saved versions"));
  await screen.findByText("Changed elsewhere");
  expect(screen.getByLabelText("Brief text")).toHaveValue("Keep my edit");
});
it("keeps saved brief provenance when a newer snapshot has been prepared", async () => {
  const source = { projectId: "shop", commit: "a".repeat(40) },
    newer = { ...source, commit: "b".repeat(40) };
  const one = {
    version: 1,
    source,
    author: "human",
    report: {
      format: "source-report-v1",
      text: "Original prose [cite:original]",
      citations: [
        {
          id: "original",
          repositoryId: "shop",
          commit: source.commit,
          path: "README.md",
          objectId: "c".repeat(40),
          contentDigest: "d".repeat(64),
          startLine: 1,
          endLine: 1,
        },
      ],
    },
  };
  const project = {
    id: "shop",
    name: "shop",
    displayName: "shop",
    aliases: [],
    branches: ["main"],
    defaultRef: "main",
    readiness: "ready",
    revision: "p1",
  };
  const saveBrief = vi
    .fn()
    .mockImplementation(async (x) => ({ ...x, version: 2 }));
  const api = {
    settings: async () => ({ state: "ready" }),
    catalog: async () => ({
      records: [project],
      ineligible: [],
      scannedAt: "",
    }),
    operations: async () => [
      {
        id: "prepared",
        projectId: "shop",
        state: "complete",
        snapshot: newer,
        message: "Prepared",
      },
    ],
    submissions: async () => [],
    detail: async () => ({ project, briefs: [one] }),
    saveBrief,
  } as unknown as ProjectApi;
  render(<ProjectsPage api={api} onOpenSettings={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: /shop/ }));
  fireEvent.click(await screen.findByText("Edit brief"));
  fireEvent.change(screen.getByLabelText("Brief text"), {
    target: { value: "Edited prose" },
  });
  fireEvent.click(screen.getByText("Save brief version"));
  await vi.waitFor(() => expect(saveBrief).toHaveBeenCalled());
  expect(saveBrief.mock.calls[0][0]).toMatchObject({
    source,
    expectedVersion: 1,
    report: { text: "Edited prose", citations: one.report.citations },
  });
});
it("retains the project edit revision when another browser changes aliases during preparation", async () => {
  const project = {
    id: "shop",
    name: "shop",
    displayName: "shop",
    aliases: ["original"],
    branches: ["main"],
    defaultRef: "main",
    readiness: "ready",
    revision: "p1",
  };
  let current = project,
    operations: unknown[] = [];
  const edit = vi
    .fn()
    .mockRejectedValue(new Error("Project changed; reload before saving"));
  const detail = vi.fn(async () => ({ project: current, briefs: [] }));
  const api = {
    settings: async () => ({ state: "ready" }),
    catalog: async () => ({
      records: [current],
      ineligible: [],
      scannedAt: "",
    }),
    operations: async () => operations,
    submissions: async () => [],
    detail,
    edit,
  } as unknown as ProjectApi;
  render(<ProjectsPage api={api} onOpenSettings={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: /shop/ }));
  fireEvent.change(await screen.findByLabelText("Aliases (comma separated)"), {
    target: { value: "my-unsaved-alias" },
  });
  current = { ...project, revision: "p2", aliases: ["saved-elsewhere"] };
  operations = [
    {
      id: "prepare",
      projectId: "shop",
      state: "complete",
      message: "Prepared",
    },
  ];
  fireEvent.click(screen.getByRole("button", { name: /^Refresh$/ }));
  await vi.waitFor(() => expect(detail).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByText("Save project"));
  await screen.findByText("Project changed; reload before saving");
  expect(edit.mock.calls[0][0]).toMatchObject({
    expectedRevision: "p1",
    aliases: ["my-unsaved-alias"],
  });
  expect(screen.getByLabelText("Aliases (comma separated)")).toHaveValue(
    "my-unsaved-alias",
  );
  fireEvent.click(
    screen.getByText("Use current project settings as edit base"),
  );
  fireEvent.click(screen.getByText("Save project"));
  await vi.waitFor(() => expect(edit).toHaveBeenCalledTimes(2));
  expect(edit.mock.calls[1][0]).toMatchObject({
    expectedRevision: "p2",
    aliases: ["my-unsaved-alias"],
  });
});
