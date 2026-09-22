# Read-only Project Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure one read-only projects root globally, automatically bind task targets/references to committed repository snapshots, and produce grounded investigation, design, and implementation-plan artifacts.

**Architecture:** A live root catalog and deterministic resolver feed a durable preparation journal before task intake. Versioned task context binds all selected snapshots and briefs; the existing coordinator schedules investigation and internal brief jobs under one concurrency limit. Snapshot access, report publication, and source previews enforce the same immutable context, while legacy task records retain their existing behavior.

**Tech Stack:** Existing Node.js/TypeScript server, local Git CLI, filesystem journals, React/Radix UI, Vitest, and Testing Library. No database, external synchronization service, indexing service, or new runtime dependency.

**Spec:** [Approved project discovery specification](../specs/2026-09-22-project-connection-design.md), approved after commit `ab38ccc`.

## Global Constraints

- “One optional global projects root, configured through the application and persisted on the coordinator host.”
- “Discover one Git repository per immediate child directory; editable aliases and project briefs are saved in Symphony storage.”
- “Automatically resolve zero or one future change target and zero or more references from task text.”
- “All repositories remain read-only in this phase, including the future change target.”
- “Without a title prefix, matched projects are references only; the system does not infer a change target.”
- “Rebinding an accepted task requires a new task.”
- “Rescan never runs fetch, pull, checkout, hooks, or repository scripts.”
- “Default preparation limits across one task's selected snapshots are 100,000 entries and 1 GiB of total materialized content, with 64 MiB for an individual regular file; positive host settings can override them.”
- “Brief text is limited to 128 KiB of UTF-8, with at most 256 citations per brief or report.”
- “Limit an individual cited range to 1,000 lines and 256 KiB of text, and validate that it can be displayed before accepting the citation.”
- “Existing aggregate assignment-input and report-output limits still apply and are checked before dispatch/publication rather than truncating saved context.”
- “Do not use the user's company repositories as test fixtures.”
- Preserve existing Node engine requirements and dependency versions in `package.json`. Use argument arrays with `spawn`/`execFile`, never shell interpolation for Git arguments or user paths.
- This document authorizes no execution yet. Implement after plan review and execution-method selection; use an isolated development workspace at execution time. Do not include unrelated `.DS_Store` files in commits.

## Review Focus

1. A project root disappears or is replaced while a draft is open: distinguish unavailable from empty and never bind different repositories silently. Tests: Tasks 2, 3, 9, 12.
2. Unicode-equivalent names, regular-expression punctuation, and overlapping names produce surprising selections: match literal normalized complete names, with traceable spans and explicit ambiguity. Tests: Task 1.
3. An external updater advances a branch or prunes objects during preparation: preserve every journaled commit and fail visibly when its objects are unavailable. Tests: Tasks 4 and 9.
4. A second browser saves aliases/briefs or an older preview response arrives last: keep unsaved work, reject stale writes, and ignore stale responses. Tests: Tasks 3, 8, 11, 12.
5. Individually verified projects are used together: verify the exact combined scope, never infer a usable combined profile from individual readiness. Tests: Tasks 6, 8, 14.

## File structure and sequencing

This is one feature with a shared context contract, not independent products. Execute Tasks 1–14 in order; each task has its own focused test cycle and commit. The file groups below prevent the already large coordinator/intake modules from absorbing catalog, Git, or UI logic.

| Area | Files to create | Existing integration points |
| --- | --- | --- |
| Shared project contract and resolution | `shared/projects.ts`, `shared/project-resolution.ts`, matching `.test.ts` | `shared/contracts.ts`, `shared/validate.ts` |
| Live root setting | `server/projects/settings.ts`, `.test.ts` | `server/config/settings.ts`, `.test.ts` |
| Discovery/catalog | `server/projects/discovery.ts`, `catalog.ts`, matching tests | `server/config/registry.ts` remains legacy-only |
| Git/snapshots | `server/projects/git.ts`, `snapshots.ts`, matching tests | Do not reuse mutating `server/repos/workspace.ts` paths |
| Context rules | `shared/project-validation.ts`, `server/domain/project-policy.ts`, matching tests | `workflow.ts`, task store, parser |
| Snapshot access | `server/codex/snapshot-access.ts`, `snapshot-capability.ts`, matching tests | adapter, capability, repository-access, startup |
| Source reports | `shared/source-report.ts`, `server/projects/citations.ts`, matching tests | coordinator report publication, prompt, artifact previews |
| Briefs/jobs | `server/projects/briefs.ts`, `brief-jobs.ts`, matching tests; `server/coordinator/store-router.ts`, `.test.ts` | existing coordinator slots, recovery, runner |
| Preparation/intake | `server/projects/binding.ts`, `.test.ts`; `server/intake/project-drafts.ts`, `.test.ts` | existing intake receipts and submission API |
| Server composition | `server/projects/service.ts`, `server/http/projects.ts`, matching tests | main, existing HTTP access checks |
| Project UI | `src/projects/api.ts`, `useProjects.ts`, matching tests; `src/components/ProjectSettings.tsx`, `ProjectsPage.tsx`, matching tests | App, shell, sidebar, navigation |
| Draft/context/source UI | `src/components/ProjectSelection.tsx`, `TaskProjectContext.tsx`, `SourceReport.tsx`, `SourcePreview.tsx`, matching tests | task dialog, task artifacts, task detail |
| Fixtures/host verification | `server/testing/projects.ts`, `server/projects/integration.test.ts`, `scripts/verify-project-access.mjs` | fake preview, operations/config docs |

Do not introduce a second independently running agent scheduler. Brief generation uses the same `Runner`, slots, stop/recovery logic, and `settings.concurrency` as ordinary work. All serializable DTO types introduced in task interface blocks belong in `shared/projects.ts`; server service interfaces stay in their owning server modules. The UI imports DTOs from `shared`, never server implementations.

## Task 1: Define project contracts and deterministic matching

**Files:** Create `shared/projects.ts`, `shared/project-resolution.ts`, `shared/project-resolution.test.ts`, `server/testing/projects.ts`.

**Interfaces:** `resolveProjects(draft: DraftText, catalog: CatalogView, choices?: ResolutionChoices): ResolutionResult`; `deriveDraftText(markdown: string, filename: string): DraftText`. The browser requests server previews; these functions also serve filesystem intake. Offsets refer to original UTF-16 text, even when normalized forms differ in length.

- [ ] **Step 1: Add contract types and failing resolver examples.** Put the following serializable types in `shared/projects.ts`; use them throughout later tasks rather than introducing competing DTOs.

```ts
export type DraftText = { title: string; description: string };
export type ProjectName = { id: string; name: string; aliases: string[] };
export type CatalogView = {
  generation: string; revision: string;
  state: 'unset' | 'ready' | 'unavailable';
  projects: ProjectName[];
};
export type ResolutionChoices = {
  excludedReferenceIds: string[];
  ambiguities: Record<string, string>;
};
export type NameMatch = {
  key: string; field: 'title' | 'description'; start: number; end: number;
  text: string; projectIds: string[]; role: 'target' | 'reference';
};
export type ResolutionProblem = {
  code: 'root-unavailable' | 'unknown-target' | 'invalid-prefix' |
    'ambiguous-name' | 'invalid-choice';
  message: string; matchKey: string | null;
};
export type ResolutionResult = {
  catalogRevision: string; generation: string;
  targetId: string | null; referenceIds: string[];
  matches: NameMatch[]; problems: ResolutionProblem[];
};
export type ResolutionPreview = ResolutionResult & { revision: string };
export type SnapshotRef = {
  projectId: string; repositoryId: string; commit: string;
  objectFormat: 'sha1' | 'sha256'; manifestDigest: string; snapshotId: string;
};
export type Citation = {
  id: string; repositoryId: string; commit: string; path: string;
  objectId: string; contentDigest: string; startLine: number; endLine: number;
};
export type SourceReport = {
  format: 'source-report-v1'; text: string; citations: Citation[];
};
export type BriefCopy = {
  version: number; digest: string; author: 'generated' | 'human' | 'human-edited';
  source: SnapshotRef; report: SourceReport; createdAt: string;
};
export type BoundProject = {
  projectId: string; repositoryId: string; name: string; ref: string;
  snapshot: SnapshotRef; brief: BriefCopy | null;
};
export type ProjectContext = {
  version: 1; generation: string; resolutionRevision: string;
  targetId: string | null; referenceIds: string[]; projects: BoundProject[];
};
export type ProjectSelection = { projectId: string; ref: string; briefVersion: number };
export type ProjectDraft = {
  text: DraftText; previewRevision: string; catalogRevision: string;
  choices: ResolutionChoices; selections: ProjectSelection[];
};
export type ProjectReadiness = 'discovered' | 'needs-setup' | 'preparing' | 'ready' | 'failed';
export type OperationStatus = {
  id: string; revision: number; kind: 'scan' | 'prepare' | 'verify' | 'brief' | 'submission';
  state: 'queued' | 'running' | 'needs-input' | 'failed' | 'complete';
  message: string; taskId: string | null;
};
```

Test fixtures and expectations:

```ts
import { expect, it } from 'vitest';
import { resolveProjects } from './project-resolution.js';
import type { CatalogView } from './projects.js';
const catalog: CatalogView = {
  generation: 'root-1', revision: 'catalog-1', state: 'ready',
  projects: [
    { id: 'p-shop', name: 'shop', aliases: ['Storefront'] },
    { id: 'p-pay', name: 'payments-service', aliases: ['Payments'] },
    { id: 'p-api', name: 'shop-api', aliases: [] },
  ],
};
it.each([
  ['[STOREFRONT] Checkout', 'Use payments-service', 'p-shop', ['p-pay']],
  ['Checkout', 'Use shop and Payments', null, ['p-shop', 'p-pay']],
  ['Checkout', 'workshop shop-api', null, ['p-api']],
  ['[shop] Checkout', 'shop shop Payments', 'p-shop', ['p-pay']],
])('resolves %s', (title, description, targetId, referenceIds) => {
  const result = resolveProjects({ title, description }, catalog);
  expect(result).toMatchObject({ targetId, referenceIds, problems: [] });
});
```

Add test rows for decomposed/composed `café`, literal aliases `C++` and `a.b`, `shop` inside `shop-api`, malformed/multiple prefixes, ambiguous aliases, unknown target, excluded references, same-offset overlapping names, negated/quoted mentions, and stale/invalid ambiguity IDs. Assert each `NameMatch.text === draft[field].slice(start, end)`. Test first nonempty `# Heading` versus filename title fallback.

- [ ] **Step 2: Run `npx vitest run shared/project-resolution.test.ts`.** Expect missing resolver exports initially, then assertion failures until matching is implemented.
- [ ] **Step 3: Implement literal matching, overlap resolution, and revision hashing.** Normalize comparisons using the existing registry's NFC/English lowercase convention. Iterate normalized code-point spans with a mapping back to original UTF-16 boundaries; don't build a regex from names. Treat Unicode marks as part of a word as well as letters/digits/underscore/hyphen to avoid splitting combining sequences.

```ts
export const normalizeProjectName = (value: string): string =>
  value.trim().normalize('NFC').toLocaleLowerCase('en');
export const isNameCharacter = (value: string): boolean =>
  /[\p{L}\p{M}\p{N}_-]/u.test(value);
export function deriveDraftText(markdown: string, filename: string): DraftText {
  const lines = markdown.split(/\r?\n/);
  const first = lines.findIndex(line => line.trim().length > 0);
  const heading = first < 0 ? null : /^#\s+(.+?)\s*$/.exec(lines[first]);
  return heading
    ? { title: heading[1], description: lines.slice(first + 1).join('\n') }
    : { title: filename.replace(/\.md$/, ''), description: markdown };
}
```

`resolveProjects` returns a pure `ResolutionResult` without a revision token. Define `resolutionPayload(draft: DraftText, catalog: CatalogView, choices: ResolutionChoices): string` beside it: serialize draft fields, catalog revision, sorted exclusions, and sorted ambiguity key/value pairs in a fixed field order. The Task 10 service hashes that payload with Node SHA-256 and adds `revision` to produce `ResolutionPreview`. Keep shared/browser-imported modules free of Node imports. Default choices are `{ excludedReferenceIds: [], ambiguities: {} }`; the server validates all choice IDs before issuing a preview.

- [ ] **Step 4: Add disposable fixture utilities.** `createProjectFixture(): Promise<{ base: string; root: string; local: string; workspace: string; configPath: string; dispose(): Promise<void> }>` creates sibling directories under `mkdtemp`. `git(cwd: string, args: string[], input?: string): Promise<string>` uses `spawn` without a shell and local test identity; `createRepository(root: string, name: string, files: Record<string,string>): Promise<{ path: string; commit: string }>` initializes `main`, writes files, stages, commits, and returns HEAD. `treeDigest(root: string): Promise<string>` hashes sorted relative paths, modes, symlink targets, and regular-file bytes including `.git`, excluding access timestamps. These are test-only helpers in `server/testing/projects.ts`; always dispose in `finally`/`afterEach`. Use small harmless content only.
- [ ] **Step 5: Rerun the resolver tests and commit.** `git add shared/projects.ts shared/project-resolution.ts shared/project-resolution.test.ts server/testing/projects.ts`; commit `feat: define deterministic project target and reference resolution`.

## Task 2: Persist and apply the global root setting

**Files:** Create `server/projects/settings.ts`, `.test.ts`; modify `server/config/settings.ts`, `.test.ts`, `config/examples/settings.json`.

**Interfaces:** Export `RootSetting = { projectsRoot: string | null; revision: string; generation: string; state: 'unset' | 'ready' | 'unavailable'; message: string | null }`; `openProjectSettings(configPath: string, settings: Settings): Promise<ProjectSettingsService>`. Service methods: `read(): Promise<RootSetting>`, `save(input: { projectsRoot: string | null; expectedRevision: string; requestId: string }): Promise<RootSetting>`. Root generations and request journals reside under `localRoot/projects/settings/`.

- [ ] **Step 1: Write persistence, stale-save, and containment tests.** Reuse the existing settings-test executable fixture. Add:

```ts
const before = await service.read();
const saved = await service.save({
  projectsRoot: fixture.root, expectedRevision: before.revision, requestId: 'root-save-1',
});
expect(saved.projectsRoot).toBe(await realpath(fixture.root));
const reopened = await openProjectSettings(fixture.configPath, settings);
expect(await reopened.read()).toEqual(saved);
await expect(service.save({ projectsRoot: null, expectedRevision: before.revision,
  requestId: 'root-save-2' })).rejects.toMatchObject({ code: 'conflict' });
const persisted = JSON.parse(await readFile(fixture.configPath, 'utf8'));
expect(persisted.codexBinary).toBe(settings.codexBinary);
```

Also assert null backward compatibility, all ancestor/descendant overlaps, configuration inside root, symlink canonicalization, unreadable/missing source, repeat request ID with different payload, crash after config rename but before generation journal completion, and removal of the root after a valid save. The last case loads the application with state `unavailable`, not a fatal settings parse error.

- [ ] **Step 2: Run `npx vitest run server/config/settings.test.ts server/projects/settings.test.ts`; expect new behavior to fail.**
- [ ] **Step 3: Add optional startup fields and a serialized settings transaction.** `projectsRoot` defaults to null; validate type and absolute syntax at startup, but report runtime availability through the service. Add positive integer overrides `projectSnapshotMaxEntries`, `projectSnapshotMaxBytes`, `projectSnapshotMaxFileBytes`, and `projectGitTimeoutMs`, defaulting to `100000`, `1073741824`, `67108864`, and `120000`. Keep the UI limited to root configuration; these limits remain host options. Config saves only change `projectsRoot`.

```ts
const parentOrSame = (path: string, parent: string): boolean =>
  path === parent || path.startsWith(parent + sep);
const overlaps = (left: string, right: string): boolean =>
  parentOrSame(left, right) || parentOrSame(right, left);
// After realpath/stat/access and revision validation:
if (overlaps(root, settings.workspaceRoot) || overlaps(root, settings.localRoot) ||
    parentOrSame(await realpath(configPath), root)) {
  throw new BoundaryError('invalid', 'Projects root overlaps Symphony writable storage');
}
const nextDocument = { ...currentDocument, projectsRoot: root };
await writeAtomic(configPath, Buffer.from(`${JSON.stringify(nextDocument, null, 2)}\n`));
```

Keep the root-change intent durable before replacing config, including old/new config digests and new generation. Recovery completes only when current bytes match old or intended new digest; otherwise returns conflict without overwriting external edits. Root setting revisions hash the entire config bytes, so an external change to unrelated fields causes a stale-save conflict. Replay an identical request before enforcing a fresh revision. Trigger discovery only after durable save. Read-only scans never create the configured root.

- [ ] **Step 4: Rerun focused tests and commit the exact changed files.** Commit `feat: configure a live read-only projects root`.

## Task 3: Discover repositories and persist the catalog

**Files:** Create `server/projects/discovery.ts`, `.test.ts`, `catalog.ts`, `.test.ts`.

**Interfaces:** `scanRoot(root: RootSetting, options: { timeoutMs: number }): Promise<DiscoveryResult>`. `DiscoveryResult` contains `entries: Array<{ name: string; canonicalPath: string | null; gitDir: string | null; branches: string[]; currentBranch: string | null; observedCommit: string | null; error: string | null }>` and `scannedAt: string`. `openProjectCatalog(localRoot: string): Promise<ProjectCatalog>`; methods `reconcile(root, discovery): Promise<CatalogSnapshot>`, `read(): Promise<CatalogSnapshot>`, `edit(input: { projectId: string; expectedRevision: string; requestId: string; aliases: string[]; displayName: string; defaultRef: string | null }): Promise<ProjectRecord>`.

`ProjectRecord` extends `ProjectName` with `repositoryId: string`, `generation: string`, `sourcePath: string`, `gitDir: string`, `displayName: string`, `defaultRef: string | null`, `branches: string[]`, `observedCommit: string | null`, `revision: string`, `readiness: ProjectReadiness`, `error: string | null`, and `lastScannedAt: string`. `CatalogSnapshot` extends `CatalogView` with `records: ProjectRecord[]`, `ineligible: DiscoveryResult['entries']`, and `scannedAt`. Historical generations remain addressable by bound IDs; root scans never delete evidence.

- [ ] **Step 1: Write real-directory discovery and catalog tests.**

```ts
const fixture = await createProjectFixture();
try {
  const shop = await createRepository(fixture.root, 'shop', { 'README.md': 'Shop\n' });
  await mkdir(join(fixture.root, 'group'));
  await createRepository(join(fixture.root, 'group'), 'nested', { 'README.md': 'Nested\n' });
  await symlink(shop.path, join(fixture.root, 'linked'));
  const before = await treeDigest(fixture.root);
  const result = await scanRoot({ projectsRoot: fixture.root, generation: 'g1',
    revision: 'r1', state: 'ready', message: null }, { timeoutMs: 5000 });
  expect(result.entries.filter(entry => entry.error === null).map(entry => entry.name)).toEqual(['shop']);
  expect(await treeDigest(fixture.root)).toBe(before);
} finally { await fixture.dispose(); }
```

Additional fixtures: enclosing parent repository, empty repo, bare repo, linked worktree, `.git` symlink, object alternates, path replaced after scan, names differing only by case/normalization, missing root, new child conflicting with an existing alias, and two concurrent edits with the same revision. Reconcile the same scan twice and assert IDs/revision remain stable; change only `lastScannedAt` and assert preview revision does not churn.

- [ ] **Step 2: Run `npx vitest run server/projects/discovery.test.ts server/projects/catalog.test.ts`; expect missing services or failed assertions.**
- [ ] **Step 3: Implement read-only scanning and catalog reconciliation.** Use `lstat` then `realpath` for child and Git metadata. Inspect with `git rev-parse --show-toplevel`, `--absolute-git-dir`, `--is-bare-repository`, `symbolic-ref --quiet HEAD`, and `for-each-ref refs/heads`, with time/output bounds and disabled optional writes. Verify exact top level, root containment, metadata containment, and absent alternates. A per-entry error does not invalidate other entries; a root enumeration failure does.

```ts
export function discoveredProjectId(generation: string, canonicalPath: string): string {
  return `discovered-${createHash('sha256')
    .update(JSON.stringify([generation, canonicalPath])).digest('hex').slice(0, 32)}`;
}
// Repository identity is one-to-one in this feature.
const repositoryId = projectId;
```

Reconcile project metadata through serialized atomic writes and request receipts. Never overwrite aliases/brief pointers on a scan. New current branches initialize defaults; missing saved defaults remain errors instead of being silently replaced. Root generation changes retire records for matching but retain history. Stable catalog revision hashes matching/default/readiness-relevant content, excluding observation timestamps. Use a shared read-only Git command wrapper; Task 4 moves it into `git.ts` without changing behavior.

- [ ] **Step 4: Rerun tests and commit.** Commit `feat: discover and catalog repositories beneath the projects root`.

## Task 4: Import committed objects and materialize immutable snapshots

**Files:** Create `server/projects/git.ts`, `.test.ts`, `snapshots.ts`, `.test.ts`; modify `discovery.ts` to use the shared Git wrapper.

**Interfaces:** `resolveSourceCommit(project: ProjectRecord, ref: string): Promise<{ commit: string; objectFormat: 'sha1' | 'sha256' }>`; `openSnapshots(localRoot: string, limits: SnapshotLimits): SnapshotService`. `SnapshotLimits = { entries: number; totalBytes: number; fileBytes: number; timeoutMs: number }`. Methods: `importCommit(project, resolved): Promise<void>`, `materialize(project, resolved): Promise<SnapshotRef>`, `verify(ref: SnapshotRef): Promise<SnapshotManifest>`, `readText(ref: SnapshotRef, path: string): Promise<{ text: string; entry: SnapshotEntry }>`. `resolved` is the return type of `resolveSourceCommit`. All reads derive paths from owned storage and IDs, never caller-supplied absolute paths.

`SnapshotEntry = { path: string; mode: string; kind: 'file' | 'symlink' | 'submodule'; objectId: string; contentDigest: string | null; bytes: number; text: boolean; lfsPointer: boolean }`; `SnapshotManifest = { version: 1; ref: Omit<SnapshotRef,'manifestDigest'>; entries: SnapshotEntry[]; totalBytes: number }`. Aggregate selection limits are checked in binding in Task 9 as well as individual preparation here.

- [ ] **Step 1: Add committed-versus-dirty, immutable-retry, and source-write tests.**

```ts
const before = await treeDigest(fixture.root);
const resolved = await resolveSourceCommit(project, 'main');
await snapshots.importCommit(project, resolved);
const snapshot = await snapshots.materialize(project, resolved);
expect((await snapshots.readText(snapshot, 'README.md')).text).toBe('Committed\n');
expect(await treeDigest(fixture.root)).toBe(before);
await writeFile(join(repo.path, 'README.md'), 'Dirty replacement\n');
expect((await snapshots.readText(snapshot, 'README.md')).text).toBe('Committed\n');
```

Use fixtures where dirty/staged/untracked files exist before capturing `before`. Add executable file, inert symlink to outside root, submodule gitlink, LFS pointer, invalid UTF-8/binary, filenames with spaces/newlines, object-format SHA-256, file/entry/byte limit overflow, tampered snapshot and manifest, same commit rebuild, missing object after ref binding, and `.git` replacement during import. Assert optional source metadata does not change. Each failure identifies the affected repository and limit/entry; it never yields a ready partial snapshot.

- [ ] **Step 2: Run `npx vitest run server/projects/git.test.ts server/projects/snapshots.test.ts server/projects/discovery.test.ts`.**
- [ ] **Step 3: Implement bounded local object import and entry materialization.** Use `spawn` with no shell. Disable Git optional locks, lazy fetching, automatic maintenance, fsmonitor, hooks, replace-object interpretation, and global/system config; clear inherited `GIT_DIR`, work-tree/index/object-directory/alternate overrides. Explicitly validate the repository's local object format and reject external alternates/metadata. Imported objects must be standalone under `localRoot/projects/objects/<repositoryId>/`; do not hardlink or create alternates to the source.

```ts
const gitEnvironment = {
  PATH: process.env.PATH,
  GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};
const safeConfig = ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
  '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
```

On the supported POSIX host, initialize an owned bare object store in the source object format. Stream source `pack-objects --stdout --revs` with the already resolved commit on stdin into owned `index-pack --stdin`; bound wall time/diagnostics, terminate both children on error, and verify the intended commit exists in the owned store before recording import success. Pin an owned ref so future owned maintenance cannot prune task evidence. No network transports are involved.

Enumerate owned committed entries using NUL-delimited `ls-tree -r -z`; copy regular blobs through `cat-file` without filters, and record links/submodules as inert manifest entries. Reject absolute/traversal paths, unsafe metadata paths, duplicate/case-fold collisions that cannot be materialized faithfully, and non-round-trippable filesystem names with an explicit unsupported-source error. Detect invalid UTF-8/NUL binary content; keep bytes but refuse text citations. Write into a temporary owned directory, hash entries and canonical manifest, then atomically publish. Concurrent imports/materializations for the same identity share a serialized operation. Manifest verification checks recorded files, digests, entry kinds, containment, and absence of redirected links before dispatch/preview. Failure may rebuild only from retained objects for the same commit.

- [ ] **Step 4: Rerun focused tests and commit.** Commit `feat: prepare verified read-only committed project snapshots`.

## Task 5: Version task context and enforce immutable project scope

**Files:** Modify `shared/contracts.ts`, `shared/validate.ts`, `shared/validate.test.ts`, `server/domain/workflow.ts`, `.test.ts`, `server/store/task-store.test.ts`; create `shared/project-validation.ts`, `.test.ts`, `server/domain/project-policy.ts`, `.test.ts`.

**Interfaces:** Preserve a discriminated `Task` union: existing fields become `TaskFields`; `LegacyTask = TaskFields & { schemaVersion: 1 }`; `ConnectedTask = TaskFields & { schemaVersion: 2; purpose: 'task' | 'project-brief'; projectContext: ProjectContext }`; `Task = LegacyTask | ConnectedTask`. Connected records retain `projectId: null`; the legacy field never represents the target. `parseProjectContext(value: unknown, purpose: ConnectedTask['purpose']): ProjectContext`; `assertProjectStep(task: Task, step: AgentStep): void`; `assertProjectWorkflow(task: Task, workflow: Workflow): void`.

- [ ] **Step 1: Add strict parser, reducer, and replay tests.** Create a fixture `connectedTask(context: ProjectContext, purpose: 'task' | 'project-brief' = 'task'): ConnectedTask` in `server/testing/projects.ts` by spreading `draftTask()` and replacing schema/version/purpose/context. A user task requires nonnull briefs; internal brief jobs allow null only for their single selected project, with no future target.

```ts
const original = connectedTask(context);
expect(parseTask(JSON.parse(JSON.stringify(original)))).toEqual(original);
expect(parseTask(draftTask())).toEqual(draftTask());
expect(() => assertProjectStep(original, {
  kind: 'agent', id: 'research', title: 'Research', role: 'researcher',
  instructions: 'Inspect', inputs: [], repositories: [context.projects[0].repositoryId],
  actions: ['write-local'], outputs: ['findings'], checks: ['findings'],
})).toThrow(/read-only/i);
```

Test duplicate IDs, target repeated as reference, unmatched repository/snapshot IDs, arbitrary digest/path values, null user brief, wrong schema fields, attempted target reassignment, foreign repository, non-read action in initial/revised workflow, and store close/reopen event replay with exact context. Assert schema-1 events still replay byte-equivalent states.

- [ ] **Step 2: Run `npx vitest run shared/validate.test.ts shared/project-validation.test.ts server/domain/project-policy.test.ts server/domain/workflow.test.ts server/store/task-store.test.ts`.**
- [ ] **Step 3: Implement context parsing and policy at proposal, acceptance, and launch.** Use strict key validation and existing error classes. Validate commit IDs against `snapshot.objectFormat` (40 or 64 hex digits); SHA-256 digests always have 64 hex digits. Structured snapshots contain IDs, never absolute paths.

```ts
export function assertProjectStep(task: Task, step: AgentStep): void {
  if (task.schemaVersion !== 2) return;
  if (step.actions.length !== 1 || step.actions[0] !== 'read')
    throw new Error('Connected projects are read-only');
  const allowed = new Set(task.projectContext.projects.map(item => item.repositoryId));
  if (new Set(step.repositories).size !== step.repositories.length ||
      step.repositories.some(id => !allowed.has(id)))
    throw new Error('Workflow selected an unbound repository');
}
```

Call workflow policy before accepting proposed/revised workflows and again on human approval. In reducer proposal handling, schema-2 results must have `projectId: null`; preserve the immutable context and original matching provenance despite display-title changes. In `eligibleStep`, connected `$triage` uses all bound repository IDs instead of the existing empty list. Internal brief tasks bypass triage only through a fixed queued researcher workflow created by the brief service, never user input. No mutable checkout preparation for any schema-2 record.

- [ ] **Step 4: Rerun tests and commit.** Commit `feat: persist immutable multi-project task context`.

## Task 6: Verify snapshot access and exact combined capabilities

**Files:** Create `server/codex/snapshot-access.ts`, `.test.ts`, `snapshot-capability.ts`, `.test.ts`; modify `repository-access.ts`, `capability.ts`, `adapter.ts`, `coordinator.ts` and their tests.

**Interfaces:** Preserve existing `RepositoryAccess` for legacy paths; add `SnapshotAccess = { kind: 'snapshot'; repository: string; snapshot: SnapshotRef; snapshotPath: string }` and `Assignment.snapshotAccess?: SnapshotAccess[]`. `resolveSnapshotAccess(context: ProjectContext, repositoryIds: string[], snapshots: SnapshotService): Promise<SnapshotAccess[]>`; `verifySnapshotProfile(settings: Settings, assignment: Assignment, version: string): Promise<{ sandbox: 'read-only'; cliProfile: string }>`.

- [ ] **Step 1: Write scope-validation and dispatch regression tests.**

```ts
const access = await resolveSnapshotAccess(context,
  context.projects.map(project => project.repositoryId), snapshots);
expect(access.map(item => item.snapshot.commit))
  .toEqual(context.projects.map(project => project.snapshot.commit));
await expect(resolveSnapshotAccess(context, ['unbound'], snapshots)).rejects.toThrow(/unbound/i);
expect(access.every(item => item.snapshotPath.startsWith(settings.localRoot + sep))).toBe(true);
```

Build verification-manifest fixtures covering missing/stale/duplicate profiles, two individual profiles without a combined profile, exact combined profile, extra scope, changed policy/skill digest, role action supersets, tampered snapshot, redirected path, and no selected repositories. Assert a schema-2 dispatch never invokes `resolveLocalRef` or `prepareCheckout`, and no source/object-store path appears in the assignment. Keep legacy mapping/profile tests intact.

- [ ] **Step 2: Run `npx vitest run server/codex/snapshot-access.test.ts server/codex/snapshot-capability.test.ts server/codex/capability.test.ts server/codex/adapter.test.ts server/coordinator/coordinator.test.ts`.**
- [ ] **Step 3: Add a separately versioned snapshot attestation format and route by assignment type.** Snapshot profiles bind role/base execution profile, actual CLI version, exact sorted repository snapshot roots, immutable policy/skill/environment digests, and recorded host probe evidence. Dynamic snapshot IDs bind through verified manifests under those roots. Root discovery itself never grants agent capabilities.

```ts
const selected = assignment.step.repositories;
if (assignment.task.schemaVersion === 2) {
  assertProjectStep(assignment.task, assignment.step);
  const access = await resolveSnapshotAccess(assignment.task.projectContext, selected, snapshots);
  const scopedAssignment = { ...assignment, repositoryAccess: [], snapshotAccess: access };
  const profile = await verifySnapshotProfile(settings, scopedAssignment, version);
  return { assignment: scopedAssignment, profile };
}
```

Implement this branch in focused helpers used by coordinator/adapter; retain legacy code paths. Adapter validation rejects nonempty legacy access together with snapshot access and validates declared input materials before launching. Keep the existing `--sandbox read-only` launch path; do not pass snapshots through `--add-dir`, which is currently used for writable grants. Snapshot readability comes from the verified host profile/tool mechanism. Record and verify that actual mechanism, and block with Needs setup if it cannot read the selected snapshots. Use the run work directory under `localRoot/tasks/<taskId>/`, never the source root as cwd. Existing startup verification must remain strict for legacy profiles but must not interpret unready catalog entries as globally fatal. Match one combined profile exactly; no automatic attestation recomputation counts as verification. Separate execution-policy digests from mutable root-setting/name/brief values. A root generation produces distinct project scope IDs; existing task profiles remain valid unless their actual policy changes.

- [ ] **Step 4: Rerun tests and commit.** Commit `feat: enforce verified read-only snapshot access for project tasks`.

## Task 7: Publish structured source reports and validate citations

**Files:** Create `shared/source-report.ts`, `.test.ts`, `server/projects/citations.ts`, `.test.ts`; modify `server/codex/prompt.ts`, `server/coordinator/coordinator.ts`, its tests.

**Interfaces:** `parseSourceReport(value: unknown): SourceReport`; `citationIds(text: string): string[]` recognizes `[cite:ID]` markers only. `validateSourceReport(report: SourceReport, allowed: SnapshotRef[], snapshots: SnapshotService, limits: { textBytes: number; citations: number }): Promise<void>`; `readCitation(report: SourceReport, citationId: string, allowed: SnapshotRef[], snapshots: SnapshotService): Promise<SourcePreview>`. `SourcePreview = { repositoryId: string; commit: string; path: string; firstLine: number; startLine: number; endLine: number; lines: string[] }`.

- [ ] **Step 1: Add valid multi-repository and rejection examples.**

```ts
const report: SourceReport = { format: 'source-report-v1',
  text: 'Checkout validates inputs [cite:checkout].', citations: [citation] };
await expect(validateSourceReport(report, [snapshot], snapshots,
  { textBytes: 128 * 1024, citations: 256 })).resolves.toBeUndefined();
const escaped = { ...report, citations: [{ ...citation, path: '../private.txt' }] };
await expect(validateSourceReport(escaped, [snapshot], snapshots,
  { textBytes: 128 * 1024, citations: 256 })).rejects.toThrow(/path/i);
expect(citationIds('Read [cite:checkout]; https://example.invalid/file')).toEqual(['checkout']);
```

Test missing/duplicate marker IDs, wrong repository/commit/blob/digest, noninteger/inverted/out-of-range lines, over-1000-line/256-KiB range, symlinks/submodules/binary/invalid UTF-8, old brief source versus current task source, HTML-looking source, final newline semantics, total output limits, and a report that explicitly states an evidence gap with no citations. Empty or whitespace-only report text is invalid.

- [ ] **Step 2: Run `npx vitest run shared/source-report.test.ts server/projects/citations.test.ts server/coordinator/coordinator.test.ts`.**
- [ ] **Step 3: Keep the outer agent result protocol compatible and version the report payload.** Existing `AgentResult.completed.evidence` remains string-valued. For connected report output IDs, each string contains serialized `SourceReport`; plain-text schema-1 outputs remain unchanged. The coordinator parses and validates all declared reports before publishing any of them. Persist the canonical JSON envelope as one versioned artifact, so text and citation mapping cannot diverge. Do not extend source browsing to arbitrary Markdown links.

```ts
const reports = assignment.step.outputs.map(id => ({
  id, report: parseSourceReport(JSON.parse(result.evidence[id])),
}));
for (const { report } of reports) {
  await validateSourceReport(report,
    assignment.task.projectContext.projects.map(project => project.snapshot), snapshots,
    { textBytes: Math.min(1024 * 1024, settings.outputLimitBytes), citations: 256 });
}
```

Place the snippet in a helper narrowed to a `ConnectedTask`/completed result; enforce aggregate envelope bytes across outputs before publication. Report check strings must still pass existing checks. Update prompt instructions only for schema-2 assignments, explaining IDs, markers, immutable target/reference roles, read-only investigation, and evidence-gap reporting. Writers receive accepted reports and any originating brief citations as separate trusted context; they must not retarget old citations to new commits. Validate prompt material bounds including all copied briefs. `readCitation` validates the persisted report and manifest again, returns bounded surrounding context, and rejects a citation outside the report's explicitly allowed snapshots.

- [ ] **Step 4: Rerun tests and commit.** Commit `feat: publish grounded project reports with validated source citations`.

## Task 8: Version project briefs and schedule generation through the coordinator

**Files:** Create `server/projects/briefs.ts`, `.test.ts`, `brief-jobs.ts`, `.test.ts`, `server/coordinator/store-router.ts`, `.test.ts`; modify `coordinator.ts`, `recovery.ts` and relevant tests, `adapter.ts` material validation.

**Interfaces:** `openBriefs(localRoot: string, snapshots: SnapshotService): Promise<BriefService>` with `current(projectId): Promise<BriefCopy | null>`, `get(projectId, version): Promise<BriefCopy>`, `history(projectId): Promise<BriefCopy[]>`, `save(input: { projectId: string; expectedVersion: number | null; requestId: string; author: BriefCopy['author']; source: SnapshotRef; report: SourceReport }): Promise<BriefCopy>`.

`createBriefJobs(deps: { store: Store; briefs: BriefService; snapshots: SnapshotService; localRoot: string }): BriefJobs`; methods `enqueue(project: ProjectRecord, snapshot: SnapshotRef, requestId: string): Promise<OperationStatus>`, `reconcile(): Promise<void>`, `status(id: string): Promise<OperationStatus>`, `candidate(id: string): Promise<SourceReport | null>`. Persist jobs in a normal `Store` opened at `localRoot/projects/jobs/`; they are not included in the public task list.

`createStoreRouter(primary: Store, projectJobs: Store): Store` exposes a combined internal scheduling/recovery view, routes existing IDs to their owning store, rejects duplicate IDs, and routes `purpose:'project-brief'` creation to the job store. The public API continues to use `primary`, never the router. Existing file-review adapter continues to see only primary tasks.

- [ ] **Step 1: Test optimistic brief saves, isolated stores, and the shared execution limit.**

```ts
const saved = await briefs.save({ projectId: project.id, expectedVersion: null,
  requestId: 'brief-1', author: 'human', source: snapshot, report });
await expect(briefs.save({ projectId: project.id, expectedVersion: null,
  requestId: 'brief-2', author: 'human', source: snapshot, report }))
  .rejects.toMatchObject({ code: 'conflict' });
expect(await briefs.get(project.id, saved.version)).toEqual(saved);
const routed = createStoreRouter(primaryStore, jobStore);
await routed.create(briefTask, 'create-brief');
expect((await primaryStore.list()).tasks).toHaveLength(0);
expect((await routed.list()).tasks.map(task => task.id)).toContain(briefTask.id);
```

Use `controlledRunner()` with concurrency 1, a queued ordinary task, and a queued brief task; run `tick` and assert only one start. Finish it, tick again, and assert the second starts. Reopen both stores after a launch intent, uncertain process exit, successful job completion before brief save, and brief save before job reconciliation. Assert no duplicated generation/save and proper shutdown waits. Test generation failure preserves an edited brief; regeneration yields a candidate and requires explicit save; an initial successful generation becomes current once.

- [ ] **Step 2: Run `npx vitest run server/projects/briefs.test.ts server/projects/brief-jobs.test.ts server/coordinator/store-router.test.ts server/coordinator/coordinator.test.ts server/coordinator/recovery.test.ts`.**
- [ ] **Step 3: Implement version storage and fixed internal brief tasks.** Brief versions are append-only with report digest, source snapshot, author kind, timestamp, and request receipt; current pointer updates use an expected version. Do not use source-folder sidecars.

```ts
const briefStep: AgentStep = {
  kind: 'agent', id: 'generate-brief', title: 'Describe project context', role: 'researcher',
  instructions: 'Inspect documentation, manifests, representative entry points and test configuration. '
    + 'Describe purpose, architecture, conventions, discovered validation commands and inspection limits. '
    + 'Return source-report-v1 with citations. Do not run project commands; label commands Not run.',
  inputs: [], repositories: [project.repositoryId], actions: ['read'],
  outputs: ['project-brief'], checks: ['project-brief'],
};
```

Create a schema-2 queued internal task with a single reference snapshot and null brief, this fixed workflow, and no triage or user workflow mutation. Use the same lifecycle and shared router-backed coordinator; unique UUIDs keep existing run paths valid. Task- and snapshot-write denial must include the internal job store. The router propagates primary-store degradation as before. Job-store issues remain scoped to internal jobs and exclude unavailable job candidates without degrading the primary queue; expose those issues through preparation status. A malformed job record must not hide a healthy ordinary task. Startup recovery operates over the router once.

`reconcile()` reads finished validated job artifacts; save an initial generated brief idempotently only if no current version exists, otherwise preserve it as a candidate. Store a candidate's originating snapshot alongside it. Reconciliation must not hold a coordinator slot or wait for another job inside `tick`. Account for copied brief text in adapter input-material limits; prompts list each brief's distinct provenance.

- [ ] **Step 4: Rerun tests and commit.** Commit `feat: generate and version project briefs with shared coordinator scheduling`.

## Task 9: Bind project submissions durably before intake dispatch

**Files:** Create `server/projects/binding.ts`, `.test.ts`, `server/intake/project-drafts.ts`, `.test.ts`; modify `server/intake/intake.ts`, `.test.ts`.

**Interfaces:** `createProjectBinding(deps: { catalog: ProjectCatalog; snapshots: SnapshotService; briefs: BriefService; localRoot: string }): BindingService`; methods `begin(input: ProjectDraft, requestId: string): Promise<OperationStatus>`, `advance(id: string): Promise<OperationStatus>`, `getContext(id: string): Promise<ProjectContext | null>`. `begin` receives a validated current preview; the service rechecks selection IDs/defaults/brief versions against that revision before persisting intent.

`createProjectDrafts(deps: { binding: BindingService; localRoot: string; resolve: (draft: DraftText, choices: ResolutionChoices) => Promise<ResolutionPreview> }): ProjectDraftGate`; `prepare(input: { submissionId: string; requestId: string; filename: string; markdown: string; projectDraft?: ProjectDraft }): Promise<{ state: 'pending' | 'needs-input'; message: string } | { state: 'ready'; title: string; context: ProjectContext | null }>`; `resolveIssue(submissionId: string, expectedRevision: number, input: ProjectDraft, requestId: string): Promise<OperationStatus>`. Intake invokes the gate after claiming stable bytes but before `store.create`/dispatch.

- [ ] **Step 1: Test journal replay and UI/filesystem equivalence.**

```ts
const operation = await binding.begin(input, 'submit-1');
await binding.advance(operation.id);
const context = await binding.getContext(operation.id);
expect(context?.targetId).toBe(inputTargetId);
expect(context?.referenceIds).toEqual(inputReferenceIds);
await git(targetSourcePath, ['commit', '--allow-empty', '-m', 'Advance source']);
await binding.advance(operation.id);
expect(await binding.getContext(operation.id)).toEqual(context);
await expect(binding.begin({ ...input, text: { ...input.text, title: '[other] Change' } },
  'submit-1')).rejects.toMatchObject({ code: 'conflict' });
```

Add crash injection after each per-project ref journal write, after imported snapshot creation, after complete context write, before draft publication, and after `store.create`. Assert original refs/briefs/task ID survive. Missing source objects fail at the bound commit. Test multi-project aggregate limits, source removal/root change after binding, new source between preview and acceptance, unresolved filesystem prefix/alias, alias correction through `resolveIssue`, and a projectless draft. Tests for unknown filesystem targets must prove no runner dispatch and no duplicate task after resolution.

- [ ] **Step 2: Run `npx vitest run server/projects/binding.test.ts server/intake/project-drafts.test.ts server/intake/intake.test.ts`.**
- [ ] **Step 3: Implement a staged submission journal and nonblocking intake gate.** Persist canonical input digest and operation ID first; resolve and journal each project ref individually, then import/materialize it. Copy the exact selected immutable brief, even if the current library pointer changes. Enforce aggregate entry/byte/material limits across the complete context before publication. Never silently trim/drop contexts. Partial progress returns pending and advances on subsequent ticks; do not await generation completion while holding intake's serial queue.

```ts
const prepared = await projectGate.prepare({ submissionId, requestId, filename,
  markdown: idea, projectDraft });
if (prepared.state !== 'ready') {
  addIssue(filename, prepared.message);
  return;
}
const task: Task = prepared.context === null ? legacyTask : {
  ...legacyTask, schemaVersion: 2, purpose: 'task', projectId: null,
  title: prepared.title, projectContext: prepared.context,
};
await store.create(task, operationId);
```

Integrate this within existing receipt recovery; retain the claimed draft bytes and task ID while pending. Do not rename the draft as consumed until its preparation/creation intent is recoverable. Root-configured submissions, including raw Markdown API requests, use the same gate. A null root follows legacy behavior. Explicit UI title/description must reconstruct the posted Markdown exactly; reject mismatches rather than binding from different text. Unresolved filesystem drafts expose a durable issue with a submission ID and revision through the project API; users can correct the pending text/choices there without creating a new submission. Different accepted input under an already bound request ID is a conflict.

- [ ] **Step 4: Rerun tests and commit.** Commit `feat: bind project contexts durably before task intake`.

## Task 10: Compose project services and expose bounded APIs

**Files:** Create `server/projects/service.ts`, `.test.ts`, `server/http/projects.ts`, `.test.ts`; modify `server/main.ts`, `.test.ts`, `server/http/api.ts`, `.test.ts`.

**Interfaces:** `openProjectServices(configPath: string, settings: Settings, primary: Store): Promise<ProjectServices>` composes prior services. It also owns durable preparation/verification operations: `prepare(projectId: string, ref: string, requestId: string): Promise<OperationStatus>` and `verify(projectId: string, requestId: string): Promise<OperationStatus>`. Preparation journals the chosen commit, imports/materializes it, checks researcher access, and enqueues first-brief generation if needed. Verification checks actual compatible profile evidence through Task 6; if there is no installed host verifier/provider, it returns Needs setup with configuration guidance. It never fabricates probe evidence. All assignment launches still recheck the exact selected combined scope. `ProjectServices` exposes `settings`, `catalog`, `snapshots`, `briefs`, `briefJobs`, `binding`, `draftGate`, `schedulerStore: Store`, `tick(): Promise<void>`, `close(): Promise<void>`, `resolve(draft, choices): Promise<ResolutionPreview>`, and operation lookup. `handleProjectRequest(request, response, url, services): Promise<boolean>` returns whether it handled the route. Existing `checkAccess` executes before this handler; all mutations remain POST.

- [ ] **Step 1: Add HTTP and startup tests for the following exact routes.** Route tests cover success plus malformed JSON, extra forbidden path fields, stale revision, unavailable root, wrong origin, oversized body, and missing resource.

| Method/path | Request/result |
| --- | --- |
| `GET /api/settings/projects` | `RootSetting` only |
| `POST /api/settings/projects` | root save input → `RootSetting` |
| `GET /api/projects` | `CatalogSnapshot` |
| `POST /api/projects/rescan` | request ID → operation, then catalog |
| `POST /api/projects/resolve` | `{ text, choices }` → current `ResolutionPreview` |
| `GET /api/projects/:id` | project, branches, brief history, readiness |
| `POST /api/projects/:id` | alias/display/default edit with expected revision |
| `POST /api/projects/:id/prepare` | `{ requestId, ref }` → operation |
| `POST /api/projects/:id/verify` | request ID → verification operation/status |
| `GET /api/projects/:id/briefs/:version` | immutable `BriefCopy` |
| `POST /api/projects/:id/briefs` | brief save input → `BriefCopy` |
| `POST /api/projects/:id/briefs/generate` | `{ requestId, ref }` → operation/candidate |
| `GET /api/project-operations/:id` | operation status, with candidate reference when present |
| `GET /api/project-submissions/:id` | unresolved submission text, revision, problems, preview |
| `POST /api/project-submissions/:id/resolve` | resolution input + expected revision/request ID |
| `POST /api/drafts` | legacy `{ markdown, requestId }` or additional `projectDraft`; accepted submission receipt |
| `GET /api/tasks/:task/artifacts/:artifact/report?version=N` | validated `SourceReport`, or unsupported format |
| `GET /api/tasks/:task/artifacts/:artifact/citations/:citation?version=N` | authorized `SourcePreview` |
| `GET /api/projects/:id/briefs/:version/citations/:citation` | preview bound to that brief's own source |

```ts
const response = await fetch(`${address}/api/settings/projects`);
const body = await response.json();
expect(Object.keys(body).sort()).toEqual(
  ['generation', 'message', 'projectsRoot', 'revision', 'state']);
expect(JSON.stringify(body)).not.toContain('codexBinary');
const refused = await fetch(`${address}/api/projects/rescan`, {
  method: 'POST', headers: { origin: 'https://untrusted.invalid', 'content-type': 'application/json' },
  body: JSON.stringify({ requestId: 'rescan-1' }),
});
expect(refused.status).toBe(403);
```

Reuse existing API-test origin expectations if the access helper deliberately returns a different refusal status; preserve the helper's semantics and assert denied/no mutation. Verify task/source endpoints cannot access internal job tasks through their UUIDs. Test browser disconnect/reconnect and restart while jobs/submissions are pending.

- [ ] **Step 2: Run `npx vitest run server/http/projects.test.ts server/http/api.test.ts server/projects/service.test.ts server/main.test.ts`.**
- [ ] **Step 3: Wire startup/recovery/ticks without long HTTP requests.** Open primary store, project settings/catalog/snapshots/briefs/job store, then shared router, intake gate, and the existing coordinator. Dependency cycles are resolved by constructing services before assigning the gate's callback for enqueueing preparation; the runner is owned only by the coordinator. `projects.tick()` advances preparation and reconciles finished brief jobs without calling a second runner. Call it from `beforeDispatch` after preserving existing file-review behavior. Since intake scans before this callback, pending work resumes on a following tick.

```ts
const coordinator = createCoordinator({
  store: projects.schedulerStore, intake, registry, runner, settings, recovered: true,
  beforeDispatch: async now => {
    await projects.tick();
    await fileReviews?.scan(now.getTime());
  },
});
```

Run `recoverAttempts(projects.schedulerStore, settings.localRoot)` once at startup, collect issues, and pass `recovered: true` to the coordinator; replace the current primary-only recovery call rather than performing it twice. Preserve the established file-review recovery-before-dispatch ordering. No generic host-path preview route. The report endpoint verifies artifact ID/version/digest through `primary.readArtifact`, parses the envelope, and derives allowed snapshots from the persisted task or originating brief. Mutations enforce strict payload keys and use service-owned paths. Return 202 operations rather than waiting for agent generation. Startup with an unavailable root keeps the UI and historical task evidence available; new bindings fail explicitly. Cleanup waits for shared coordinator shutdown before closing project services.

- [ ] **Step 4: Rerun tests and commit.** Commit `feat: expose project settings discovery and preparation APIs`.

## Task 11: Build global settings and discovered-project management

**Files:** Create `src/projects/api.ts`, `.test.ts`, `useProjects.ts`, `.test.tsx`; create `ProjectSettings.tsx`, `ProjectsPage.tsx` and tests; modify `App.tsx`, `WorkspaceShell.tsx`, `WorkspaceSidebar.tsx`, `src/tasks/navigation.ts`, `.test.ts`, and `src/styles/workspace.css`.

**Interfaces:** `ProjectApi` mirrors Task 10 endpoints using the signatures below. Keep project data out of localStorage. Export `useProjects(api: ProjectApi)` for catalog/root loading, operation polling, connectivity/error state, and refresh. Components accept the API via props for tests. `ProjectDetail = { project: ProjectRecord; briefs: BriefCopy[] }`; `ProjectOperation = OperationStatus & { candidate: { projectId: string; source: SnapshotRef; report: SourceReport } | null }`; `ProjectSubmission = { id: string; revision: number; text: DraftText; preview: ResolutionPreview; status: OperationStatus }`.

```ts
export type ProjectApi = {
  settings(signal?: AbortSignal): Promise<RootSetting>;
  saveSettings(input: { projectsRoot: string | null; expectedRevision: string; requestId: string }): Promise<RootSetting>;
  catalog(signal?: AbortSignal): Promise<CatalogSnapshot>;
  rescan(requestId: string): Promise<OperationStatus>;
  resolve(text: DraftText, choices: ResolutionChoices, signal?: AbortSignal): Promise<ResolutionPreview>;
  detail(projectId: string, signal?: AbortSignal): Promise<ProjectDetail>;
  edit(input: { projectId: string; expectedRevision: string; requestId: string;
    aliases: string[]; displayName: string; defaultRef: string | null }): Promise<ProjectRecord>;
  prepare(projectId: string, ref: string, requestId: string): Promise<OperationStatus>;
  verify(projectId: string, requestId: string): Promise<OperationStatus>;
  brief(projectId: string, version: number, signal?: AbortSignal): Promise<BriefCopy>;
  saveBrief(input: { projectId: string; expectedVersion: number | null; requestId: string;
    author: BriefCopy['author']; source: SnapshotRef; report: SourceReport }): Promise<BriefCopy>;
  generateBrief(projectId: string, ref: string, requestId: string): Promise<OperationStatus>;
  operation(id: string, signal?: AbortSignal): Promise<ProjectOperation>;
  submission(id: string, signal?: AbortSignal): Promise<ProjectSubmission>;
  resolveSubmission(id: string, expectedRevision: number, input: ProjectDraft, requestId: string): Promise<OperationStatus>;
  report(taskId: string, artifactId: string, version: number, signal?: AbortSignal): Promise<SourceReport>;
  citation(taskId: string, artifactId: string, version: number, citationId: string,
    signal?: AbortSignal): Promise<SourcePreview>;
  briefCitation(projectId: string, version: number, citationId: string,
    signal?: AbortSignal): Promise<SourcePreview>;
};
```

Browser brief saves may submit only `human` or `human-edited` authorship; generated author identity is assigned server-side by completed jobs. Validate the source against a prepared snapshot belonging to that project rather than trusting the posted `SnapshotRef`. Task 10's HTTP handler enforces this even though the shared DTO supports all author kinds.

- [ ] **Step 1: Add settings and catalog interaction tests.**

```tsx
render(<ProjectSettings api={api} />);
const field = await screen.findByLabelText('Projects root folder');
await user.clear(field);
await user.type(field, '/srv/investigation-projects');
await user.click(screen.getByRole('button', { name: 'Save projects root' }));
expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
  projectsRoot: '/srv/investigation-projects', expectedRevision: 'settings-1',
}));
expect(await screen.findByText(/externally maintained/i)).toBeVisible();
```

Test failed save preserves field text and old root, no default `~/projects`, explicit clear, missing-root status, rejected stale aliases, unsaved brief survives polling/regeneration, operation resumes after remount, no clone/local-connect action, keyboard focus, and selected-project readiness. Add navigation tests for settings/projects screens and backward-compatible stored list/detail preferences. Mock stale API responses and assert they cannot overwrite current state.

- [ ] **Step 2: Run `npx vitest run src/projects/api.test.ts src/projects/useProjects.test.tsx src/components/ProjectSettings.test.tsx src/components/ProjectsPage.test.tsx src/tasks/navigation.test.ts src/App.test.tsx`.**
- [ ] **Step 3: Add navigation destinations and focused UI.** Extend `NavigationState.screen` with `projects` and `settings`, plus a `screen` navigation event; do not change the task filter when visiting them. Shell breadcrumbs show the active destination; task back controls only appear for detail. Use current inputs/buttons/tables/dialogs, typography, spacing, narrow-screen patterns, and origin-aware POST requests.

```ts
export type ProjectSettingsProps = { api: ProjectApi };
export type ProjectsPageProps = { api: ProjectApi; onOpenSettings(): void };
```

Settings shows root field, save/clear, saved path, read-only/external-maintenance copy, status, and rescan. Projects shows canonical names, aliases, default branch, observed commit, last scanned time, and preparation/access status. Details provide brief history/edit/candidate comparison and retry controls. Distinguish “last scanned” from freshness. Candidate generation never overwrites an active editor; saving uses the version loaded when editing began. Poll only active operations and abort reads on unmount; require fresh connectivity before mutations.

- [ ] **Step 4: Rerun tests and commit.** Commit `feat: add global projects settings and discovered project management`.

## Task 12: Preview project matching in task creation and resolve pending drafts

**Files:** Create `src/components/ProjectSelection.tsx`, `.test.tsx`; modify `NewTaskDialog.tsx`, `.test.tsx`, `src/tasks/api.ts`, `.test.ts`, `useWorkspace.ts`, `.test.tsx`, `App.tsx`, `.test.tsx`, `ProjectsPage.tsx`.

**Interfaces:** Extend `WorkspaceApi.submit(markdown, requestId, projectDraft?: ProjectDraft)`; keep existing first two arguments. Extend `useWorkspace.submit` similarly. `ProjectSelection` props: `{ api: ProjectApi; text: DraftText; onChange(value: ProjectDraft | null): void; onOpenSettings(): void }`. Parent considers project resolution pending until the latest text/catalog preview is ready or explicitly projectless. `NewTaskDialog.onSubmit` receives `(markdown: string, projectDraft?: ProjectDraft)`.

- [ ] **Step 1: Add target/reference UI and stale-response tests.**

```tsx
await user.type(screen.getByLabelText(/Title hint/i), '[shop] Checkout');
await user.type(screen.getByLabelText('Brief'), 'Follow Payments');
expect(await screen.findByLabelText('Future change target')).toHaveTextContent('shop');
expect(screen.getByLabelText('Reference projects')).toHaveTextContent('payments-service');
await user.click(screen.getByRole('button', { name: 'Remove payments-service reference' }));
await user.click(screen.getByRole('button', { name: /Submit draft/i }));
expect(onSubmit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
  choices: expect.objectContaining({ excludedReferenceIds: ['p-pay'] }),
}));
```

Test no-prefix-only references, ambiguity/unknown prefix blocking, branch/default requirements, every selected brief ready, root-change conflict, settings navigation preserving title/brief, cancel/remount while operation runs, keyboard removal/clarification, no aliases from retired roots, and two preview promises resolved in reverse order. Pending filesystem submission UI loads by stable submission ID and posts clarification with expected revision, then observes a single resulting task.

- [ ] **Step 2: Run `npx vitest run src/components/ProjectSelection.test.tsx src/components/NewTaskDialog.test.tsx src/tasks/api.test.ts src/tasks/useWorkspace.test.tsx src/App.test.tsx`.**
- [ ] **Step 3: Integrate debounced server previews with explicit revision checks.** Display match provenance and reference-removal controls; prefix edits control target selection. Ref/brief selectors use discovered project detail. Debounce 250 ms, abort superseded requests, and guard late resolution with a monotonically increasing generation even if cancellation is ignored by a mock/network. Editing title/description invalidates bound choices/previews as specified.

```ts
const sequence = useRef(0);
useEffect(() => {
  const current = ++sequence.current;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    void api.resolve(text, choices, controller.signal).then(value => {
      if (!controller.signal.aborted && current === sequence.current) setPreview(value);
    }).catch(error => {
      if (!controller.signal.aborted && current === sequence.current) setError(String(error));
    });
  }, 250);
  return () => { clearTimeout(timer); controller.abort(); };
}, [api, text, choices]);
```

Memoize `text`/`choices` in the parent to avoid polling loops. On 409, preserve draft text, display the replacement preview, and require the user to resubmit after checking it. User-visible submission progress distinguishes preparing repositories from waiting for task pickup. Keep request IDs stable for network retries and change them for intentionally edited submissions. A root that is configured but unavailable must not be presented as a projectless preview. Put pending filesystem resolution in a focused panel on Projects reached from its workspace issue; reuse `ProjectSelection` and the server's original submission identity.

- [ ] **Step 4: Rerun tests and commit.** Commit `feat: resolve task project targets and references during drafting`.

## Task 13: Display pinned project context and navigable evidence

**Files:** Create `TaskProjectContext.tsx`, `SourceReport.tsx`, `SourcePreview.tsx` and matching tests; modify `TaskDetail.tsx`, `.test.tsx`, `TaskArtifacts.tsx`, `.test.tsx`, `ArtifactPreview.tsx`, `.test.tsx`, `src/styles/task.css`.

**Interfaces:** `TaskProjectContext({ task, api }: { task: ConnectedTask; api: ProjectApi })`; `SourceReportView({ report, onCitation }: { report: SourceReport; onCitation(id: string): void })`; `SourcePreview({ source, onClose }: { source: SourcePreview | null; onClose(): void })` with an import alias to avoid component/type collision. Brief views use `briefCitation`; task outputs use `citation` with exact artifact version.

- [ ] **Step 1: Write pinned-provenance and escaping tests.**

```tsx
render(<SourceReportView report={{ format: 'source-report-v1',
  text: 'Validation [cite:check]. <script>alert(1)</script>', citations: [citation] }}
  onCitation={onCitation} />);
await user.click(screen.getByRole('button', { name: /check/i }));
expect(onCitation).toHaveBeenCalledWith('check');
expect(document.querySelector('script')).toBeNull();
expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeVisible();
```

Cover reference-only labels, target/reference deduplication, old brief commit versus task commit, exact artifact-version URL, missing/unsupported source, range highlighting, aborted loads, large bounded previews, keyboard dialog close/focus restoration, and legacy plain-text artifact download/preview regression.

- [ ] **Step 2: Run `npx vitest run src/components/TaskProjectContext.test.tsx src/components/SourceReport.test.tsx src/components/SourcePreview.test.tsx src/components/TaskDetail.test.tsx src/components/TaskArtifacts.test.tsx src/components/ArtifactPreview.test.tsx`.**
- [ ] **Step 3: Render verified metadata and literal text.** Context panels read immutable task copies; don't replace names/briefs with current catalog records. Source reports replace only validated `[cite:ID]` markers with buttons. Other content stays text, using React escaping. No `dangerouslySetInnerHTML` or arbitrary link-to-filesystem behavior.

```tsx
<pre aria-label="Cited source">
  {source.lines.map((line, index) => {
    const number = source.firstLine + index;
    const highlighted = number >= source.startLine && number <= source.endLine;
    return <span key={number} data-highlighted={highlighted}>
      <span aria-hidden="true">{number} </span>{line}{'\n'}
    </span>;
  })}
</pre>
```

Request structured report data only for connected report artifacts; workflow artifacts and legacy outputs retain current behavior. Preserve downloads of the entire canonical report envelope. The report UI shows human-readable text and evidence buttons, not its JSON format. A failed source preview is explicit and does not hide the associated report. Task details label future target independently of access: every project shows read-only.

- [ ] **Step 4: Rerun tests and commit.** Commit `feat: show pinned project context and source evidence in task views`.

## Task 14: Verify complete workflows, real host access, and operations guidance

**Files:** Create `server/projects/integration.test.ts`, `server/projects/probe.ts`, `.test.ts`, `scripts/verify-project-access.mjs`; modify `scripts/preview-fake.mjs`, `config/examples/README.md`, `config/examples/verified-profiles.example.json`, `docs/coordinator-operations.md`, `README.md`.

**Interfaces:** `node scripts/verify-project-access.mjs --config <host-config> --output <evidence-path>` creates only disposable repositories and probe artifacts outside the configured projects root. It never uses company repositories, grants new capabilities, rewrites an existing attestation, or claims fake-runner checks verify the real host. Evidence records CLI version, execution-profile identity, exact probed scopes, policy digests, sentinel outcomes, and limitations. Evidence output alone does not install/approve a profile. `runProjectProbe(configPath: string): Promise<ProbeObservation>` in `server/projects/probe.ts` constructs disposable fixtures and runs the real configured CLI through the production runner; it returns explicit unavailable results if the installed profile/provider cannot grant the exact temporary scopes. `ProbeObservation` has `cliVersion: string`, `scopes: string[]`, `policyDigests: Record<string,string>`, `readText: string | null`, `expectedText: string`, `writeAttempts: Array<{ location: 'source' | 'snapshot' | 'task-store' | 'job-store'; attempted: boolean; denied: boolean }>`, `combinedScopeVerified: boolean`, `toolPolicyVerified: boolean`, `citationsResolve: boolean`, `beforeDigest: string`, `afterDigest: string`, `limitations: string[]`. Evaluate observations with `evaluateProjectProbe(observation: ProbeObservation): { checks: Record<string,boolean>; passed: boolean }`; never infer a denial from an unattempted operation.

- [ ] **Step 1: Add end-to-end fake-runner tests using the public API.** One test configures a disposable root, scans shop/payments, prepares briefs, submits a target-plus-reference task, approves a read-only investigation/design/plan workflow, and opens a valid citation. A second submits references only. A third restarts during preparation and resumes the original task/commits. Include real dirty files and external source advancement between old/new tasks.

```ts
expect(firstTask.projectContext.targetId).toBe(shopId);
expect(firstTask.projectContext.referenceIds).toEqual([paymentsId]);
expect(secondTask.projectContext.targetId).toBeNull();
expect(oldTask.projectContext.projects[0].snapshot.commit).toBe(oldCommit);
expect(newTask.projectContext.projects[0].snapshot.commit).toBe(newCommit);
expect(await treeDigest(projectsRoot)).toBe(afterExternalUpdateDigest);
expect(control.starts.every(start => start.step.actions.join(',') === 'read')).toBe(true);
```

Exercise HTTP conflicts and unsupported entries without blocking unrelated ready projects. Ensure no internal brief task leaks into task navigation/file reviews, and aggregate concurrency is respected through preparation, investigation, and shutdown.

- [ ] **Step 2: Run `npx vitest run server/projects/integration.test.ts server/projects/probe.test.ts`; expect failures if any integration path remains unwired.** Fix the owning component and rerun its focused test before returning to integration.
- [ ] **Step 3: Implement the disposable host probe and document its use.** Reuse the production snapshot/access verifier entry points from built server code; do not create a second test-only definition of readiness. Probe single and combined snapshot profiles. Record attempted source/snapshot/task-store/internal-job-store writes and confirm denial; verify declared tool-policy checks cover write-capable external tools. Execute only probe-owned sentinel commands, never commands from the repositories being investigated. Verify readable committed sentinel content, inaccessible dirty/untracked content through assigned snapshots, valid returned citations, and unchanged source/tree metadata. If scope-specific read restrictions are part of the deployed policy, probe those explicitly; do not claim read-only sandboxing alone proves them.

```ts
export function evaluateProjectProbe(observation: ProbeObservation) {
  const denied = (location: ProbeObservation['writeAttempts'][number]['location']) =>
    observation.writeAttempts.some(attempt => attempt.location === location &&
      attempt.attempted && attempt.denied);
  const checks = {
    committedSnapshotReadable: observation.readText === observation.expectedText,
    sourceWriteDenied: denied('source'), snapshotWriteDenied: denied('snapshot'),
    taskStoreWriteDenied: denied('task-store'), jobStoreWriteDenied: denied('job-store'),
    combinedScopeVerified: observation.combinedScopeVerified,
    toolPolicyVerified: observation.toolPolicyVerified,
    citationsResolve: observation.citationsResolve,
    sourceUnchanged: observation.beforeDigest === observation.afterDigest,
  };
  return { checks, passed: Object.values(checks).every(Boolean) && observation.limitations.length === 0 };
}
```

The CLI script imports `runProjectProbe`/`evaluateProjectProbe` from the built module, parses the two required arguments, rejects an output path under the configured source root, executes the probe, and writes observation plus evaluated outcome with exclusive `wx` mode `0600`. Exit nonzero when `passed` is false. Never suppress probe errors or classify a launch failure as write denial. Add `probe.test.ts` table tests turning off each required observation in turn, including an omitted write attempt, changed sentinel digest, and a documented limitation; every case must evaluate to false.

Use a host-supported OS-enforced read-only mount or equivalent write-denial fixture for the root test and document the mechanism actually used. If no compatible host profile/provider exists, keep readiness at Needs setup, record the exact missing capability, and do not mark real-host acceptance complete. Do not invent attestations merely to pass startup.

Operations docs explain root configuration, direct-child eligibility, external maintenance, no remote-freshness guarantee, aliases and title syntax, reference exclusions, branch/brief preparation, read-only policy, retained snapshots after root changes, aggregate limits, recovery, and compatibility. The example manifest demonstrates the separate snapshot scope format without credentials. The fake preview exposes Settings/Projects and representative pending/error/ready states using disposable data.

- [ ] **Step 4: Run the full required suite once after focused checks pass.**

```bash
npm test -- --run
npm run build
```

Expected: all tests and both UI/server builds pass. Then run the host probe only against a disposable configured fixture and review its recorded evidence. A blocked real-host verification is reported as an outstanding acceptance item, not counted as a pass.

- [ ] **Step 5: Perform browser verification and record results.** Start `npm run preview:fake` using its printed address. Check Settings save/clear/conflict, root rescan/unavailable state, Projects aliases/default/brief/candidate behavior, draft prefix/reference/exclusion/ambiguity flow, pending filesystem correction, pinned task metadata, multi-repository citations, narrow screens, keyboard navigation, and disconnect/reconnect. Fix any discovered issue with a focused regression test where behavior warrants it; rerun full checks only after changes that justify it.
- [ ] **Step 6: Commit the integration/probe/docs work and perform whole-branch review.** Commit `test: verify read-only project investigation workflows`. Review scope, immutable replay, combined capability enforcement, source-write denial, and evidence authorization. Summarize test/build/browser/probe evidence and remaining host limitations honestly; choose branch integration only after review.

## Spec coverage and execution handoff

| Spec requirement | Owning tasks |
| --- | --- |
| Global root, persistence, direct-child discovery, external upkeep | 2, 3, 10, 11, 14 |
| Names/aliases, prefix target, references, ambiguity and exclusions | 1, 3, 9, 12 |
| Branch/brief readiness and immutable per-repository binding | 4, 8, 9 |
| Read-only snapshots, limits, special entries and fixed evidence | 4, 5, 6, 7 |
| Grounded design/plan outputs and target/reference semantics | 5, 7, 8, 13, 14 |
| Versioned briefs, provenance, manual edits and candidates | 7, 8, 11, 13 |
| Citation authorization, bounded literal source viewing | 7, 10, 13 |
| Recovery, idempotence, legacy schemas and new shared scheduler jobs | 2, 3, 5, 8, 9, 10, 14 |
| Exact combined access and genuine host acceptance | 6, 14 |

Plan review and execution-method selection are next. Recommended execution: **Native**, because these tasks share context, persistence, and scheduling interfaces and benefit from one implementer retaining that context. The alternative is subagent-driven execution with a fresh implementer/reviewer per task. Neither approach begins until the user reviews this plan and chooses the method.
