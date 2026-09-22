import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishExclusive, readBounded, verifyMaterial } from './io.js';
import { createHash } from 'node:crypto';

describe('safe file review IO', () => {
  it('reads a regular file and rejects oversized, symlinked, and escaping input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'file-review-io-'));
    try {
      await mkdir(join(root, 'reviews'));
      await writeFile(join(root, 'reviews', 'ok.md'), 'hello');
      expect((await readBounded(root, 'reviews/ok.md'))?.toString()).toBe('hello');
      expect(await readBounded(root, 'reviews/missing.md')).toBeNull();
      await writeFile(join(root, 'reviews', 'large.md'), Buffer.alloc(1024 * 1024 + 1));
      await expect(readBounded(root, 'reviews/large.md')).rejects.toMatchObject({ code: 'invalid' });
      await symlink('ok.md', join(root, 'reviews', 'link.md'));
      await expect(readBounded(root, 'reviews/link.md')).rejects.toMatchObject({ code: 'invalid' });
      await expect(readBounded(root, '../escape')).rejects.toMatchObject({ code: 'invalid' });
      await expect(readBounded(root, 'reviews')).rejects.toMatchObject({ code: 'invalid' });
      await symlink('reviews', join(root, 'alias'));
      await expect(readBounded(root, 'alias/ok.md')).rejects.toMatchObject({ code: 'invalid' });
      await symlink(root, `${root}-link`);
      try { await expect(readBounded(`${root}-link`, 'reviews/ok.md')).rejects.toMatchObject({ code: 'invalid' }); }
      finally { await rm(`${root}-link`); }
      await expect(readBounded(root, 'reviews/ok.md', async () => {
        await writeFile(join(root, 'reviews', 'ok.md'), 'hello growing');
      })).rejects.toMatchObject({ code: 'unavailable' });
      await expect(readBounded(root, 'reviews/ok.md', async () => {
        await rm(join(root, 'reviews', 'ok.md'));
      })).rejects.toMatchObject({ code: 'unavailable' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('streams large materials without the response intake cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'file-review-io-'));
    try {
      await mkdir(join(root, 'reviews'));
      const bytes = Buffer.alloc(2 * 1024 * 1024, 42);
      await writeFile(join(root, 'reviews', 'large.bin'), bytes);
      expect(await verifyMaterial(root, 'reviews/large.bin', createHash('sha256').update(bytes).digest('hex'))).toBe(true);
      expect(await verifyMaterial(root, 'reviews/large.bin', '0'.repeat(64))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('never replaces existing bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'file-review-io-'));
    try {
      await mkdir(join(root, 'reviews'));
      await writeFile(join(root, 'reviews/answer.md'), 'My unfinished answer');
      await expect(publishExclusive(root, 'reviews/answer.md', Buffer.from('generated'))).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(join(root, 'reviews/answer.md'), 'utf8')).toBe('My unfinished answer');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
