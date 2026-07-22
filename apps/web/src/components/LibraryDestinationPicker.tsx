"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import Input from "@/components/ui/Input";
import LibraryColorDot from "@/components/LibraryColorDot";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import {
  isLibraryDestinationDefect,
  searchWritableLibraryDestinations,
  type LibraryDestinationSelection,
} from "@/lib/libraries/client";
import styles from "./LibraryDestinationPicker.module.css";

export type LibraryDestinationPickerProps = {
  selected: readonly LibraryDestinationSelection[];
  onChange(next: readonly LibraryDestinationSelection[]): void;
  presentation:
    | { kind: "Inline" }
    | { kind: "DisclosureContent"; onRequestClose(): void };
  label: string;
  interaction:
    | { kind: "Enabled" }
    | { kind: "Disabled" }
    | { kind: "Creating" };
  onCreateDestination(name: string): Promise<LibraryDestinationSelection>;
};

type Row =
  | { kind: "Library"; id: string; destination: LibraryDestinationSelection }
  | { kind: "Create"; id: "create"; name: string }
  | { kind: "LoadMore"; id: "load-more" };

function uniqueDestinations(
  destinations: readonly LibraryDestinationSelection[],
): LibraryDestinationSelection[] {
  const seen = new Set<string>();
  return destinations.filter((destination) => {
    if (seen.has(destination.id)) return false;
    seen.add(destination.id);
    return true;
  });
}

export default function LibraryDestinationPicker({
  selected,
  onChange,
  presentation,
  label,
  interaction,
  onCreateDestination,
}: LibraryDestinationPickerProps) {
  const id = useId();
  const listboxId = `${id}-listbox`;
  const statusId = `${id}-status`;
  const optionId = (rowId: string) => `${id}-option-${rowId}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const composingRef = useRef(false);
  const [inlineOpen, setInlineOpen] = useState(false);
  const [query, setQuery] = useState("");
  const normalizedQuery = useMemo(() => query.trim().toLowerCase(), [query]);
  const normalizedQueryRef = useRef(normalizedQuery);
  normalizedQueryRef.current = normalizedQuery;
  const [results, setResults] = useState<LibraryDestinationSelection[]>([]);
  const [resultsQuery, setResultsQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [createFocusRequest, setCreateFocusRequest] = useState(0);
  const handledCreateFocusRequestRef = useRef(0);
  const enabled = interaction.kind === "Enabled";
  const listVisible = presentation.kind === "DisclosureContent" || inlineOpen;

  useEffect(() => {
    if (!enabled) setInlineOpen(false);
  }, [enabled]);

  useEffect(() => {
    if (
      !enabled ||
      handledCreateFocusRequestRef.current === createFocusRequest
    ) {
      return;
    }
    handledCreateFocusRequestRef.current = createFocusRequest;
    inputRef.current?.focus();
  }, [createFocusRequest, enabled]);

  useEffect(() => () => loadMoreAbortRef.current?.abort(), []);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = null;
    setLoadingMore(false);
    if (!listVisible || !enabled) return;
    const controller = new AbortController();
    const requestedQuery = normalizedQuery;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      setMoreError(null);
      void searchWritableLibraryDestinations({
        q: requestedQuery,
        limit: 25,
        signal: controller.signal,
      })
        .then((page) => {
          if (requestId !== requestIdRef.current) return;
          setResults(page.data);
          setResultsQuery(requestedQuery);
          setNextCursor(page.page.next_cursor);
        })
        .catch((caught) => {
          if (controller.signal.aborted || requestId !== requestIdRef.current)
            return;
          if (handleUnauthenticatedApiError(caught)) return;
          if (isLibraryDestinationDefect(caught)) {
            setDefect({ error: caught });
            return;
          }
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not load libraries",
          );
          setResults([]);
          setNextCursor(null);
        })
        .finally(() => {
          if (requestId === requestIdRef.current) setLoading(false);
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, listVisible, normalizedQuery]);

  async function loadMoreResults() {
    if (!enabled || loadingMore || nextCursor === null) return;
    const requestId = requestIdRef.current;
    const requestedQuery = resultsQuery;
    const controller = new AbortController();
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = controller;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await searchWritableLibraryDestinations({
        q: requestedQuery,
        cursor: nextCursor,
        limit: 25,
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        requestId !== requestIdRef.current ||
        requestedQuery !== normalizedQueryRef.current
      ) {
        return;
      }
      setResults((current) => uniqueDestinations([...current, ...page.data]));
      setNextCursor(page.page.next_cursor);
    } catch (caught) {
      if (controller.signal.aborted || requestId !== requestIdRef.current)
        return;
      if (handleUnauthenticatedApiError(caught)) return;
      if (isLibraryDestinationDefect(caught)) {
        setDefect({ error: caught });
        return;
      }
      setMoreError(
        caught instanceof Error
          ? caught.message
          : "Could not load more libraries",
      );
    } finally {
      if (!controller.signal.aborted && requestId === requestIdRef.current) {
        setLoadingMore(false);
      }
    }
  }

  const selectedIds = useMemo(
    () => new Set(selected.map((destination) => destination.id)),
    [selected],
  );
  const createName = query.trim();
  const normalizedCreateName = createName.toLowerCase();
  const canCreate =
    createName.length > 0 &&
    createName.length <= 100 &&
    !loading &&
    !loadingMore &&
    !error &&
    nextCursor === null &&
    resultsQuery === normalizedCreateName &&
    !results.some(
      (destination) =>
        destination.name.trim().toLowerCase() === normalizedCreateName,
    );
  const rows = useMemo<Row[]>(
    () => [
      ...uniqueDestinations([...selected, ...results]).map(
        (destination): Row => ({
          kind: "Library",
          id: destination.id,
          destination,
        }),
      ),
      ...(canCreate
        ? [{ kind: "Create" as const, id: "create" as const, name: createName }]
        : []),
      ...(nextCursor !== null
        ? [{ kind: "LoadMore" as const, id: "load-more" as const }]
        : []),
    ],
    [canCreate, createName, nextCursor, results, selected],
  );
  const activeOptionId =
    listVisible &&
    !loading &&
    !error &&
    activeId !== null &&
    rows.some((row) => row.id === activeId)
      ? optionId(activeId)
      : undefined;

  useEffect(() => {
    if (!listVisible) return;
    if (rows.length === 0) {
      setActiveId(null);
      return;
    }
    if (!activeId || !rows.some((row) => row.id === activeId)) {
      setActiveId(rows[0]!.id);
    }
  }, [activeId, listVisible, rows]);

  function toggle(destination: LibraryDestinationSelection) {
    if (!enabled) return;
    if (selectedIds.has(destination.id)) {
      onChange(selected.filter((item) => item.id !== destination.id));
      return;
    }
    onChange([...selected, destination]);
  }

  async function runCreate(name: string) {
    if (!enabled) return;
    setError(null);
    try {
      const destination = await onCreateDestination(name);
      setResults((current) => [
        destination,
        ...current.filter((item) => item.id !== destination.id),
      ]);
      if (!selectedIds.has(destination.id))
        onChange([...selected, destination]);
      setQuery("");
      setActiveId(destination.id);
      setCreateFocusRequest((current) => current + 1);
    } catch (caught) {
      if (isAbortError(caught)) return;
      if (handleUnauthenticatedApiError(caught)) return;
      if (isLibraryDestinationDefect(caught)) {
        setDefect({ error: caught });
        return;
      }
      setError(
        caught instanceof Error ? caught.message : "Could not create library",
      );
    }
  }

  function select(row: Row) {
    if (!enabled) return;
    switch (row.kind) {
      case "Create":
        void runCreate(row.name);
        return;
      case "LoadMore":
        void loadMoreResults();
        return;
      case "Library":
        toggle(row.destination);
        return;
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (composingRef.current) return;
    if (event.key === "Escape") {
      if (presentation.kind === "DisclosureContent") {
        event.preventDefault();
        if (interaction.kind !== "Creating") presentation.onRequestClose();
      } else if (inlineOpen) {
        event.preventDefault();
        setInlineOpen(false);
      } else if (query) {
        event.preventDefault();
        setQuery("");
      }
      return;
    }
    if (!enabled) return;
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      event.preventDefault();
      setInlineOpen(true);
      if (rows.length === 0) return;
      const current = rows.findIndex((row) => row.id === activeId);
      const start = current >= 0 ? current : 0;
      const last = rows.length - 1;
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : event.key === "ArrowDown"
              ? Math.min(last, start + 1)
              : Math.max(0, start - 1);
      setActiveId(rows[next]!.id);
      return;
    }
    if (event.key === "Enter") {
      const row =
        rows.find((candidate) => candidate.id === activeId) ?? rows[0];
      if (row) {
        event.preventDefault();
        select(row);
      }
    }
  }

  const status = loading
    ? "Loading libraries"
    : loadingMore
      ? "Loading more libraries"
      : interaction.kind === "Creating"
        ? "Creating library"
        : error
          ? error
          : moreError
            ? moreError
            : rows.length === 0
              ? "No matching libraries"
              : `${rows.length} library options`;

  if (defect) throw defect.error;

  return (
    <div className={styles.root}>
      <label className={styles.label} htmlFor={`${id}-input`}>
        {label}
      </label>
      <div className={styles.control} data-disabled={!enabled || undefined}>
        <div className={styles.chips}>
          {selected.length === 0 ? (
            <span className={styles.empty}>My Library only</span>
          ) : (
            selected.map((destination) => (
              <span key={destination.id} className={styles.chip}>
                <LibraryColorDot color={destination.color} size="sm" />
                <span className={styles.chipText}>{destination.name}</span>
                <button
                  type="button"
                  className={styles.remove}
                  aria-label={`Remove ${destination.name}`}
                  disabled={!enabled}
                  onClick={() => toggle(destination)}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </span>
            ))
          )}
        </div>
        <Input
          ref={inputRef}
          id={`${id}-input`}
          variant="bare"
          className={styles.input}
          role="combobox"
          aria-expanded={listVisible}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          aria-describedby={statusId}
          disabled={!enabled}
          value={query}
          placeholder="Search or create"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={() => {
            if (enabled) setInlineOpen(true);
          }}
          onChange={(event) => {
            if (!enabled) return;
            setQuery(event.target.value);
            setInlineOpen(true);
            setError(null);
            setLoading(true);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div id={statusId} className="sr-only">
        {status}
      </div>
      {listVisible ? (
        <div
          id={listboxId}
          role="listbox"
          className={styles.list}
          aria-label={label}
          aria-multiselectable="true"
        >
          {loading ? (
            <div
              role="option"
              aria-disabled="true"
              aria-selected="false"
              className={styles.status}
            >
              Loading libraries…
            </div>
          ) : null}
          {!loading && error ? (
            <div
              role="option"
              aria-disabled="true"
              aria-selected="false"
              className={styles.status}
            >
              {error}
            </div>
          ) : null}
          {!loading && !error && moreError ? (
            <div
              role="option"
              aria-disabled="true"
              aria-selected="false"
              className={styles.status}
            >
              {moreError}
            </div>
          ) : null}
          {!loading && !error && rows.length === 0 ? (
            <div
              role="option"
              aria-disabled="true"
              aria-selected="false"
              className={styles.status}
            >
              No matching libraries
            </div>
          ) : null}
          {!loading && !error
            ? rows.map((row) => {
                const library = row.kind === "Library" ? row.destination : null;
                return (
                  <div
                    key={row.id}
                    id={optionId(row.id)}
                    role="option"
                    aria-selected={
                      library ? selectedIds.has(library.id) : false
                    }
                    aria-disabled={row.kind === "LoadMore" && loadingMore}
                    className={styles.option}
                    data-active={row.id === activeId || undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => {
                      if (enabled) setActiveId(row.id);
                    }}
                    onClick={() => select(row)}
                  >
                    {row.kind === "Create" ? (
                      <>
                        <Plus size={16} aria-hidden="true" />
                        <span className={styles.optionText}>
                          Create “{row.name}”
                        </span>
                      </>
                    ) : row.kind === "LoadMore" ? (
                      <>
                        <Plus size={16} aria-hidden="true" />
                        <span className={styles.optionText}>
                          {loadingMore
                            ? "Loading more libraries…"
                            : "Load more libraries"}
                        </span>
                      </>
                    ) : (
                      <>
                        <LibraryColorDot
                          color={row.destination.color}
                          size="sm"
                        />
                        <span className={styles.optionText}>
                          {row.destination.name}
                        </span>
                        {selectedIds.has(row.destination.id) ? (
                          <Check size={16} aria-hidden="true" />
                        ) : null}
                      </>
                    )}
                  </div>
                );
              })
            : null}
        </div>
      ) : null}
    </div>
  );
}
