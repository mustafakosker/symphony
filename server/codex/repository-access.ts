import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Assignment } from './adapter.js';

export type RepositoryAccess = {
  repository: string; rule: string; commit: string | null; selectedCommits: string[];
  localPath: string | null; checkoutPath: string | null; mcpProfile: string | null;
};

export async function validateRepositoryAccess(assignment: Assignment, localRoot: string): Promise<void> {
  const access = assignment.repositoryAccess ?? [];
  const selected = assignment.step.repositories;
  const invalid = () => new Error('Invalid selected repository access mapping');
  if (new Set(selected).size !== selected.length || access.length !== selected.length ||
      new Set(access.map(item => item.repository)).size !== access.length ||
      !selected.every(id => access.some(item => item.repository === id))) throw invalid();
  const preparing = assignment.step.id.startsWith('$resolve:');
  const mutable = assignment.step.actions.some(action => action !== 'read');
  if (assignment.run.repos.length !== (preparing ? 0 : access.length)) throw invalid();
  const root = await realpath(localRoot);
  for (const item of access) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(item.repository) || !item.rule ||
        (!item.localPath && !item.mcpProfile) || (item.localPath && item.mcpProfile)) throw invalid();
    if (item.mcpProfile && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(item.mcpProfile)) throw invalid();
    const ref = assignment.run.repos.find(ref => ref.repository === item.repository);
    if (preparing ? (item.localPath !== null || item.commit !== null || item.selectedCommits.length !== 0) :
        (!ref || !item.commit || !/^[a-f0-9]{40}$/i.test(item.commit) || !item.selectedCommits.length ||
          item.selectedCommits.some(sha => !/^[a-f0-9]{40}$/i.test(sha)) ||
          ref.commit !== item.commit || ref.rule !== item.rule || JSON.stringify(ref.selectedCommits) !== JSON.stringify(item.selectedCommits))) throw invalid();
    if (item.localPath) {
      if (!isAbsolute(item.localPath) || await realpath(item.localPath) !== item.localPath || !(await stat(item.localPath)).isDirectory()) throw invalid();
      if (mutable && !item.checkoutPath) throw invalid();
    }
    if (item.checkoutPath) {
      const expected = join(root, 'tasks', assignment.task.id, 'repositories', item.repository);
      if (!mutable || !item.localPath || item.checkoutPath !== expected || await realpath(item.checkoutPath) !== expected ||
          !(await stat(item.checkoutPath)).isDirectory()) throw invalid();
    }
  }
}
