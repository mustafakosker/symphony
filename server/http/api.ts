import { randomUUID } from 'node:crypto';
import type { RequestListener, ServerResponse } from 'node:http';
import { BoundaryError, parseCommand } from '../../shared/validate.js';
import { applyHumanCommand } from '../coordinator/reviews.js';
import type { Store } from '../store/task-store.js';
import type { Intake } from '../intake/intake.js';
import type { Coordinator } from '../coordinator/coordinator.js';
import { checkAccess, HttpError, readJson } from './access.js';

type Deps = { store: Store; intake: Intake; coordinator: Coordinator; allowedOrigin: string;
  runtimeVersion?: () => string; health?: () => 'ready' | 'degraded';
  issues?: () => Promise<import('../../shared/contracts.js').Issue[]> };
const token = '[A-Za-z0-9][A-Za-z0-9._-]*';
const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
const taskRoute = new RegExp(`^/api/tasks/(${uuid})$`);
const commandRoute = new RegExp(`^/api/tasks/(${uuid})/commands$`);
const logRoute = new RegExp(`^/api/tasks/(${uuid})/runs/(${uuid})/log$`);
const artifactRoute = new RegExp(`^/api/tasks/(${uuid})/artifacts/(${token})$`);

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BoundaryError('invalid', 'Request must be a JSON object');
  return value as Record<string, unknown>;
}
function status(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof BoundaryError) return ({ invalid: 400, missing: 404, conflict: 409, unavailable: 503 })[error.code];
  return 503;
}

export function createApi(deps: Deps): RequestListener {
  return (request, response) => {
    void (async () => {
      const method = request.method ?? '';
      if (!request.url?.startsWith('/') || request.url.startsWith('//'))
        throw new BoundaryError('invalid', 'Invalid request target');
      const url = new URL(request.url ?? '/', deps.allowedOrigin);
      const path = url.pathname;
      const mutation = method === 'POST';
      checkAccess(request, deps.allowedOrigin, mutation);
      if (method === 'GET' && path === '/api/workspace') {
        const view = await deps.store.list();
        const [intakeIssues, startupIssues] = await Promise.all([deps.intake.issues(), deps.issues?.() ?? []]);
        send(response, 200, { ...view, issues: [...view.issues, ...intakeIssues, ...startupIssues],
          coordinator: view.coordinator === 'degraded' || deps.health?.() === 'degraded' ? 'degraded' : 'ready' });
        return;
      }
      if (method === 'GET' && path === '/api/health') {
        const view = await deps.store.list();
        send(response, 200, { status: view.coordinator === 'degraded' || deps.health?.() === 'degraded' ? 'degraded' : 'ready',
          runtimeVersion: deps.runtimeVersion?.() ?? 'unavailable' });
        return;
      }
      const taskMatch = path.match(taskRoute);
      if (method === 'GET' && taskMatch) { send(response, 200, await deps.store.get(taskMatch[1])); return; }
      if (method === 'POST' && path === '/api/drafts') {
        const value = object(await readJson(request));
        if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.requestId) ||
          typeof value.markdown !== 'string') throw new BoundaryError('invalid', 'Invalid draft request');
        send(response, 202, await deps.intake.submit(value.markdown, value.requestId)); return;
      }
      const commandMatch = path.match(commandRoute);
      if (method === 'POST' && commandMatch) {
        const raw = object(await readJson(request));
        if (raw.taskId !== commandMatch[1]) throw new BoundaryError('invalid', 'Command task ID does not match URL');
        if (raw.expectedRevision === 0) throw new BoundaryError('conflict', 'Task revision has changed');
        const command = parseCommand(raw);
        send(response, 200, await applyHumanCommand(deps.store, deps.coordinator, command)); return;
      }
      const logMatch = path.match(logRoute);
      if (method === 'GET' && logMatch) {
        const offsetText = url.searchParams.get('offset') ?? '0';
        if (!/^(0|[1-9]\d*)$/.test(offsetText) || !Number.isSafeInteger(Number(offsetText)))
          throw new BoundaryError('invalid', 'Invalid log offset');
        const stream = url.searchParams.get('stream') ?? 'stdout';
        if (stream !== 'stdout' && stream !== 'stderr') throw new BoundaryError('invalid', 'Invalid log stream');
        // JSON escapes can expand a byte to six ASCII characters (for example NUL).
        const live = await deps.coordinator.readLiveLog?.(logMatch[1], logMatch[2], Number(offsetText), 10 * 1024, stream);
        send(response, 200, live ?? await deps.store.readRunLog(logMatch[1], logMatch[2], Number(offsetText), 10 * 1024, stream)); return;
      }
      const artifactMatch = path.match(artifactRoute);
      if (method === 'GET' && artifactMatch) {
        const versionText = url.searchParams.get('version');
        if (versionText !== null && (!/^[1-9]\d*$/.test(versionText) || !Number.isSafeInteger(Number(versionText))))
          throw new BoundaryError('invalid', 'Invalid artifact version');
        const task = await deps.store.get(artifactMatch[1]);
        const refs = task.artifacts.filter(item => item.id === artifactMatch[2]);
        const ref = versionText === null ? refs.sort((a, b) => b.version - a.version)[0] : refs.find(item => item.version === Number(versionText));
        if (!ref) throw new BoundaryError('missing', 'Artifact does not exist');
        const bytes = await deps.store.readArtifact(task.id, ref);
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${ref.id}.${ref.version}.txt"`,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox" });
        response.end(bytes); return;
      }
      send(response, 404, { error: 'Route not found' });
    })().catch(error => {
      const operationId = randomUUID();
      console.error(`[api ${operationId}]`, error);
      if (!response.headersSent) send(response, status(error), { error: error instanceof HttpError && error.status < 500 ? error.message :
        error instanceof BoundaryError && error.code !== 'unavailable' ? error.message : 'Operation unavailable', operationId });
      else response.destroy();
    });
  };
}
