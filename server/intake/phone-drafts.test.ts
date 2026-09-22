import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntake } from './intake.js';
import { openStore } from '../store/task-store.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'symphony-phone-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const phone = (name: string) => join(root, 'drafts/phone', name);
async function setup() {
  const store = await openStore(root);
  const intake = createIntake(root, store, 2000, {}, { phoneDraftsEnabled: true });
  await intake.scan(0);
  return { store, intake };
}

it('provides a blank template and leaves autosaved ideas untouched across restarts', async () => {
  const { store, intake } = await setup();
  expect(await readdir(phone(''))).toEqual(['New idea-001.md']);
  expect(await readFile(phone('New idea-001.md'), 'utf8')).toBe('');
  await writeFile(phone('New idea-001.md'), 'Still thinking');
  await intake.scan(3000); await intake.scan(6000);
  await createIntake(root, store, 2000, {}, { phoneDraftsEnabled: true }).scan(9000);
  expect((await store.list()).tasks).toHaveLength(0);
  expect(await readFile(phone('New idea-001.md'), 'utf8')).toBe('Still thinking');
  expect(await intake.issues()).toEqual([]);
});

it('submits only a renamed stable draft and prepares the next numbered template', async () => {
  const { store, intake } = await setup();
  await writeFile(phone('New idea-001.md'), 'My first idea');
  await rename(phone('New idea-001.md'), phone('New idea-001.ready.md'));
  await intake.scan(3000);
  expect((await store.list()).tasks).toHaveLength(0);
  await intake.scan(5001);
  const [task] = (await store.list()).tasks;
  expect(task).toMatchObject({ idea: 'My first idea', source: 'drafts/phone/New idea-001.ready.md' });
  expect(await readdir(phone(''))).toEqual(['New idea-002.md']);
  expect(await readFile(phone('New idea-002.md'), 'utf8')).toBe('');
  await writeFile(phone('New idea-002.md'), 'My first idea');
  await rename(phone('New idea-002.md'), phone('New idea-002.ready.md'));
  await intake.scan(8000); await intake.scan(10001);
  expect((await store.list()).tasks).toHaveLength(2);
  expect(await readdir(phone(''))).toEqual(['New idea-003.md']);
});

it('does not resubmit a delayed copy and preserves changed copies as conflicts', async () => {
  const { store, intake } = await setup();
  await writeFile(phone('New idea-001.md'), 'Original');
  await rename(phone('New idea-001.md'), phone('New idea-001.ready.md'));
  await intake.scan(3000); await intake.scan(5001);
  await writeFile(phone('New idea-001.ready.md'), 'Original');
  const restarted = createIntake(root, store, 2000, {}, { phoneDraftsEnabled: true });
  await restarted.scan(8000); await restarted.scan(10001);
  expect((await store.list()).tasks).toHaveLength(1);
  await writeFile(phone('New idea-001.ready.md'), 'Late edits');
  await restarted.scan(13000);
  expect((await store.list()).tasks.map(task => task.idea)).toEqual(['Original']);
  expect((await restarted.issues()).some(issue => issue.message.includes('conflict'))).toBe(true);
  expect(await readFile(phone('New idea-002.md'), 'utf8')).toBe('');
});

it('leaves an empty submission available to rename back and correct', async () => {
  const { store, intake } = await setup();
  await rename(phone('New idea-001.md'), phone('New idea-001.ready.md'));
  await intake.scan(3000); await intake.scan(5001);
  expect((await store.list()).tasks).toHaveLength(0);
  expect(await readdir(phone(''))).toEqual(['New idea-001.ready.md']);
  expect((await intake.issues()).some(issue => issue.message.includes('blank'))).toBe(true);
  await rename(phone('New idea-001.ready.md'), phone('New idea-001.md'));
  await writeFile(phone('New idea-001.md'), 'Corrected idea');
  await intake.scan(8000); await intake.scan(10001);
  expect((await store.list()).tasks).toHaveLength(0);
  await rename(phone('New idea-001.md'), phone('New idea-001.ready.md'));
  await intake.scan(13000); await intake.scan(15001);
  expect((await store.list()).tasks.map(task => task.idea)).toEqual(['Corrected idea']);
  expect(await intake.issues()).toEqual([]);
});

it('recovers a claimed submission after task creation failed without advancing early', async () => {
  const { store } = await setup();
  const intake = createIntake(root, { ...store, create: async () => { throw new Error('offline'); } },
    2000, {}, { phoneDraftsEnabled: true });
  await writeFile(phone('New idea-001.md'), 'Keep me');
  await rename(phone('New idea-001.md'), phone('New idea-001.ready.md'));
  await intake.scan(3000); await intake.scan(5001);
  expect(await readdir(phone(''))).toEqual(['New idea-001.ready.md']);
  const restarted = createIntake(root, store, 2000, {}, { phoneDraftsEnabled: true });
  await restarted.scan(8000); await restarted.scan(10001);
  expect((await store.list()).tasks.map(task => task.idea)).toEqual(['Keep me']);
  expect(await readdir(phone(''))).toEqual(['New idea-002.md']);
});

it('does not recreate a missing draft while its renamed copy may still be syncing', async () => {
  const { store } = await setup();
  await rm(phone('New idea-001.md'));
  const restarted = createIntake(root, store, 2000, {}, { phoneDraftsEnabled: true });
  await restarted.scan(3000);
  expect(await readdir(phone(''))).toEqual([]);
  expect((await restarted.issues()).some(issue => /missing|sync/i.test(issue.message))).toBe(true);
  await writeFile(phone('New idea-001.ready.md'), 'Arrived later');
  await restarted.scan(6000); await restarted.scan(8001);
  expect((await store.list()).tasks.map(task => task.idea)).toEqual(['Arrived later']);
  expect(await readdir(phone(''))).toEqual(['New idea-002.md']);
});

it('never overwrites a pre-existing next draft', async () => {
  const { store, intake } = await setup();
  await writeFile(phone('New idea-002.md'), 'Unfinished second idea');
  await writeFile(phone('New idea-001.md'), 'First idea');
  await rename(phone('New idea-001.md'), phone('New idea-001.ready.md'));
  await intake.scan(3000); await intake.scan(5001);
  expect((await store.list()).tasks).toHaveLength(1);
  expect(await readFile(phone('New idea-002.md'), 'utf8')).toBe('Unfinished second idea');
});

it('keeps phone drafts inert when disabled while ordinary and UI intake still work', async () => {
  const store = await openStore(root);
  await mkdir(phone(''), { recursive: true });
  await writeFile(phone('New idea-001.ready.md'), 'Phone idea');
  await writeFile(join(root, 'drafts/ordinary.md'), 'Ordinary idea');
  const intake = createIntake(root, store, 2000);
  await intake.submit('UI idea', 'ui-1');
  await intake.scan(0); await intake.scan(2001);
  expect((await store.list()).tasks.map(task => task.idea).sort()).toEqual(['Ordinary idea', 'UI idea']);
  expect(await readdir(phone(''))).toEqual(['New idea-001.ready.md']);
});

it('rejects linked phone files without reading or overwriting their targets', async () => {
  const { store, intake } = await setup();
  const outside = join(root, 'outside.md');
  await writeFile(outside, 'External text');
  await rm(phone('New idea-001.md'));
  await symlink(outside, phone('New idea-001.ready.md'));
  await intake.scan(3000); await intake.scan(5001);
  expect((await store.list()).tasks).toHaveLength(0);
  expect(await readFile(outside, 'utf8')).toBe('External text');
  expect((await intake.issues()).length).toBeGreaterThan(0);
});

it('recovers template publication after a crash without overwriting later autosaves', async () => {
  const store = await openStore(root);
  let crashed = false;
  const intake = createIntake(root, store, 2000, { open: async (...args) => {
    const handle = await open(...args);
    if (!crashed && String(args[0]).endsWith('New idea-001.md') && args[1] === 'wx') {
      crashed = true;
      await handle.close();
      throw new Error('simulated publication crash');
    }
    return handle;
  } }, { phoneDraftsEnabled: true });
  await intake.scan(0);
  await writeFile(phone('New idea-001.md'), 'Autosaved before recovery');
  const restarted = createIntake(root, store, 2000, {}, { phoneDraftsEnabled: true });
  await restarted.scan(3000);
  expect(await readFile(phone('New idea-001.md'), 'utf8')).toBe('Autosaved before recovery');
  expect((await store.list()).tasks).toHaveLength(0);
  expect(await restarted.issues()).toEqual([]);
});

it('preserves a template arriving during exclusive publication', async () => {
  const store = await openStore(root);
  const intake = createIntake(root, store, 2000, { open: async (...args) => {
    if (String(args[0]).endsWith('New idea-001.md') && args[1] === 'wx') {
      await writeFile(args[0], 'Synced unfinished text');
    }
    return open(...args);
  } }, { phoneDraftsEnabled: true });
  await intake.scan(0);
  expect(await readFile(phone('New idea-001.md'), 'utf8')).toBe('Synced unfinished text');
  expect((await store.list()).tasks).toHaveLength(0);
});

it('does not reset a missing journal or overwrite files after journal corruption', async () => {
  const { store, intake } = await setup();
  await writeFile(phone('New idea-001.md'), 'Saved thought');
  const journal = join(root, '.intake/phone.json');
  await rm(journal);
  await intake.scan(3000);
  expect((await intake.issues()).some(issue => issue.message.includes('journal'))).toBe(true);
  await writeFile(journal, '{ broken');
  const restarted = createIntake(root, store, 2000, {}, { phoneDraftsEnabled: true });
  await restarted.scan(6000);
  expect((await restarted.issues()).length).toBeGreaterThan(0);
  expect(await readFile(phone('New idea-001.md'), 'utf8')).toBe('Saved thought');
  expect((await store.list()).tasks).toHaveLength(0);
});

it('requires fresh stable observations after a ready file is withdrawn for editing', async () => {
  const { store, intake } = await setup();
  await writeFile(phone('New idea-001.md'), 'Same text');
  await rename(phone('New idea-001.md'), phone('New idea-001.ready.md'));
  await intake.scan(3000);
  await rename(phone('New idea-001.ready.md'), phone('New idea-001.md'));
  await intake.scan(6000);
  await rename(phone('New idea-001.md'), phone('New idea-001.ready.md'));
  await intake.scan(9000);
  expect((await store.list()).tasks).toHaveLength(0);
  await intake.scan(11001);
  expect((await store.list()).tasks.map(task => task.idea)).toEqual(['Same text']);
});
