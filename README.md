# Symphony workspace

Symphony is an initial local coordinator for free-form Markdown drafts. A folder-backed task store and sequential scheduler run bounded Codex CLI assignments, stop at human review checkpoints, and expose persisted state through a loopback HTTP API and React UI. The UI shows live run output, versioned artifacts, workflow scope, questions, feedback, and terminal history.

The workspace opens to a task list. Use the sidebar to switch among All tasks, Needs review, Active, and Closed, or search by title, brief, type, or source. Open a row for its dedicated task page; the back control returns to the originating list. Overview contains pending reviews and workflow steps, Activity contains available run and review history, and Artifacts contains saved versions. At narrow widths, the menu opens the sidebar and Properties expands within the task page. Command/Ctrl+K focuses task search.

This checkout has a local setup with no projects or repositories required:

```sh
npm run start:local
```

Open <http://127.0.0.1:4317>. Add free-form Markdown files to `.symphony-local/workspace/drafts/`, or submit an idea in the UI. Answer questions and approve work in the UI. Optional synced Markdown reviews are described in [coordinator operations](docs/coordinator-operations.md#synced-file-reviews). The configured triage, researcher, PRD writer, and reviewer roles are read-only.

For phone capture without uploading files, enable [phone idea drafts](docs/coordinator-operations.md#phone-idea-drafts) on your OneDrive-connected host. Symphony provides `drafts/phone/New idea-001.md`; edit it freely, close the editor, and rename it to `New idea-001.ready.md` to submit. Autosave does not submit. After acceptance, Symphony prepares the next numbered blank. This checkout enables the feature for its local workspace; OneDrive sync still needs to be configured on the designated host.

Local settings are in `symphony.config.json`. Task folders (`drafts`, `active`, `done`, `rejected`, and `cancelled`) and the project/role registries are under `.symphony-local/workspace/`. Execution data, the isolated Codex profile, and existing capability verification are under `.symphony-local/runtime/`. `start:local` selects this isolated profile directory and reuses your existing Codex login. Keep these local folders when updating the code; they contain your saved tasks and configuration. Changes to profiles/registries or the CLI version require renewed capability verification.

After changing code, stop the server, run `npm run build`, then run `npm run start:local` again. A restart is required after rebuilding the UI because the server registers built asset names at startup.

The UI uses local Geist Sans 400/500 files imported in `src/main.tsx`, Radix-backed shadcn components in `src/components/ui/`, theme tokens in `src/styles/tokens.css`, and workspace/task layout rules in `src/styles/workspace.css` and `src/styles/task.css`.

Use Node.js **22.23.2**, the tested version pinned in `.nvmrc`. Node 20 is incompatible with the locked development dependencies; supported engine ranges are declared in `package.json`. If you use nvm, run `nvm install` and `nvm use` in this directory first. Install the committed dependency versions with `npm ci`, copy the examples in `config/examples/`, and follow [coordinator operations](docs/coordinator-operations.md) to provision a designated host, local OneDrive sync root, separate work directory, roles, project aliases and verified read-only/mutating profiles. Then:

```sh
npm ci
npm run build
SYMPHONY_CONFIG=/absolute/path/to/config.json npm run start
```

On a managed laptop, a registry `403` naming JFrog Curation or an immature-package hold is separate from Node's `EBADENGINE` warnings and authentication errors. `npm ci` preserves the lockfile, but cannot make a blocked version available. Wait until the locked versions satisfy the registry's hold policy, request approval through the registry administrator, or use a tested lockfile containing policy-compliant versions. Keep the configured company registry and the committed lockfile; deleting the lockfile can select more recently published packages.

The built server listens on `127.0.0.1:4317` by default. `npm run dev` serves the UI through Vite and proxies `/api` to port 4317; set `SYMPHONY_API_PORT` and `allowedOrigin` if using other development ports. Browser storage holds presentation choices only. Task records, approvals and attempts live in the configured workspace root. No real CLI assignment launches without a matching host-local `verifiedProfilesPath` capability attestation.

For deterministic local checks:

```sh
npm test -- --run
npm run build
```

`npm run preview:fake` after build starts a disposable fake-only browser preview at `127.0.0.1:4321`; its task roots are temporary and removed on shutdown. Set `SYMPHONY_PREVIEW_EMPTY=1` to check an empty workspace or `SYMPHONY_PREVIEW_PORT` to choose another loopback port. The separate opt-in real CLI smoke is described in [operations](docs/coordinator-operations.md). Do not point that smoke at company repositories.

This slice has been checked with temporary filesystem roots, a fake CLI subprocess, DOM tests and desktop/narrow Chrome browser checks. Real OneDrive sync behavior, company authentication and reverse proxy, deployment Codex credentials/profile permissions, and mutating external effects remain unverified. The built-in listener is local only; no public or mobile network deployment is supplied.

Project investigation uses a dedicated **Settings → Projects root** folder. Symphony discovers immediate child Git repositories, imports committed snapshots into its local runtime, and saves versioned project briefs. Keep the copies current externally; Symphony does not clone, fetch, pull, or push them. A title beginning `[shop]` selects the future implementation target, and mentions of other project names or aliases add references. Tasks without a prefix can use references only. This phase produces investigation, design, and implementation plans with source citations.

Prepare projects from **Projects** before using them. A compatible, verified read-only host profile is required; absent verification, the project stays **Needs setup**. See [project operations](docs/coordinator-operations.md#project-investigation) for setup, limits, recovery, and host-verification requirements.
