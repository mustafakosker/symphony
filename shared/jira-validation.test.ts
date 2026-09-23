import { expect, it } from 'vitest';
import { parseTask } from './validate';
import { draftTask } from '../server/testing/fixtures';
import { artifact, jiraTask } from '../server/preparation/testing';

it('preserves preparation on round-trip and leaves legacy event state unchanged', () => {
  expect(parseTask(draftTask())).toEqual(draftTask());
  expect(parseTask(jiraTask())).toEqual(jiraTask());
});
it.each([
  { status: 'queued' }, { currentStepId: '$triage' }, { intent: 'pause' },
  { workflow: { version: 1, steps: [], completionChecks: [] } },
])('rejects preparation with generic execution state %j', override => {
  expect(() => parseTask({ ...jiraTask(), ...override })).toThrow();
});
it('rejects a selected document not bound to published task artifacts', () => {
  const task = jiraTask();
  task.preparation!.documents.design = { role: 'design', filename: 'design.md', size: 10, ref: artifact() };
  expect(() => parseTask(task)).toThrow();
});
it('rejects unsafe source links and mismatched document roles', () => {
  const task = jiraTask();
  task.preparation!.source.url = 'javascript:alert(1)';
  expect(() => parseTask(task)).toThrow();
  const valid = jiraTask({ artifacts: [artifact()] });
  valid.preparation!.documents.implementation = { role: 'design', filename: 'x.md', size: 10, ref: artifact() };
  expect(() => parseTask(valid)).toThrow();
});
it('rejects acceptance without a bound receipt', () => {
  const task = jiraTask({ artifacts: [artifact('jira-package')] });
  task.preparation!.attempts = [{ requestId: 'request-1', packageRef: artifact('jira-package'),
    payloadDigest: 'a'.repeat(64), dispatch: 1, status: 'accepted', receipt: null, reason: null }];
  expect(() => parseTask(task)).toThrow();
});
