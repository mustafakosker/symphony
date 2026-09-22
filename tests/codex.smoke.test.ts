import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCodexRunner, type Assignment } from '../server/codex/adapter.js';
import { loadSettings } from '../server/config/settings.js';
import { loadRegistry } from '../server/config/registry.js';
import { draftTask } from '../server/testing/fixtures.js';

const configured = process.env.SYMPHONY_CODEX_SMOKE === '1' &&
  Boolean(process.env.SYMPHONY_CODEX_SMOKE_CONFIG && process.env.SYMPHONY_CODEX_SMOKE_ROLE);
const smoke = configured ? it : it.skip;
smoke('accepts two real read-only CLI handoffs under an operator-verified disposable profile', async () => {
  const settings = await loadSettings(process.env.SYMPHONY_CODEX_SMOKE_CONFIG!);
  const registry = await loadRegistry(settings.workspaceRoot);
  const role = registry.roles.find(item => item.role === process.env.SYMPHONY_CODEX_SMOKE_ROLE);
  expect(role).toBeDefined();
  expect(role?.actions).toEqual(['read']);
  expect(settings.verifiedProfilesPath).toBeTruthy();
  const root = await mkdtemp(join(settings.localRoot, 'smoke-fixture-'));
  try {
    await promisify(execFile)('git', ['init', '--quiet', root]);
    await writeFile(join(root, 'fixture.md'), '# Harmless fixture\n\nThe sky is blue in this sample sentence.\n');
    const runner = createCodexRunner(settings);
    const task = draftTask();
    task.idea = 'Summarize the harmless fixture.md in one sentence. Do not change files or invoke network tools.';
    task.reviews = [];
    const humanAnswer = 'Emphasize the sample sentence.';
    const run = async (answer: string | null) => {
      const attemptId = randomUUID();
      const outputDir = join(root, `output-${attemptId}`);
      await mkdir(outputDir);
      const assignedTask = structuredClone(task);
      if (answer) assignedTask.reviews = [{ id: 'answer', kind: 'question', workflowVersion: 1,
        stepId: 'research', artifacts: [], prompt: 'What should be emphasized?', answer, decision: 'answer' }];
      const step = { kind: 'agent' as const, id: 'research', title: 'Summarize fixture', role: role!.role,
        instructions: 'Read fixture.md without modifying files. Return completed with evidence["fixture-summary"] containing the fixture fact in your own words. If a human answer is present, include evidence["human-answer"] with its exact text and mention the requested emphasis in the summary. Do not invoke network tools.',
        inputs: [], repositories: [], actions: ['read' as const], outputs: [],
        checks: answer ? ['fixture-summary', 'human-answer'] : ['fixture-summary'] };
      const assignment: Assignment = { task: assignedTask, step, role: role!, cwd: root, outputDir,
        schemaPath: join(outputDir, 'schema.json'), materials: [],
        run: { id: attemptId, stepId: 'research', workflowVersion: 1, generation: answer ? 2 : 1,
          phase: 'launch-intent', pid: null, processStartedAt: null, runtimeVersion: (await runner.probe()).version,
          inputRefs: [], repos: [], startedAt: new Date().toISOString(), endedAt: null,
          exitCode: null, retryCount: 0, nextRetryAt: null, result: null } };
      const running = await runner.start(assignment, () => {});
      const exit = await running.completion;
      expect(exit.code).toBe(0);
      expect(exit.result?.taskId).toBe(task.id);
      expect(exit.result?.kind).toBe('completed');
      if (exit.result?.kind !== 'completed') throw new Error(`Expected completed smoke result: ${exit.error}`);
      expect(exit.result.evidence['fixture-summary']).toMatch(/sky.*blue|blue.*sky/i);
      if (answer) {
        expect(exit.result.evidence['human-answer']).toBe(answer);
        expect(exit.result.summary).toMatch(/sample sentence/i);
      }
      return exit;
    };
    await run(null);
    await run(humanAnswer); // The exact human-answer evidence above is the semantic dependency.
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);
