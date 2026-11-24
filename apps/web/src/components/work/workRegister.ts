"use client";

import {useLayoutEffect, useMemo, useRef} from "react";
import type {QueryResult, WorkIndexItem, WorkRegisterResult, WorkRegisterSource} from "@nexus/authored/types";
import {useAuthoredAccountId} from "@/lib/authored/provider";
import type {RankedIndex} from "@/lib/collections/measuredIndexWindow";
import {useCapturedOrder} from "@/lib/notes/capturedIndex";
import {useAuthoredQuery} from "@/lib/notes/hooks";
import {useRankedAuthoredWindow} from "@/lib/notes/rankedAuthoredWindow";
import {usePaneScrollMotion} from "@/lib/workspace/paneReturnMemento";

const selectOrder = (result: QueryResult) => {
  const work = result.work_index;
  return work?.kind === "placements" || work?.kind === "row" ? null : work;
};
const select = (result: QueryResult) => {
  const work = selectOrder(result);
  return work?.kind === "retained" || work?.kind === "held" || work?.kind === "successor" ? null : work;
};
type Placement = Extract<WorkRegisterResult, {kind: "placements"}>["items"][number];

export function useWorkRegister(kind: WorkRegisterSource["kind"], date: string | null) {
  const account = useAuthoredAccountId();
  const source = useMemo<WorkRegisterSource>(() => ({kind, local_date: date ?? ""}), [kind, date]);
  const read = useAuthoredQuery(date === null ? null : {...source, at: {kind: "describe"}, expected_revision: null});
  const answer = read.data?.work_index;
  const description = answer?.kind === "description" ? answer : null;
  const revision = read.data?.store_revision ?? null;
  const count = description?.total ?? 0;
  const sparse = description !== null && count > description.items.length;
  const motion = usePaneScrollMotion();
  const order = useCapturedOrder(source, sparse ? revision : null, selectOrder);
  const returnOrder = useMemo(() => order.data === null ? undefined : {...order.data, prefix: [], scopedRevision: true as const},
    [order.data]);
  const window = useRankedAuthoredWindow(source, revision, description, select);
  const items = useMemo(() => sparse ? window.items : new Map(description?.items.map((item, rank) => [rank, item])),
    [description, sparse, window.items]);
  const rows = useMemo(() => new Map([...items.values()].map(row => [row.ref, row])), [items]);
  const ranks = useMemo(() => new Map([...items].map(([rank, row]) => [row.ref, rank])), [items]);
  const ranked: Omit<RankedIndex, "heads"> | undefined = !sparse ? undefined : {
    count, revision: revision ?? "", failed: window.error !== null,
    idAt: rank => items.get(rank)?.ref,
    rankOf: ref => ranks.get(ref) ?? window.positions?.get(ref),
    request: (ranks, refs) => {if (motion === "still") window.request(ranks, refs);},
    returnOrder,
  };
  const next = revision === null || sparse && order.data === null ? null : {account, source, revision, count, ranked};
  const prior = useRef<typeof next>(null);
  const presentation = next ?? (prior.current?.account === account && prior.current.source === source ? prior.current : null);
  useLayoutEffect(() => {if (next !== null) prior.current = next;});
  return {read, revision, sparse, rows, presentation,
    error: order.error ?? window.error, retry: order.error === null ? window.retry : order.retry};
}

/** Local dwell, undo and focused editors are the only rows that can amend the
 * register. Their positions name gaps in one canonical revision. */
export function useWorkOrder(base: Omit<RankedIndex, "heads"> | undefined, placements: readonly Placement[] | null,
  retained: ReadonlyMap<string, WorkIndexItem>, expired: ReadonlySet<string>) {
  const overlay = useMemo(() => {
    if (placements === null || placements.length === 0) return null;
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
    function slotAt(rank: number) {
      let original = rank;
      for (const event of events) {
        if (event.displayed > rank) break;
        if (!event.present && event.displayed === rank) return {added: event.ref, original: event.rank} as const;
        original += event.present ? 1 : -1;
      }
      return {original} as const;
    }
    return {placed, placedAt, added, removed, events, shift, slotAt};
  }, [placements, retained, expired]);
  const order = base?.returnOrder;
  const returnOrder = useMemo(() => {
    if (order === undefined || overlay === null || overlay.events.length === 0) return order;
    const land: typeof order.land = async (rank, revision, present) => {
      const slot = overlay.slotAt(rank);
      if ("added" in slot) {
        const next = overlay.events.find(event => !event.present && event.rank === slot.original &&
          event.displayed >= rank && present(event.ref));
        if (next !== undefined) return next.ref;
      }
      return order.land(slot.original, revision, present);
    };
    return {...order, land, successor: (id, revision, present) => {
      const rank = id === null ? undefined : overlay.added.get(id);
      return rank === undefined ? order.successor(id, revision, present) : land(rank, revision, present);
    }} satisfies typeof order;
  }, [order, overlay]);
  if (base === undefined || overlay === null) return base;
  const {placed, placedAt, added, removed, events, shift, slotAt} = overlay;
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
        return "added" in slot ? [] : [slot.original];
      }), refs.filter(ref => !added.has(ref) && !removed.has(ref)));
    },
    returnOrder,
  };
}

export function compareWork(left: WorkIndexItem, right: WorkIndexItem) {
  const a = left.work.captured, b = right.work.captured;
  const x = BigInt(a.lamport), y = BigInt(b.lamport);
  return x < y ? -1 : x > y ? 1 : a.replica_id < b.replica_id ? -1 : a.replica_id > b.replica_id ? 1
    : left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0;
}
