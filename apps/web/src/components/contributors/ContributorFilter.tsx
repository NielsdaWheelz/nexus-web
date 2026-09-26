"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { fetchContributorDetail } from "@/lib/contributors/api";
import type { ContributorSearchItem } from "@/lib/contributors/types";
import { useContributorSearch } from "@/lib/contributors/useContributorSearch";
import { useStringIdSet } from "@/lib/useStringIdSet";

/** One label cache for the selected-author editor and applied chips. */
export function useContributorFilterLabels(selectedHandles: string[]) {
  const [labels, setLabels] = useState<Record<string, string>>({});
  const requested = useStringIdSet();
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    for (const handle of selectedHandles) {
      if (labels[handle] || requested.has(handle)) continue;
      requested.add(handle);
      void fetchContributorDetail(handle)
        .then((detail) => {
          if (!mountedRef.current) return;
          setLabels((current) =>
            current[handle] ? current : { ...current, [handle]: detail.displayName },
          );
        })
        .catch(() => {});
    }
  }, [selectedHandles, labels, requested]);

  const remember = useCallback((item: ContributorSearchItem) => {
    setLabels((current) => ({ ...current, [item.handle]: item.displayName }));
  }, []);
  return { labels, remember };
}

interface ContributorFilterProps {
  selectedHandles: string[];
  onAdd: (item: ContributorSearchItem) => void;
}

export default function ContributorFilter({ selectedHandles, onAdd }: ContributorFilterProps) {
  const [query, setQuery] = useState("");
  const search = useContributorSearch(query);
  const suggestions = useMemo<ContributorSearchItem[]>(() => {
    if (search.status !== "ready") return [];
    const selected = new Set(selectedHandles);
    return search.items.filter((item) => !selected.has(item.handle));
  }, [search, selectedHandles]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
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

      {search.status === "error" ? (
        <p role="alert" style={{ color: "var(--ink-muted)", fontSize: "var(--text-sm)" }}>
          Couldn&rsquo;t load authors.
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
              onClick={() => {
                onAdd(item);
                setQuery("");
              }}
              style={{ justifyContent: "flex-start" }}
            >
              {item.displayName}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
