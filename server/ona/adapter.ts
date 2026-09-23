import type {
  DocumentRole,
  FrozenPackage,
  OnaReceipt,
} from "../../shared/jira-preparation.js";
export type OnaOutcome =
  | { kind: "accepted"; receipt: OnaReceipt }
  | { kind: "not-accepted"; reason: string }
  | { kind: "unknown"; reason: string };
export type OnaLaunch = {
  package: FrozenPackage;
  promptText: string;
  documents: Array<{ role: DocumentRole; filename: string; bytes: Uint8Array }>;
};
export type OnaAdapter = {
  launch(input: OnaLaunch, signal: AbortSignal): Promise<OnaOutcome>;
  lookup(requestId: string, signal: AbortSignal): Promise<OnaOutcome>;
};
