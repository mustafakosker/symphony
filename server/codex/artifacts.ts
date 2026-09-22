import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import type { AgentResult } from '../../shared/contracts.js';

export async function validateDeclaredArtifacts(result: AgentResult, outputDir: string): Promise<void> {
  for (const artifact of result.artifacts) {
    if (!artifact.path || isAbsolute(artifact.path) || artifact.path.includes('\\') ||
        artifact.path.split('/').some(part => !part || part === '.' || part === '..') ||
        normalize(artifact.path).startsWith(`..${sep}`)) throw new Error(`Artifact path escapes output directory: ${artifact.path}`);
    const parts = artifact.path.split('/'); let current = outputDir;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Artifact symlink is forbidden: ${artifact.path}`);
      if (i < parts.length - 1 && !info.isDirectory()) throw new Error(`Artifact parent is not a directory: ${artifact.path}`);
      if (i === parts.length - 1 && !info.isFile()) throw new Error(`Artifact is not a regular file: ${artifact.path}`);
    }
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(current)) digest.update(chunk);
    if (digest.digest('hex') !== artifact.digest) throw new Error(`Artifact digest mismatch: ${artifact.path}`);
  }
}
