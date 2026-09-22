import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { stopProcessTree } from './process-control.js';

it('abandons a pending termination probe promptly after its owner gives up', async () => {
  if (process.platform === 'win32') return;
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  if (!child.pid) throw new Error('Child process did not spawn');
  try {
    await Promise.race([
      new Promise<void>(resolve => child.stdout.once('data', () => resolve())),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Child readiness timed out')), 1000)),
    ]);
    const controller = new AbortController();
    const started = Date.now();
    const stopping = stopProcessTree(child.pid, 1000, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(stopping).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(500);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    child.stdout.destroy();
    child.unref();
  }
});
