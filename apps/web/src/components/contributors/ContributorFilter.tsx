"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import Input from "@/components/ui/Input";
import { fetchContributor } from "@/lib/contributors/api";
import { contributorAuthorHref } from "@/lib/contributors/routes";
import type { ContributorSummary } from "@/lib/contributors/types";
import { useContributorSearch } from "@/lib/contributors/useContributorSearch";

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

export default function ContributorFilter({
  selectedHandles,
  onChange,
}: ContributorFilterProps) {
  const [query, setQuery] = useState("");
  const [selectedByHandle, setSelectedByHandle] = useState<Record<string, ContributorSummary>>({});
  const selectedHandleRequestsRef = useRef(new Set<string>());
  const selectedHandleSetRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const normalizedHandles = useMemo(() => dedupeHandles(selectedHandles), [selectedHandles]);
  const searchResults = useContributorSearch(query);
  const suggestions = useMemo(() => {
    const selected = new Set(normalizedHandles);
    return searchResults.filter((contributor) => !selected.has(contributor.handle));
  }, [normalizedHandles, searchResults]);

  useEffect(() => {
    selectedHandleSetRef.current = new Set(normalizedHandles);
  }, [normalizedHandles]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    for (const handle of normalizedHandles) {
      if (selectedByHandle[handle] || selectedHandleRequestsRef.current.has(handle)) {
        continue;
      }
      selectedHandleRequestsRef.current.add(handle);
      void fetchContributor(handle)
        .then((response) => {
          if (!mountedRef.current || !selectedHandleSetRef.current.has(handle)) {
            return;
          }
          setSelectedByHandle((current) =>
            current[handle]
              ? current
              : {
                  ...current,
                  [handle]: response,
                }
          );
        })
        .catch(() => {})
        .finally(() => {
          selectedHandleRequestsRef.current.delete(handle);
        });
    }
  }, [normalizedHandles, selectedByHandle]);

  function addContributor(contributor: ContributorSummary) {
    onChange(dedupeHandles([...normalizedHandles, contributor.handle]));
    setSelectedByHandle((current) => ({
      ...current,
      [contributor.handle]: contributor,
    }));
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
            const contributor = selectedByHandle[handle];
            const label = contributor?.display_name ?? handle;
            return (
              <Chip
                key={handle}
                removable
                onRemove={() => removeHandle(handle)}
                aria-label={label}
              >
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

      {suggestions.length > 0 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-1)",
            maxWidth: "360px",
          }}
        >
          {suggestions.map((contributor) => (
            <Button
              key={contributor.handle}
              variant="secondary"
              size="sm"
              onClick={() => addContributor(contributor)}
              style={{ justifyContent: "flex-start" }}
            >
              {contributor.display_name}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
