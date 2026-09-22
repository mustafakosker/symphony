import { randomUUID } from 'node:crypto';
import type { Issue, Run, Task } from '../../shared/contracts.js';
import type { Store } from '../store/task-store.js';

function readOnly(task: Task, run: Run): boolean {
  if (run.stepId === '$triage' || run.stepId.startsWith('$resolve:')) return true;
  const step = task.workflow?.steps.find(item => item.id === run.stepId);
  return step?.kind === 'agent' && step.actions.every(action => action === 'read');
}

function identityState(run: Run): 'dead' | 'unknown' {
  if (run.phase !== 'running' || !run.pid || !run.processStartedAt || process.platform === 'win32') return 'unknown';
  try { process.kill(run.pid, 0); return 'unknown'; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return 'unknown'; }
  // POSIX assignments start in detached groups. A missing leader does not mean
  // its managed descendants exited. Probe only; never signal recovered identity.
  try { process.kill(-run.pid, 0); return 'unknown'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'; }
}

export async function recoverAttempts(store: Store, _localRoot: string): Promise<Issue[]> {
  const issues = await store.recover();
  for (const task of (await store.list()).tasks) {
    const run = task.runs.findLast(item => item.phase === 'running' || item.phase === 'launch-intent');
    if (!run) continue;
    const dead = identityState(run) === 'dead';
    const safeRetry = dead && readOnly(task, run) && !task.intent && run.retryCount < 2;
    const reason = run.phase === 'launch-intent'
      ? 'Launch intent was not followed by verified process registration; reconcile possible effects'
      : dead ? 'Interrupted process and managed process group are confirmed absent' : 'Process identity is uncertain; reconcile before retrying';
    try {
      await store.apply(task.id, task.revision, `recovery:${run.id}`, {
        kind: 'run-failed', attemptId: run.id, reason,
        retryAt: safeRetry ? new Date(Date.now() + (run.retryCount === 0 ? 1000 : 5000)).toISOString() : null,
        exitCode: null, uncertainEffects: !dead || !readOnly(task, run), processExitConfirmed: dead,
      });
    } catch (error) {
      issues.push({ id: `recovery-${randomUUID()}`, taskId: task.id,
        message: `Attempt reconciliation could not be persisted: ${String(error)}` });
      continue;
    }
    if (!safeRetry) issues.push({ id: `recovery-${run.id}`, taskId: task.id, message: reason });
  }
  return issues;
}
