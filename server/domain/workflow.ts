import type { AgentStep, ArtifactRef, Command, DomainEvent, HumanStep, Review, Run, Status, Task } from '../../shared/contracts.js';

import { TransitionConflict } from './transition-conflict.js';
export { TransitionConflict } from './transition-conflict.js';
import { reducePreparation } from '../preparation/reducer.js';

const triageStep: AgentStep = {
  kind: 'agent', id: '$triage', title: 'Triage idea', role: 'triage',
  instructions: 'Classify the idea, ask for missing information, or propose a workflow.',
  inputs: [], repositories: [], actions: ['read'], outputs: ['workflow proposal'],
  checks: ['workflow proposal'],
};

export function isTerminal(status: Status): boolean {
  return status === 'done' || status === 'rejected' || status === 'cancelled';
}

function acceptedProducerArtifacts(task: Task, checkpoint: HumanStep): ArtifactRef[] | null {
  if (checkpoint.producerStepId === '$triage') {
    const proposal = [...task.reviews].reverse().find(review => review.kind === 'workflow' &&
      review.stepId === '$triage' && review.decision === 'approve');
    return proposal?.artifacts ?? [];
  }
  if (!task.completedStepIds.includes(checkpoint.producerStepId)) return null;
  const run = [...task.runs].reverse().find(item => item.stepId === checkpoint.producerStepId);
  if (!run || run.phase !== 'ended' || run.result?.kind !== 'completed') return null;
  return checkpoint.artifactIds.length
    ? checkpoint.artifactIds.flatMap(id => run.result!.artifacts.filter(ref => ref.id === id))
    : run.result.artifacts;
}

function sameArtifacts(left: ArtifactRef[], right: ArtifactRef[]): boolean {
  const key = (ref: ArtifactRef) => `${ref.id}:${ref.version}:${ref.digest}:${ref.path}`;
  return left.length === right.length && left.map(key).sort().every((value, index) => value === right.map(key).sort()[index]);
}

function reviewMatchesProducer(task: Task, checkpoint: HumanStep, review: Review): boolean {
  const expected = acceptedProducerArtifacts(task, checkpoint);
  return expected !== null && checkpoint.artifactIds.every(id => expected.some(ref => ref.id === id)) &&
    sameArtifacts(review.artifacts, expected) && review.artifacts.every(ref => task.artifacts.some(saved =>
      saved.id === ref.id && saved.version === ref.version && saved.digest === ref.digest));
}

export function hasCurrentApproval(task: Task, stepId: string): boolean {
  const workflow = task.workflow;
  const checkpoint = workflow?.steps.find(step => step.id === stepId);
  if (!workflow || !checkpoint || checkpoint.kind !== 'human' ||
      !task.completedStepIds.includes(stepId) || task.staleStepIds.includes(stepId)) return false;
  const review = [...task.reviews].reverse().find(item => item.kind === 'artifact' && item.stepId === stepId);
  if (!review || review.decision !== 'approve') return false;
  const binding = task.approvalBindings?.find(item => item.reviewId === review.id &&
    item.stepId === stepId && item.workflowVersion === workflow.version);
  if (review.workflowVersion !== workflow.version && !binding) return false;
  return reviewMatchesProducer(task, checkpoint, review);
}

function lookupEligibleAgentStep(task: Task): AgentStep | null {
  if (task.currentStepId === '$triage') return structuredClone(triageStep);
  const step = task.workflow?.steps.find(item => item.id === task.currentStepId);
  if (!step || step.kind !== 'agent') return null;
  if (task.completedStepIds.includes(step.id)) return null;
  return step;
}

export function eligibleStep(task: Task): AgentStep | null {
  if (task.preparation) return null;
  if (isTerminal(task.status) || task.intent || task.blockedReason) return null;
  if (task.reviews.some(review => review.decision === null)) return null;
  if (task.status !== 'triaging' && task.status !== 'queued') return null;
  const currentIndex = task.workflow?.steps.findIndex(step => step.id === task.currentStepId) ?? -1;
  if (currentIndex >= 0 && task.workflow!.steps.slice(0, currentIndex).some(step =>
    step.kind === 'human' && !hasCurrentApproval(task, step.id))) return null;
  return lookupEligibleAgentStep(task);
}

function setStatus(task: Task, status: Status, now: string): void {
  if ((status === 'triaging' || status === 'queued') && task.reviews.some(review => review.decision === null)) {
    status = 'waiting-for-human';
  }
  task.status = status;
  task.updatedAt = now;
  if (status === 'triaging' || status === 'queued') task.queuedAt ??= now;
  if (isTerminal(status)) task.queuedAt = null;
}

function requireRun(task: Task, attemptId: string): Run {
  const run = task.runs.find(item => item.id === attemptId);
  if (!run) throw new Error(`Unknown attempt ${attemptId}`);
  return run;
}

function requireActiveRun(task: Task, attemptId: string): Run {
  const run = requireRun(task, attemptId);
  if (run.phase !== 'running' && run.phase !== 'launch-intent') throw new Error(`Attempt ${attemptId} is not active`);
  return run;
}

function pendingReview(task: Task, reviewId: string): Review {
  const index = task.reviews.findIndex(item => item.id === reviewId);
  const review = task.reviews[index];
  if (!review || review.decision !== null) throw new Error(`No pending review ${reviewId}`);
  if (task.reviews.slice(0, index).some(item => item.decision === null))
    throw new Error('An earlier review is still pending');
  return review;
}

function reviewId(task: Task, stepId: string, kind: Review['kind']): string {
  return `${kind}-${stepId.replace('$', '')}-${task.generation}-${task.reviews.length + 1}`;
}

function carryApprovals(task: Task, fromVersion: number, toVersion: number, preservedStepIds: Set<string>): void {
  task.approvalBindings ??= [];
  for (const stepId of preservedStepIds) {
    const checkpoint = task.workflow?.steps.find(step => step.id === stepId);
    if (!checkpoint || checkpoint.kind !== 'human' || !task.completedStepIds.includes(stepId)) continue;
    const review = [...task.reviews].reverse().find(item => item.kind === 'artifact' && item.stepId === stepId);
    if (!review || review.decision !== 'approve' || !reviewMatchesProducer(task, checkpoint, review)) continue;
    const boundToOldVersion = review.workflowVersion === fromVersion || task.approvalBindings.some(binding =>
      binding.reviewId === review.id && binding.workflowVersion === fromVersion);
    if (!boundToOldVersion) continue;
    task.approvalBindings.push({ reviewId: review.id,
      originalWorkflowVersion: review.workflowVersion ?? fromVersion,
      workflowVersion: toVersion, stepId: review.stepId,
      artifacts: structuredClone(review.artifacts) });
  }
}

function allCompletionChecksMet(task: Task): boolean {
  if (!task.workflow || task.reviews.some(review => review.decision === null)) return false;
  if (!task.workflow.steps.every(step => task.completedStepIds.includes(step.id) &&
      !task.staleStepIds.includes(step.id) && (step.kind !== 'human' || hasCurrentApproval(task, step.id)))) return false;
  const completedEvidence = new Set<string>();
  const visitedSteps = new Set<string>();
  for (const run of [...task.runs].reverse()) {
    if (run.phase === 'ended' && run.result?.kind === 'completed' &&
        task.completedStepIds.includes(run.stepId) && !task.staleStepIds.includes(run.stepId) &&
        !visitedSteps.has(run.stepId)) {
      visitedSteps.add(run.stepId);
      for (const key of Object.keys(run.result.evidence)) completedEvidence.add(key);
    }
  }
  return task.workflow.completionChecks.every(check => completedEvidence.has(check));
}

function advanceAfterStep(task: Task, stepId: string, now: string): void {
  const workflow = task.workflow;
  if (!workflow) throw new Error('Approved workflow required to advance');
  const steps = workflow.steps;
  const index = steps.findIndex(step => step.id === stepId);
  if (index < 0) throw new Error(`Workflow step ${stepId} missing`);
  const next = steps[index + 1];
  const current = steps[index];
  if (current.kind === 'human' && current.allowsStepId !== (next?.id ?? null)) {
    throw new Error(`Checkpoint ${stepId} must allow the immediate next step`);
  }
  if (!next) {
    if (!allCompletionChecksMet(task)) throw new Error('Workflow completion checks or reviews remain unsatisfied');
    setStatus(task, 'done', now);
    return;
  }
  task.currentStepId = next.id;
  if (next.kind === 'human') {
    task.reviews.push({ id: reviewId(task, next.id, 'artifact'), kind: 'artifact',
      workflowVersion: workflow.version, stepId: next.id,
      artifacts: structuredClone(acceptedProducerArtifacts(task, next) ?? []),
      prompt: next.title, answer: null, decision: null });
    setStatus(task, 'waiting-for-human', now);
  } else {
    setStatus(task, 'queued', now);
  }
}

function requireDecisionRefs(task: Task, review: Review, digests: string[]): void {
  if (review.workflowVersion !== null && review.workflowVersion !== (review.kind === 'workflow' ? task.proposedWorkflow?.version : task.workflow?.version)) {
    throw new Error('Review workflow version is stale');
  }
  const actual = review.artifacts.map(artifact => artifact.digest).sort();
  if (actual.length !== digests.length || actual.some((digest, index) => digest !== [...digests].sort()[index])) {
    throw new Error('Review artifact digests do not match');
  }
  if (review.kind === 'artifact') {
    const checkpoint = task.workflow?.steps.find(step => step.id === review.stepId);
    if (!checkpoint || checkpoint.kind !== 'human') throw new Error('Review checkpoint is missing');
    if (!reviewMatchesProducer(task, checkpoint, review))
      throw new Error('Review artifact or producer version is stale, missing, or unavailable');
  }
  for (const artifact of review.artifacts) {
    if (!task.artifacts.some(current => current.id === artifact.id && current.version === artifact.version && current.digest === artifact.digest)) {
      throw new Error(`Review artifact ${artifact.id} is stale`);
    }
  }
}

function settleStopIntent(task: Task, uncertainEffects: boolean, now: string): boolean {
  if (task.intent === 'cancel') {
    task.intent = null; setStatus(task, 'cancelled', now);
    return true;
  }
  if (task.intent === 'pause') {
    task.intent = null;
    const kind = uncertainEffects ? 'reconciliation' : 'pause';
    task.reviews.push({ id: reviewId(task, task.currentStepId, kind), kind,
      workflowVersion: task.workflow?.version ?? null, stepId: task.currentStepId,
      artifacts: [], prompt: uncertainEffects ? 'Reconcile possible external effects before retrying' : 'Review partial work before resuming',
      answer: null, decision: null });
    setStatus(task, 'waiting-for-human', now);
    return true;
  }
  return false;
}

function handleHuman(task: Task, command: Command, now: string): void {
  if (command.taskId !== task.id) throw new Error('Command taskId does not match task');
  if (command.expectedRevision !== task.revision) throw new Error('Command expectedRevision is stale');
  const action = command.action;
  const unconfirmed = task.runs.some(run => run.processExitConfirmed === false && !run.reconciliationNote);
  if (unconfirmed && (action.kind === 'pause' || action.kind === 'cancel')) {
    if (action.kind === 'cancel' || task.intent !== 'cancel') task.intent = action.kind;
    setStatus(task, 'blocked', now);
    return;
  }
  if (action.kind === 'cancel') {
    if (task.status === 'running') task.intent = 'cancel';
    else setStatus(task, 'cancelled', now);
    return;
  }
  if (action.kind === 'pause') {
    if (task.status === 'running') task.intent = 'pause';
    else {
      task.reviews.push({ id: reviewId(task, task.currentStepId, 'pause'), kind: 'pause',
        workflowVersion: task.workflow?.version ?? null, stepId: task.currentStepId,
        artifacts: [], prompt: 'Resume this task?', answer: null, decision: null });
      setStatus(task, 'waiting-for-human', now);
    }
    return;
  }
  if (action.kind === 'retry') {
    if (task.status !== 'blocked') throw new Error('Retry requires a blocked task');
    if (!action.text.trim()) throw new Error('Retry requires a reconciliation note');
    const uncertain = [...task.runs].reverse().find(run => run.phase === 'uncertain' &&
      (run.stepId === task.currentStepId || run.stepId === `$resolve:${task.currentStepId}`));
    if (uncertain) {
      uncertain.reconciliationNote = action.text.trim();
      if (uncertain.processExitConfirmed === false) { uncertain.processExitConfirmed = true; uncertain.endedAt = now; }
    }
    task.blockedReason = null;
    if (settleStopIntent(task, false, now)) return;
    task.intent = null;
    setStatus(task, task.currentStepId === '$triage' ? 'triaging' : 'queued', now);
    return;
  }
  if (action.kind === 'insert-review') {
    if (!task.workflow) throw new Error('Approved workflow required to insert review');
    if (task.reviews.some(review => review.decision === null))
      throw new TransitionConflict('Pending review must be resolved before inserting a checkpoint');
    if (task.intent) throw new TransitionConflict('Cannot insert a checkpoint while a stop intent is pending');
    if (task.status !== 'queued' && task.status !== 'running')
      throw new TransitionConflict('Checkpoint insertion requires a queued or running task');
    if (task.status === 'running' && action.beforeStepId === task.currentStepId)
      throw new Error('Pause the active running step before inserting a checkpoint ahead of it');
    const index = task.workflow.steps.findIndex(step => step.id === action.beforeStepId);
    if (index < 0 || task.completedStepIds.includes(action.beforeStepId)) throw new Error('Review target must be an upcoming step');
    if (task.runs.some(run => run.stepId === action.beforeStepId))
      throw new Error('Review target already started; pause and reconcile before changing it');
    const oldVersion = task.workflow.version;
    carryApprovals(task, oldVersion, oldVersion + 1,
      new Set(task.workflow.steps.slice(0, index).map(step => step.id)));
    const previous = [...task.workflow.steps.slice(0, index)].reverse().find(step => step.kind === 'agent');
    const producerId = previous?.id ?? '$triage';
    const producerRun = [...task.runs].reverse().find(run => run.stepId === producerId);
    const proposal = producerId === '$triage' ? [...task.reviews].reverse().find(review =>
      review.kind === 'workflow' && review.stepId === '$triage' && review.decision === 'approve') : null;
    const artifactIds = [...new Set((producerRun?.phase === 'ended' && producerRun.result?.kind === 'completed'
      ? producerRun.result.artifacts : proposal?.artifacts ?? [])
      .map(artifact => artifact.id))];
    const id = `review-${task.workflow.version + 1}-${task.workflow.steps.length}`;
    const inserted: HumanStep = { kind: 'human', id, title: action.title,
      producerStepId: producerId, artifactIds, allowsStepId: action.beforeStepId };
    task.workflow = { ...task.workflow, version: task.workflow.version + 1,
      steps: [...task.workflow.steps.slice(0, index), inserted, ...task.workflow.steps.slice(index)] };
    const priorStep = task.workflow.steps[index - 1];
    if (priorStep?.kind === 'human') priorStep.allowsStepId = id;
    if (task.currentStepId === action.beforeStepId && task.status !== 'running') {
      task.currentStepId = id;
      task.reviews.push({ id: reviewId(task, id, 'artifact'), kind: 'artifact',
        workflowVersion: task.workflow.version, stepId: id,
        artifacts: structuredClone(acceptedProducerArtifacts(task, inserted) ?? []),
        prompt: action.title, answer: null, decision: null });
      setStatus(task, 'waiting-for-human', now);
    }
    return;
  }
  const review = pendingReview(task, action.reviewId);
  if (task.status !== 'waiting-for-human') throw new Error('Review decision requires waiting-for-human');
  if (action.kind === 'answer') {
    if (review.kind !== 'question' && review.kind !== 'reconciliation') throw new Error('Answer requires a question or reconciliation review');
    if (!action.text.trim()) throw new Error('Answer requires nonempty text');
    review.answer = action.text.trim(); review.decision = 'answer';
    if (review.kind === 'reconciliation') {
      const uncertain = [...task.runs].reverse().find(run => run.phase === 'uncertain' &&
        (run.stepId === review.stepId || run.stepId === `$resolve:${review.stepId}`));
      if (!uncertain) throw new Error('Reconciliation attempt is missing');
      uncertain.reconciliationNote = review.answer;
    }
    setStatus(task, task.currentStepId === '$triage' ? 'triaging' : 'queued', now);
    return;
  }
  if (action.kind === 'reject') {
    if (review.kind === 'question') throw new Error('Question cannot be rejected as an approval');
    review.answer = action.text; review.decision = 'reject';
    setStatus(task, 'rejected', now);
    return;
  }
  if (action.kind === 'changes') {
    if (review.kind !== 'workflow' && review.kind !== 'artifact') throw new Error('Changes require an approval review');
    if (!action.text.trim()) throw new Error('Changes require nonempty feedback');
    review.answer = action.text.trim(); review.decision = 'changes';
    if (review.kind === 'workflow') {
      task.proposedWorkflow = null;
      task.currentStepId = review.stepId;
      setStatus(task, review.stepId === '$triage' ? 'triaging' : 'queued', now);
    } else {
      const checkpoint = task.workflow?.steps.find(step => step.id === review.stepId);
      if (!checkpoint || checkpoint.kind !== 'human') throw new Error('Review checkpoint missing');
      task.currentStepId = checkpoint.producerStepId;
      const producerIndex = task.workflow!.steps.findIndex(step => step.id === checkpoint.producerStepId);
      const affected = new Set(task.workflow!.steps.slice(Math.max(0, producerIndex)).map(step => step.id));
      const downstream = task.completedStepIds.filter(id => id !== checkpoint.producerStepId && affected.has(id));
      task.completedStepIds = task.completedStepIds.filter(id => !affected.has(id));
      task.staleStepIds = [...new Set([...task.staleStepIds, checkpoint.producerStepId, ...downstream])];
      setStatus(task, checkpoint.producerStepId === '$triage' ? 'triaging' : 'queued', now);
    }
    return;
  }
  if (action.kind === 'approve') {
    if (review.kind === 'question' || review.kind === 'reconciliation') throw new Error('Review cannot be approved');
    requireDecisionRefs(task, review, action.artifactDigests);
    review.decision = 'approve';
    if (review.kind === 'workflow') {
      if (!task.proposedWorkflow) throw new Error('Proposed workflow missing');
      const former = task.workflow;
      const approved = task.proposedWorkflow;
      let unchangedPrefix = 0;
      while (former && unchangedPrefix < former.steps.length && unchangedPrefix < approved.steps.length &&
          JSON.stringify(former.steps[unchangedPrefix]) === JSON.stringify(approved.steps[unchangedPrefix])) {
        unchangedPrefix++;
      }
      const preserved = new Set(approved.steps.slice(0, unchangedPrefix).map(step => step.id));
      if (former) carryApprovals(task, former.version, approved.version, preserved);
      task.workflow = approved; task.proposedWorkflow = null;
      let firstInvalidatedIndex = unchangedPrefix;
      for (let index = 0; index < unchangedPrefix; index++) {
        const step = approved.steps[index];
        if (step.kind === 'human' && task.completedStepIds.includes(step.id) && !hasCurrentApproval(task, step.id)) {
          firstInvalidatedIndex = index;
          break;
        }
      }
      const invalidated = task.completedStepIds.filter(id =>
        !preserved.has(id) || approved.steps.findIndex(step => step.id === id) >= firstInvalidatedIndex);
      task.completedStepIds = task.completedStepIds.filter(id => !invalidated.includes(id));
      task.staleStepIds = [...new Set([...task.staleStepIds, ...invalidated])];
      const target = approved.steps.find(step => !task.completedStepIds.includes(step.id));
      if (!target) throw new Error('Revised workflow has no remaining step');
      task.currentStepId = target.id;
      if (target.kind === 'human') {
        task.reviews.push({ id: reviewId(task, target.id, 'artifact'), kind: 'artifact',
          workflowVersion: approved.version, stepId: target.id,
          artifacts: structuredClone(acceptedProducerArtifacts(task, target) ?? []),
          prompt: target.title, answer: null, decision: null });
        setStatus(task, 'waiting-for-human', now);
      } else setStatus(task, 'queued', now);
    } else if (review.kind === 'pause') {
      task.intent = null;
      setStatus(task, task.currentStepId === '$triage' ? 'triaging' : 'queued', now);
    } else {
      const checkpoint = task.workflow?.steps.find(step => step.id === review.stepId);
      if (!checkpoint || checkpoint.kind !== 'human') throw new Error('Review checkpoint missing');
      task.completedStepIds.push(checkpoint.id);
      task.staleStepIds = task.staleStepIds.filter(id => id !== checkpoint.id);
      advanceAfterStep(task, checkpoint.id, now);
    }
  }
}

export function reduceTask(task: Task, event: DomainEvent, now: string): Task {
  if (task.preparation || event.kind === 'preparation') {
    if (!task.preparation || event.kind !== 'preparation') throw new TransitionConflict('Command does not match task mode');
    return reducePreparation(task, event, now);
  }
  if (isTerminal(task.status)) throw new Error('Terminal task is immutable');
  const next = structuredClone(task);
  next.updatedAt = now;
  switch (event.kind) {
    case 'human': handleHuman(next, event.command, now); break;
    case 'launch': {
      const step = eligibleStep(next);
      if (!step || (step.id !== event.run.stepId && event.run.stepId !== `$resolve:${step.id}`)) throw new Error('Run step is not eligible');
      if (event.run.stepId.startsWith('$resolve:') && (step.actions.some(action => action !== 'read') && !step.repositories.length))
        throw new Error('Invalid repository resolution assignment');
      if (next.runs.some(run => run.phase === 'running' || run.phase === 'launch-intent')) throw new Error('Task already has an active attempt');
      if (next.runs.some(run => run.id === event.run.id)) throw new Error('Duplicate attempt ID');
      if (event.run.phase !== 'launch-intent' || event.run.generation !== next.generation + 1 ||
          event.run.workflowVersion !== (next.workflow?.version ?? null)) throw new Error('Invalid launch intent binding');
      next.generation = event.run.generation;
      next.runs.push(structuredClone(event.run));
      setStatus(next, 'running', now);
      break;
    }
    case 'started': {
      const run = requireRun(next, event.attemptId);
      if (run.phase !== 'launch-intent') throw new Error('Attempt has already started or ended');
      run.phase = 'running'; run.pid = event.pid; run.processStartedAt = event.processStartedAt;
      break;
    }
    case 'finished': {
      const run = requireActiveRun(next, event.attemptId);
      if (next.intent || event.generation !== next.generation || run.generation !== event.generation ||
          (run.stepId !== next.currentStepId && run.stepId !== `$resolve:${next.currentStepId}`) ||
          (run.workflowVersion !== null && (!next.workflow || run.workflowVersion > next.workflow.version)) ||
          (run.workflowVersion === null && next.workflow !== null)) {
        throw new Error('Finished attempt is stale or superseded');
      }
      if (event.exitCode !== 0) throw new Error('Successful result requires zero exit code');
      if (event.result.taskId !== next.id || event.result.attemptId !== run.id) throw new Error('Result task or attempt binding mismatch');
      run.phase = 'ended'; run.endedAt = now; run.exitCode = 0; run.result = structuredClone(event.result);
      next.artifacts.push(...structuredClone(event.result.artifacts));
      if (run.stepId.startsWith('$resolve:')) {
        if (event.result.kind !== 'completed') throw new Error('Repository preparation requires a completed result');
        setStatus(next, 'queued', now);
        break;
      }
      const result = event.result;
      if (result.kind === 'completed') {
        const step = run.stepId === '$triage' ? triageStep : next.workflow?.steps.find(item => item.id === run.stepId);
        if (!step || step.kind !== 'agent') throw new Error('Completed run does not match agent step');
        if (!step.checks.every(check => result.evidence[check]?.trim())) throw new Error('Completion checks lack evidence');
        if (run.stepId === '$triage') throw new Error('Triage must propose a workflow');
        next.completedStepIds.push(run.stepId);
        next.staleStepIds = next.staleStepIds.filter(id => id !== run.stepId);
        advanceAfterStep(next, run.stepId, now);
      } else if (result.kind === 'needs_human') {
        next.reviews.push({ id: reviewId(next, run.stepId, 'question'), kind: 'question',
          workflowVersion: next.workflow?.version ?? null, stepId: run.stepId,
          artifacts: result.artifacts, ...(event.bindQuestionAttempt ? { attemptId: run.id } : {}), prompt: result.question, answer: null, decision: null });
        setStatus(next, 'waiting-for-human', now);
      } else if (result.kind === 'propose_workflow_change') {
        if (result.workflow.version <= (next.workflow?.version ?? 0)) throw new Error('Proposed workflow version must increase');
        next.proposedWorkflow = structuredClone(result.workflow);
        next.title = result.title; next.type = result.taskType; next.projectId = result.projectId;
        next.reviews.push({ id: reviewId(next, run.stepId, 'workflow'), kind: 'workflow',
          workflowVersion: result.workflow.version, stepId: run.stepId,
          artifacts: result.artifacts, prompt: result.reason, answer: null, decision: null });
        setStatus(next, 'waiting-for-human', now);
      } else {
        next.blockedReason = result.reason;
        setStatus(next, 'blocked', now);
      }
      break;
    }
    case 'stopped': {
      const run = requireActiveRun(next, event.attemptId);
      run.phase = event.uncertainEffects ? 'uncertain' : 'ended'; run.endedAt = now;
      if (!settleStopIntent(next, event.uncertainEffects, now)) {
        next.blockedReason = event.uncertainEffects ? 'Stopped attempt has uncertain effects' : 'Attempt stopped';
        setStatus(next, 'blocked', now);
      }
      break;
    }
    case 'run-failed': {
      const run = requireActiveRun(next, event.attemptId);
      // Omitted markers preserve legacy immutable-event replay shapes.
      if (event.processExitConfirmed !== undefined) run.processExitConfirmed = event.processExitConfirmed;
      const confirmed = event.processExitConfirmed !== false;
      run.phase = event.uncertainEffects || !confirmed ? 'uncertain' : 'ended';
      run.endedAt = confirmed ? now : null; run.exitCode = event.exitCode; run.nextRetryAt = event.retryAt;
      if (!confirmed) {
        run.nextRetryAt = null; next.blockedReason = event.reason;
        setStatus(next, 'blocked', now);
        break;
      }
      if (settleStopIntent(next, event.uncertainEffects, now)) {
        run.nextRetryAt = null;
        break;
      }
      if (event.retryAt && !event.uncertainEffects && run.retryCount < 2 && !next.intent) {
        setStatus(next, run.stepId === '$triage' ? 'triaging' : 'queued', now);
      } else {
        run.nextRetryAt = null;
        next.blockedReason = event.reason;
        setStatus(next, 'blocked', now);
      }
      break;
    }
    case 'block': next.blockedReason = event.reason; setStatus(next, 'blocked', now); break;
  }
  return next;
}
