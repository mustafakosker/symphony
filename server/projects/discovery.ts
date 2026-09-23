import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { BoundaryError } from "../../shared/validate.js";
import type { DiscoveryResult, RootSetting } from "../../shared/projects.js";
import { runGit } from "./git.js";
async function assertMetadata(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink())
    throw new BoundaryError("invalid", "Git metadata contains a symbolic link");
  if (info.isDirectory())
    for (const name of await readdir(path))
      await assertMetadata(join(path, name));
  if (basename(path) === "alternates" || basename(path) === "http-alternates")
    throw new BoundaryError("invalid", "Git object alternates are unsupported");
}
export async function validateSource(
  root: string,
  path: string,
  timeoutMs = 120000,
): Promise<{ gitDir: string }> {
  if (
    (await lstat(path)).isSymbolicLink() ||
    (await realpath(root)) !== root ||
    (await realpath(path)) !== path ||
    dirname(path) !== root
  )
    throw new BoundaryError(
      "invalid",
      "Project must be a direct non-symlink child of the canonical projects root",
    );
  const metadata = join(path, ".git");
  if (!(await lstat(metadata)).isDirectory())
    throw new BoundaryError(
      "invalid",
      "Standalone Git metadata is required; linked worktrees are unsupported",
    );
  await assertMetadata(metadata);
  const output = await runGit(
    path,
    [
      "rev-parse",
      "--show-toplevel",
      "--absolute-git-dir",
      "--is-bare-repository",
    ],
    { timeoutMs },
  );
  const [top, gitDir, bare] = output.toString().trim().split("\n");
  if (
    top !== path ||
    gitDir !== metadata ||
    !gitDir.startsWith(path + sep) ||
    bare !== "false"
  )
    throw new BoundaryError(
      "invalid",
      "Git repository escapes its project directory",
    );
  return { gitDir };
}
export async function scanRoot(
  root: RootSetting,
  options: { timeoutMs: number },
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    entries: [],
    scannedAt: new Date().toISOString(),
  };
  if (root.state === "unset") return result;
  if (root.state !== "ready" || !root.projectsRoot)
    throw new BoundaryError(
      "unavailable",
      root.message ?? "Projects root is unavailable",
    );
  const path = root.projectsRoot;
  if ((await realpath(path)) !== path)
    throw new BoundaryError("invalid", "Projects root was redirected");
  for (const child of (await readdir(path, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (!child.isDirectory() && !child.isSymbolicLink()) continue;
    const entry: DiscoveryResult["entries"][number] = {
      name: child.name,
      canonicalPath: null,
      gitDir: null,
      branches: [],
      currentBranch: null,
      observedCommit: null,
      error: null,
    };
    try {
      if (child.isSymbolicLink())
        throw new Error("Symbolic link projects are unsupported");
      const source = join(path, child.name),
        metadata = await validateSource(path, source, options.timeoutMs);
      entry.canonicalPath = source;
      entry.gitDir = metadata.gitDir;
      entry.branches = (
        await runGit(
          source,
          ["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
          options,
        )
      )
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean);
      try {
        entry.currentBranch = (
          await runGit(
            source,
            ["symbolic-ref", "--quiet", "--short", "HEAD"],
            options,
          )
        )
          .toString()
          .trim();
      } catch {
        entry.currentBranch = null;
      }
      try {
        entry.observedCommit = (
          await runGit(
            source,
            ["rev-parse", "--verify", "HEAD^{commit}"],
            options,
          )
        )
          .toString()
          .trim();
      } catch {
        entry.error = "Repository has no usable committed HEAD";
      }
    } catch (error) {
      entry.error =
        error instanceof Error
          ? error.message
          : "Repository cannot be inspected";
    }
    result.entries.push(entry);
  }
  return result;
}
