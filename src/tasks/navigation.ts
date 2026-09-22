import type { Filter } from "./presentation";

export type NavigationState = {
  selectedId: string | null;
  filter: Filter;
  screen: "list" | "detail" | "projects" | "settings";
};

export type NavigationEvent =
  | { type: "screen"; screen: "projects" | "settings" }
  | { type: "select"; id: string }
  | { type: "filter"; filter: Filter }
  | { type: "back" }
  | { type: "submitted" };

const defaults: NavigationState = { selectedId: null, filter: "all", screen: "list" };

export function parsePreferences(raw: string | null): NavigationState {
  if (raw === null) return { ...defaults };
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { ...defaults };
    const preferences = value as Record<string, unknown>;
    const selectedId = typeof preferences.selectedId === "string" && preferences.selectedId.trim()
      ? preferences.selectedId
      : null;
    const filter: Filter = preferences.filter === "review" || preferences.filter === "active" || preferences.filter === "closed"
      ? preferences.filter
      : "all";
    const screen = preferences.screen === "projects" || preferences.screen === "settings" ? preferences.screen : selectedId === null || preferences.screen === "list" ? "list" : "detail";
    return { selectedId, filter, screen };
  } catch {
    return { ...defaults };
  }
}

export function navigate(state: NavigationState, event: NavigationEvent): NavigationState {
  switch (event.type) {
    case "screen": return {...state,screen:event.screen};
    case "select": return { ...state, selectedId: event.id, screen: "detail" };
    case "filter": return { ...state, filter: event.filter, screen: "list" };
    case "back": return { ...state, screen: "list" };
    case "submitted": return { ...state, filter: "all", screen: "list" };
  }
}
