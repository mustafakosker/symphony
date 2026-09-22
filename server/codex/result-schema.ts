import { writeFile } from 'node:fs/promises';
import type { AgentResult, ArtifactRef, Workflow } from '../../shared/contracts.js';

const string = { type: 'string' }; const integer = { type: 'integer' };
const stringArray = { type: 'array', items: string };
const artifact = { type: 'object', additionalProperties: false,
  required: ['id', 'version', 'digest', 'path'],
  properties: { id: string, version: integer, digest: string, path: string } };
const agentStep = { type: 'object', additionalProperties: false,
  required: ['kind','id','title','role','instructions','inputs','repositories','actions','outputs','checks'],
  properties: { kind: { const: 'agent' }, id: string, title: string,
    role: { enum: ['triage','researcher','prd-writer','implementer','reviewer'] },
    instructions: string, inputs: { type: 'array', items: artifact }, repositories: stringArray,
    actions: { type: 'array', items: { enum: ['read','write-local','open-pr','merge','deploy'] } },
    outputs: stringArray, checks: stringArray } };
const humanStep = { type: 'object', additionalProperties: false,
  required: ['kind','id','title','producerStepId','artifactIds','allowsStepId'],
  properties: { kind: { const: 'human' }, id: string, title: string,
    producerStepId: string, artifactIds: stringArray, allowsStepId: { type: ['string','null'] } } };
const workflow = { type: 'object', additionalProperties: false,
  required: ['version','steps','completionChecks'], properties: { version: integer,
    steps: { type: 'array', items: { oneOf: [agentStep, humanStep] } }, completionChecks: stringArray } };
const base = { taskId: string, attemptId: string, summary: string,
  artifacts: { type: 'array', items: artifact } };
const variant = (kind: string, properties: Record<string, unknown>) => ({ type: 'object',
  additionalProperties: false, required: [...Object.keys(base), 'kind', ...Object.keys(properties)],
  properties: { ...base, kind: { const: kind }, ...properties } });
export const agentResultSchema = { $schema: 'http://json-schema.org/draft-07/schema#',
  oneOf: [variant('completed', { evidence: { type: 'object', additionalProperties: string } }),
    variant('needs_human', { question: string, checkpoint: string }),
    variant('propose_workflow_change', { workflow, reason: string, title: string, taskType: string,
      projectId: { type: ['string','null'] } }),
    variant('blocked', { reason: string }),
    variant('failed', { reason: string, retryable: { type: 'boolean' } })] };

export async function writeResultSchema(path: string): Promise<void> {
  await writeFile(path, JSON.stringify(agentResultSchema), { flag: 'wx', mode: 0o600 });
}

const obj = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => key in value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const roles = ['triage','researcher','prd-writer','implementer','reviewer'];
const actions = ['read','write-local','open-pr','merge','deploy'];
const artifactValid = (value: unknown): value is ArtifactRef => obj(value) &&
  exact(value, ['id','version','digest','path']) && typeof value.id === 'string' &&
  Number.isSafeInteger(value.version) && Number(value.version) > 0 &&
  typeof value.digest === 'string' && typeof value.path === 'string';
const stepValid = (value: unknown): boolean => {
  if (!obj(value)) return false;
  if (value.kind === 'human') return exact(value, ['kind','id','title','producerStepId','artifactIds','allowsStepId']) &&
    ['id','title','producerStepId'].every(key => typeof value[key] === 'string') && strings(value.artifactIds) &&
    (value.allowsStepId === null || typeof value.allowsStepId === 'string');
  return value.kind === 'agent' && exact(value, ['kind','id','title','role','instructions','inputs','repositories','actions','outputs','checks']) &&
    ['id','title','instructions'].every(key => typeof value[key] === 'string') && roles.includes(String(value.role)) &&
    Array.isArray(value.inputs) && value.inputs.every(artifactValid) &&
    [value.repositories,value.actions,value.outputs,value.checks].every(strings) &&
    (value.actions as string[]).every(action => actions.includes(action));
};
const workflowValid = (value: unknown): value is Workflow => obj(value) &&
  exact(value, ['version','steps','completionChecks']) && Number.isSafeInteger(value.version) &&
  Array.isArray(value.steps) && value.steps.every(stepValid) && strings(value.completionChecks);

export function parseAgentResult(value: unknown): AgentResult {
  if (!obj(value) || !['taskId','attemptId','summary'].every(key => typeof value[key] === 'string') ||
      !Array.isArray(value.artifacts) || !value.artifacts.every(artifactValid)) throw new Error('Invalid final result envelope');
  const common = ['taskId','attemptId','summary','artifacts','kind'];
  switch (value.kind) {
    case 'completed':
      if (exact(value, [...common,'evidence']) && obj(value.evidence) && Object.values(value.evidence).every(item => typeof item === 'string')) break;
      throw new Error('Invalid completed final result');
    case 'needs_human':
      if (exact(value, [...common,'question','checkpoint']) && typeof value.question === 'string' && typeof value.checkpoint === 'string') break;
      throw new Error('Invalid needs_human final result');
    case 'propose_workflow_change':
      if (exact(value, [...common,'workflow','reason','title','taskType','projectId']) && workflowValid(value.workflow) &&
        ['reason','title','taskType'].every(key => typeof value[key] === 'string') &&
        (value.projectId === null || typeof value.projectId === 'string')) break;
      throw new Error('Invalid workflow final result');
    case 'blocked':
      if (exact(value, [...common,'reason']) && typeof value.reason === 'string') break;
      throw new Error('Invalid blocked final result');
    case 'failed':
      if (exact(value, [...common,'reason','retryable']) && typeof value.reason === 'string' && typeof value.retryable === 'boolean') break;
      throw new Error('Invalid failed final result');
    default: throw new Error('Unknown final result kind');
  }
  return value as AgentResult;
}
