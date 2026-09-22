// Disposable, fake-only browser preview. Never imported by the production entry point.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openStore } from '../dist-server/server/store/task-store.js';
import { startApplication } from '../dist-server/server/main.js';

const root = await mkdtemp(join(tmpdir(), 'symphony-fake-preview-'));
const workspaceRoot = join(root, 'workspace');
const localRoot = join(root, 'local');
await Promise.all([mkdir(join(workspaceRoot, 'projects'), { recursive: true }), mkdir(join(workspaceRoot, 'roles'), { recursive: true }), mkdir(localRoot)]);
await writeFile(join(workspaceRoot, 'projects/projects.json'), JSON.stringify({ projects: [] }));
await writeFile(join(workspaceRoot, 'roles/roles.json'), JSON.stringify({ roles: [
  { role: 'triage', instructions: 'FAKE triage', skills: [], cliProfile: 'fake', actions: ['read'] },
  { role: 'researcher', instructions: 'FAKE research', skills: [], cliProfile: 'fake', actions: ['read'] },
] }));
const port = Number(process.env.SYMPHONY_PREVIEW_PORT ?? 4321);
const emptyPreview = process.env.SYMPHONY_PREVIEW_EMPTY === '1';
const configPath = join(root, 'config.json');
await writeFile(configPath, JSON.stringify({ workspaceRoot, localRoot, codexBinary: process.execPath,
  port, allowedOrigin: `http://127.0.0.1:${port}`, scanMs: 100, stableMs: 100, stopGraceMs: 200 }));
const store = await openStore(workspaceRoot);
const workflow = { version: 1, steps: [
  { kind: 'agent', id: 'research', title: 'Research', role: 'researcher', instructions: 'FAKE research',
    inputs: [], repositories: [], actions: ['read'], outputs: ['findings'], checks: ['findings'] },
  { kind: 'human', id: 'findings', title: 'Review findings', producerStepId: 'research',
    artifactIds: ['findings'], allowsStepId: null },
], completionChecks: ['findings'] };
const makeTask = (title, status = 'triaging') => {
  const at = new Date().toISOString();
  return { schemaVersion: 1, id: randomUUID(), revision: 1, title, idea: `# ${title}\n\nFake preview fixture.`,
    type: 'unknown', projectId: null, source: `drafts/${title}.md`, status,
    workflow: null, proposedWorkflow: null, currentStepId: '$triage', completedStepIds: [],
    staleStepIds: [], generation: 0, intent: null, reviews: [], runs: [], artifacts: [],
    approvalBindings: [], blockedReason: null, queuedAt: at, createdAt: at, updatedAt: at };
};
const workflowTask = makeTask('Workflow approval', 'waiting-for-human');
workflowTask.proposedWorkflow = workflow;
workflowTask.reviews = [{ id: 'workflow-review', kind: 'workflow', workflowVersion: 1, stepId: '$triage',
  artifacts: [], prompt: 'Approve this fake research workflow?', answer: null, decision: null }];
if (!emptyPreview) await store.create(workflowTask, 'seed-workflow');

const revisionTask = makeTask('FAKE Workflow revision over v1', 'waiting-for-human');
revisionTask.workflow = structuredClone(workflow);
revisionTask.proposedWorkflow = { version: 2, completionChecks: ['revised-findings'], steps: [
  { kind: 'agent', id: 'revised-research', title: 'FAKE Revised repository investigation', role: 'researcher',
    instructions: 'Inspect the revised scope before approval. This fixture is fake only.', inputs: [],
    repositories: ['fake-revised-repo'], actions: ['read'], outputs: ['revised-findings'], checks: ['revised-findings'] },
  { kind: 'human', id: 'revised-review', title: 'FAKE Review revised findings', producerStepId: 'revised-research',
    artifactIds: ['revised-findings'], allowsStepId: null },
] };
revisionTask.reviews = [{ id: 'revision-review', kind: 'workflow', workflowVersion: 2, stepId: 'research',
  artifacts: [], prompt: 'Review the fake changed scope and completion conditions.', answer: null, decision: null }];
if (!emptyPreview) await store.create(revisionTask, 'seed-revision');

const questionTask = makeTask('Question handoff', 'waiting-for-human');
questionTask.reviews = [{ id: 'question-review', kind: 'question', workflowVersion: null, stepId: '$triage',
  artifacts: [], prompt: 'Which option should the fake agent use?', answer: null, decision: null }];
if (!emptyPreview) await store.create(questionTask, 'seed-question');

const artifactTask = makeTask('Artifact approval', 'queued');
artifactTask.workflow = workflow;
artifactTask.currentStepId = 'research';
const bytes = Buffer.from('# Fake findings\n\nThis is a disposable preview artifact.\n' +
  Array.from({ length: 40 }, (_, index) => `\nFAKE finding ${index + 1}: ${'Long content '.repeat(8)}`).join(''));
const ref = { id: 'findings', version: 1, digest: createHash('sha256').update(bytes).digest('hex'), path: 'artifacts/findings.1.bin' };
if (!emptyPreview) await store.create(artifactTask, 'seed-artifact');

const blockedTask = makeTask('Blocked reconciliation', 'blocked');
blockedTask.blockedReason = 'Fake uncertain external effect; operator reconciliation required';
blockedTask.runs = [{ id: randomUUID(), stepId: '$triage', workflowVersion: null, generation: 0,
  phase: 'uncertain', pid: 99999, processStartedAt: blockedTask.createdAt, runtimeVersion: 'fake-preview',
  inputRefs: [], repos: [], startedAt: blockedTask.createdAt, endedAt: blockedTask.createdAt,
  exitCode: null, retryCount: 0, nextRetryAt: null, result: null }];
if (!emptyPreview) await store.create(blockedTask, 'seed-blocked');

const longTask = makeTask('Long running fake task');
if (!emptyPreview) await store.create(longTask, 'seed-long');
const closedTask = makeTask('FAKE completed research', 'waiting-for-human');
closedTask.idea = 'Completed fake work remains available for inspection.';
closedTask.workflow = { ...structuredClone(workflow), steps: [workflow.steps[0], { ...workflow.steps[1], artifactIds: [] }] };
closedTask.currentStepId = 'findings';
closedTask.completedStepIds = ['research'];
closedTask.generation = 1;
closedTask.runs = [{ id: randomUUID(), stepId: 'research', workflowVersion: 1, generation: 1,
  phase: 'ended', pid: process.pid, processStartedAt: closedTask.createdAt, runtimeVersion: 'fake-preview',
  inputRefs: [], repos: [], startedAt: closedTask.createdAt, endedAt: closedTask.createdAt,
  exitCode: 0, retryCount: 0, nextRetryAt: null,
  result: { kind: 'completed', taskId: closedTask.id, attemptId: '', summary: 'FAKE research completed',
    artifacts: [], evidence: { findings: 'FAKE evidence' } } }];
closedTask.runs[0].result.attemptId = closedTask.runs[0].id;
closedTask.reviews = [{ id: 'closed-review', kind: 'artifact', workflowVersion: 1, stepId: 'findings',
  artifacts: [], prompt: 'FAKE final research review', answer: null, decision: null }];
if (!emptyPreview) {
  await store.create(closedTask, 'seed-closed');
  await store.apply(closedTask.id, 1, 'seed-closed-approval', { kind: 'human', command: {
    requestId: 'seed-closed-approval', taskId: closedTask.id, expectedRevision: 1,
    action: { kind: 'approve', reviewId: 'closed-review', artifactDigests: [] } } });
}
const longContentTask = makeTask('FAKE ' + 'Long task title '.repeat(12), 'waiting-for-human');
longContentTask.source = 'drafts/' + 'long-source-name-'.repeat(16) + '.md';
longContentTask.reviews = [{ id: 'long-question', kind: 'question', workflowVersion: null,
  stepId: '$triage', artifacts: [], prompt: 'First line\nSecond line\n' + 'Details '.repeat(80),
  answer: null, decision: null }];
if (!emptyPreview) await store.create(longContentTask, 'seed-long-content');
const runner = { async probe() { return { version: 'fake-preview-only' }; },
  async start(assignment) {
    let finish;
    let timer;
    const completion = new Promise(done => { finish = done; });
    if (assignment.step.id === 'research') await writeFile(join(assignment.outputDir, 'findings.md'), bytes);
    await writeFile(join(assignment.outputDir, 'stdout.log'), `FAKE ${assignment.step.id}: inspecting ${assignment.task.title}\n` +
      Array.from({ length: 40 }, (_, index) => `FAKE log line ${index + 1}: ${'output '.repeat(12)}\n`).join(''));
    const heading = assignment.task.idea.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const result = assignment.step.id === '$triage'
      ? { kind: 'propose_workflow_change', taskId: assignment.task.id, attemptId: assignment.run.id,
          summary: 'Fake workflow proposal', artifacts: [], workflow, reason: 'Fake triage',
          title: heading || assignment.task.title, taskType: 'feature', projectId: null }
      : { kind: 'completed', taskId: assignment.task.id, attemptId: assignment.run.id,
          summary: 'Fake research complete', artifacts: [{ ...ref, path: 'findings.md' }], evidence: { findings: 'Fake findings' } };
    timer = setTimeout(() => finish({ code: 0, signal: null, error: null, result }),
      assignment.task.id === longTask.id ? 5 * 60_000 : 800);
    return { pid: process.pid, processStartedAt: new Date().toISOString(), completion,
      async stop() { clearTimeout(timer); finish({ code: null, signal: 'SIGTERM', error: 'Fake stop', result: null }); } };
  } };
const app = await startApplication({ configPath, buildDir: resolve('dist'), runner,
  verifyCapabilities: async () => {} });
console.log(`FAKE PREVIEW ${app.address} (temporary root ${root})`);
const close = async () => { await app.close(); await rm(root, { recursive: true, force: true }); };
process.once('SIGINT', () => { void close().then(() => process.exit(0)); });
process.once('SIGTERM', () => { void close().then(() => process.exit(0)); });
