import { createServer, type Server } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Runner } from './codex/adapter.js';
import { createCodexRunner } from './codex/adapter.js';
import { verifyConfiguredProfiles } from './codex/capability.js';
import { loadRegistry, type RoleConfig } from './config/registry.js';
import { loadSettings, type Settings } from './config/settings.js';
import { createCoordinator } from './coordinator/coordinator.js';
import { applyHumanCommand } from './coordinator/reviews.js';
import { createFileReviews, type FileReviewAdapter } from './file-reviews/adapter.js';
import { recoverAttempts } from './coordinator/recovery.js';
import { createApi } from './http/api.js';
import { createStaticHandler } from './http/static.js';
import { createIntake } from './intake/intake.js';
import { acquireHostLock } from './store/lock.js';
import { openStore } from './store/task-store.js';

type TestOnlyInjection = { runner?: Runner;
  verifyCapabilities?: (settings: Settings, roles: RoleConfig[], version: string) => Promise<void> };
type Options = { configPath?: string; buildDir?: string } & TestOnlyInjection;
export type Application = { address: string; close(): Promise<void> };

const defaultBuildDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist');
export const defaultConfigPath = () => resolve(process.env.SYMPHONY_CONFIG ?? 'symphony.config.json');

export async function startApplication(options: Options = {}): Promise<Application> {
  const configPath = options.configPath ?? defaultConfigPath();
  let releaseLock: (() => Promise<void>) | null = null;
  let server: Server | null = null;
  let coordinator: ReturnType<typeof createCoordinator> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let ticking: Promise<void> | null = null;
  let stopping = false;
  let degraded = false;
  try {
    const settings = await loadSettings(configPath);
    releaseLock = await acquireHostLock(settings.localRoot);
    const registry = await loadRegistry(settings.workspaceRoot);
    const store = await openStore(settings.workspaceRoot);
    const startupIssues = await recoverAttempts(store, settings.localRoot);
    if (startupIssues.some(issue => issue.message.includes('could not be persisted'))) throw new Error('Startup recovery could not persist an uncertain run');
    const runner = options.runner ?? createCodexRunner(settings);
    const { version } = await runner.probe();
    await (options.verifyCapabilities ?? verifyConfiguredProfiles)(settings, registry.roles, version);
    const intake = createIntake(settings.workspaceRoot, store, settings.stableMs);
    let fileReviews: FileReviewAdapter | undefined;
    coordinator = createCoordinator({ store, intake, registry, runner, settings, recovered: true,
      beforeDispatch: async now => { await fileReviews?.scan(now.getTime()); } });
    const activeCoordinator = coordinator;
    if (settings.fileReviewsEnabled) {
      fileReviews = createFileReviews({ store, workspaceRoot: settings.workspaceRoot,
        localRoot: settings.localRoot, stableMs: settings.stableMs,
        apply: command => applyHumanCommand(store, activeCoordinator, command) });
    }
    const ui = createStaticHandler(options.buildDir ?? defaultBuildDir);
    const api = createApi({ store, intake, coordinator, allowedOrigin: settings.allowedOrigin,
      runtimeVersion: () => version, health: () => degraded ? 'degraded' : 'ready',
      issues: async () => [...startupIssues, ...(await fileReviews?.issues() ?? [])] });
    server = createServer((request, response) => {
      if ((request.url ?? '').startsWith('/api/')) api(request, response);
      else ui(request, response);
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server!.once('error', rejectListen);
      server!.listen(settings.port, '127.0.0.1', () => {
        server!.off('error', rejectListen);
        resolveListen();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP server did not bind a TCP address');
    const schedule = () => {
      if (stopping || degraded) return;
      ticking = coordinator!.tick(new Date()).catch(error => {
        degraded = true;
        console.error('[coordinator] Scheduling stopped:', error);
      }).finally(() => {
        ticking = null;
        if (!stopping && !degraded) timer = setTimeout(schedule, settings.scanMs);
      });
    };
    timer = setTimeout(schedule, 0);
    const ownedServer = server;
    const ownedCoordinator = coordinator;
    const ownedLock = releaseLock;
    return { address: `http://127.0.0.1:${address.port}`,
      async close() {
        if (stopping) return;
        stopping = true;
        if (timer) clearTimeout(timer);
        let clean = false;
        try {
          await ownedCoordinator.shutdown();
          if (ticking) {
            let deadline: NodeJS.Timeout | undefined;
            try {
              await Promise.race([ticking, new Promise<void>((_, reject) => {
                deadline = setTimeout(() => reject(new Error('Scheduler tick did not finish before shutdown deadline')),
                  Math.max(1000, settings.stopGraceMs * 2 + 1000));
              })]);
            } finally { if (deadline) clearTimeout(deadline); }
          }
          clean = true;
        }
        finally {
          await new Promise<void>(resolveClose => ownedServer.close(() => resolveClose()));
          if (clean) await ownedLock();
        }
      } };
  } catch (error) {
    stopping = true;
    if (timer) clearTimeout(timer);
    let clean = true;
    await coordinator?.shutdown().catch(cause => { clean = false; console.error('[startup] Coordinator shutdown failed:', cause); });
    if (server?.listening) await new Promise<void>(resolveClose => server!.close(() => resolveClose()));
    if (clean) await releaseLock?.();
    throw new Error(`Symphony startup failed with ${configPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startApplication().then(app => {
    console.log(`Symphony listening at ${app.address}`);
    let closing = false;
    const shutdown = (signal: string) => {
      if (closing) return;
      closing = true;
      console.log(`Stopping after ${signal}`);
      void app.close().catch(error => { console.error('[shutdown]', error); process.exitCode = 1; });
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
