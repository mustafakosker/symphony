import { expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockOnaAdapter } from "./mock";
import { bytesDigest } from "../preparation/operations";
it("distinguishes absent ledger from corrupt ledger without relaunching", async () => {
  const root = await mkdtemp(join(tmpdir(), "ona-mock-"));
  try {
    const adapter = createMockOnaAdapter({ localRoot: root }),
      signal = new AbortController().signal;
    expect((await adapter.lookup("unknown", signal)).kind).toBe("not-accepted");
    await mkdir(join(root, "jira-handoff/ona"), { recursive: true });
    await writeFile(
      join(
        root,
        "jira-handoff/ona",
        bytesDigest(Buffer.from("unknown")) + ".json",
      ),
      "broken",
    );
    expect((await adapter.lookup("unknown", signal)).kind).toBe("unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
