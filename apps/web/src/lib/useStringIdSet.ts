"use client";

import { useCallback, useMemo, useState } from "react";

export interface StringIdSet {
  ids: Set<string>;
  add: (id: string) => void;
  remove: (id: string) => void;
  replace: (ids: Iterable<string>) => void;
  clear: () => void;
}

/**
 * Tracks a set of string ids for busy/loading/expanded-row tracking. Mutations
 * preserve immutability (each operation returns a new Set so React detects the
 * change) and skip the state update when the membership already matches the
 * request, avoiding redundant renders. The returned object is reference-stable
 * across renders when `ids` is unchanged so consumers can safely list it in
 * `useCallback`/`useEffect` dependency arrays.
 */
export function useStringIdSet(): StringIdSet {
  const [ids, setIds] = useState<Set<string>>(() => new Set());

  const add = useCallback((id: string) => {
    setIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  const remove = useCallback((id: string) => {
    setIds((prev) => {
      if (!prev.has(id)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setIds((prev) => (prev.size === 0 ? prev : new Set()));
  }, []);

  const replace = useCallback((nextIds: Iterable<string>) => {
    setIds(new Set(nextIds));
  }, []);

  return useMemo(
    () => ({ ids, add, remove, replace, clear }),
    [add, clear, ids, remove, replace],
  );
}
