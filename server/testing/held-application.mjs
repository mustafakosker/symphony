// Crash-boundary fixture: accept a real fake-CLI subprocess exit, then hold the
// coordinator callback after its validated final output and before application.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCodexRunner } from '../../dist-server/server/codex/adapter.js';
import { loadSettings } from '../../dist-server/server/config/settings.js';
import { startApplication } from '../../dist-server/server/main.js';

const [configPath, buildDir, marker] = process.argv.slice(2);
if (!configPath || !buildDir || !marker) throw new Error('Expected config, build directory and marker');
const settings = await loadSettings(configPath);
const actual = createCodexRunner(settings, { executable: process.execPath,
  prefixArgs: [resolve('server/testing/lifecycle-cli.mjs')] });
const runner = { probe: () => actual.probe(),
  async start(assignment, onLine) {
    const running = await actual.start(assignment, onLine);
    if (assignment.step.id !== 'research') return running;
    return { ...running, completion: running.completion.then(async exit => {
      if (exit.code !== 0 || exit.result?.kind !== 'completed') throw new Error(`Fake CLI did not complete: ${exit.error}`);
      await writeFile(marker, JSON.stringify({ taskId: assignment.task.id, runId: assignment.run.id }));
      return new Promise(() => {});
    }) };
  } };
const app = await startApplication({ configPath, buildDir, runner, verifyCapabilities: async () => {} });
process.stdout.write(`Held fixture listening at ${app.address}\n`);
