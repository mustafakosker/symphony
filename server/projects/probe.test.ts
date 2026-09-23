import { expect, it } from "vitest";
import { evaluateProjectProbe, type ProbeObservation } from "./probe.js";
const good: ProbeObservation = {
  cliVersion: "real",
  scopes: ["one", "two"],
  policyDigests: { policy: "digest" },
  readText: "committed",
  expectedText: "committed",
  writeAttempts: ["source", "snapshot", "task-store", "job-store"].map(
    (location) => ({
      location: location as any,
      attempted: true,
      denied: true,
    }),
  ),
  combinedScopeVerified: true,
  toolPolicyVerified: true,
  citationsResolve: true,
  beforeDigest: "same",
  afterDigest: "same",
  limitations: [],
};
it("requires every observed read/write/scope check and no limitations", () => {
  expect(evaluateProjectProbe(good).passed).toBe(true);
  const variants = [
    { readText: null },
    { combinedScopeVerified: false },
    { toolPolicyVerified: false },
    { citationsResolve: false },
    { afterDigest: "changed" },
    { limitations: ["unavailable"] },
    ...good.writeAttempts.map((_, i) => ({
      writeAttempts: good.writeAttempts.map((a, n) =>
        n === i ? { ...a, attempted: false } : a,
      ),
    })),
    ...good.writeAttempts.map((_, i) => ({
      writeAttempts: good.writeAttempts.map((a, n) =>
        n === i ? { ...a, denied: false } : a,
      ),
    })),
  ];
  for (const bad of variants)
    expect(evaluateProjectProbe({ ...good, ...bad }).passed).toBe(false);
});
