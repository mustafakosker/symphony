import { parseSourceReport } from '../../shared/source-report.js';
import { validateSourceReport } from '../projects/citations.js';
import { openSnapshots } from '../projects/snapshots.js';
import { resolveSnapshotAccess, snapshotLimits } from '../codex/snapshot-access.js';
import { assertProjectStep } from '../domain/project-policy.js';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentResult, AgentStep, ArtifactRef, Issue, RepoRef, Run, Task } from '../../shared/contracts.js';
import { BoundaryError, parseAgentResult } from '../../shared/validate.js';
import type { Assignment, Exit, Runner, Running } from '../codex/adapter.js';
import { validateDeclaredArtifacts } from '../codex/artifacts.js';
import type { Registry, Repository, RoleConfig } from '../config/registry.js';
import type { Settings } from '../config/settings.js';
import { eligibleStep, hasCurrentApproval } from '../domain/workflow.js';
import type { Intake } from '../intake/intake.js';
import { prepareCheckout, resolveLocalRef } from '../repos/workspace.js';
import type { Store } from '../store/task-store.js';
import { readRunLogFile, type LogPage, type LogStream } from '../store/run-log.js';
import { recoverAttempts } from './recovery.js';

export type Coordinator = { tick(now: Date): Promise<void>; stopTask(taskId: string, expectedAttemptId?: string): Promise<void>; shutdown(): Promise<void>;
  readLiveLog?(taskId: string, runId: string, offset: number, maxBytes: number, stream: LogStream): Promise<LogPage | null> };
type Deps = { store: Store; intake: Intake; registry: Registry; runner: Runner; settings: Settings;
  recovered?: boolean; beforeDispatch?: (now: Date) => Promise<void> };
type Slot = { taskId: string; runId: string | null; running: Running | null;
  assignment: Assignment | null; accepted: Promise<void> | null; settling: boolean; abandoned: boolean;
  uncertainty: Promise<void> | null; starting: boolean; intentWriting: boolean };
const MAX_MATERIAL_BYTES = 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Process termination or result settlement was not confirmed before shutdown deadline')), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
const exactActions = (step: AgentStep, role: RoleConfig) => step.actions.length === role.actions.length &&
  step.actions.every(action => role.actions.includes(action));
const safeSha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);

function selectedRepositories(task: Task, step: AgentStep, registry: Registry): Repository[] {
  if (!step.repositories.length) return [];
  const project = registry.projects.find(item => item.id === task.projectId);
  if (!project) throw new Error(`Project ${task.projectId ?? '(unselected)'} is unavailable`);
  return step.repositories.map(id => {
    const repo = project.repositories.find(item => item.id === id);
    if (!repo) throw new Error(`Repository ${id} is not configured for project ${project.id}`);
    return repo;
  });
}

function checkProtectedActionApproval(task: Task, step: AgentStep): void {
  if (!step.actions.some(action => action === 'merge' || action === 'deploy')) return;
  const index = task.workflow?.steps.findIndex(item => item.id === step.id) ?? -1;
  const checkpoint = index > 0 ? task.workflow?.steps[index - 1] : null;
  if (!checkpoint || checkpoint.kind !== 'human' || checkpoint.allowsStepId !== step.id ||
      !hasCurrentApproval(task, checkpoint.id)) {
    throw new Error(`Merge or deploy step ${step.id} requires its approved human checkpoint`);
  }
}

function resolutionStep(step: AgentStep, repositories: Repository[]): AgentStep {
  return { kind: 'agent', id: `$resolve:${step.id}`, title: `Resolve repository refs for ${step.title}`,
    role: 'researcher', instructions: `Read only the configured MCP repositories. Put a JSON array of exact repository, rule, commit and selectedCommits records in completed.evidence['repository-refs'] for ${repositories.map(repo => `${repo.id}:${repo.defaultRef}`).join(', ')}. Do not create a file artifact.`,
    inputs: [], repositories: repositories.map(repo => repo.id), actions: ['read'], outputs: ['repository-refs'],
    checks: ['repository-refs'], };
}

function validateRepoRefs(raw: unknown, repositories: Repository[]): RepoRef[] {
  if (!Array.isArray(raw) || raw.length !== repositories.length) throw new Error('Repository preparation returned the wrong number of refs');
  return repositories.map(repo => {
    const value = raw.find((item: unknown) => item && typeof item === 'object' && (item as RepoRef).repository === repo.id) as RepoRef | undefined;
    if (!value || value.rule !== repo.defaultRef || !safeSha(value.commit) || !Array.isArray(value.selectedCommits) ||
        !value.selectedCommits.length || !value.selectedCommits.every(safeSha) ||
        new Set(value.selectedCommits).size !== value.selectedCommits.length) throw new Error(`Invalid exact ref for ${repo.id}`);
    return { repository: repo.id, rule: value.rule, commit: value.commit, selectedCommits: value.selectedCommits };
  });
}

async function readSkill(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path || stat.size > MAX_MATERIAL_BYTES)
    throw new Error(`Approved skill is unsafe or oversized: ${path}`);
  const bytes = await readFile(path);
  if (bytes.length > MAX_MATERIAL_BYTES) throw new Error(`Approved skill is oversized: ${path}`);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function stagedMaterials(store: Store, taskId: string, refs: ArtifactRef[], role: RoleConfig): Promise<Assignment['materials']> {
  const materials: Assignment['materials'] = [];
  for (const ref of refs) {
    const bytes = await store.readArtifact(taskId, ref);
    if (bytes.length > MAX_MATERIAL_BYTES) throw new Error(`Input artifact ${ref.id} is oversized`);
    materials.push({ kind: 'artifact', name: `${ref.id}@${ref.version}`,
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
  }
  for (const path of role.skills) materials.push({ kind: 'skill', name: path, text: await readSkill(path) });
  if (Buffer.byteLength(JSON.stringify(materials)) > MAX_MATERIAL_BYTES) throw new Error('Combined staged materials exceed 1 MiB');
  return materials;
}

function previousFailures(task: Task, stepId: string): number {
  let count = 0;
  for (const run of [...task.runs].reverse()) {
    if (run.stepId !== stepId) continue;
    if (run.result?.kind === 'completed' || run.result?.kind === 'needs_human' || run.result?.kind === 'propose_workflow_change') break;
    if (run.phase === 'ended' || run.phase === 'uncertain') count++;
  }
  return count;
}

export function createCoordinator({ store, intake, registry, runner, settings, recovered = false, beforeDispatch }: Deps): Coordinator {
  const slots = new Map<string, Slot>();
  let started = recovered;
  let ticking: Promise<void> | null = null;
  let closing = false;
  const operationalErrors: unknown[] = [];
  let logicalNow = new Date();
  const terminationDeadlineMs = Math.max(1000, (settings.stopGraceMs || 5000) * 2 + 1000);
  function recordOperationalFailure(error: unknown): void { operationalErrors.push(error); }
  function captureLine(_line: string): void { /* Runner owns bounded, durable local log files. */ }
  async function applyCurrent(taskId: string, operationId: string, event: Parameters<Store['apply']>[3]): Promise<Task> {
    const current = await store.get(taskId);
    return store.apply(taskId, current.revision, operationId, event);
  }
  async function persistFailure(taskId: string, attemptId: string, reason: string, exitCode: number | null,
      uncertainEffects: boolean, retryable: boolean, now: Date, processExitConfirmed = true): Promise<void> {
    const task = await store.get(taskId);
    const run = task.runs.find(item => item.id === attemptId);
    if (!run || (run.phase !== 'running' && run.phase !== 'launch-intent')) return;
    const canRetry = retryable && !uncertainEffects && !task.intent && run.retryCount < 2;
    const delay = run.retryCount === 0 ? 1000 : 5000;
    await store.apply(taskId, task.revision, `${attemptId}:failed`, { kind: 'run-failed', attemptId, reason,
      retryAt: canRetry ? new Date(now.getTime() + delay).toISOString() : null, exitCode, uncertainEffects, processExitConfirmed });
  }
  function markUnconfirmed(slot: Slot): Promise<void> {
    if (slot.uncertainty) return slot.uncertainty;
    slot.abandoned = true;
    slot.uncertainty = (async () => {
      if (!slot.runId) throw new Error('Unconfirmed process has no persisted attempt ID');
      await persistFailure(slot.taskId, slot.runId,
        'Process termination could not be confirmed; reconcile possible effects', null, true, false, new Date(), false);
      slot.running?.abandon?.();
      if (slots.get(slot.taskId) === slot) slots.delete(slot.taskId);
    })();
    return slot.uncertainty;
  }
  async function publishResult(assignment: Assignment, result: AgentResult): Promise<AgentResult> {
    if (assignment.task.schemaVersion === 2) {
      if (result.artifacts.length) throw new Error('Connected agents return report text, never file artifacts');
      if (result.kind === 'completed') {
        const snapshots = await openSnapshots(settings.localRoot, snapshotLimits(settings));
        const reports = assignment.step.outputs.map(id => ({ id, report: parseSourceReport(JSON.parse(result.kind === 'completed' ? result.evidence[id] : 'null')) }));
        const limit = Math.min(MAX_MATERIAL_BYTES, settings.outputLimitBytes ?? MAX_MATERIAL_BYTES);
        if (reports.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item.report)), 0) > limit) throw new Error('Declared report evidence exceeds the output material limit');
        for (const { report } of reports) await validateSourceReport(report, assignment.task.projectContext.projects.map(p => p.snapshot), snapshots,
          { textBytes: assignment.task.purpose === 'project-brief' ? 128 * 1024 : limit, citations: 256 });
        result = { ...result, evidence: { ...result.evidence, ...Object.fromEntries(reports.map(item => [item.id, JSON.stringify(item.report)])) } };
      }
    }
    await validateDeclaredArtifacts(result, assignment.outputDir);
    const refs: ArtifactRef[] = [];
    for (const item of result.artifacts) {
      const path = join(assignment.outputDir, item.path);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > settings.outputLimitBytes)
        throw new Error(`Output artifact ${item.id} is unsafe or oversized`);
      const bytes = await readFile(path);
      if (bytes.length > settings.outputLimitBytes) throw new Error(`Output artifact ${item.id} is oversized`);
      if (sha(bytes) !== item.digest) throw new Error(`Artifact digest changed during publication: ${item.id}`);
      refs.push(await store.publishArtifact(assignment.task.id, item.id, bytes));
    }
    if (result.kind === 'completed' && !assignment.step.id.startsWith('$resolve:') &&
        assignment.step.actions.every(action => action === 'read')) {
      const reports = assignment.step.outputs.filter(id => !refs.some(ref => ref.id === id)).map(id => {
        const text = result.evidence[id];
        if (!text?.trim()) throw new Error(`Declared report output ${id} is missing from completed.evidence`);
        return { id, bytes: Buffer.from(text, 'utf8') };
      });
      const limit = Math.min(MAX_MATERIAL_BYTES, settings.outputLimitBytes ?? MAX_MATERIAL_BYTES);
      if (reports.reduce((total, report) => total + report.bytes.length, 0) > limit)
        throw new Error('Declared report evidence exceeds the output material limit');
      for (const report of reports) refs.push(await store.publishArtifact(assignment.task.id, report.id, report.bytes));
    }
    let published = { ...result, artifacts: refs } as AgentResult;
    if (assignment.step.id.startsWith('$resolve:')) {
      if (published.kind !== 'completed' || refs.length)
        throw new Error('Repository preparation must return exact refs as evidence');
      const repos = selectedRepositories(assignment.task, assignment.task.workflow!.steps.find(item => item.id === assignment.task.currentStepId) as AgentStep, registry)
        .filter(repo => repo.localPath === null);
      const exact = validateRepoRefs(JSON.parse(published.evidence['repository-refs']), repos);
      const ref = await store.publishArtifact(assignment.task.id, 'repository-refs', json(exact));
      published = { ...published, artifacts: [ref] };
    } else if (result.kind === 'completed') {
      if (!assignment.step.checks.every(check => result.evidence[check]?.trim())) throw new Error('Completion check evidence is missing');
    } else if (result.kind === 'propose_workflow_change' && result.projectId !== null &&
        !registry.projects.some(project => project.id === result.projectId)) {
      throw new Error(`Proposed project ${result.projectId} is not configured`);
    }
    await store.publishRunFiles(assignment.task.id, assignment.run.id, { 'result.json': json(published) });
    return published;
  }
  async function acceptExit(attemptId: string, exit: Exit): Promise<void> {
    const slot = [...slots.values()].find(item => item.runId === attemptId);
    if (!slot || !slot.assignment || slot.settling || slot.abandoned) return;
    slot.settling = true;
    const { taskId, assignment } = slot;
    try {
      const logs: Record<string, Uint8Array> = {};
      let logBytes = 0;
      for (const name of ['stdout.log', 'stderr.log']) {
        try {
          const path = join(assignment.outputDir, name);
          const stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > settings.outputLimitBytes - logBytes)
            throw new Error(`Run log ${name} is unsafe or oversized`);
          logs[name] = await readFile(path);
          logBytes += logs[name].length;
          if (logBytes > settings.outputLimitBytes) throw new Error('Run logs exceed configured output limit');
        }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (Object.keys(logs).length) await store.publishRunFiles(taskId, attemptId, logs);
      if (slot.abandoned) return;
      const current = await store.get(taskId);
      const run = current.runs.find(item => item.id === attemptId);
      if (!run || (run.phase !== 'running' && run.phase !== 'launch-intent')) return;
      if (current.intent) {
        await store.apply(taskId, current.revision, `${attemptId}:stopped`, {
          kind: 'stopped', attemptId, uncertainEffects: assignment.step.actions.some(action => action !== 'read') });
        return;
      }
      if (exit.result) {
        try {
          exit.result = parseAgentResult(exit.result);
          if (exit.result.taskId !== taskId || exit.result.attemptId !== attemptId)
            throw new Error('Final result task/attempt mismatch');
        } catch (error) {
          await persistFailure(taskId, attemptId, `Invalid final result: ${errorText(error)}`, exit.code, true, false, logicalNow);
          return;
        }
      }
      if (exit.code === 0 && exit.result?.kind === 'failed' && !exit.error) {
        await store.publishRunFiles(taskId, attemptId, { 'result.json': json(exit.result) });
        await persistFailure(taskId, attemptId, exit.result.reason, 0,
          assignment.step.actions.some(action => action !== 'read'),
          assignment.step.actions.every(action => action === 'read') && exit.result.retryable, logicalNow);
        return;
      }
      if (exit.code === 0 && exit.result && !exit.error) {
        try {
          const result = await publishResult(assignment, exit.result);
          if (slot.abandoned) return;
          await applyCurrent(taskId, `${attemptId}:finished`, { kind: 'finished', attemptId,
            generation: assignment.run.generation, exitCode: 0, result, bindQuestionAttempt: true });
          return;
        } catch (error) {
          await persistFailure(taskId, attemptId, `Result rejected: ${errorText(error)}`, exit.code, true, false, logicalNow);
          return;
        }
      }
      const reason = exit.error ?? (exit.result?.kind === 'failed' ? exit.result.reason : 'Run failed');
      await persistFailure(taskId, attemptId, reason, exit.code,
        assignment.step.actions.some(action => action !== 'read'), false, logicalNow);
    } catch (error) {
      try { await persistFailure(taskId, attemptId, `Output handling failed: ${errorText(error)}`, exit.code, true, false, logicalNow); }
      catch (failure) { recordOperationalFailure(failure); }
    }
    finally { if (slots.get(taskId) === slot) slots.delete(taskId); }
  }
  async function launch(task: Task, step: AgentStep, now: Date): Promise<void> {
    const slot: Slot = { taskId: task.id, runId: null, running: null, assignment: null, accepted: null, settling: false, abandoned: false,
      uncertainty: null, starting: false, intentWriting: false };
    slots.set(task.id, slot);
    let launched: Task | null = null;
    try {
      const current = await store.get(task.id);
      const eligible = eligibleStep(current);
      if (!eligible || eligible.id !== step.id) return;
      checkProtectedActionApproval(current, step);
      const last = [...current.runs].reverse().find(run => run.stepId === step.id || run.stepId === `$resolve:${step.id}`);
      if (last?.nextRetryAt && now.getTime() < Date.parse(last.nextRetryAt)) return;
      if (last?.phase === 'running' || last?.phase === 'launch-intent' ||
          last?.phase === 'uncertain' && !last.reconciliationNote) return;
      assertProjectStep(current, step);
      const repositories = current.schemaVersion === 2 ? [] : selectedRepositories(current, step, registry);
      const mcp = repositories.filter(repo => repo.localPath === null);
      const preparedRun = [...current.runs].reverse().find(run => run.stepId === `$resolve:${step.id}` &&
        run.phase === 'ended' && run.result?.kind === 'completed');
      const resolution = preparedRun?.result?.artifacts.find(ref => ref.id === 'repository-refs');
      const prepare = mcp.length > 0 && !resolution;
      const actualStep = current.schemaVersion === 2 ? { ...step, instructions: `${step.instructions}\nUse only the bound project context. Keep projectId null. Propose read-only investigation, design and implementation-plan outputs; preserve the future target/reference distinction.` } : prepare ? resolutionStep(step, mcp) : step.id === '$triage'
        ? { ...step, instructions: `${step.instructions}\n${registry.projects.length
          ? `Configured project choices: ${JSON.stringify(registry.projects.map(project => ({ id: project.id, names: project.names })))}. If the draft does not identify one project unambiguously, return needs_human with the choices; do not invent a project ID.`
          : 'No projects are configured. Use projectId: null and repositories: [] for all steps. Propose a repository-free workflow; do not ask the human to select a project. If the idea requires repository access, explain the missing access instead of inventing it.'}` }
        : step;
      const role = registry.roles.find(item => item.role === actualStep.role);
      if (!role || !exactActions(actualStep, role)) throw new Error(`Unsupported action profile for ${actualStep.role}`);
      const { version } = await runner.probe();
      const refs = [...actualStep.inputs];
      if (resolution && !prepare) refs.push(resolution);
      const materials = await stagedMaterials(store, current.id, refs, role);
      const repos: RepoRef[] = current.schemaVersion === 2 ? step.repositories.map(id => {
        const p = current.projectContext.projects.find(p => p.repositoryId === id)!;
        return { repository: id, rule: p.ref, commit: p.snapshot.commit, selectedCommits: [p.snapshot.commit] };
      }) : [];
      const snapshotAccess = current.schemaVersion === 2
        ? await resolveSnapshotAccess(current.projectContext, step.repositories, await openSnapshots(settings.localRoot, snapshotLimits(settings))) : undefined;
      for (const repo of prepare ? [] : repositories) if (repo.localPath) repos.push(await resolveLocalRef(repo, repo.defaultRef));
      if (resolution && !prepare) {
        const selected = validateRepoRefs(JSON.parse(Buffer.from(await store.readArtifact(current.id, resolution)).toString('utf8')), mcp);
        repos.push(...selected);
      }
      await mkdir(settings.localRoot, { recursive: true });
      const localRoot = await realpath(settings.localRoot);
      let cwd = join(localRoot, 'tasks', current.id);
      const repositoryAccess: NonNullable<Assignment['repositoryAccess']> = [];
      await mkdir(cwd, { recursive: true });
      for (const repo of prepare ? mcp : repositories) {
        const ref = repos.find(item => item.repository === repo.id);
        const localPath = repo.localPath ? await realpath(repo.localPath) : null;
        const checkoutPath = !prepare && localPath && step.actions.some(action => action !== 'read')
          ? await prepareCheckout(localRoot, current.id, repo, ref!) : null;
        repositoryAccess.push({ repository: repo.id, rule: repo.defaultRef, commit: ref?.commit ?? null,
          selectedCommits: ref?.selectedCommits ?? [], localPath, checkoutPath,
          mcpProfile: localPath ? null : repo.mcpProfile });
      }
      cwd = repositoryAccess.find(item => item.checkoutPath)?.checkoutPath ?? cwd;
      if (closing || slot.abandoned) return;
      const runId = randomUUID();
      const outputDir = join(localRoot, 'tasks', current.id, 'runs', runId);
      await mkdir(outputDir, { recursive: true });
      if (await realpath(outputDir) !== outputDir || await realpath(cwd) !== cwd)
        throw new Error('Assignment directory is redirected through a symlink');
      const run: Run = { id: runId, stepId: actualStep.id, workflowVersion: current.workflow?.version ?? null,
        generation: current.generation + 1, phase: 'launch-intent', pid: null, processStartedAt: null,
        runtimeVersion: version, inputRefs: refs, repos, startedAt: now.toISOString(), endedAt: null,
        exitCode: null, retryCount: previousFailures(current, actualStep.id), nextRetryAt: null, result: null };
      const assignment: Assignment = { task: current, step: actualStep, run, role, cwd, outputDir,
        schemaPath: join(outputDir, 'schema.json'), materials, repositoryAccess, ...(snapshotAccess ? { snapshotAccess } : {}) };
      await store.publishRunFiles(current.id, runId, { 'input.json': json(assignment) });
      if (closing || slot.abandoned) return;
      slot.intentWriting = true;
      launched = await store.apply(current.id, current.revision, runId, { kind: 'launch', run });
      slot.intentWriting = false;
      slot.runId = runId; slot.assignment = assignment;
      if (closing || slot.abandoned) { await markUnconfirmed(slot); return; }
      slot.starting = true;
      const active = await runner.start(assignment, captureLine);
      slot.starting = false;
      slot.running = active;
      if (closing || slot.abandoned) {
        try { await within(Promise.resolve().then(() => active.stop()), terminationDeadlineMs); }
        catch { /* The persisted launch intent or uncertainty requires reconciliation. */ }
        const previouslyMarked = Boolean(slot.uncertainty);
        await markUnconfirmed(slot);
        if (previouslyMarked) active.abandon?.();
        return;
      }
      let registrationError: unknown = null;
      let stopAfterRegistration = false;
      try {
        const startedState = await applyCurrent(current.id, `${runId}:started`, { kind: 'started', attemptId: runId,
          pid: active.pid, processStartedAt: active.processStartedAt });
        await store.publishRunFiles(current.id, runId, { 'process.json': json({ pid: active.pid, processStartedAt: active.processStartedAt }) });
        stopAfterRegistration = Boolean(startedState.intent || closing);
      } catch (error) { registrationError = error; }
      if (slot.abandoned) { await slot.uncertainty; return; }
      if (registrationError || stopAfterRegistration) {
        try { await within(Promise.resolve().then(() => active.stop()), terminationDeadlineMs); }
        catch { await markUnconfirmed(slot); return; }
      }
      if (registrationError) {
        slot.running = null;
        await persistFailure(current.id, runId, `Process registration failed: ${errorText(registrationError)}`, null, true, false, now);
        return;
      }
      slot.accepted = active.completion.then(exit => acceptExit(runId, exit)).catch(recordOperationalFailure);
    } catch (error) {
      if (slot.abandoned) { try { await slot.uncertainty; } catch (failure) { recordOperationalFailure(failure); } return; }
      if (launched && slot.runId) {
        try { await persistFailure(task.id, slot.runId, `Launch uncertain: ${errorText(error)}`, null, true, false, now, false); }
        catch (failure) { recordOperationalFailure(failure); }
      } else {
        try { await applyCurrent(task.id, `prepare:${randomUUID()}`, { kind: 'block', reason: errorText(error) }); }
        catch (failure) { recordOperationalFailure(failure); }
      }
    } finally { slot.starting = false; slot.intentWriting = false; if (!slot.running && slots.get(task.id) === slot) slots.delete(task.id); }
  }
  async function tickInternal(now: Date): Promise<void> {
    if (closing) return;
    if (operationalErrors.length) throw new Error(`Coordinator operational failure: ${errorText(operationalErrors[0])}`);
    if (!started) {
      const issues: Issue[] = await recoverAttempts(store, settings.localRoot);
      started = true;
      if (issues.some(issue => issue.id.startsWith('recovery-') && issue.message.includes('could not be persisted'))) return;
    }
    await intake.scan(now.getTime());
    if (closing) return;
    await beforeDispatch?.(now);
    if (operationalErrors.length) throw new Error(`Coordinator operational failure: ${errorText(operationalErrors[0])}`);
    const view = await store.list();
    if (view.coordinator === 'degraded') return;
    const candidates = view.tasks.filter(task => eligibleStep(task) && !slots.has(task.id))
      .sort((a, b) => (a.queuedAt ?? a.createdAt).localeCompare(b.queuedAt ?? b.createdAt) || a.id.localeCompare(b.id));
    for (const task of candidates) {
      if (closing || slots.size >= settings.concurrency) break;
      const step = eligibleStep(task);
      if (step) await launch(task, step, now);
    }
  }
  return {
    tick(now) { if (ticking) return ticking; logicalNow = now; const current = tickInternal(now).finally(() => { if (ticking === current) ticking = null; }); ticking = current; return current; },
    async readLiveLog(taskId, runId, offset, maxBytes, stream) {
      const slot = slots.get(taskId);
      if (!slot?.running || !slot.assignment || slot.runId !== runId || slot.assignment.task.id !== taskId ||
          slot.assignment.run.id !== runId) return null;
      const task = await store.get(taskId);
      const run = task.runs.find(item => item.id === runId);
      if (!run || run.phase !== 'running' || run.pid !== slot.running.pid ||
          run.processStartedAt !== slot.running.processStartedAt) return null;
      const root = await realpath(settings.localRoot);
      const expected = join(root, 'tasks', taskId, 'runs', runId);
      if (slot.assignment.outputDir !== expected || await realpath(expected) !== expected)
        throw new BoundaryError('conflict', 'Live run output directory is redirected');
      return readRunLogFile(join(expected, `${stream}.log`), run, offset, maxBytes);
    },
    async stopTask(taskId, expectedAttemptId) {
      const slot = slots.get(taskId);
      if (slot?.running && (!expectedAttemptId || slot.runId === expectedAttemptId)) {
        try {
          await within(Promise.resolve().then(() => slot.running!.stop()), terminationDeadlineMs);
          if (ticking) await within(ticking, terminationDeadlineMs);
          if (slot.abandoned) { await slot.uncertainty; return; }
          if (slot.accepted) await within(slot.accepted, terminationDeadlineMs);
          else if (slots.get(taskId) === slot) await markUnconfirmed(slot);
        } catch { await markUnconfirmed(slot); }
      }
    },
    async shutdown() {
      closing = true;
      const outcomes = await Promise.allSettled([...slots.values()].map(async slot => {
        if (!slot.running) {
          slot.abandoned = true;
          if (slot.intentWriting) throw new Error(`Launch intent for ${slot.taskId} has not finished persisting`);
          if (slot.starting && slot.runId) {
            await within(markUnconfirmed(slot), terminationDeadlineMs);
            throw new Error(`Process launch for ${slot.runId} has not returned a stoppable handle`);
          }
          if (slots.get(slot.taskId) === slot) slots.delete(slot.taskId);
          return;
        }
        try {
          await within(Promise.resolve().then(() => slot.running!.stop()), terminationDeadlineMs);
          await within(slot.accepted ?? Promise.reject(new Error('Attempt has no result settlement')), terminationDeadlineMs);
        } catch { await within(markUnconfirmed(slot), terminationDeadlineMs); }
      }));
      const errors = outcomes.filter((item): item is PromiseRejectedResult => item.status === 'rejected').map(item => item.reason);
      if (errors.length) throw new AggregateError(errors, `Could not complete shutdown cleanup: ${errors.map(errorText).join('; ')}`);
    },
  };
}
