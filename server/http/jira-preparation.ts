import type { IncomingMessage, ServerResponse } from "node:http";
import { BoundaryError } from "../../shared/validate.js";
import type {
  PreparationCommand,
  UploadCommand,
} from "../../shared/jira-preparation.js";
import type { PreparationService } from "../preparation/service.js";
import type { JiraIntake } from "../jira/intake.js";
import { HttpError, readBytes, readJson } from "./access.js";
const uuid =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const detail = new RegExp(`^/api/tasks/(${uuid})/preparation$`),
  commands = new RegExp(`^/api/tasks/(${uuid})/preparation/commands$`),
  documents = new RegExp(
    `^/api/tasks/(${uuid})/documents/(design|implementation)$`,
  );
export async function handlePreparationRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  { preparation, jira }: { preparation: PreparationService; jira: JiraIntake },
): Promise<boolean> {
  const send = (value: unknown) => {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(value));
  };
  const method = request.method,
    path = url.pathname;
  if (method === "POST" && path === "/api/jira/sync") {
    const value = (await readJson(request)) as { requestId?: unknown } | null;
    if (
      !value ||
      typeof value.requestId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.requestId)
    )
      throw new BoundaryError("invalid", "Invalid sync request ID");
    send(await jira.sync(new Date()));
    return true;
  }
  const d = path.match(detail);
  if (method === "GET" && d) {
    send(await preparation.detail(d[1]));
    return true;
  }
  const c = path.match(commands);
  if (method === "POST" && c) {
    const value = (await readJson(request)) as PreparationCommand | null;
    if (!value || value.taskId !== c[1])
      throw new BoundaryError("invalid", "Command task ID does not match URL");
    send(await preparation.command(value));
    return true;
  }
  const doc = path.match(documents);
  if (method === "POST" && doc) {
    if (request.headers["content-type"] !== "application/octet-stream")
      throw new HttpError(400, "Binary content type is required");
    const header = (name: string) => {
      const v = request.headers[name];
      if (typeof v !== "string")
        throw new BoundaryError("invalid", "Missing upload metadata");
      return v;
    };
    let filename: string;
    try {
      filename = decodeURIComponent(header("x-symphony-filename"));
    } catch {
      throw new BoundaryError("invalid", "Invalid filename encoding");
    }
    const revision = header("x-symphony-expected-revision");
    if (!/^[1-9]\d*$/.test(revision))
      throw new BoundaryError("invalid", "Invalid revision");
    const value: UploadCommand = {
      taskId: doc[1],
      role: doc[2] as UploadCommand["role"],
      requestId: header("x-symphony-request-id"),
      expectedRevision: Number(revision),
      filename,
    };
    send(
      await preparation.upload(value, await readBytes(request, 1024 * 1024)),
    );
    return true;
  }
  return false;
}
