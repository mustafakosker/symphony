import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntake } from './intake.js';
import { openStore } from '../store/task-store.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'symphony-intake-')); await mkdir(join(root, 'drafts')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function setup() { const store = await openStore(root); return { store, intake: createIntake(root, store, 2000) }; }

describe('intake', () => {
  it('waits for two stable observations and ignores replay', async () => {
    const { store, intake } = await setup();
    await writeFile(join(root, 'drafts', 'idea.md'), 'Investigate login failures');
    await intake.scan(0);
    expect((await store.list()).tasks).toHaveLength(0);
    await intake.scan(2001);
    const [task] = (await store.list()).tasks;
    expect(task.idea).toBe('Investigate login failures');
    await writeFile(join(root, 'drafts', 'idea.md'), 'Investigate login failures');
    await intake.scan(3000); await intake.scan(5001);
    expect((await store.list()).tasks.map(t => t.id)).toEqual([task.id]);
  });

  it('replays a receipt after a failed create with original timestamps', async () => {
    const { store } = await setup();
    await writeFile(join(root, 'drafts', 'idea.md'), 'A');
    const failingStore = { ...store, create: async () => { throw new Error('crash'); } };
    const intake = createIntake(root, failingStore, 2000);
    await intake.scan(0);
    await expect(intake.scan(2001)).resolves.toBeUndefined();
    const restarted = createIntake(root, await openStore(root), 2000);
    await restarted.scan(9000);
    const tasks = (await (await openStore(root)).list()).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].createdAt).toBe(new Date(2001).toISOString());
    expect(await readdir(join(root, 'drafts'))).toEqual([]);
  });

  it('does not duplicate a materialized task when the inbox copy remains', async () => {
    const { store } = await setup();
    await writeFile(join(root, 'drafts', 'idea.md'), 'A');
    const failingStore = { ...store, create: async () => { throw new Error('crash'); } };
    const intake = createIntake(root, failingStore, 2000);
    await intake.scan(0); await intake.scan(2001);
    const [name] = await readdir(join(root, '.intake', 'receipts'));
    const receipt = JSON.parse(await readFile(join(root, '.intake', 'receipts', name), 'utf8'));
    await store.create(receipt.task, receipt.operationId);
    const restartedStore = await openStore(root);
    await createIntake(root, restartedStore, 2000).scan(9000);
    expect((await restartedStore.list()).tasks).toHaveLength(1);
    expect(await readdir(join(root, 'drafts'))).toEqual([]);
  });

  it('keeps claimed original bytes when source changes before materialization', async () => {
    const { store } = await setup();
    await writeFile(join(root, 'drafts', 'idea.md'), 'Original');
    const failingStore = { ...store, create: async () => { throw new Error('crash'); } };
    const intake = createIntake(root, failingStore, 2000);
    await intake.scan(0); await intake.scan(2001);
    await writeFile(join(root, 'drafts', 'idea.md'), 'New version');
    const restartedStore = await openStore(root);
    const restarted = createIntake(root, restartedStore, 2000);
    await restarted.scan(9000);
    expect((await restartedStore.list()).tasks.map(t => t.idea)).toEqual(['Original']);
    const names = await readdir(join(root, '.intake', 'conflicts'));
    expect(await readFile(join(root, '.intake', 'conflicts', names[0]), 'utf8')).toBe('New version');
  });

  it('preserves changed claimed bytes as a conflict', async () => {
    const { store, intake } = await setup();
    await writeFile(join(root, 'drafts', 'idea.md'), 'First');
    await intake.scan(0); await intake.scan(2001);
    await writeFile(join(root, 'drafts', 'idea.md'), 'Changed');
    await intake.scan(3000); await intake.scan(5001);
    expect((await store.list()).tasks).toHaveLength(1);
    expect((await intake.issues()).some(issue => issue.message.includes('conflict'))).toBe(true);
    const names = (await readdir(join(root, '.intake', 'conflicts'))).filter(name => name.endsWith('.md'));
    expect(names).toHaveLength(1);
    expect(await readFile(join(root, '.intake', 'conflicts', names[0]), 'utf8')).toBe('Changed');
  });

  it('archives a replacement swapped in immediately before cleanup', async () => {
    const { store } = await setup();
    await writeFile(join(root, 'drafts', 'idea.md'), 'Original');
    let replaced = false;
    const intake = createIntake(root, store, 2000, { rename: async (from, to) => {
      if (!replaced && String(from).endsWith('drafts/idea.md')) {
        replaced = true;
        await writeFile(from, 'Replacement');
      }
      return fs.rename(from, to);
    } });
    await intake.scan(0); await intake.scan(2001);
    expect((await store.list()).tasks.map(task => task.idea)).toEqual(['Original']);
    const conflicts = await readdir(join(root, '.intake', 'conflicts'));
    expect(conflicts.some(name => name.endsWith('.md'))).toBe(true);
    const archived = await Promise.all(conflicts.filter(name => name.endsWith('.md')).map(name => readFile(join(root, '.intake', 'conflicts', name), 'utf8')));
    expect(archived).toContain('Replacement');
  });

  it('leaves a new source published after the atomic move untouched', async () => {
    const { store } = await setup();
    const source = join(root, 'drafts', 'idea.md');
    await writeFile(source, 'Original');
    const intake = createIntake(root, store, 2000, { rename: async (from, to) => {
      await fs.rename(from, to);
      if (String(from).endsWith('/drafts/idea.md')) await writeFile(source, 'New source');
    } });
    await intake.scan(0); await intake.scan(2001);
    expect(await readFile(source, 'utf8')).toBe('New source');
    await intake.scan(3000);
    expect((await intake.issues()).some(issue => issue.message.includes('conflict'))).toBe(true);
    expect((await store.list()).tasks.map(task => task.idea)).toEqual(['Original']);
  });

  it('retains the received inode and reports writes through an old file descriptor', async () => {
    const { store, intake } = await setup();
    const source = join(root, 'drafts', 'idea.md');
    await writeFile(source, 'Original');
    const writer = await fs.open(source, 'r+');
    try {
      await intake.scan(0); await intake.scan(2001);
      const [received] = await readdir(join(root, '.intake', 'received'));
      expect(received).toBeDefined();
      await writer.write(Buffer.from('Changed!'), 0, 8, 0);
      await writer.sync();
      await intake.scan(3000);
      const issues = await intake.issues();
      const [task] = (await store.list()).tasks;
      expect(issues.some(issue => issue.taskId === task.id && issue.message.includes('conflict'))).toBe(true);
      expect(await readFile(join(root, '.intake', 'received', received), 'utf8')).toBe('Changed!');
    } finally { await writer.close(); }
  });

  it('retains an oversized replacement as a task-bound conflict', async () => {
    const { store } = await setup();
    await writeFile(join(root, 'drafts', 'idea.md'), 'Original');
    const oversized = Buffer.alloc(1024 * 1024 + 1, 88);
    const intake = createIntake(root, store, 2000, { rename: async (from, to) => {
      if (String(from).endsWith('/drafts/idea.md')) await writeFile(from, oversized);
      await fs.rename(from, to);
    } });
    await intake.scan(0); await intake.scan(2001);
    const [task] = (await store.list()).tasks;
    const [received] = await readdir(join(root, '.intake', 'received'));
    expect((await fs.stat(join(root, '.intake', 'received', received))).size).toBe(oversized.length);
    expect((await intake.issues()).some(issue => issue.taskId === task.id && issue.message.includes('conflict'))).toBe(true);
    const restarted = createIntake(root, await openStore(root), 2000);
    await restarted.scan(9000);
    expect((await restarted.issues()).some(issue => issue.taskId === task.id && issue.message.includes('conflict'))).toBe(true);
  });

  it('recovers a held file after a crash between rename and inspection', async () => {
    const { store } = await setup();
    await writeFile(join(root, 'drafts', 'idea.md'), 'Original');
    let crashed = false;
    const intake = createIntake(root, store, 2000, { rename: async (from, to) => {
      await fs.rename(from, to);
      if (!crashed && String(from).endsWith('drafts/idea.md')) { crashed = true; throw new Error('simulated crash'); }
    } });
    await intake.scan(0); await expect(intake.scan(2001)).rejects.toThrow('simulated crash');
    expect((await readdir(join(root, '.intake', 'holding'))).length).toBe(1);
    const restarted = createIntake(root, await openStore(root), 2000);
    await restarted.scan(9000);
    expect(await readdir(join(root, '.intake', 'holding'))).toEqual([]);
    expect((await store.list()).tasks).toHaveLength(1);
  });

  it('retains an archived conflict issue after source removal and restart', async () => {
    const { store, intake } = await setup();
    await writeFile(join(root, 'drafts', 'idea.md'), 'Original');
    await intake.scan(0); await intake.scan(2001);
    await writeFile(join(root, 'drafts', 'idea.md'), 'Changed');
    await intake.scan(3000);
    await rm(join(root, 'drafts', 'idea.md'), { force: true });
    const restarted = createIntake(root, await openStore(root), 2000);
    await restarted.scan(9000);
    expect((await restarted.issues()).some(issue => issue.message.includes('conflict'))).toBe(true);
    expect((await store.list()).tasks).toHaveLength(1);
  });

  it('preserves BOM, independent equal drafts, and UTF-8 filenames', async () => {
    const { store, intake } = await setup();
    await writeFile(join(root, 'drafts', 'café.md'), Buffer.from([0xef, 0xbb, 0xbf, 65]));
    await writeFile(join(root, 'drafts', 'other.md'), Buffer.from([0xef, 0xbb, 0xbf, 65]));
    await intake.scan(0); await intake.scan(2001);
    const tasks = (await store.list()).tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks.every(task => task.idea.charCodeAt(0) === 0xfeff)).toBe(true);
    for (const task of tasks) expect(await readFile(join(root, 'active', task.id, 'idea.md'))).toEqual(Buffer.from([0xef, 0xbb, 0xbf, 65]));
  });

  it('flags different bytes under canonically equivalent filenames', async () => {
    const { store, intake } = await setup();
    await writeFile(join(root, 'drafts', 'café.md'), 'First');
    await intake.scan(0); await intake.scan(2001);
    await writeFile(join(root, 'drafts', 'cafe\u0301.md'), 'Second');
    await intake.scan(3000);
    expect((await store.list()).tasks).toHaveLength(1);
    expect((await intake.issues()).some(issue => issue.message.includes('conflict'))).toBe(true);
  });

  it('reports invalid bytes, blank and oversized drafts without deleting them', async () => {
    const { store, intake } = await setup();
    await writeFile(join(root, 'drafts', 'bad.md'), Buffer.from([0xff]));
    await writeFile(join(root, 'drafts', 'blank.md'), ' \n');
    await writeFile(join(root, 'drafts', 'huge.md'), 'x'.repeat(1024 * 1024 + 1));
    await intake.scan(0); await intake.scan(2001);
    expect((await store.list()).tasks).toHaveLength(0);
    expect(await intake.issues()).toHaveLength(3);
    expect((await readdir(join(root, 'drafts'))).length).toBe(3);
  });

  it('bounds the read when a draft grows after its size check', async () => {
    const { store } = await setup();
    const source = join(root, 'drafts', 'growing.md');
    await writeFile(source, 'Small');
    let grew = false;
    let largestReadBuffer = 0;
    const intake = createIntake(root, store, 2000, { open: async (...args) => {
      const handle = await fs.open(...args);
      if (!String(args[0]).endsWith('/drafts/growing.md')) return handle;
      return { ...handle,
        stat: async () => {
          const before = await handle.stat();
          if (!grew) { grew = true; await writeFile(source, Buffer.alloc(2 * 1024 * 1024, 65)); }
          return before;
        },
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          largestReadBuffer = Math.max(largestReadBuffer, buffer.length);
          return handle.read(buffer, offset, length, position);
        },
        readFile: async () => { throw new Error('unbounded readFile called'); },
        close: () => handle.close(),
      } as typeof handle;
    } });
    await intake.scan(0); await intake.scan(2001);
    expect(largestReadBuffer).toBeLessThanOrEqual(1024 * 1024 + 1);
    expect((await store.list()).tasks).toHaveLength(0);
    expect((await intake.issues()).some(issue => issue.message.includes('1 MiB'))).toBe(true);
  });

  it('ignores temporary entries and rejects symlink sources', async () => {
    const { store, intake } = await setup();
    await writeFile(join(root, 'outside.md'), 'Outside');
    await symlink(join(root, 'outside.md'), join(root, 'drafts', 'link.md'));
    await writeFile(join(root, 'drafts', 'temp.tmp'), 'Temporary');
    await mkdir(join(root, 'drafts', 'folder.md'));
    await intake.scan(0); await intake.scan(2001);
    expect((await store.list()).tasks).toHaveLength(0);
    expect((await intake.issues()).some(issue => issue.message.includes('symbolic'))).toBe(true);
  });

  it('refuses a symlink swapped between source stat and read', async () => {
    const { store } = await setup();
    const source = join(root, 'drafts', 'idea.md');
    const outside = join(root, 'outside.md');
    await writeFile(source, 'Safe');
    await writeFile(outside, 'External');
    let swapped = false;
    const intake = createIntake(root, store, 2000, { open: async (...args) => {
      if (!swapped && String(args[0]).endsWith('/drafts/idea.md')) {
        swapped = true;
        await rm(source);
        await symlink(outside, source);
      }
      return fs.open(...args);
    } });
    await intake.scan(0); await intake.scan(2001);
    expect((await store.list()).tasks).toHaveLength(0);
    expect((await intake.issues()).some(issue => issue.message.includes('symbolic'))).toBe(true);
  });

  it('publishes submit idempotently and rejects a changed request', async () => {
    const { store, intake } = await setup();
    const first = await intake.submit('Hello', 'request-1');
    expect(await intake.submit('Hello', 'request-1')).toEqual(first);
    await expect(intake.submit('Changed', 'request-1')).rejects.toMatchObject({ code: 'conflict' });
    expect((await store.list()).tasks).toHaveLength(0);
    await intake.scan(0); await intake.scan(2001);
    expect((await store.list()).tasks).toHaveLength(1);
  });

  it('recovers submission publication and serializes concurrent retries', async () => {
    const { store, intake } = await setup();
    const [first, second] = await Promise.all([
      intake.submit('Hello', 'request-2'), intake.submit('Hello', 'request-2'),
    ]);
    expect(second).toEqual(first);
    await rm(join(root, 'drafts', `${first.submissionId}.md`));
    const restarted = createIntake(root, store, 2000);
    await restarted.scan(0); await restarted.scan(2001);
    expect((await store.list()).tasks.map(task => task.idea)).toEqual(['Hello']);
  });
});
