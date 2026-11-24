"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { QueryResult, RankedIndexResult, WorkRegisterSource } from "@nexus/authored/types";
import { useAuthoredAccountId, useAuthoredStore } from "@/lib/authored/provider";

type Description<Row> = Extract<RankedIndexResult<Row>, {kind: "description"}>;
type Locations<Row> = Extract<RankedIndexResult<Row>, {kind: "locations"}>["items"];
const BLOCK = 64;
const EMPTY = new Map<never, never>();

/** The admitted viewport and pins own this cache. The description's compact
 * head sample survives seeks, and each reply belongs to its requested revision. */
export function useRankedAuthoredWindow<Row extends {ref: string}>(
  source: {kind: "page_register"; text: string} | {kind: "habits"} | WorkRegisterSource | {kind: "mentions"; ref: string},
  revision: string | null,
  description: Description<Row> | null,
  select: (result: QueryResult) => RankedIndexResult<Row> | null,
) {
  const store = useAuthoredStore(), account = useAuthoredAccountId();
  const key = JSON.stringify([account, source, revision]);
  const [wanted, setWanted] = useState<{key: string; signature: string; starts: number[]; refs: string[]} | null>(null);
  const [cache, setCache] = useState<{
    key: string;
    blocks: ReadonlyMap<number, Row[]>;
    positions: ReadonlyMap<string, number | null>;
    pinned: Locations<Row>;
    error: unknown | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const count = description?.total ?? 0;
  const sampled = description?.items.length ?? 0;
  const request = useCallback((ranks: readonly number[], refs: readonly string[]) => {
    const starts = [...new Set(ranks.filter(rank => rank >= sampled && rank < count).map(rank => rank - rank % BLOCK))]
      .sort((left, right) => left - right);
    const ids = [...new Set(refs)].sort();
    const signature = JSON.stringify([starts, ids]);
    setWanted(previous => previous?.key === key && previous.signature === signature ? previous : {key, signature, starts, refs: ids});
  }, [key, count, sampled]);

  useEffect(() => {
    if (revision === null || description === null || count <= sampled || wanted?.key !== key) return;
    const previous = cache?.key === key ? cache : null;
    let retired = false;
    void (async () => {
      const results = await Promise.all(wanted.starts.map(async start => {
        const known = previous?.blocks.get(start);
        if (known !== undefined) return [start, known] as const;
        const limit = Math.min(BLOCK, count - start);
        const result = await store.query({...source, at: {kind: "range", start, limit}, expected_revision: revision});
        if (result.store_revision !== revision) return null;
        const range = select(result);
        if (range?.kind !== "range" || range.start !== start || range.items.length !== limit)
          throw new Error("Incomplete authored index slice");
        return [start, range.items] as const;
      }));
      if (retired || results.some(result => result === null)) return;
      const blocks = new Map(results.filter(result => result !== null));
      const positions = new Map<string, number | null>();
      const pinned: Locations<Row> = [];
      const knownItems = new Map(description.items.map((item, rank) => [item.ref, {...item, rank}]));
      for (const item of previous?.pinned ?? []) knownItems.set(item.ref, item);
      for (const [start, items] of blocks)
        for (const [offset, item] of items.entries()) knownItems.set(item.ref, {...item, rank: start + offset});
      const unresolved: string[] = [];
      for (const ref of wanted.refs) {
        const item = knownItems.get(ref);
        if (item !== undefined) { positions.set(ref, item.rank); pinned.push(item); }
        else if (previous?.positions.get(ref) === null) positions.set(ref, null);
        else unresolved.push(ref);
      }
      for (let start = 0; start < unresolved.length; start += 100) {
        const refs = unresolved.slice(start, start + 100);
        const result = await store.query({...source, at: {kind: "locate", refs}, expected_revision: revision});
        if (retired || result.store_revision !== revision) return;
        const locations = select(result);
        if (locations?.kind !== "locations") throw new Error("Missing authored index positions");
        for (const ref of refs) positions.set(ref, null);
        for (const item of locations.items) { positions.set(item.ref, item.rank); pinned.push(item); }
      }
      if (!retired) setCache({key, blocks, positions, pinned, error: null});
    })().catch(error => {
      if (!retired) setCache(old => ({key, blocks: old?.key === key ? old.blocks : new Map(),
        positions: old?.key === key ? old.positions : new Map(), pinned: old?.key === key ? old.pinned : [], error}));
    });
    return () => { retired = true; };
    // The currently admitted cache is read once per demand, then replaced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, key, count, revision, description, sampled, store, select, attempt]);

  const resolved = cache?.key === key ? cache : null;
  const items = useMemo<ReadonlyMap<number, Row>>(() => {
    if (description === null || description.total <= description.items.length) return EMPTY;
    const rows = new Map(description.items.map((item, rank) => [rank, item]));
    if (resolved !== null) {
      for (const [start, block] of resolved.blocks) for (const [offset, item] of block.entries()) rows.set(start + offset, item);
      for (const item of resolved.pinned) rows.set(item.rank, item);
    }
    return rows;
  }, [description, resolved]);
  return {items, positions: resolved?.positions ?? null, error: resolved?.error ?? null, request, retry};
}
