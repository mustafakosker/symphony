import { execFile } from 'node:child_process';

const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal?.throwIfAborted();
  const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(finish, ms);
  const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('Termination abandoned')); };
  signal?.addEventListener('abort', abort, { once: true });
});
const exists = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const groupExists = (pid: number) => { try { process.kill(-pid, 0); return true; } catch { return false; } };

function liveGroupMembers(pid: number, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (!groupExists(pid)) return Promise.resolve(false);
  return new Promise((resolve, reject) => execFile('ps', ['-axo', 'pgid=,stat='], { timeout: 5000, signal }, (error, output) => {
    if (error) { reject(new Error(`Cannot verify stopped process group ${pid}: ${error.message}`)); return; }
    resolve(output.split('\n').some(line => {
      const match = line.trim().match(/^(\d+)\s+(\S+)/);
      return match && Number(match[1]) === pid && !match[2].startsWith('Z');
    }));
  }));
}

function taskkill(pid: number, force: boolean, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => execFile('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])],
    { timeout: 5000, signal }, error => error && exists(pid) ? reject(error) : resolve()));
}

export async function stopProcessTree(pid: number, graceMs: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process ID');
  signal?.throwIfAborted();
  if (process.platform === 'win32') {
    await taskkill(pid, false, signal);
    await pause(graceMs, signal);
    if (exists(pid)) await taskkill(pid, true, signal);
    if (exists(pid)) throw new Error(`Could not stop process tree ${pid}`);
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return;
  }
  const until = Date.now() + graceMs;
  while (Date.now() < until && groupExists(pid)) await pause(Math.min(25, until - Date.now()), signal);
  signal?.throwIfAborted();
  if (groupExists(pid)) {
    try { process.kill(-pid, 'SIGKILL'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  const killedBy = Date.now() + Math.max(1000, graceMs);
  while (Date.now() < killedBy && await liveGroupMembers(pid, signal)) await pause(25, signal);
  if (await liveGroupMembers(pid, signal)) throw new Error(`Could not verify stopped process group ${pid}`);
}
