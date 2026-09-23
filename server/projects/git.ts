import { spawn } from "node:child_process";
import { BoundaryError } from "../../shared/validate.js";
export const gitEnvironment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ALLOW_PROTOCOL: "",
  LC_ALL: "C",
};
export const gitConfig = [
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.auto=0",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
];
export function runGit(
  cwd: string,
  args: string[],
  options: {
    timeoutMs?: number;
    maxBytes?: number;
    input?: Uint8Array | string;
  } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...gitConfig, ...args], {
      cwd,
      env: gitEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const output: Buffer[] = [];
    let bytes = 0,
      error = "",
      failure: Error | null = null;
    const fail = (message: string) => {
      failure ??= new BoundaryError("unavailable", message);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => fail("Git inspection timed out"),
      options.timeoutMs ?? 120000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 1048576))
        fail("Git output exceeds the configured limit");
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      error = (error + chunk.toString()).slice(-4096);
    });
    child.on("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new BoundaryError(
            "unavailable",
            `Git inspection failed: ${error.replace(/https?:\/\/[^\s]+/g, "[redacted URL]").trim()}`,
          ),
        );
      else resolve(Buffer.concat(output));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}
