import type {
  JiraSnapshot,
  PreparationCommand,
  PreparationDetail,
  Target,
} from "../../shared/jira-preparation.js";
import { parsePreparationCommand } from "../../shared/jira-validation.js";
import { BoundaryError } from "../../shared/validate.js";
import type { Registry } from "../config/registry.js";
import type { Store } from "../store/task-store.js";
import {
  assertEditable,
  validateInput,
  type PreparationOperations,
} from "./operations.js";
export function initialPrompt(source: JiraSnapshot): string {
  return [
    `Implement ${source.key}: ${source.title}.`,
    "Use the attached Design document and Implementation plan as the task instructions.",
    "Run the checks specified in the implementation plan.",
    "Open a GitLab merge request with a summary of changes and test results.",
    "If the documents conflict or required information is missing, report the blocker.",
  ].join("\n\n");
}
export function validateTarget(
  registry: Registry,
  target: Target | null,
): void {
  if (
    target &&
    !registry.projects
      .find((p) => p.id === target.projectId)
      ?.repositories.some((r) => r.id === target.repositoryId)
  )
    throw new BoundaryError("invalid", "Select a configured repository");
}
export function createDraftService(
  store: Store,
  registry: Registry,
  operations: PreparationOperations,
) {
  async function write(input: PreparationCommand, action: "prepare" | "save") {
    const command = validateInput(() => parsePreparationCommand(input));
    if (command.action.kind !== action)
      throw new BoundaryError("invalid", `Expected ${action} action`);
    const inputDigest = operations.digest(command);
    return operations.serial(command.taskId, async () => {
      const prior = await operations.replay(
        command.taskId,
        command.requestId,
        inputDigest,
      );
      if (prior) return prior;
      const task = await store.get(command.taskId);
      assertEditable(task, command.expectedRevision);
      const p = task.preparation!;
      const target =
        command.action.kind === "save" ? command.action.target : p.target;
      validateTarget(registry, target);
      let prompt = p.prompt;
      if (command.action.kind === "save" || !prompt) {
        const text =
          command.action.kind === "save"
            ? command.action.promptText
            : initialPrompt(p.source);
        const bytes = Buffer.from(text, "utf8");
        if (bytes.length > 1024 * 1024)
          throw new BoundaryError("invalid", "Prompt exceeds 1 MiB");
        const ref = await store.publishArtifact(task.id, "jira-prompt", bytes);
        prompt = {
          ref,
          revision: (p.prompt?.revision ?? 0) + 1,
          sourceDigest: p.prompt?.sourceDigest ?? p.sourceDigest,
          nonblank: Boolean(text.trim()),
        };
      }
      return store.apply(task.id, task.revision, command.requestId, {
        kind: "preparation",
        inputDigest,
        change: { kind: "draft", prompt, target },
      });
    });
  }
  return {
    prepare: (command: PreparationCommand) => write(command, "prepare"),
    save: (command: PreparationCommand) => write(command, "save"),
    async detail(taskId: string): Promise<PreparationDetail> {
      const task = await store.get(taskId);
      if (!task.preparation)
        throw new BoundaryError("invalid", "Task is not a Jira handoff");
      const promptText = task.preparation.prompt
        ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            await store.readArtifact(task.id, task.preparation.prompt.ref),
          )
        : "";
      return { taskId, revision: task.revision, promptText };
    },
  };
}
