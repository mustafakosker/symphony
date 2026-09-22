# Symphony workspace

Symphony is an initial local coordinator for free-form Markdown drafts. A folder-backed task store and sequential scheduler run bounded Codex CLI assignments, stop at human review checkpoints, and expose persisted state through a loopback HTTP API and React UI. The UI shows live run output, versioned artifacts, workflow scope, questions, feedback, and terminal history.

This checkout has a local setup with no projects or repositories required:

```sh
npm run start:local
```

Open <http://127.0.0.1:4317>. Add free-form Markdown files to `.symphony-local/workspace/drafts/`, or submit an idea in the UI. Answer questions and approve work in the UI. The configured triage, researcher, PRD writer, and reviewer roles are read-only.

Local settings are in `symphony.config.json`. Task folders (`drafts`, `active`, `done`, `rejected`, and `cancelled`) and the project/role registries are under `.symphony-local/workspace/`. Execution data, the isolated Codex profile, and existing capability verification are under `.symphony-local/runtime/`. `start:local` selects this isolated profile directory and reuses your existing Codex login. Keep these local folders when updating the code; they contain your saved tasks and configuration. Changes to profiles/registries or the CLI version require renewed capability verification.

After changing code, stop the server, run `npm run build`, then run `npm run start:local` again. A restart is required after rebuilding the UI because the server registers built asset names at startup.

Use Node.js **22.12 or newer**. Install dependencies without upgrading them, copy the examples in `config/examples/`, and follow [coordinator operations](docs/coordinator-operations.md) to provision a designated host, local OneDrive sync root, separate work directory, roles, project aliases and verified read-only/mutating profiles. Then:

```sh
npm install
npm run build
SYMPHONY_CONFIG=/absolute/path/to/config.json npm run start
```

The built server listens on `127.0.0.1:4317` by default. `npm run dev` serves the UI through Vite and proxies `/api` to port 4317; set `SYMPHONY_API_PORT` and `allowedOrigin` if using other development ports. Browser storage holds presentation choices only. Task records, approvals and attempts live in the configured workspace root. No real CLI assignment launches without a matching host-local `verifiedProfilesPath` capability attestation.

For deterministic local checks:

```sh
npm test -- --run
npm run build
```

`npm run preview:fake` after build starts a disposable fake-only browser preview at `127.0.0.1:4321`; its task roots are temporary and removed on shutdown. The separate opt-in real CLI smoke is described in [operations](docs/coordinator-operations.md). Do not point that smoke at company repositories.

This slice has been checked with temporary filesystem roots, a fake CLI subprocess, DOM tests and desktop/narrow Chrome browser checks. Real OneDrive sync behavior, company authentication and reverse proxy, deployment Codex credentials/profile permissions, and mutating external effects remain unverified. The built-in listener is local only; no public or mobile network deployment is supplied.
