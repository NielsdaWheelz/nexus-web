"use client";

import {useCallback, useEffect, useMemo, useState} from "react";
import type {CapturedIndexDemand, CapturedIndexResult, CapturedIndexSource, QueryResult, RankedIndexResult} from "@nexus/authored/types";
import {useAuthoredQuery} from "./hooks";
import {useAuthoredAccountId, useAuthoredStore} from "@/lib/authored/provider";
import {usePaneScrollMotion, type ReturnOrder} from "@/lib/workspace/paneReturnMemento";

type OrderAnchor = {ref: string | null} | {rank: number};
type Successor = Extract<CapturedIndexResult<never>, {kind: "successor"}>;
export type CapturedOrder<Row> = Omit<ReturnOrder, "prefix"> & {
  find(anchor: OrderAnchor, revision: string): Promise<Successor | undefined>;
  range(start: number, limit: number, revision: string): Promise<(Row | null)[] | null>;
};

type IndexRead<Row> = (result: QueryResult) => RankedIndexResult<Row> | CapturedIndexResult<Row> | null;

export function useCapturedOrder<Row>(source: CapturedIndexSource, revision: string | null, select: IndexRead<Row>) {
  const store = useAuthoredStore();
  const key = JSON.stringify([useAuthoredAccountId(), source, revision]);
  const [state, setState] = useState<{key: string; data: CapturedOrder<Row> | null; error: unknown | null} | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (revision === null) return;
    const token = crypto.randomUUID();
    let references = 1;
    let live = true;
    const detailSource: CapturedIndexSource = source.kind === "page_register" ? {...source, text: ""} : source;
    const release = () => {
      if (--references === 0) void store.query({...detailSource, at: {kind: "release", token}, expected_revision: null}).catch(() => {});
    };
    const find: CapturedOrder<Row>["find"] = async (anchor, expected_revision) => {
      const at: Extract<CapturedIndexDemand["at"], {kind: "successor" | "landing"}> = "rank" in anchor
        ? {kind: "landing", token, rank: anchor.rank}
        : {kind: "successor", token, ref: anchor.ref !== null && source.kind === "page_register" ? `page:${anchor.ref}` : anchor.ref};
      const result = await store.query({...source, at, expected_revision});
      const found = select(result);
      if (found?.kind === "changed") return undefined;
      if (found?.kind !== "successor") throw new Error("missing captured index successor");
      return found;
    };
    const identity = (found: Successor | undefined) => {
      if (found === undefined) return undefined;
      const ref = found.occurrence?.ref ?? null;
      return ref !== null && source.kind === "page_register" ? ref.slice(5) : ref;
    };
    const order: CapturedOrder<Row> = {
      retain() {
        references++;
        return release;
      },
      async range(start, limit, expectedRevision) {
        const result = await store.query({...detailSource, at: {kind: "held", token, start, limit}, expected_revision: expectedRevision});
        const range = select(result);
        if (range?.kind === "changed") return null;
        if (range?.kind !== "held" || range.start !== start || range.items.length !== limit)
          throw new Error("incomplete held index range");
        return range.items;
      },
      find,
      successor: (ref, revision) => find({ref}, revision).then(identity),
      land: (rank, revision) => find({rank}, revision).then(identity),
    };
    void store.query({...source, at: {kind: "retain", token}, expected_revision: revision}).then(result => {
      if (live && select(result)?.kind === "retained") setState({key, data: order, error: null});
    }, error => {if (live) setState({key, data: null, error});});
    return () => {live = false; release();};
  }, [attempt, key, revision, select, source, store]);
  const current = state?.key === key ? state : null;
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  return {data: current?.data ?? null, error: current?.error ?? null, retry};
}

/** Admit a sparse description with its old order. Motion retains that pair while current visibility advances. */
export function useCapturedIndex<Row, Source extends CapturedIndexSource>(source: Source, select: IndexRead<Row>) {
  const account = useAuthoredAccountId();
  const read = useAuthoredQuery({...source, at: {kind: "describe"}, expected_revision: null});
  const raw = read.data === null ? null : select(read.data);
  const sparse = raw?.kind === "description" && raw.total > raw.items.length;
  const order = useCapturedOrder(source, sparse ? read.data!.store_revision : null, select);
  const admitted = sparse && order.data === null ? null : read.data;
  const motion = usePaneScrollMotion();
  const [last, setLast] = useState<{
    account: string; source: Source; data: QueryResult; order: typeof order.data;
  } | null>(null);
  const frozen = motion !== "still" && last?.account === account && last.source === source && last.order !== null;
  const current = frozen ? null : admitted;
  if (current !== null && (last?.account !== account || last.source !== source || last.data !== current || last.order !== order.data))
    setLast({account, source, data: current, order: order.data});
  const previous = current === null && last?.account === account ? last : null;
  const observation = current ?? previous?.data ?? null;
  const shownOrder = previous === null ? order.data : previous.order;
  const revision = observation?.store_revision ?? null;
  const liveRevision = read.data?.store_revision ?? revision;
  const held = useMemo(() => shownOrder === null || liveRevision === null || liveRevision === revision ? undefined
    : {revision: liveRevision, range: (start: number, limit: number) => shownOrder.range(start, limit, liveRevision)},
    [shownOrder, revision, liveRevision]);
  return {read, order, admitted, observation, shownOrder, source: previous?.source ?? source, revision, liveRevision, frozen, held};
}
