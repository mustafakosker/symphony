import { afterEach, expect, it } from "vitest";
import {
  chmod,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  createProjectFixture,
  createRepository,
  git,
  treeDigest,
} from "../testing/projects.js";
import { scanRoot } from "./discovery.js";
import { openProjectCatalog } from "./catalog.js";
import { openSnapshots, resolveSourceCommit } from "./snapshots.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});
const limits = {
  entries: 1000,
  totalBytes: 1024 * 1024,
  fileBytes: 512 * 1024,
  timeoutMs: 5000,
};
async function setup() {
  const f = await createProjectFixture();
  cleanup.push(f.dispose);
  const repo = await createRepository(f.root, "shop", {
    "README.md": "Committed\n",
    "run.sh": "echo Never run\n",
  });
  const root = {
    projectsRoot: f.root,
    generation: "g1",
    revision: "r1",
    state: "ready" as const,
    message: null,
  };
  const catalog = await openProjectCatalog(f.local),
    view = await catalog.reconcile(
      root,
      await scanRoot(root, { timeoutMs: 5000 }),
    );
  return {
    ...f,
    repo,
    project: view.records[0],
    snapshots: await openSnapshots(f.local, limits),
  };
}
it("retains committed bytes without importing dirty staged or untracked content and leaves source unchanged", async () => {
  const f = await setup();
  await writeFile(join(f.repo.path, "README.md"), "Staged\n");
  await git(f.repo.path, ["add", "."]);
  await writeFile(join(f.repo.path, "README.md"), "Dirty\n");
  await writeFile(join(f.repo.path, "secret"), "Untracked");
  const before = await treeDigest(f.root),
    resolved = await resolveSourceCommit(f.project, "main");
  await f.snapshots.importCommit(f.project, resolved);
  const snapshot = await f.snapshots.materialize(f.project, resolved);
  expect((await f.snapshots.readText(snapshot, "README.md")).text).toBe(
    "Committed\n",
  );
  await expect(f.snapshots.readText(snapshot, "secret")).rejects.toThrow();
  expect(await treeDigest(f.root)).toBe(before);
  await rm(f.repo.path, { recursive: true });
  expect((await f.snapshots.readText(snapshot, "README.md")).text).toBe(
    "Committed\n",
  );
});
it("records inert links, submodules, LFS pointers and binary entries without following or executing them", async () => {
  const f = await setup();
  await symlink("/outside/private", join(f.repo.path, "link"));
  await writeFile(join(f.repo.path, "binary"), Buffer.from([0, 255, 1]));
  await writeFile(
    join(f.repo.path, "large pointer"),
    "version https://git-lfs.github.com/spec/v1\noid sha256:" +
      "a".repeat(64) +
      "\nsize 100\n",
  );
  await writeFile(join(f.repo.path, "line\nbreak"), "Safe\n");
  await chmod(join(f.repo.path, "run.sh"), 0o755);
  await git(f.repo.path, ["add", "."]);
  await git(f.repo.path, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${f.repo.commit},submodule`,
  ]);
  await git(f.repo.path, ["commit", "-m", "Special entries"]);
  const resolved = await resolveSourceCommit(f.project, "main");
  await f.snapshots.importCommit(f.project, resolved);
  const snapshot = await f.snapshots.materialize(f.project, resolved),
    manifest = await f.snapshots.verify(snapshot);
  expect(manifest.entries.find((e) => e.path === "link")?.kind).toBe("symlink");
  expect(manifest.entries.find((e) => e.path === "submodule")?.kind).toBe(
    "submodule",
  );
  expect(
    manifest.entries.find((e) => e.path === "large pointer")?.lfsPointer,
  ).toBe(true);
  expect(manifest.entries.find((e) => e.path === "run.sh")?.mode).toBe(
    "100755",
  );
  expect((await f.snapshots.readText(snapshot, "line\nbreak")).text).toBe(
    "Safe\n",
  );
  for (const path of ["link", "submodule", "binary", "../secret"])
    await expect(f.snapshots.readText(snapshot, path)).rejects.toThrow();
});
it.each([{ entries: 1 }, { totalBytes: 5 }, { fileBytes: 5 }])(
  "fails visibly at configured limits %j",
  async (change) => {
    const f = await setup(),
      snapshots = await openSnapshots(f.local, { ...limits, ...change }),
      resolved = await resolveSourceCommit(f.project, "main");
    await expect(
      (async () => {
        await snapshots.importCommit(f.project, resolved);
        return snapshots.materialize(f.project, resolved);
      })(),
    ).rejects.toThrow(/limit/i);
  },
);
it("detects altered bytes or manifests and rebuilds only the same retained commit", async () => {
  const f = await setup(),
    resolved = await resolveSourceCommit(f.project, "main");
  await f.snapshots.importCommit(f.project, resolved);
  const snapshot = await f.snapshots.materialize(f.project, resolved),
    path = await f.snapshots.path(snapshot);
  await chmod(join(path, "files/README.md"), 0o600);
  await writeFile(join(path, "files/README.md"), "Altered\n");
  await expect(f.snapshots.verify(snapshot)).rejects.toThrow(/digest|changed/i);
  expect(await f.snapshots.materialize(f.project, resolved)).toEqual(snapshot);
  await chmod(join(path, "manifest.json"), 0o600);
  await writeFile(join(path, "manifest.json"), "{}");
  await expect(f.snapshots.verify(snapshot)).rejects.toThrow();
});
it("keeps an already resolved commit when the source branch advances and rejects forged IDs", async () => {
  const f = await setup(),
    resolved = await resolveSourceCommit(f.project, "main");
  await git(f.repo.path, ["commit", "--allow-empty", "-m", "Advance"]);
  await f.snapshots.importCommit(f.project, resolved);
  const snapshot = await f.snapshots.materialize(f.project, resolved);
  expect(snapshot.commit).toBe(f.repo.commit);
  await expect(
    f.snapshots.verify({ ...snapshot, snapshotId: "../escape" }),
  ).rejects.toThrow();
  await expect(
    resolveSourceCommit(f.project, "--output=/tmp/x"),
  ).rejects.toThrow();
});
it("supports SHA-256 repositories without assuming 40 character object IDs", async () => {
  const f = await createProjectFixture();
  cleanup.push(f.dispose);
  const path = join(f.root, "sha");
  await mkdir(path);
  await git(path, ["init", "-b", "main", "--object-format=sha256"]);
  await writeFile(join(path, "file"), "SHA256\n");
  await git(path, ["add", "."]);
  await git(path, ["commit", "-m", "Fixture"]);
  const root = {
    projectsRoot: f.root,
    generation: "g1",
    revision: "r1",
    state: "ready" as const,
    message: null,
  };
  const cat = await openProjectCatalog(f.local),
    project = (
      await cat.reconcile(root, await scanRoot(root, { timeoutMs: 5000 }))
    ).records[0];
  const snapshots = await openSnapshots(f.local, limits),
    resolved = await resolveSourceCommit(project, "main");
  expect(resolved.commit).toHaveLength(64);
  await snapshots.importCommit(project, resolved);
  expect(
    (
      await snapshots.readText(
        await snapshots.materialize(project, resolved),
        "file",
      )
    ).text,
  ).toBe("SHA256\n");
});

it("validates snapshot identity independently of JSON property ordering", async () => {
  const f = await setup(),
    resolved = await resolveSourceCommit(f.project, "main");
  await f.snapshots.importCommit(f.project, resolved);
  const snapshot = await f.snapshots.materialize(f.project, resolved);
  const reordered = Object.fromEntries(
    Object.entries(snapshot).reverse(),
  ) as typeof snapshot;
  await expect(f.snapshots.verify(reordered)).resolves.toMatchObject({
    ref: { commit: resolved.commit },
  });
});
it("refuses missing committed source objects rather than moving to a newer branch", async () => {
  const f = await setup(),
    resolved = await resolveSourceCommit(f.project, "main");
  await rm(join(f.repo.path, ".git/objects"), { recursive: true });
  await mkdir(join(f.repo.path, ".git/objects"));
  await expect(f.snapshots.importCommit(f.project, resolved)).rejects.toThrow();
});
