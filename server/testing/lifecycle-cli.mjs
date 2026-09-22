// Deterministic subprocess fixture for HTTP/filesystem lifecycle tests only.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.fake.lifecycle\n');
} else if (process.argv.includes('--help')) {
  process.stdout.write('Usage: codex exec --json --output-schema --output-last-message --cd --add-dir --profile --ask-for-approval --sandbox -\n');
} else {
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  const taskId = prompt.match(/^Task ID: (.+)$/m)?.[1];
  const attemptId = prompt.match(/^Attempt ID: (.+)$/m)?.[1];
  const step = JSON.parse(prompt.match(/^Approved step: (.+)$/m)?.[1] ?? '{}');
  const continuation = JSON.parse(prompt.match(/^Saved continuation and accepted results: (.+)$/m)?.[1] ?? '[]');
  const feedback = JSON.parse(prompt.match(/^Human feedback: (.+)$/m)?.[1] ?? '[]');
  const outputDir = prompt.match(/^Output directory: (.+)$/m)?.[1];
  if (!taskId || !attemptId || !outputDir) throw new Error('missing assignment envelope');
  const resultPath = process.argv[process.argv.indexOf('--output-last-message') + 1];
  const workflow = { version: 1, steps: [
    { kind: 'agent', id: 'research', title: 'Research', role: 'researcher', instructions: 'Summarize fixture',
      inputs: [], repositories: [], actions: ['read'], outputs: ['findings'], checks: ['findings'] },
    { kind: 'human', id: 'findings', title: 'Review findings', producerStepId: 'research',
      artifactIds: ['findings'], allowsStepId: null },
  ], completionChecks: ['findings'] };
  let result;
  if (step.id === '$triage') {
    if (prompt.includes('[context-handoff]') && !feedback.some(item => item.answer)) {
      result = { kind: 'needs_human', taskId, attemptId, summary: 'Choice', artifacts: [],
        question: 'Choose ALPHA or BETA?', checkpoint: 'Unique continuation fact: preserve invoice order' };
    } else if (prompt.includes('[context-handoff]') && !continuation.some(item => item.attemptId &&
      item.result?.question === 'Choose ALPHA or BETA?' && item.result?.checkpoint.includes('preserve invoice order') && item.answer === 'BETA')) {
      throw new Error('Saved question/checkpoint/answer identity did not reach fresh assignment');
    } else if (prompt.includes('[two-questions]') && feedback.filter(item => item.stepId === '$triage' && item.answer).length < 2) {
      result = { kind: 'needs_human', taskId, attemptId, summary: 'Clarification requested', artifacts: [],
        question: 'Which option?', checkpoint: 'Human answer saved' };
    } else {
      const title = prompt.match(/^# (.+)$/m)?.[1] ?? 'Fixture task';
      result = { kind: 'propose_workflow_change', taskId, attemptId, summary: 'Workflow proposed', artifacts: [],
        workflow, reason: 'Fixture proposal', title, taskType: 'feature', projectId: null };
    }
  } else if (step.id === 'research') {
    if (prompt.includes('[evidence-only]')) {
      const count = 1 + feedback.filter(item => item.decision === 'changes').length;
      if (process.argv[process.argv.indexOf('-s') + 1] !== 'read-only') throw new Error('Evidence report must stay read-only');
      result = { kind: 'completed', taskId, attemptId, summary: `Evidence report v${count}`, artifacts: [],
        evidence: { findings: `# Evidence-only findings v${count}\nUnique report detail without filesystem writes.` } };
    } else {
    const countPath = join(process.cwd(), 'research-count.txt');
    const previous = Number(await readFile(countPath, 'utf8').catch(() => '0'));
    const count = previous + 1;
    await writeFile(countPath, String(count));
    if (prompt.includes('[slow-child]')) {
      const { spawn } = await import('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      await writeFile(join(process.cwd(), 'child-pid.txt'), String(child.pid));
      setInterval(() => {}, 1000);
    }
    const bytes = Buffer.from(`# Findings v${count}\n\nFixture evidence.\n`);
    await writeFile(join(outputDir, 'findings.md'), bytes);
    result = { kind: 'completed', taskId, attemptId, summary: `Findings v${count}`, evidence: { findings: 'Fixture evidence' },
      artifacts: [{ id: 'findings', version: count, digest: createHash('sha256').update(bytes).digest('hex'), path: 'findings.md' }] };
    }
  } else throw new Error(`unexpected step ${step.id}`);
  process.stdout.write('{"message":"fixture progressed"}\n');
  await writeFile(resultPath, JSON.stringify(result));
}
