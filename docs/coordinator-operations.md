# Coordinator operations (initial local slice)

This service runs on one designated host. The host's local OneDrive sync directory is the task store and transport; it is not a multi-host lock, a transactional database, or proof of upload completion. Keep the workspace available offline on that host so the coordinator can read complete local files. Do not point two coordinators at the same synced tree.

## Provision and start

1. Install Node.js 22.12 or newer, the project dependencies, and a Codex CLI version whose noninteractive `exec` flags pass the startup probe. Provision a local OneDrive sync directory on the designated host. Configure required workspace files to remain downloaded locally. Use a separate host-local directory for locks, run output, and repository worktrees.
2. Copy [the example settings](../config/examples/settings.json) to a host-local JSON file. Set absolute, disjoint `workspaceRoot` and `localRoot` paths; set the executable `codexBinary` path. Copy [project definitions](../config/examples/projects/projects.json) to `<workspaceRoot>/projects/projects.json` and [role definitions](../config/examples/roles/roles.json) to `<workspaceRoot>/roles/roles.json`. Replace every example path, repository alias, role profile and instruction with an approved value. Repository checkout paths stay outside the synced workspace.
3. Configure Codex credentials, CLI base/profile files, selected skills, and any approved MCP connections in the host's approved mechanisms outside OneDrive. Do not put secrets in settings, role files, task artifacts, or the capability manifest.
4. Verify the actual host CLI (`--version`, root `--help`, and `exec --help`). On disposable sentinel files and test repositories, verify each configured profile's task-store write denial; read-only repository write denial; and denial of merge/deploy tools and credentials where those actions are absent. Verify the host's process-tree stop behavior and the permissions confinement before allowing mutating roles. Record the tested CLI version, role/profile, exact actions, sandbox, environment variable names, required check labels, and SHA-256 hashes of the base/profile configs, registry files, and selected skills in a `verifiedProfilesPath` manifest inside `localRoot`. A changed file, version, action set or missing manifest blocks launch. The manifest is an operator attestation, not an automatic proof about ambient credentials.
5. Run `npm install`, `npm run build`, then `SYMPHONY_CONFIG=/absolute/path/to/config.json npm run start`. The built server binds loopback and serves both UI and `/api` at the configured port. `npm run dev` serves the development UI through Vite; set `SYMPHONY_API_PORT` for its API proxy and set `allowedOrigin` to that Vite origin during development.

The built-in HTTP boundary is suitable for local host access. Company-network use needs a deployment-approved authenticated reverse proxy, access controls, TLS and an origin setting that matches the served UI. This repository does not provision that proxy or promise phone/mobile network access. A browser disconnect leaves approved background work running and leaves human decisions pending until the UI reconnects.

## Settings

| Setting | Default | Meaning |
|---|---:|---|
| `workspaceRoot` | required | Absolute synced task-store directory. |
| `localRoot` | required | Absolute disjoint host-local locks and task work directories. |
| `codexBinary` | required | Executable Codex CLI path or name found on `PATH`. |
| `port` | `4317` | Loopback HTTP port. |
| `concurrency` | `1` | Maximum concurrent assignments globally; one per task. |
| `scanMs` | `2000` | Intake and scheduler polling interval in milliseconds. |
| `stableMs` | `2000` | Minimum matching draft observation interval. |
| `runTimeoutMs` | `1800000` | Assignment time limit in milliseconds. |
| `stopGraceMs` | `5000` | Grace before process-tree escalation. |
| `outputLimitBytes` | `10485760` | Captured output limit per run. |
| `allowedOrigin` | `http://127.0.0.1:4317` | Exact browser origin allowed to mutate through the API. |
| `environmentKeys` | `[]` | Extra environment variable names passed to the CLI. |
| `verifiedProfilesPath` | `null` | Host-local operator capability manifest; null keeps real launch closed. |

`projects/projects.json` maps project names/aliases to local repositories or MCP profiles and ref-selection rules. `roles/roles.json` gives each role its instructions, absolute approved `SKILL.md` paths, CLI profile and exact action categories. Startup rejects unknown fields and invalid paths. Each assignment uses the configured role's profile and an explicit sandbox; workflow approval cannot enlarge a role's configured permissions.

## Capability manifest format

Set `verifiedProfilesPath` in the host settings to an absolute path **inside `localRoot`**, such as `/srv/symphony-local/verified-profiles.json`. The [redacted JSON example](../config/examples/verified-profiles.example.json) shows the exact shape: a top-level `profiles` array with at least one entry **for every configured role**. Multiple entries for a role support distinct exact repository scopes using different isolated CLI profiles. Each entry needs `role`, `profile`, `cliVersion`, `sandbox`, `actions`, `environmentKeys`, `coveredFiles`, `repositories`, and `checks`. `cliVersion` is the version token from `codex --version` after the `codex-cli ` prefix. `role` and `profile` must match `roles/roles.json`; optional `executionProfile` selects the actual isolated named CLI profile passed at launch (defaults to `profile`); `actions` and `environmentKeys` must exactly match the role and settings arrays, with no duplicates. `sandbox` is `read-only` when all actions are `read`, otherwise `workspace-write`.

`repositories` is the exact scope exposed by this profile: an array of `{ "repository": "registry-id", "localPath": "/canonical/source/path", "mcpProfile": null }` for local repositories or `{ "repository": "registry-id", "localPath": null, "mcpProfile": "approved-connection-identifier" }` for MCP access. Use `[]` for no repository access (omission is accepted only as this empty scope). An assignment must select exactly this set; a profile exposing additional repositories is rejected at launch. Repository assignments additionally require the `repository-scope-verified` check, based on operator probes that the selected sources/connections are usable and unrelated sources/connections are denied. The adapter does not install or enable MCP connections: the named CLI profile must provide the attested connection identifiers. For one role used across tasks with different selected repositories, supply one entry per allowed exact set under the same `role`/`profile`, with a distinct `executionProfile` for each isolated set (including the empty set if needed). Startup verifies every entry and rejects duplicate scopes or reused execution profile names within that configured role; assignment launch selects exactly one matching entry. For example, `profile: researcher` can have `executionProfile: researcher-alpha` for only repository alpha and `executionProfile: researcher-beta` for only beta. A task selecting both requires its own alpha+beta entry and isolated profile. Unknown scopes fail closed. Only stable canonical source paths and connection identifiers are attested, never random future worktree paths.

Assignments persist only selected access mappings in `runs/<attempt>/input.json`, including exact commit IDs (or unresolved rules for the read-only `$resolve` preparation), canonical local source paths, owned checkout paths, or approved MCP identifiers. Read-only roles use local source paths with exact revisions and receive no added writable directories. Mutable local work uses the first selected owned checkout as `cwd`; every additional selected checkout and the run output directory is passed explicitly through CLI `--add-dir`. Startup requires this flag. Deployment probes must cover these actual multi-directory paths, task-store denial, and the configured tools; matching an attestation is not proof of confinement.

Each `coveredFiles` item is `{ "path": "/absolute/path", "sha256": "64-lowercase-hex-digits" }`. Include these exact paths for each role: `${CODEX_HOME}/config.toml` (or `${HOME}/.codex/config.toml` if `CODEX_HOME` is unset), `${CODEX_HOME}/<cliProfile>.config.toml`, `${CODEX_HOME}/<executionProfile>.config.toml` when different, `<workspaceRoot>/roles/roles.json`, `<workspaceRoot>/projects/projects.json`, and every absolute `SKILL.md` listed in that role. The `<cliProfile>.config.toml` sidecar is a **verifier-covered operator policy file**. The coordinator hashes it, but the CLI does not automatically load it from that filename. The adapter passes `-p <executionProfile>` (or `<cliProfile>` when no override is configured); define that named profile in the CLI's supported configuration and verify its actual permissions separately. Keep any additional tool-policy files in `coveredFiles` when they are part of the operator's attestation.

After the sentinel/tool-denial probes, calculate each hash from the exact host file bytes. This portable Node command prints SHA-256 and path for each file passed to it; copy the hashes into the manifest, then keep the manifest outside OneDrive:

```sh
node -e 'const fs=require("node:fs"); const crypto=require("node:crypto"); for (const p of process.argv.slice(1)) console.log(crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"), p)' /absolute/codex-home/config.toml /absolute/codex-home/example-read-only.config.toml /absolute/workspace/roles/roles.json /absolute/workspace/projects/projects.json
```

The required `checks` labels are `task-store-write-denied` for every role, `repository-write-denied` for read-only roles, and `merge-deploy-tool-denied` when merge/deploy actions are absent or `merge-deploy-scope-verified` when either is present. Labels record operator evidence; writing the labels alone does not perform the probes. Startup validates all configured roles against the manifest before dispatch, and the runner checks the assigned role again at launch.

## Records, review and recovery

Place free-form UTF-8 `.md` files in `drafts/` or use **New task** in the UI. Intake waits for stable observations and caps drafts at 1 MiB. `.intake/receipts/` binds a source name and digest to one task ID; `.intake/received/` retains claimed source bytes, while `.intake/conflicts/` preserves changed or colliding versions for operator review. Repeating identical bytes under the same name replays the receipt. To intentionally submit the same idea again, use a new filename. A receipt conflict does not authorize another run. Inspect the UI issue list and archive files before resolving it; keep both versions as evidence.

`active/<id>/` contains original `idea.md`, current `task.json`, immutable `events/`, workflow versions, reviews, `runs/` and versioned `artifacts/`. Terminal records move intact to `done/`, `rejected/`, or `cancelled/`. The state and current revision determine dispatch eligibility; folder location alone does not. The UI shows exact artifact versions and digests under review. A stale tab receives a revision conflict; retry using the freshly loaded record. Reusing a request ID with different payload is rejected.

The UI accepts human answers, approvals, changes, pause and cancellation. A pending decision stops the entire task while other tasks can use the free slot. Pause first writes a dispatch barrier, then stops the process tree. Cancellation does not roll back files, external actions or an already opened PR. If process termination is unconfirmed, the task remains blocked with its original pause/cancel intent and no end timestamp, including after restart. In **Confirm stop reconciliation**, record confirmation that the process tree has ended and reconcile checkout/provider effects. This settles cancellation into `cancelled`, or pause into a separate Continue review; it does not silently retry the stopped assignment. A confirmed process exit with uncertain external effects is recorded separately and requires effect reconciliation before retry. Read-only transient failures before side effects may retry twice, after roughly one and five seconds; exhausted or unsafe retries block. `done` means the approved workflow and completion checks passed, not that anything was merged or deployed unless explicitly included and verified.

## Synced file reviews

On the designated host, set `"fileReviewsEnabled": true` in its settings to enable question answers and workflow/artifact decisions through Markdown. The [example settings](../config/examples/settings.json) leave it `false`. Keep `workspaceRoot` pointed at the OneDrive-synced task store and `localRoot` at a separate host-local directory. Stop and restart the designated host after changing the setting; `npm run start:local` starts this repository's local setup only. Do not delete `localRoot/file-reviews/` while submissions are in flight: it holds the request journal needed for safe recovery.

For each pending review, open the generated file in `<workspaceRoot>/reviews/`. Edit only below `## Your response`. Save and close the editor, then rename the full filename from `name.md` to `name.ready.md`. Keep the `.md` extension exactly once; do not create `name.md.ready.md` or `name.ready.md.md`. Stop editing after the rename. Ordinary autosaves to `name.md` do not submit. A separate `name.receipt.md` confirms the response the coordinator actually processed; the submitted file alone is not confirmation. Examples of complete response sections are:

```markdown
## Your response
action: answer

We use Java 17.
```

```markdown
## Your response
action: approve

```

```markdown
## Your response
action: reject

The proposed scope includes the wrong repository.
```

Use `answer` with nonempty text for a question. Questions cannot be rejected through file approval. For workflow or artifact review, use blank-body `approve` or `reject` with a reason. `reject` rejects the task; use the UI to request changes instead. The UI also remains available for answers and approvals, and is required for pause, cancellation, request-changes, and uncertain-run reconciliation.

If a receipt says **Needs correction**, use the new draft the coordinator creates; the submitted filename cannot be reused. **Outdated** means another decision or a changed review won first, including a competing UI action; inspect the current task in the UI. Edits to the question, instructions, workflow scope, or reviewed-material header are rejected. If host-local review records are lost, old submitted files are left inert and an issue appears in the UI; restore the matching local journal or make the decision in the UI. The settling interval reduces partial-file reads but cannot prove OneDrive delivered edits in order. Check the receipt's processed response when sync is delayed or devices disagree.

If the host-local review journal cannot be read or written, a workspace issue explains that file decisions are suspended. Unrelated work and UI decisions remain operational; file scanning retries automatically when the journal is repaired. Preserve the journal and restore only a matching backup.

Phone editor and OneDrive behavior on the intended deployment is **unverified**. After deployment, manually check edit, save, close, rename, receipt visibility, and correction flow from the actual phone before treating synced review as ready for routine use. Local filesystem tests do not establish cloud sync compatibility.

Read-only completed reports return `artifacts: []` and place each declared output's exact text in `completed.evidence[outputId]`. The coordinator publishes immutable versioned artifacts before accepting the result, bounded to the smaller of 1 MiB and `outputLimitBytes` in total report bytes. Missing declared report text or excessive bytes block acceptance. Checkpoint approvals bind the published versions/digests. Fresh assignments carry saved questions, checkpoints and answers with attempt/workflow identity and relevant accepted completion evidence; saved continuation context is capped at 1 MiB and excessive context blocks before spawning rather than silently discarding facts. Input artifacts and selected skills have a separate combined 1 MiB staging limit. Rejection and request-changes require visible nonempty feedback in the UI.

The UI reads run output from `/api/tasks/<id>/runs/<run-id>/log?stream=stdout|stderr&offset=<byte-offset>`. The API pages logs and returns the next byte offset; completed empty streams say **No output recorded**. Task runs and coordinator errors are visible in the task detail and service stderr. Keep operational logs outside the synced task store under the host's normal log management. Artifact previews read at most 256 KiB as strict UTF-8; use the versioned download for binary or full artifacts.

Startup holds `localRoot/coordinator.lock`. If another process owns it, do not remove it. When startup detects a dead recorded owner, it serializes reclamation with `coordinator.reclaim.lock`; an uncertain owner requires manual investigation. Recovery rebuilds stale snapshots from committed events, completes terminal moves, and blocks uncertain attempts. An event-write failure stops affected dispatch rather than accepting an in-memory decision. Preserve failed files and diagnostics before repair.

Back up the complete synced workspace, `localRoot/tasks/`, and `localRoot/file-reviews/` together after stopping the coordinator, including `.intake`, events, artifacts, run output and local checkouts. The local review journal must match the workspace checkpoint: it contains issued bindings, captured submissions, and in-flight operation identities. Restore all of these together to the same checkpoint on the designated host, verify configured paths and repository refs, then start and inspect recovery issues before approving retries. A OneDrive copy alone cannot restore live local work directories or prove that pending sync was uploaded. Never restore a stale snapshot over newer immutable events.

## Verification boundaries

Run `npm test -- --run` and `npm run build` for local deterministic checks. `npm run preview:fake` after build provides disposable fake data on a separate loopback port for browser inspection; it bypasses real profile verification only through a test-only application injection and is not a production setting. The opt-in real CLI smoke requires `SYMPHONY_CODEX_SMOKE=1`, `SYMPHONY_CODEX_SMOKE_CONFIG=/absolute/path/to/a/disposable/read-only/config.json` and `SYMPHONY_CODEX_SMOKE_ROLE=<read-only-role>`; then run `npm test -- --run tests/codex.smoke.test.ts`. It creates and removes an isolated local Git fixture, invokes the actual configured CLI twice, and must be treated as blocked if authentication, network, attestation or the host profile is unavailable. It never targets company repositories.

The deterministic suite and fake-browser checks do not establish production readiness. OneDrive sync, company authentication/proxy, actual Codex credentials and permission denial on the deployment host, host-specific process-tree stopping, and mutating workflow effects still require operator verification.
