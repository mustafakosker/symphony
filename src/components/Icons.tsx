import { Bug, Diamond, FileText, Lightbulb } from "lucide-react";
export function TypeIcon({ type, size = 15 }: { type: string; size?: number }) {
  const Icon =
    (
      { idea: Lightbulb, bug: Bug, jira: Diamond } as Record<
        string,
        typeof FileText
      >
    )[type.toLowerCase()] ?? FileText;
  return <Icon size={size} strokeWidth={1.7} />;
}
