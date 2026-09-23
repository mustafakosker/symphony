import { readFile } from 'node:fs/promises';
import type { JiraHandoffConfig } from '../config/jira-handoff.js';
import type { JiraAdapter } from './adapter.js';
import { parseJiraSnapshot } from '../../shared/jira-validation.js';
export function createMockJiraAdapter(config: JiraHandoffConfig): JiraAdapter {
  return { async listAssignedOpen() {
    const bytes = await readFile(config.fixturesPath);
    if (bytes.length > 10 * 1024 * 1024) throw new Error('Jira fixture file exceeds 10 MiB');
    const raw: unknown = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(raw)) throw new Error('Jira fixtures must be an array');
    return { complete: true, issues: raw.map(parseJiraSnapshot).filter(issue => issue.open && issue.assignedToCurrentUser) };
  } };
}
