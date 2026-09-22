import { expect, it } from "vitest";
import {
  createProjectFixture,
  createRepository,
  treeDigest,
} from "../testing/projects.js";
import { runGit } from "./git.js";
it("bounds output and does not inherit alternate Git directory variables", async () => {
  const f = await createProjectFixture(),
    prior = process.env.GIT_DIR;
  try {
    const repo = await createRepository(f.root, "repo", { a: "A" }),
      before = await treeDigest(f.root);
    process.env.GIT_DIR = "/nonexistent";
    expect(
      (await runGit(repo.path, ["rev-parse", "HEAD"])).toString().trim(),
    ).toBe(repo.commit);
    await expect(
      runGit(repo.path, ["rev-parse", "HEAD"], { maxBytes: 1 }),
    ).rejects.toThrow(/limit/);
    expect(await treeDigest(f.root)).toBe(before);
  } finally {
    if (prior === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = prior;
    await f.dispose();
  }
});
