import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BoundaryError } from '../../shared/validate.js';

export async function confinedPath(root: string, relativePath: string): Promise<string> {
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes('\\') || /^[A-Za-z]:/.test(relativePath) ||
      relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new BoundaryError('invalid', 'Path must be a safe relative path');
  }
  let base: string;
  try {
    if ((await lstat(root)).isSymbolicLink()) throw new BoundaryError('invalid', 'Store root may not be a symbolic link');
    base = await realpath(root);
  }
  catch (error) {
    if (error instanceof BoundaryError) throw error;
    throw new BoundaryError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable', 'Cannot resolve store root', { cause: error });
  }
  let current = base;
  for (const part of relativePath.split('/')) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new BoundaryError('invalid', 'Symbolic links are not allowed in task paths');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const target = resolve(base, relativePath);
  const rest = relative(base, target);
  if (!rest || rest.startsWith(`..${sep}`) || rest === '..' || isAbsolute(rest)) throw new BoundaryError('invalid', 'Path escapes root');
  return target;
}
