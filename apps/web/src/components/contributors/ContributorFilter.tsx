"use client";

// The search pane's author filter: type to find an author, click to add its
// handle to `authors=`; chosen options read display names from a label cache.

import { useCallback, useEffect, useRef, useState } from "react";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import DiscoveryTail from "@/components/collections/DiscoveryTail";
import { discoveryViewport, heldDiscoveryOptionStyle, nearDiscoveryTail, useDiscoveryOptions, useInitialDiscoveryDemand } from "@/lib/search/discoveryBoundary";
import collection from "@/components/ui/Collection.module.css";
import { usePaneFreeServerList } from "@/lib/api/useServerList";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { useSettled } from "@/lib/api/serverState";
import { requestWithRetry } from "@/lib/api/retry";
import {
  getContributor,
  searchContributors,
  type ContributorSearchItem,
} from "@/lib/contributors/api";
import styles from "./ContributorFilter.module.css";

/**
 * Display names for applied handles: remembered on add, else fetched with
 * retry. A failed fetch is forgotten, so the next change to the handles
 * retries it; until then the option shows the handle.
 */
export function useContributorFilterLabels(handles: readonly string[]) {
  const [labels, setLabels] = useState<Readonly<Record<string, string>>>({});
  const known = useRef(labels);
  known.current = labels;
  const key = handles.join(" ");
  useEffect(() => {
    const controller = new AbortController();
    for (const handle of new Set(key ? key.split(" ") : [])) {
      if (known.current[handle] !== undefined) continue;
      requestWithRetry(
        (signal) => getContributor(handle, signal),
        controller.signal,
      ).then(
        (detail) =>
          setLabels((current) => ({
            ...current,
            [handle]: detail.display_name,
          })),
        () => {},
      );
    }
    return () => controller.abort();
  }, [key]);
  const remember = useCallback((item: ContributorSearchItem) => {
    setLabels((current) => ({ ...current, [item.handle]: item.display_name }));
  }, []);
  return { labels, remember };
}

export default function ContributorFilter({
  selectedHandles,
  active,
  onAdd,
}: {
  readonly selectedHandles: readonly string[];
  readonly active: boolean;
  readonly onAdd: (item: ContributorSearchItem) => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const q = query.trim().normalize("NFC");
  // The disclosure owns activity; only this exact settled query can supply choices.
  const settled = useSettled(q, 180);
  const live = q !== "" && settled === q;
  const search = usePaneFreeServerList<ContributorSearchItem>({
    key: live ? `/contributors/search?q=${encodeURIComponent(q)}` : null,
    stale: "",
    pageSize: 10,
    active: active && live,
    cursorRecovery: "manual",
    continuation: item => !selectedHandles.includes(item.handle),
    id: (item) => item.handle,
    fetchPage: (cursor, limit, signal) => searchContributors({ q, cursor, limit, signal }),
  });
  const suggestions = live && search.current
    ? search.items.filter((item) => !selectedHandles.includes(item.handle))
    : [];
  const failure = live ? search.failure?.error ?? null : null;
  const repeated = failure?.code === "E_REPEATED_CURSOR";
  const canContinue = live && search.current && !search.complete && failure === null;
  const run = () => { if (canContinue) search.fetchAhead(); };
  const slots = useDiscoveryOptions({ key: q, viewport, open: active && live, rows: suggestions,
    id: item => item.handle, forward: run });
  useInitialDiscoveryDemand({ key: search.requestedKey, current: search.current, active: canContinue && search.active && suggestions.length === 0,
    viewport: () => viewport.current, run });
  return (
    <div className={styles.filter}>
      <label className={styles.label}>
        <span>authors</span>
        <Input ref={inputRef} type="search" value={query} placeholder="find an author"
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === "ArrowDown" && viewport.current !== null && nearDiscoveryTail(discoveryViewport(viewport.current))) run();
          }} />
      </label>
      {live ? <div ref={viewport} className={`${collection.compactViewport} ${styles.suggestions}`} data-collection-viewport=""
        onKeyDownCapture={event => {
          if (event.key === "Tab" && !event.shiftKey && viewport.current !== null && nearDiscoveryTail(discoveryViewport(viewport.current))) run();
        }}>
        {slots.map(({id, row: item, height}) => item === null
          ? <div key={id} data-discovery-option={id} style={heldDiscoveryOptionStyle(height)} aria-hidden="true" />
          : <Button key={id} data-discovery-option={id} style={heldDiscoveryOptionStyle(height)} className={styles.suggestion}
            onClick={() => { inputRef.current?.focus({ preventScroll: true }); onAdd(item); setQuery(""); }}
          >{item.display_name}</Button>)}
      </div> : null}
      {repeated ? <Fact line={{ fact: "couldn’t load more authors.", reason: "the source repeated its continuation." }} />
        : failure !== null ? <Failed error={failure} noun={search.current ? "more authors" : "authors"} retry={{
          run: failure.code === "E_INVALID_CURSOR" ? () => { void search.refetch().catch(() => {}); } : search.retry,
          busy: search.running !== null,
        }} />
        : live && (!search.current || suggestions.length === 0 && search.running !== null) ? <Ruling />
        : live && search.complete && suggestions.length === 0 ? <Fact line={{ fact: "no other authors match this search." }} speak={active} /> : null}
      <DiscoveryTail label="continue searching authors" action={canContinue ? search.more : null}
        busy={search.running !== null} show={suggestions.length === 0 || search.continuationNeedsAction} />
    </div>
  );
}
