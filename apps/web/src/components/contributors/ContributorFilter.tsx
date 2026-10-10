"use client";

// The search pane's author filter: type to find an author, click to add its
// handle to `authors=`; applied chips read display names from a label cache.

import { useCallback, useEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { requestWithRetry } from "@/lib/api/retryPolicy";
import { useDebouncedFetch } from "@/lib/api/useDebouncedFetch";
import {
  getContributor,
  searchContributors,
  type ContributorSearchItem,
} from "@/lib/contributors/api";

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
            [handle]: detail.displayName,
          })),
        () => {},
      );
    }
    return () => controller.abort();
  }, [key]);
  const remember = useCallback((item: ContributorSearchItem) => {
    setLabels((current) => ({ ...current, [item.handle]: item.displayName }));
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
  const search = useDebouncedFetch(
    q || null,
    (signal) => searchContributors(q, signal),
    { debounceMs: 180 },
  );
  const suggestions =
    search.dataIdentity === q
      ? (search.data?.contributors ?? []).filter(
          (item) => !selectedHandles.includes(item.handle),
        )
      : [];
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
      }}
    >
      <label>
        <span>Authors</span>
        <Input
          type="search"
          value={query}
          placeholder="Find an author"
          style={{ width: "min(340px, 100%)" }}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {search.error !== null && search.errorIdentity === q ? (
        <p
          role="alert"
          style={{ color: "var(--ink-muted)", fontSize: "var(--text-sm)" }}
        >
          Couldn’t load authors.
        </p>
      ) : null}
      {suggestions.length > 0 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-1)",
            maxWidth: "360px",
          }}
        >
          {suggestions.map((item) => (
            <Button
              key={item.handle}
              variant="secondary"
              size="sm"
              style={{ justifyContent: "flex-start" }}
              onClick={() => {
                onAdd(item);
                setQuery("");
              }}
            >
              {item.displayName}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
