"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, type ApiError } from "@/lib/api/client";
import { requestWithRetry } from "@/lib/api/retry";
import type { ApiJson } from "@/lib/api/wire";
import { readFailureOf, type Timeline, type Turn } from "@/lib/chat/wire";

type Body = { observation: Timeline | null; turn: Turn | null };
type FailedRead = { observation: Timeline | null; ids: readonly string[]; error: ApiError };

function acceptTurn(previous: Turn | null | undefined, turn: Turn): Turn {
  // An overlapping index or detail read can predate the final stream adoption.
  return previous && previous.assistant_message.status !== "pending" && turn.assistant_message.status === "pending"
    ? previous : turn;
}

export function useTranscriptBodies(timeline: Timeline | null, adopted: readonly Turn[], demand: readonly string[], refresh: () => void) {
  const seeds = useMemo(() => new Map((timeline?.items ?? []).map(turn => [turn.run_id, turn])), [timeline]);
  const accepted = useMemo(() => new Map(adopted.map(turn => [turn.run_id, turn])), [adopted]);
  const active = useMemo(() => new Set(timeline?.order.map(key => key.run_id)), [timeline]);
  const wanted = JSON.stringify(demand);
  const [state, setState] = useState<{ timeline: Timeline | null; wanted: string; ids: ReadonlySet<string>; rows: ReadonlyMap<string, Body> }>(() =>
    ({ timeline, wanted, ids: new Set(demand), rows: new Map() }));
  if (timeline !== state.timeline || wanted !== state.wanted) {
    const rows = new Map<string, Body>();
    for (const id of demand) {
      const previous = state.rows.get(id);
      const seed = seeds.get(id);
      if (seed) rows.set(id, { observation: timeline, turn: acceptTurn(previous?.turn, seed) });
      else if (previous && active.has(id)) rows.set(id, previous);
    }
    setState({ timeline, wanted, ids: new Set(demand), rows });
  }
  const [failed, setFailed] = useState<FailedRead | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const missing = demand.filter(id => active.has(id) && !seeds.has(id)
    && (!state.rows.has(id) || state.rows.get(id)?.observation !== timeline));
  const missingKey = JSON.stringify(missing.filter(id => failed?.observation !== timeline || !failed.ids.includes(id)));
  const omissions = useRef(new Set<string>());
  useEffect(() => {
    const ids: string[] = JSON.parse(missingKey);
    if (ids.length === 0) return;
    const controller = new AbortController();
    void (async () => {
      let refreshOrder = false;
      for (let start = 0; start < ids.length; start += 25) {
        const runIds = ids.slice(start, start + 25);
        try {
          const { data } = await requestWithRetry(signal => apiFetch<ApiJson<"/librarian/turns/resolve", "post">>(
            "/api/librarian/turns/resolve", { method: "POST", signal, body: JSON.stringify({ run_ids: runIds }) },
          ), controller.signal);
          if (controller.signal.aborted) return;
          const results = new Map(data.items.map(turn => [turn.run_id, turn]));
          for (const id of runIds) {
            if (results.has(id)) omissions.current.delete(id);
            else if (!omissions.current.has(id)) {
              omissions.current.add(id);
              refreshOrder = true;
            }
          }
          setState(previous => {
            if (previous.timeline !== timeline || previous.wanted !== wanted) return previous;
            const rows = new Map(previous.rows);
            for (const id of runIds) {
              const turn = results.get(id);
              rows.set(id, { observation: timeline, turn: turn ? acceptTurn(rows.get(id)?.turn, turn) : null });
            }
            return { ...previous, rows };
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          const failure = readFailureOf(error);
          if (failure.kind === "Defect") setDefect({ error });
          else if (failure.kind === "Failed") setFailed({ observation: timeline, ids: runIds, error: failure.error });
          break;
        }
      }
      if (refreshOrder) refresh();
    })();
    return () => controller.abort();
  }, [missingKey, refresh, timeline, wanted]);
  useEffect(() => {
    for (const id of omissions.current) if (!active.has(id)) omissions.current.delete(id);
  }, [active]);

  const adopt = useCallback((turn: Turn) => {
    setState(previous => {
      const id = turn.run_id;
      if (!previous.ids.has(id)) return previous;
      const rows = new Map(previous.rows);
      rows.set(id, { observation: previous.timeline, turn: acceptTurn(rows.get(id)?.turn, turn) });
      return { ...previous, rows };
    });
  }, []);
  const get = useCallback((id: string) => {
    if (!active.has(id)) return accepted.get(id) ?? null;
    return state.rows.get(id)?.turn ?? (state.rows.has(id) ? null : seeds.get(id) ?? null);
  }, [active, accepted, state.rows, seeds]);
  if (defect) throw defect.error;
  return {
    get,
    unavailable: (id: string) => state.rows.get(id)?.turn === null && state.rows.get(id)?.observation === timeline,
    error: (id: string) => failed?.observation === timeline && failed.ids.includes(id) ? failed.error : null,
    retry: () => setFailed(null),
    adopt,
  };
}
