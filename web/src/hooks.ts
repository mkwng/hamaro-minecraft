import { useEffect, useRef, useState } from "react";

// Run fn every ms while the page is visible (null pauses).
export function useInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const tick = () => { if (!document.hidden) ref.current(); };
    const id = setInterval(tick, ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): [T | undefined, () => void] {
  const [v, setV] = useState<T>();
  const reload = () => { fn().then(setV).catch(() => {}); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, deps);
  return [v, reload];
}
