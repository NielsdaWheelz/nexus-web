"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AuthoredQuery, QueryResult } from "@nexus/authored/types";
import { useAuthoredContinuation } from "@/lib/notes/hooks";

type SearchQuery = Extract<AuthoredQuery, { kind: "search" }>;

/** A demand resumes its exact local cursor. Admission criteria belong to the consumer. */
export function useLocalDiscovery(query: SearchQuery | null, active: boolean, useful: (row: QueryResult["rows"][number]) => boolean) {
  const prefix = useAuthoredContinuation(query);
  const key = JSON.stringify(query);
  const latest = useRef({ active, prefix, useful });
  useLayoutEffect(() => { latest.current = { active, prefix, useful }; }, [active, prefix, useful]);
  const [pausedKey, setPausedKey] = useState<string | null>(null);
  const attempt = useRef<{ controller: AbortController; remaining: number; running: boolean } | null>(null);
  useEffect(() => {
    const retire = () => { attempt.current?.controller.abort(); attempt.current = null; };
    const hide = () => { if (document.visibilityState === "hidden") retire(); };
    document.addEventListener("visibilitychange", hide);
    return () => { document.removeEventListener("visibilitychange", hide); retire(); };
  }, [key, active, prefix.more, prefix.data?.store_revision]);

  const run = (retry: boolean) => {
    const current = latest.current;
    const initial = current.prefix.data;
    if (!current.active || document.visibilityState === "hidden" || initial === null || initial.next_cursor === null || attempt.current?.running) return;
    const demand = retry ? attempt.current : { controller: new AbortController(), remaining: 3, running: false };
    if (demand === null) return;
    attempt.current = demand;
    demand.running = true;
    setPausedKey(null);
    void (async () => {
      let accepted = initial;
      while (demand.remaining > 0) {
        const next = await current.prefix.more(demand.controller.signal);
        if (demand.controller.signal.aborted || next === null) return;
        demand.remaining--;
        if (next.next_cursor === null || next.rows.slice(accepted.rows.length).some(latest.current.useful)) {
          attempt.current = null;
          return;
        }
        accepted = next;
      }
      attempt.current = null;
      setPausedKey(key);
    })().finally(() => { demand.running = false; });
  };
  const continuationNeedsAction = pausedKey === key;
  return {
    ...prefix, continuationNeedsAction,
    more: () => { if (prefix.error === null) run(false); },
    fetchAhead: () => { if (!continuationNeedsAction && prefix.error === null) run(false); },
    retry: () => { if (attempt.current === null) prefix.retry(); else run(true); },
  };
}
