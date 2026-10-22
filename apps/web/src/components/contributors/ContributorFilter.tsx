"use client";

// The search pane's author filter: type to find an author, click to add its
// handle to `authors=`; applied chips read display names from a label cache.

import { useCallback, useEffect, useRef, useState } from "react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
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
    key: live ? q : null,
    stale: "",
    pageSize: 10,
    active: active && live,
    id: (item) => item.handle,
    fetchPage: (cursor, limit, signal) => searchContributors({ q, cursor, limit, signal }),
  });
  const suggestions = live && search.current
    ? search.items.filter((item) => !selectedHandles.includes(item.handle))
    : [];
  const failure = live && search.failure?.op !== "More" ? search.failure : null;
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
      {failure !== null ? (
        <FeedbackNotice content={{ tone: "Warning", title: "couldn’t load authors", requestId: failure.error.requestId }}
          announcement={search.active ? "Polite" : "None"}
          actions={[{ label: "try again", onClick: search.retry, busy: search.running !== null }]}
          returnFocus={() => inputRef.current} />
      ) : live && !search.current ? (
        <FeedbackStatus content={{ tone: "Neutral", title: "searching authors…" }} announcement={search.active ? "Polite" : "None"} />
      ) : null}
      {suggestions.length > 0 ? (
        <div className={styles.suggestions}>
          {suggestions.map((item) => (
            <Button
              key={item.handle}
              variant="secondary"
              size="sm"
              className={styles.suggestion}
              onClick={() => {
                onAdd(item);
                setQuery("");
              }}
            >
              {item.display_name}
            </Button>
          ))}
        </div>
      ) : null}
      {live ? <CollectionExhaustionNotice list={search} unit={{ singular: "author", plural: "authors" }} returnFocus={() => inputRef.current} /> : null}
    </div>
  );
}
