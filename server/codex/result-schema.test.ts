import { expect, it } from 'vitest';
import { parseAgentResult } from './result-schema.js';

it('normalizes the strict API envelope and evidence entries into domain results', () => {
  expect(parseAgentResult({ result: {
    kind: 'completed', taskId: 'task', attemptId: 'run', summary: 'Done', artifacts: [],
    evidence: [{ id: 'report', text: 'Findings' }],
  } })).toEqual({ kind: 'completed', taskId: 'task', attemptId: 'run', summary: 'Done',
    artifacts: [], evidence: { report: 'Findings' } });
});

it('rejects duplicate evidence IDs in an API envelope', () => {
  expect(() => parseAgentResult({ result: {
    kind: 'completed', taskId: 'task', attemptId: 'run', summary: 'Done', artifacts: [],
    evidence: [{ id: 'report', text: 'First' }, { id: 'report', text: 'Second' }],
  } })).toThrow();
});
