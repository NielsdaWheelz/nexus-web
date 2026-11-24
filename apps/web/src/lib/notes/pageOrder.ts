"use client";

import {useCallback, useEffect, useState} from "react";
import type {RegisterItem} from "@nexus/authored/types";
import {useAuthoredAccountId, useAuthoredStore} from "@/lib/authored/provider";
import type {ReturnOrder} from "@/lib/workspace/paneReturnMemento";

type PageOrder = Omit<ReturnOrder, "prefix"> & {
  range(start: number, limit: number, revision: string): Promise<(RegisterItem | null)[] | null>;
};

export function usePageOrder(text: string, revision: string | null) {
  const store = useAuthoredStore();
  const key = JSON.stringify([useAuthoredAccountId(), text, revision]);
  const [state, setState] = useState<{key: string; data: PageOrder | null; error: unknown | null} | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (revision === null) return;
    const token = crypto.randomUUID();
    let references = 1;
    let live = true;
    const release = () => {
      if (--references === 0) void store.query({kind: "page_register", text: "", at: {kind: "release", token}, expected_revision: null}).catch(() => {});
    };
    const order: PageOrder = {
      retain() {
        references++;
        return release;
      },
      async range(start, limit, expectedRevision) {
        const result = await store.query({kind: "page_register", text: "", at: {kind: "held", token, start, limit}, expected_revision: expectedRevision});
        const range = result.page_register;
        if (range?.kind === "changed") return null;
        if (range?.kind !== "held" || range.start !== start || range.items.length !== limit)
          throw new Error("incomplete held page range");
        return range.items;
      },
      async successor(id, expectedRevision) {
        const result = await store.query({kind: "page_register", text, at: {kind: "successor", token, ref: id === null ? null : `page:${id}`}, expected_revision: expectedRevision});
        const successor = result.page_register;
        if (successor?.kind === "changed") return undefined;
        if (successor?.kind !== "successor") throw new Error("missing page register successor");
        return successor.ref?.slice(5) ?? null;
      },
    };
    void store.query({kind: "page_register", text, at: {kind: "retain", token}, expected_revision: revision}).then(result => {
      if (live && result.page_register?.kind === "retained") setState({key, data: order, error: null});
    }, error => {if (live) setState({key, data: null, error});});
    return () => {live = false; release();};
  }, [attempt, key, revision, store, text]);
  const current = state?.key === key ? state : null;
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  return {data: current?.data ?? null, error: current?.error ?? null, retry};
}
