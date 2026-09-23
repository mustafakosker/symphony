# Workspace configuration examples

Copy `projects/projects.json` to `<workspaceRoot>/projects/projects.json` and `roles/roles.json` to `<workspaceRoot>/roles/roles.json`, then replace the example repository paths, MCP profile names and Codex role profiles. Keep repository work directories outside the synced workspace.

Real Codex launches require a host-local `verifiedProfilesPath` manifest under `localRoot`. [The redacted example](verified-profiles.example.json) shows the required JSON keys; provide one entry for every role. Before creating it, the deployment operator must test task-store write denial, repository write denial for read-only profiles, and merge/deploy tool and credential denial for profiles without those actions. Attest the installed CLI version, exact action set, sandbox, environment variable names, and hashes of the Codex base/profile policy files, these two registry files, every selected skill, and relevant tool-policy files. The `<profile>.config.toml` sidecar is hashed by the verifier; define the actual `-p` profile in Codex's supported configuration. A manifest with stale hashes blocks launch; do not include credentials in it. See [operations](../../docs/coordinator-operations.md#capability-manifest-format) for path conventions and a hash command.

## Optional Jira inbox and mock ONA

Set `jiraHandoffConfigPath` in the host settings to an absolute path to a copy of [`jira-handoff.json`](jira-handoff.json). Edit its absolute `fixturesPath` to point to a copy of [`jira-issues.json`](jira-issues.json). Only `mode: "mock"` is supported. Do not put credentials in these files.

`connectionId` identifies the Jira connection. `projectMappings` maps Jira project keys to existing registry project IDs. A mapped project with exactly one repository suggests that repository and its base branch; other cases require a user selection. The browser receives only project/repository IDs and base branches, not local paths or MCP profiles.

Each fixture has an immutable `issueId`, HTTP(S) URL, current key/title/description/status, optional acceptance criteria (string or null), `assignedToCurrentUser`, `open`, and an ISO `updatedAt`. Only assigned-open issues are imported. Sync runs once per minute or through **Refresh Jira**; a full successful sync marks absent issues without deleting saved preparation. Failed or incomplete syncs preserve the last known inbox and last-success time. Omitting `jiraHandoffConfigPath` leaves existing workflows and API response shape unchanged.
