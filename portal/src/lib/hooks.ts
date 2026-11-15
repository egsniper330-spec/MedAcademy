import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/** Fetch on mount / dependency change, with cancellation and manual reload. */
export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> & { reload: () => void; setData: (data: T | null) => void } {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null });
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState((prev) => ({ data: prev.data, loading: true, error: null }));
    loaderRef.current(controller.signal)
      .then((data) => {
        if (active) setState({ data, loading: false, error: null });
      })
      .catch((error) => {
        if (!active || (error as { name?: string }).name === 'AbortError') return;
        setState({ data: null, loading: false, error: errorMessage(error) });
      });
    return () => {
      active = false;
      controller.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  const setData = useCallback((data: T | null) => setState((prev) => ({ ...prev, data })), []);
  return { ...state, reload, setData };
}

export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = title ? `${title} · MedAcademy` : 'MedAcademy';
    return () => { document.title = previous; };
  }, [title]);
}
