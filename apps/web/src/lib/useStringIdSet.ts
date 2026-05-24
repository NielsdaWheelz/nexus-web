"use client";

import { useCallback, useMemo, useRef, useState } from "react";

interface StringIdSet {
  ids: Set<string>;
  /**
   * Synchronous membership check that reads from the live ref, not the React
   * state. Use this from event handlers that need to dedupe back-to-back
   * invocations before the next render commits (e.g. double-click guards).
   */
  has: (id: string) => boolean;
  add: (id: string) => void;
  remove: (id: string) => void;
  replace: (ids: Iterable<string>) => void;
  clear: () => void;
}

/**
 * Tracks a set of string ids for busy/loading/expanded-row tracking. A live
 * ref is the source of truth — mutations write to it before scheduling state
 * — so `has()` is synchronous-correct across event handlers in the same tick.
 * Each mutation produces a new Set so React detects the change, and the
 * returned object is reference-stable across renders when `ids` is unchanged
 * so consumers can list it in `useCallback`/`useEffect` dependency arrays.
 */
export function useStringIdSet(): StringIdSet {
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  const idsRef = useRef(ids);

  const has = useCallback((id: string) => idsRef.current.has(id), []);

  const add = useCallback((id: string) => {
    if (idsRef.current.has(id)) return;
    const next = new Set(idsRef.current).add(id);
    idsRef.current = next;
    setIds(next);
  }, []);

  const remove = useCallback((id: string) => {
    if (!idsRef.current.has(id)) return;
    const next = new Set(idsRef.current);
    next.delete(id);
    idsRef.current = next;
    setIds(next);
  }, []);

  const clear = useCallback(() => {
    if (idsRef.current.size === 0) return;
    const next = new Set<string>();
    idsRef.current = next;
    setIds(next);
  }, []);

  const replace = useCallback((nextIds: Iterable<string>) => {
    const next = new Set(nextIds);
    idsRef.current = next;
    setIds(next);
  }, []);

  return useMemo(
    () => ({ ids, has, add, remove, replace, clear }),
    [add, clear, has, ids, remove, replace],
  );
}
