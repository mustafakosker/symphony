import { expect, it } from "vitest";
import { navigate, parsePreferences } from "./navigation";

it("reads legacy selection and retains it when returning to a list", () => {
  const state = parsePreferences(JSON.stringify({ selectedId: "task-a", filter: "review" }));
  expect(state).toEqual({ selectedId: "task-a", filter: "review", screen: "detail" });
  expect(navigate(state, { type: "back" })).toEqual({ ...state, screen: "list" });
  expect(parsePreferences("{broken")).toEqual({ selectedId: null, filter: "all", screen: "list" });
  expect(parsePreferences(JSON.stringify({ selectedId: 99, filter: "invalid", screen: "detail" })))
    .toEqual({ selectedId: null, filter: "all", screen: "list" });
});

it("keeps valid list preferences and applies navigation events", () => {
  const state = parsePreferences(JSON.stringify({ selectedId: "task-a", filter: "active", screen: "list" }));
  expect(state).toEqual({ selectedId: "task-a", filter: "active", screen: "list" });
  expect(navigate(state, { type: "select", id: "task-b" })).toEqual({ selectedId: "task-b", filter: "active", screen: "detail" });
  expect(navigate(state, { type: "filter", filter: "closed" })).toEqual({ selectedId: "task-a", filter: "closed", screen: "list" });
  expect(navigate(state, { type: "submitted" })).toEqual({ selectedId: "task-a", filter: "all", screen: "list" });
});

it("returns defaults for empty and non-object preferences", () => {
  const defaultState = { selectedId: null, filter: "all", screen: "list" };
  expect(parsePreferences(null)).toEqual(defaultState);
  expect(parsePreferences("null")).toEqual(defaultState);
  expect(parsePreferences("[]")).toEqual(defaultState);
  expect(parsePreferences(JSON.stringify({ selectedId: "", filter: "review", screen: "detail" })))
    .toEqual({ ...defaultState, filter: "review" });
});
it('visits global projects and settings without changing the task filter',()=>{const state=parsePreferences(JSON.stringify({screen:'projects',filter:'review',selectedId:'task'}));expect(state.screen).toBe('projects');expect(navigate(state,{type:'screen',screen:'settings'})).toMatchObject({screen:'settings',filter:'review',selectedId:'task'});});
