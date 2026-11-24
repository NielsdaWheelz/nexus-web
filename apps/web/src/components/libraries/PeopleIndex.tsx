"use client";

import {useMemo, useRef, useState, type ReactNode} from "react";
import {INDEX_WINDOW_THRESHOLD} from "@/lib/collections/measuredIndexWindow";
import {useVariableIndex} from "@/lib/collections/variableIndex";

export default function PeopleIndex<Row>({label, scope, rows, id, pinned, render}: {
  label: string; scope: string; rows: readonly Row[]; id(row: Row): string;
  pinned: string | null; render(row: Row): ReactNode;
}) {
  const list = useRef<HTMLUListElement>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const {ids, byId} = useMemo(() => {
    const byId = new Map(rows.map(row => [id(row), row]));
    return {ids: [...byId.keys()], byId};
  }, [rows, id]);
  const pins = useMemo(() => new Set([pinned, focus].filter(value => value !== null)), [pinned, focus]);
  const index = useVariableIndex({scope, ids, list, estimate: 64, pinned: pins, windowed: ids.length > INDEX_WINDOW_THRESHOLD});
  return <ul ref={list} aria-label={label} data-pane-return-scope={scope}
    style={{position: "relative", height: index.height, listStyle: "none", padding: 0, margin: 0}}
    onBlur={event => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocus(null);
    }}>
    {index.slots.map(({id, rank, top, size}) => <li key={id} ref={index.measure} data-index={rank}
      data-collection-row-id={id} aria-posinset={rank + 1} aria-setsize={index.count}
      onFocus={() => setFocus(id)}
      style={{position: top === undefined ? undefined : "absolute", insetInline: 0, top, blockSize: size,
        paddingBlockEnd: "var(--space-2)", overflow: size === undefined ? undefined : "clip"}}>
      {byId.has(id) ? render(byId.get(id)!) : null}
    </li>)}
  </ul>;
}
