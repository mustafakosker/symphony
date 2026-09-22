import { readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.fake.1\n');
} else if (process.argv.includes('--help')) {
  process.stdout.write('Usage: codex exec --json --output-schema --output-last-message --cd --add-dir --profile --ask-for-approval --sandbox -\n');
} else {
  const scenario = JSON.parse(await readFile(join(process.cwd(), 'scenario.json'), 'utf8'));
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  await writeFile(join(process.cwd(), 'captured-prompt.txt'), prompt);
  await writeFile(join(process.cwd(), 'captured-args.json'), JSON.stringify(process.argv.slice(2)));
  const finalPath = process.argv[process.argv.indexOf('--output-last-message') + 1];
  if (scenario.mode === 'log-symlink') {
    const logPath = join(dirname(finalPath), 'stdout.log');
    await unlink(logPath).catch(() => {});
    await symlink(scenario.sentinelPath, logPath);
  }
  const valid = scenario.result ?? (scenario.mode === 'question' ? {
    kind: 'needs_human', taskId: scenario.taskId, attemptId: scenario.attemptId,
    summary: 'Needs a decision', artifacts: [], question: 'Which option?', checkpoint: 'Research paused',
  } : { kind: 'completed', taskId: scenario.taskId,
    attemptId: scenario.attemptId, summary: 'Finished', artifacts: [], evidence: { findings: 'café' } });
  if (scenario.mode === 'split-utf8') {
    const bytes = Buffer.from('{"message":"Investigating café"}\n');
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    process.stdout.write(bytes.subarray(0, split));
    await new Promise(resolve => setTimeout(resolve, 5));
    process.stdout.write(bytes.subarray(split));
  } else if (scenario.mode === 'overflow') {
    process.stdout.write('x'.repeat(100_000));
  } else {
    process.stdout.write('{"message":"working"}\n');
  }
  if (scenario.mode === 'hang' || scenario.mode === 'leader-exits') {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
    await writeFile(join(process.cwd(), 'child-pid.txt'), String(child.pid));
    if (scenario.mode === 'hang') setInterval(() => {}, 1000);
    else { await new Promise(resolve => setTimeout(resolve, 100)); process.exit(0); }
  } else {
    if (!['zero-no-final', 'overflow'].includes(scenario.mode)) {
      await writeFile(finalPath, scenario.mode === 'malformed-final' ? '{bad' : JSON.stringify(valid));
    }
    process.exit(scenario.mode === 'nonzero' ? 7 : 0);
  }
}
