import { useCallback, useEffect, useRef, useState } from "react";
import type { CatalogSnapshot, RootSetting } from "../../shared/projects";
import type { ProjectApi, ProjectOperation } from "./api";
export function useProjects(api: ProjectApi) {
  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(null),
    [root, setRoot] = useState<RootSetting | null>(null),
    [operations, setOperations] = useState<ProjectOperation[]>([]),
    [error, setError] = useState<string | null>(null),
    [connected, setConnected] = useState(false);
  const epoch = useRef(0),
    controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    const generation = ++epoch.current;
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    try {
      const [r, v, o] = await Promise.all([
        api.settings(c.signal),
        api.catalog(c.signal),
        api.operations(c.signal),
      ]);
      if (c.signal.aborted || epoch.current !== generation) return;
      setRoot(r);
      setCatalog(v);
      setOperations(o);
      setConnected(true);
      setError(null);
    } catch (e) {
      if (!c.signal.aborted && epoch.current === generation) {
        setConnected(false);
        setError(e instanceof Error ? e.message : "Projects unavailable");
      }
    }
  }, [api]);
  useEffect(() => {
    void refresh();
    return () => {
      epoch.current++;
      controller.current?.abort();
    };
  }, [refresh]);
  useEffect(() => {
    if (!operations.some((o) => o.state === "queued" || o.state === "running"))
      return;
    const timer = setTimeout(() => void refresh(), 1000);
    return () => clearTimeout(timer);
  }, [operations, refresh]);
  return { catalog, root, operations, error, connected, refresh };
}
