"use client";

// The search pane's author filter: type to find an author, click to add its
// handle to `authors=`; applied chips read display names from a label cache.

import { useCallback, useEffect, useRef, useState } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import {
  requestWithRetry,
  usePaneFreeServerValue,
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
  onAdd,
}: {
  readonly selectedHandles: readonly string[];
  readonly onAdd: (item: ContributorSearchItem) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim();
  // One read per query that held still for 180 ms; results show only for it.
  const settled = useSettled(q, 180);
  const live = q !== "" && settled === q;
  const search = usePaneFreeServerValue({
    key: live ? q : null,
    stale: "",
    load: (signal) => searchContributors(q, signal),
  });
  const suggestions =
    live && search.status === "ready"
      ? search.data.contributors.filter(
          (item) => !selectedHandles.includes(item.handle),
        )
      : [];
  return (
    <div className={styles.filter}>
      <label className={styles.label}>
        <span>Authors</span>
        <Input
          type="search"
          value={query}
          placeholder="Find an author"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {live && search.status === "failed" ? (
        <FeedbackNotice content={{ tone: "Warning", title: "couldn’t load authors", requestId: search.error.requestId }}
          announcement="Polite"
          actions={[{ label: "try again", onClick: search.refetch, busy: search.retrying }]} />
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
    </div>
  );
}
