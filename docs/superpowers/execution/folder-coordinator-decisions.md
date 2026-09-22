# Implementation decisions and tradeoffs

These decisions were recorded in execution order in the [progress ledger](folder-coordinator-progress.md). The approved design remains authoritative.

| Decision | Reason and tradeoff |
|---|---|
| Work in the existing non-Git directory. | The approved plan requires it. There is no commit or branch history; review snapshots are retained. |
| Use local snapshots/diffs instead of Git-dependent execution helpers. | Preserves independent review without creating a repository. Costs local disk space and manual artifact retention. |
| Add necessary persisted fields to the illustrative contracts. | Implements the design's full requirements. Consumers must follow the actual shared types. |
| Require verified role capability configuration; tests use fake runners and disposable roots. | Prevents tests from launching company work. Real-host deployment verification remains necessary. |
| Exclude execution snapshots and compiled server output from test discovery. | Avoids running duplicate copied tests. Tests belong in source/test directories. |
| Human checkpoints authorize the immediate next sequential step, or completion at the end. | Handles consecutive reviews and review before the first agent. More general dependency graphs remain unsupported. |
| Derive retry counts across attempts in the coordinator and cap automatic retries at two. | Prevents resetting the limit on each attempt. Persisted attempt history is needed for recovery. |
| Serialize stale-lock reclamation and retain task-creation intent. | Avoids competing reclaimers and unsafe adoption of partial folders. Uncertain recovery ownership may require operator intervention. |
| Recover recognized temporary-only creation staging; preserve unknown files as conflicts. | Clears harmless interrupted writes without discarding unrecognized content. Some conflicts need manual reconciliation. |
| Claim intake by atomic move to private recoverable holding and preserve changed versions. | Protects original drafts through cleanup races. Adds receipt/archive storage and reconciliation paths. |
| Retain claimed source inodes without automatic cleanup in v1. | Detects late writes through already-open handles. Costs continuing disk growth until an operator-reviewed retention policy is added. |
| Gate real execution with an unsynced operator capability attestation. | Binds CLI version, role/profile actions, sandbox, environment and config hashes to deployment checks. It is an operator assertion, not automatic proof of every ambient credential restriction. |
| Stage actual artifact/skill text; skills use approved absolute paths covered by verification. | Fresh CLI assignments receive complete context. Paths are host-specific and context size is bounded. |
| Preserve launch intent and report cleanup failure if uncertainty cannot be persisted. | Storage failure cannot guarantee a new durable event. Cleanup may retain the lock and require operator reconciliation. |
| Fix keyboard coverage and prospective submission copy during the UI review loop. | Both were explicit acceptance requirements despite minor review severity. Adds narrow test/UI work. |
| Resolve existing review/control intent before inserting another checkpoint. | Avoids invalidating the pending decision's workflow version. Limits checkpoint editing while paused. |
| Keep artifact schema without MIME metadata; use bounded strict-UTF8 previews and download fallback. | Provides safe text inspection without adding an unplanned schema. Binary types have no specialized inline viewer. |

Repository/profile paths were also aligned to the approved `projects/` and `roles/` directories. No deployment, real Codex model assignment, or company repository mutation was performed during implementation verification.

Final integration decisions: exact repository source/connection sets select isolated execution profiles, costing an operator-defined profile entry for each supported combination. Unconfirmed process termination retains the pause/cancel barrier until an operator records exit/effect reconciliation; this avoids false terminal state but requires manual resolution when exit cannot be proved.

Final recovery ruling: absence of the original parent PID alone is insufficient proof that its child processes exited. Recovery remains blocked where tree exit is uncertain, costing additional manual reconciliation in exchange for avoiding false cancellation.
