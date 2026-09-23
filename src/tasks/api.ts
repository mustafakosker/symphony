import type { Command, Task, WorkspaceView } from "../../shared/contracts";

export type WorkspaceApi = {
  load(signal?: AbortSignal): Promise<WorkspaceView>;
  submit(
    markdown: string,
    requestId: string,
  ): Promise<{ submissionId: string }>;
  command(value: Command): Promise<Task>;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly operationId?: string,
  ) {
    super(message);
  }
}

export async function read<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const value =
      body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    throw new ApiError(
      typeof value.error === "string" ? value.error : "Coordinator unavailable",
      response.status,
      typeof value.operationId === "string" ? value.operationId : undefined,
    );
  }
  return body as T;
}

export const workspaceApi: WorkspaceApi = {
  async load(signal) {
    return read<WorkspaceView>(
      await fetch("/api/workspace", { signal, cache: "no-store" }),
    );
  },
  async submit(markdown, requestId) {
    return read<{ submissionId: string }>(
      await fetch("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown, requestId }),
      }),
    );
  },
  async command(value) {
    return read<Task>(
      await fetch(`/api/tasks/${encodeURIComponent(value.taskId)}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      }),
    );
  },
};
