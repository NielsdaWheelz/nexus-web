"use client";

import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchContributor, fetchContributors } from "@/lib/contributors/api";
import type { ContributorSummary } from "@/lib/contributors/types";

interface ContributorFilterProps {
  selectedHandles: string[];
  onChange: (handles: string[]) => void;
}

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
};

const selectedStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.35rem",
};

const chipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.35rem",
  border: "1px solid var(--color-border)",
  borderRadius: "999px",
  padding: "2px 8px",
  background: "var(--color-bg-secondary)",
  color: "var(--color-text)",
  fontSize: "var(--font-size-xs)",
};

const removeStyle: CSSProperties = {
  border: "none",
  padding: 0,
  background: "transparent",
  color: "var(--color-text-muted)",
  cursor: "pointer",
  font: "inherit",
  lineHeight: 1,
};

const selectedLinkStyle: CSSProperties = {
  color: "inherit",
  textDecoration: "none",
};

const inputStyle: CSSProperties = {
  width: "min(340px, 100%)",
  padding: "8px 10px",
  border: "1px solid var(--color-border)",
  borderRadius: "8px",
  background: "var(--color-bg)",
  color: "var(--color-text)",
  font: "inherit",
  fontSize: "var(--font-size-sm)",
};

const suggestionListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  maxWidth: "360px",
};

const suggestionStyle: CSSProperties = {
  border: "1px solid var(--color-border)",
  borderRadius: "8px",
  padding: "6px 8px",
  background: "var(--color-bg-secondary)",
  color: "var(--color-text)",
  cursor: "pointer",
  font: "inherit",
  fontSize: "var(--font-size-sm)",
  textAlign: "left",
};

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
    <div style={rootStyle}>
      {normalizedHandles.length > 0 ? (
        <div style={selectedStyle} aria-label="Selected authors">
          {normalizedHandles.map((handle) => {
            const contributor = selectedByHandle[handle];
            return (
              <span key={handle} style={chipStyle}>
                <a
                  href={`/authors/${encodeURIComponent(handle)}`}
                  style={selectedLinkStyle}
                >
                  {contributor?.display_name ?? handle}
                </a>
                <button
                  type="button"
                  style={removeStyle}
                  aria-label={`Remove ${contributor?.display_name ?? handle}`}
                  onClick={() => removeHandle(handle)}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      ) : null}

      <label>
        <span className="sr-only">Filter by author</span>
        <input
          type="search"
          value={query}
          style={inputStyle}
          placeholder="Filter authors..."
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      {suggestions.length > 0 ? (
        <div style={suggestionListStyle}>
          {suggestions.map((contributor) => (
            <button
              key={contributor.handle}
              type="button"
              style={suggestionStyle}
              onClick={() => addContributor(contributor)}
            >
              {contributor.display_name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
