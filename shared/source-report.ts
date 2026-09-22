import type { SourceReport } from "./projects.js";
import { parseReport } from "./project-validation.js";
export function citationIds(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/\[cite:([^\[\]\r\n]+)\]/g)].map((match) => match[1]),
    ),
  ];
}
export function parseSourceReport(value: unknown): SourceReport {
  const report = parseReport(value),
    ids = new Set(report.citations.map((c) => c.id));
  if (citationIds(report.text).some((id) => !ids.has(id)))
    throw new Error("Report references an unknown citation ID");
  return report;
}
