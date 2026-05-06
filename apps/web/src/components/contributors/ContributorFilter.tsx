"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import Input from "@/components/ui/Input";
import { fetchContributor, fetchContributors } from "@/lib/contributors/api";
import type { ContributorSummary } from "@/lib/contributors/types";

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
  const [suggestions, setSuggestions] = useState<ContributorSummary[]>([]);
  const [selectedByHandle, setSelectedByHandle] = useState<Record<string, ContributorSummary>>({});
  const requestIdRef = useRef(0);
  const normalizedHandles = useMemo(() => dedupeHandles(selectedHandles), [selectedHandles]);

  useEffect(() => {
    let cancelled = false;
    for (const handle of normalizedHandles) {
      if (selectedByHandle[handle]) {
        continue;
      }
      void fetchContributor(handle)
        .then((response) => {
          if (cancelled) {
            return;
          }
          setSelectedByHandle((current) => ({
            ...current,
            [handle]: response,
          }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [normalizedHandles, selectedByHandle]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const timer = setTimeout(() => {
      void fetchContributors(trimmed)
        .then((contributors) => {
          if (requestIdRef.current !== requestId) {
            return;
          }
          const selected = new Set(normalizedHandles);
          setSuggestions(
            contributors.filter((contributor) => !selected.has(contributor.handle))
          );
        })
        .catch(() => {
          if (requestIdRef.current === requestId) {
            setSuggestions([]);
          }
        });
    }, 200);

    return () => {
      clearTimeout(timer);
    };
  }, [normalizedHandles, query]);

  function addContributor(contributor: ContributorSummary) {
    onChange(dedupeHandles([...normalizedHandles, contributor.handle]));
    setSelectedByHandle((current) => ({
      ...current,
      [contributor.handle]: contributor,
    }));
    setQuery("");
    setSuggestions([]);
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
                  href={`/authors/${encodeURIComponent(handle)}`}
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
