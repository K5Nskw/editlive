import { useCallback, useEffect, useRef, useState } from 'react';

/** Re-run `fn` on an interval while `active` is true, and once immediately. */
export function usePolling(fn: () => void | Promise<void>, intervalMs: number, active: boolean): void {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void saved.current();
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs, active]);
}

export interface Toast {
  message: string;
  error?: boolean;
}

export function useToast(): [Toast | null, (message: string, error?: boolean) => void] {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const show = useCallback((message: string, error = false) => {
    setToast({ message, error });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), error ? 6000 : 3200);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [toast, show];
}

/** Minimal history-API router: the app only has three screens. */
export function useRoute(): [string, (path: string) => void] {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((next: string) => {
    if (next === window.location.pathname) return;
    window.history.pushState({}, '', next);
    setPath(next);
  }, []);

  return [path, navigate];
}
