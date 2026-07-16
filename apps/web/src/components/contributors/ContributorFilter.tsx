"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import Input from "@/components/ui/Input";
import { fetchContributorDetail } from "@/lib/contributors/api";
import { contributorAuthorHref } from "@/lib/contributors/routes";
import type { ContributorSearchItem } from "@/lib/contributors/types";
import { useContributorSearch } from "@/lib/contributors/useContributorSearch";
import { useStringIdSet } from "@/lib/useStringIdSet";

interface ContributorFilterProps {
  selectedHandles: string[];
  onChange: (handles: string[]) => void;
}

function dedupeHandles(handles: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const handle of handles) {
    const trimmed = handle.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    next.push(trimmed);
  }
  return next;
}

export default function ContributorFilter({ selectedHandles, onChange }: ContributorFilterProps) {
  const [query, setQuery] = useState("");
  const [labels, setLabels] = useState<Record<string, string>>({});
  // Request-once set for selected-handle label hydration: a handle is added before
  // its detail fetch and never removed, so a failed fetch never retries in a loop.
  const requested = useStringIdSet();
  const mountedRef = useRef(true);
  const normalizedHandles = useMemo(() => dedupeHandles(selectedHandles), [selectedHandles]);
  const search = useContributorSearch(query);

  const suggestions = useMemo<ContributorSearchItem[]>(() => {
    if (search.status !== "ready") {
      return [];
    }
    const selected = new Set(normalizedHandles);
    return search.items.filter((item) => !selected.has(item.handle));
  }, [search, normalizedHandles]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    for (const handle of normalizedHandles) {
      if (labels[handle] || requested.has(handle)) {
        continue;
      }
      requested.add(handle);
      void fetchContributorDetail(handle)
        .then((detail) => {
          if (!mountedRef.current) {
            return;
          }
          setLabels((current) =>
            current[handle] ? current : { ...current, [handle]: detail.displayName },
          );
        })
        .catch(() => {});
    }
  }, [normalizedHandles, labels, requested]);

  function addContributor(item: ContributorSearchItem) {
    onChange(dedupeHandles([...normalizedHandles, item.handle]));
    setLabels((current) => ({ ...current, [item.handle]: item.displayName }));
    setQuery("");
  }

  function removeHandle(handle: string) {
    onChange(normalizedHandles.filter((candidate) => candidate !== handle));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      {normalizedHandles.length > 0 ? (
        <div
          style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }}
          aria-label="Selected authors"
        >
          {normalizedHandles.map((handle) => {
            const label = labels[handle] ?? handle;
            return (
              <Chip key={handle} removable onRemove={() => removeHandle(handle)} aria-label={label}>
                <a
                  href={contributorAuthorHref(handle)}
                  style={{ color: "inherit", textDecoration: "none" }}
                >
                  {label}
                </a>
              </Chip>
            );
          })}
        </div>
      ) : null}

      <label>
        <span className="sr-only">Filter by author</span>
        <Input
          type="search"
          value={query}
          placeholder="Filter authors..."
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
              onClick={() => addContributor(item)}
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
