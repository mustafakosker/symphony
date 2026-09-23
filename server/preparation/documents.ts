import type { Store } from "../store/task-store.js";
import type {
  PreparationCommand,
  UploadCommand,
} from "../../shared/jira-preparation.js";
import {
  parsePreparationCommand,
  parseUploadCommand,
} from "../../shared/jira-validation.js";
import { BoundaryError } from "../../shared/validate.js";
import {
  assertEditable,
  bytesDigest,
  validateInput,
  type PreparationOperations,
} from "./operations.js";
export function validateDocument(
  filename: string,
  bytes: Uint8Array,
): { filename: string; size: number } {
  if (
    !filename ||
    [...filename].length > 255 ||
    /[\u0000-\u001f\u007f/\\]/u.test(filename) ||
    !/\.(md|txt)$/i.test(filename)
  )
    throw new BoundaryError(
      "invalid",
      "Use a Markdown or text filename without paths",
    );
  if (!bytes.length || bytes.length > 1024 * 1024)
    throw new BoundaryError(
      "invalid",
      "Document must be between 1 byte and 1 MiB",
    );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BoundaryError(
      "invalid",
      "Document must contain valid UTF-8 text",
    );
  }
  if (!text.trim())
    throw new BoundaryError("invalid", "Document must not be blank");
  return { filename, size: bytes.length };
}
export function createDocumentService(
  store: Store,
  operations: PreparationOperations,
) {
  return {
    async upload(input: UploadCommand, bytes: Uint8Array) {
      const command = validateInput(() => parseUploadCommand(input));
      const metadata = validateDocument(command.filename, bytes);
      const inputDigest = operations.digest({
        command,
        bytesDigest: bytesDigest(bytes),
      });
      return operations.serial(command.taskId, async () => {
        const prior = await operations.replay(
          command.taskId,
          command.requestId,
          inputDigest,
        );
        if (prior) return prior;
        const task = await store.get(command.taskId);
        assertEditable(task, command.expectedRevision);
        const ref = await store.publishArtifact(
          task.id,
          `jira-${command.role}`,
          bytes,
        );
        return store.apply(task.id, task.revision, command.requestId, {
          kind: "preparation",
          inputDigest,
          change: {
            kind: "document",
            role: command.role,
            document: { role: command.role, ...metadata, ref },
          },
        });
      });
    },
    async remove(input: PreparationCommand) {
      const command = validateInput(() => parsePreparationCommand(input));
      if (command.action.kind !== "remove-document")
        throw new BoundaryError("invalid", "Expected remove-document action");
      const role = command.action.role,
        inputDigest = operations.digest(command);
      return operations.serial(command.taskId, async () => {
        const prior = await operations.replay(
          command.taskId,
          command.requestId,
          inputDigest,
        );
        if (prior) return prior;
        const task = await store.get(command.taskId);
        assertEditable(task, command.expectedRevision);
        return store.apply(task.id, task.revision, command.requestId, {
          kind: "preparation",
          inputDigest,
          change: { kind: "document", role, document: null },
        });
      });
    },
  };
}
