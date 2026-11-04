"use client";

// The search pane's author filter: type to find an author, click to add its
// handle to `authors=`; applied chips read display names from a label cache.

import { useCallback, useEffect, useRef, useState } from "react";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import { usePaneFreeServerList } from "@/lib/api/useServerList";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import {
  requestWithRetry,
  useSettled,
} from "@/lib/api/serverState";
import {
  getContributor,
  searchContributors,
  type ContributorSearchItem,
} from "@/lib/contributors/api";
import styles from "./ContributorFilter.module.css";

/**
 * Display names for applied handles: remembered on add, else fetched with
 * retry. A failed fetch is forgotten, so the next change to the handles
 * retries it; until then the chip shows the handle.
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
  const q = query.trim();
  // The disclosure owns activity; only this exact settled query can supply choices.
  const settled = useSettled(q, 180);
  const live = q !== "" && settled === q;
  const search = usePaneFreeServerList<ContributorSearchItem>({
    key: live ? `/contributors/search?q=${encodeURIComponent(q)}` : null,
    stale: "",
    pageSize: 10,
    active: active && live,
    id: (item) => item.handle,
    fetchPage: (cursor, limit, signal) => searchContributors({ q, cursor, limit, signal }),
  });
  const suggestions = live && search.current
    ? search.items.filter((item) => !selectedHandles.includes(item.handle))
    : [];
  const failure = live && !search.current ? search.failure : null;
  const readFeedback = useCollectionReadFeedback({ list: search, unit: { singular: "author", plural: "authors" }, waiting: live && !search.current && failure === null, outcome: null });
  return (
    <div className={styles.filter}>
      <label className={styles.label}>
        <span>Authors</span>
        <Input
          ref={inputRef}
          type="search"
          value={query}
          placeholder="Find an author"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {failure !== null ? <Failed error={failure.error} noun="authors" retry={{ run: search.retry, busy: search.running !== null }} />
        : live && search.failure === null && (!search.current || suggestions.length === 0 && !search.complete) ? <Ruling />
        : null}
      {suggestions.length > 0 ? (
        <div className={styles.suggestions}>
          {suggestions.map((item) => (
            <Button
              key={item.handle}
              className={styles.suggestion}
              onClick={() => {
                inputRef.current?.focus({ preventScroll: true });
                onAdd(item);
                setQuery("");
              }}
            >
              {item.display_name}
            </Button>
          ))}
        </div>
      ) : null}
      {live && search.complete && failure === null && suggestions.length === 0
        ? <Fact line={{ fact: "no other authors match this search." }} speak={active} /> : null}
      {live ? readFeedback.notice : null}
      {readFeedback.announcement}
    </div>
  );
}
