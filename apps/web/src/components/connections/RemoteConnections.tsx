"use client";

import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { Fact, Failed } from "@/components/feedback/Fact";
import ResourceOutlineList, { ResourceBranch } from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { FactRemovalsContext, useFactRemovals } from "@/lib/resourceGraph/useFactRemovals";
import { queryConnections, resolveConnections } from "@/lib/resourceGraph/links";
import { OpenOutlineScopes, ParentOutlineScope, remoteConnectionScope } from "@/lib/resourceGraph/openOutlineScopes";
import { PaneRefreshAnchor } from "@/lib/workspace/paneReturnMemento";
import styles from "./ConnectionsSurface.module.css";

export function useRemoteConnections(ownerRef: string, stale: string, enabled = true) {
  const load = useCallback((signal: AbortSignal) => queryConnections({...remoteConnectionScope(ownerRef), match_text: null}, signal), [ownerRef]);
  return usePaneFreeServerValue({key: enabled ? `connections:remote:${ownerRef}` : null, stale, load});
}

export default function RemoteConnections({ ownerRef, occurrencePrefix, list, onChanged, label }: {
  ownerRef: string;
  label?: string;
  occurrencePrefix: string;
  list: ReturnType<typeof useRemoteConnections>;
  onChanged: () => void;
}) {
  const branch = useContext(ResourceBranch);
  const search = useContext(OpenOutlineScopes);
  const filtering = Boolean(search?.filter);
  const match = filtering ? search?.results?.get(occurrencePrefix) : null;
  const removals = useFactRemovals(occurrencePrefix);
  const filtered = useMemo(() => match?.kind === "ready" ? [...match.ids] : null, [match]);
  const order = filtering ? filtered : list.status === "ready" ? list.data.edge_ids : null;
  const ids = useMemo(() => order?.filter(id => !branch.traversedEdgeIds.has(id)) ?? [], [order, branch]);
  const element = useRef<HTMLUListElement | null>(null);
  const [margin, setMargin] = useState(0);
  const [pinned, setPinned] = useState<string | null>(null);
  const getPort = useCallback(() => {
    const node = element.current;
    for (let ancestor = node?.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (/^(auto|scroll)$/u.test(getComputedStyle(ancestor).overflowY)) return ancestor;
    }
    return null;
  }, []);
  useLayoutEffect(() => {
    const root = element.current, port = getPort();
    if (!root || !port) return;
    const read = () => setMargin(root.getBoundingClientRect().top - port.getBoundingClientRect().top - port.clientTop + port.scrollTop);
    read();
    const resize = new ResizeObserver(read);
    resize.observe(port);
    resize.observe(root);
    return () => resize.disconnect();
  }, [getPort, ids.length]);
  const index = useVirtualizer({
    count: ids.length, getScrollElement: getPort, getItemKey: rank => ids[rank]!,
    estimateSize: () => 80, scrollMargin: margin, overscan: 4,
    rangeExtractor(range) {
      const pin = pinned === null ? -1 : ids.indexOf(pinned);
      const visible = defaultRangeExtractor(range);
      return pin < 0 || visible.includes(pin) ? visible : [...visible, pin].sort((a, b) => a - b);
    },
    scrollToFn: () => {},
  });
  index.shouldAdjustScrollPositionOnItemSizeChange = () => false;
  const slots = index.getVirtualItems();
  const wanted = slots.slice(0, 100).map(slot => ids[slot.index]!);
  const key = JSON.stringify([ownerRef, wanted]);
  const load = (signal: AbortSignal) => resolveConnections({...remoteConnectionScope(ownerRef), edge_ids: wanted}, signal);
  const details = usePaneFreeServerValue({key: wanted.length ? key : null,
    stale: list.status === "ready" ? String(list.generation) : "", load});
  const items = useMemo(() => new Map(details.status === "ready" ? details.data.items.map(row => [row.edge_id, row]) : []), [details]);
  const refetched = useRef<string | null>(null);
  if (refetched.current !== null && refetched.current !== key) refetched.current = null;
  useLayoutEffect(() => {
    if (details.status !== "ready" || !details.fresh || items.size === wanted.length || refetched.current === key) return;
    refetched.current = key;
    if (filtering) search?.retry(occurrencePrefix);
    else void list.refetch().catch(() => undefined);
  }, [details, items.size, wanted.length, key, list, filtering, search, occurrencePrefix]);
  return <FactRemovalsContext value={removals}><ParentOutlineScope value={occurrencePrefix}>
    {match?.kind === "failed" ? <Fact line={{fact: `couldn’t search links in ${label ?? "this item"}.`}}
      verbs={[{label: "retry", commandKey: "RetryOutlineLinks", run: () => search?.retry(occurrencePrefix)}]}/> : null}
    {!filtering && list.status === "failed" ? <Failed error={list.error} noun="other connections" retry={{run: list.refetch, busy: list.retrying}}/> : null}
    {ids.length > 0 ? <section aria-label="other connections">
      <h3 className={styles.subtitle}>other connections</h3>
      {details.status === "failed" ? <Failed error={details.error} noun="visible connections"
        retry={{run: details.refetch, busy: details.retrying}}/> : null}
      <PaneRefreshAnchor identity={occurrencePrefix} value={order} ready>
        <ResourceOutlineList scope={`remote:${occurrencePrefix}`} ariaLabel="other connections" ancestorRef={ownerRef}
          listProps={{ref: element, style: {height: index.getTotalSize()}, onBlur: event => {
            if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setPinned(null);
          }}}>
          {slots.map(slot => {
            const id = ids[slot.index]!, connection = items.get(id);
            const style = {position: "absolute", insetInline: 0, top: slot.start - margin} as const;
            return connection === undefined ? <li key={id} aria-hidden="true" role="presentation" style={style}/>
              : <ResourceOutlineRow key={id} item={connection.other} rowRef={index.measureElement}
                occurrenceKey={`${occurrencePrefix}/${id}`} connection={connection}
                rootProps={{style, "data-index": slot.index, "aria-posinset": slot.index + 1, "aria-setsize": ids.length,
                  "data-collection-row-id": id, onFocus: () => setPinned(id)}}
                incoming={{kind: "edge", edge_id: id, origin: connection.origin, mutation: connection.mutation, creation: connection.creation}}
                historical={connection.origin === "citation" && connection.ordinal !== null} onChanged={onChanged}/>;
          })}
        </ResourceOutlineList>
      </PaneRefreshAnchor>
    </section> : null}
    {removals.holds}
  </ParentOutlineScope></FactRemovalsContext>;
}
