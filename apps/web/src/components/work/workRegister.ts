"use client";

import {useMemo} from "react";
import type {QueryResult, WorkIndexItem, WorkRegisterResult, WorkRegisterSource} from "@nexus/authored/types";
import type {RankedIndex} from "@/lib/collections/measuredIndexWindow";
import {useAuthoredQuery} from "@/lib/notes/hooks";
import {useRankedAuthoredWindow} from "@/lib/notes/rankedAuthoredWindow";
import {usePaneScrollMotion} from "@/lib/workspace/paneReturnMemento";

const select = (result: QueryResult) => {
  const work = result.work_index;
  return work?.kind === "placements" || work?.kind === "row" ? null : work;
};
type Placement = Extract<WorkRegisterResult, {kind: "placements"}>["items"][number];

export function useWorkRegister(kind: WorkRegisterSource["kind"], date: string | null) {
  const source = {kind, local_date: date ?? ""};
  const read = useAuthoredQuery(date === null ? null : {...source, at: {kind: "describe"}, expected_revision: null});
  const answer = read.data?.work_index;
  const description = answer?.kind === "description" ? answer : null;
  const revision = read.data?.store_revision ?? null;
  const count = description?.total ?? 0;
  const sparse = description !== null && count > description.items.length;
  const motion = usePaneScrollMotion();
  const window = useRankedAuthoredWindow(source, revision, description, select);
  const items = useMemo(() => sparse ? window.items : new Map(description?.items.map((item, rank) => [rank, item])),
    [description, sparse, window.items]);
  const rows = useMemo(() => new Map([...items.values()].map(row => [row.ref, row])), [items]);
  const ranks = useMemo(() => new Map([...items].map(([rank, row]) => [row.ref, rank])), [items]);
  const ranked: Omit<RankedIndex, "heads"> = {
    count, revision: revision ?? "", failed: window.error !== null,
    idAt: rank => items.get(rank)?.ref,
    rankOf: ref => ranks.get(ref) ?? (sparse ? window.positions?.get(ref) : null),
    request: (ranks, refs) => {if (motion === "still") window.request(ranks, refs);},
  };
  return {read, revision, sparse, count, ranked, rows, error: window.error, retry: window.retry};
}

/** Local dwell, undo and focused editors are the only rows that can amend the
 * register. Their positions name gaps in one canonical revision. */
export function amendWorkOrder(base: Omit<RankedIndex, "heads">, placements: readonly Placement[],
  retained: ReadonlyMap<string, WorkIndexItem>, expired: ReadonlySet<string>) {
  if (placements.length === 0) return base;
  const members = placements.filter(p => p.present);
  const placed = new Map(members.map(p => [p.ref, p.rank]));
  const placedAt = new Map(members.map(p => [p.rank, p.ref]));
  const added = new Map(placements.filter(p => !p.present && !expired.has(p.ref)).map(p => [p.ref, p.rank]));
  const removed = new Set(placements.filter(p => p.present && expired.has(p.ref)).map(p => p.ref));
  const edits = placements.filter(p => added.has(p.ref) || removed.has(p.ref)).sort((a, b) =>
    a.rank - b.rank || Number(a.present) - Number(b.present) || compareWork(retained.get(a.ref)!, retained.get(b.ref)!));
  let shift = 0;
  const events = edits.map(edit => {
    const displayed = edit.rank + shift;
    shift += edit.present ? -1 : 1;
    if (!edit.present) added.set(edit.ref, displayed);
    return {...edit, displayed};
  });
  const slotAt = (rank: number) => {
    let original = rank;
    for (const event of events) {
      if (event.displayed > rank) break;
      if (!event.present && event.displayed === rank) return {added: event.ref} as const;
      original += event.present ? 1 : -1;
    }
    return {original} as const;
  };
  return {
    ...base, count: base.count + shift,
    revision: events.length === 0 ? base.revision : JSON.stringify([base.revision, events.map(({ref, present}) => [ref, present])]),
    idAt(rank: number) {
      const slot = slotAt(rank);
      return "added" in slot ? slot.added : base.idAt(slot.original) ?? placedAt.get(slot.original);
    },
    rankOf(ref: string) {
      if (removed.has(ref)) return null;
      if (added.has(ref)) return added.get(ref)!;
      const rank = placed.get(ref) ?? base.rankOf(ref);
      if (rank == null) return rank;
      return rank + events.reduce((shift, event) => shift +
        (event.rank < rank || event.rank === rank && !event.present ? event.present ? -1 : 1 : 0), 0);
    },
    request(ranks: readonly number[], refs: readonly string[]) {
      base.request(ranks.flatMap(rank => {
        const slot = slotAt(rank);
        return slot.original === undefined ? [] : [slot.original];
      }), refs.filter(ref => !added.has(ref) && !removed.has(ref)));
    },
  };
}

export function compareWork(left: WorkIndexItem, right: WorkIndexItem) {
  const a = left.work.captured, b = right.work.captured;
  const x = BigInt(a.lamport), y = BigInt(b.lamport);
  return x < y ? -1 : x > y ? 1 : a.replica_id < b.replica_id ? -1 : a.replica_id > b.replica_id ? 1
    : left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0;
}
