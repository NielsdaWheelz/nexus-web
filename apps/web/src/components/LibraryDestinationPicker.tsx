"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import Input from "@/components/ui/Input";
import LibraryColorDot from "@/components/LibraryColorDot";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  cachedLibraryDestinations,
  createLibrary,
  searchWritableLibraryDestinations,
  type LibraryDestination,
} from "@/lib/libraries/client";
import styles from "./LibraryDestinationPicker.module.css";

interface LibraryDestinationPickerProps {
  selectedLibraryIds: string[];
  onChange(next: string[]): void;
  disabled?: boolean;
  label: string;
  emptySelectionLabel?: string;
  onBusyChange?(busy: boolean): void;
}

type Row =
  | { kind: "library"; id: string; destination: LibraryDestination }
  | { kind: "create"; id: "create"; name: string }
  | { kind: "load-more"; id: "load-more" };

function uniqueDestinations(destinations: LibraryDestination[]) {
  const seen = new Set<string>();
  return destinations.filter((destination) => {
    if (seen.has(destination.id)) return false;
    seen.add(destination.id);
    return true;
  });
}

export default function LibraryDestinationPicker({
  selectedLibraryIds,
  onChange,
  disabled = false,
  label,
  emptySelectionLabel = "My Library only",
  onBusyChange,
}: LibraryDestinationPickerProps) {
  const id = useId();
  const listboxId = `${id}-listbox`;
  const optionId = (rowId: string) => `${id}-option-${rowId}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const composingRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const normalizedQuery = useMemo(() => query.trim().toLowerCase(), [query]);
  const normalizedQueryRef = useRef(normalizedQuery);
  normalizedQueryRef.current = normalizedQuery;
  const [results, setResults] = useState<LibraryDestination[]>([]);
  const [resultsQuery, setResultsQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    onBusyChange?.(creating || loadingMore);
  }, [creating, loadingMore, onBusyChange]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => () => loadMoreAbortRef.current?.abort(), []);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = null;
    setLoadingMore(false);
    if (!open || disabled) return;
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
        .catch((err) => {
          if (controller.signal.aborted || requestId !== requestIdRef.current) return;
          if (handleUnauthenticatedApiError(err)) return;
          setError(err instanceof Error ? err.message : "Could not load libraries");
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
  }, [disabled, normalizedQuery, open]);

  async function loadMoreResults() {
    if (disabled || loadingMore || nextCursor === null) return;
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
    } catch (err) {
      if (controller.signal.aborted || requestId !== requestIdRef.current) return;
      if (handleUnauthenticatedApiError(err)) return;
      setMoreError(err instanceof Error ? err.message : "Could not load more libraries");
    } finally {
      if (!controller.signal.aborted && requestId === requestIdRef.current) {
        setLoadingMore(false);
      }
    }
  }

  const selectedIds = useMemo(() => new Set(selectedLibraryIds), [selectedLibraryIds]);
  const resultById = useMemo(
    () => new Map(results.map((destination) => [destination.id, destination])),
    [results],
  );
  const selectedRows = useMemo(
    () => {
      const cachedById = new Map(
        cachedLibraryDestinations(selectedLibraryIds).map((destination) => [
          destination.id,
          destination,
        ]),
      );
      return selectedLibraryIds.map(
        (libraryId) =>
          cachedById.get(libraryId) ??
          resultById.get(libraryId) ?? {
            id: libraryId,
            name: "Selected library",
            color: null,
            created_at: "",
            updated_at: "",
          },
      );
    },
    [resultById, selectedLibraryIds],
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
      (destination) => destination.name.trim().toLowerCase() === normalizedCreateName,
    );
  const rows = useMemo<Row[]>(
    () => [
      ...uniqueDestinations([...selectedRows, ...results]).map(
        (destination): Row => ({
          kind: "library",
          id: destination.id,
          destination,
        }),
      ),
      ...(canCreate
        ? [{ kind: "create" as const, id: "create" as const, name: createName }]
        : []),
      ...(nextCursor !== null
        ? [{ kind: "load-more" as const, id: "load-more" as const }]
        : []),
    ],
    [canCreate, createName, nextCursor, results, selectedRows],
  );

  useEffect(() => {
    if (!open) return;
    if (rows.length === 0) {
      setActiveId(null);
      return;
    }
    if (!activeId || !rows.some((row) => row.id === activeId)) {
      setActiveId(rows[0]!.id);
    }
  }, [activeId, open, rows]);

  function toggle(libraryId: string) {
    if (disabled) return;
    if (selectedIds.has(libraryId)) {
      onChange(selectedLibraryIds.filter((id) => id !== libraryId));
      return;
    }
    onChange([...selectedLibraryIds, libraryId]);
  }

  async function runCreate(name: string) {
    if (disabled || creating) return;
    setCreating(true);
    try {
      const destination = await createLibrary({ name });
      setResults((current) => uniqueDestinations([destination, ...current]));
      if (!selectedLibraryIds.includes(destination.id)) {
        onChange([...selectedLibraryIds, destination.id]);
      }
      setQuery("");
      setOpen(true);
      setActiveId(destination.id);
      inputRef.current?.focus();
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      setError(err instanceof Error ? err.message : "Could not create library");
    } finally {
      setCreating(false);
    }
  }

  function select(row: Row) {
    if (disabled) return;
    if (row.kind === "create") {
      void runCreate(row.name);
      return;
    }
    if (row.kind === "load-more") {
      void loadMoreResults();
      return;
    }
    toggle(row.destination.id);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (composingRef.current) return;
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      event.preventDefault();
      setOpen(true);
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
      const row = rows.find((candidate) => candidate.id === activeId) ?? rows[0];
      if (row) {
        event.preventDefault();
        select(row);
      }
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
      } else if (query) {
        event.preventDefault();
        setQuery("");
      }
    }
  }

  const status = loading
    ? "Loading libraries"
    : loadingMore
      ? "Loading more libraries"
    : error
      ? error
      : moreError
        ? moreError
      : rows.length === 0
        ? "No matching libraries"
        : `${rows.length} library options`;

  return (
    <div className={styles.root}>
      <label className={styles.label} htmlFor={`${id}-input`}>
        {label}
      </label>
      <div className={styles.control} data-disabled={disabled || undefined}>
        <div className={styles.chips}>
          {selectedRows.length === 0 ? (
            <span className={styles.empty}>{emptySelectionLabel}</span>
          ) : (
            selectedRows.map((destination) => (
              <span key={destination.id} className={styles.chip}>
                <LibraryColorDot color={destination.color} size="sm" />
                <span className={styles.chipText}>{destination.name}</span>
                <button
                  type="button"
                  className={styles.remove}
                  aria-label={`Remove ${destination.name}`}
                  disabled={disabled}
                  onClick={() => toggle(destination.id)}
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
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={open && activeId ? optionId(activeId) : undefined}
          disabled={disabled}
          value={query}
          placeholder="Search or create"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={() => {
            if (disabled) return;
            setOpen(true);
          }}
          onChange={(event) => {
            if (disabled) return;
            setQuery(event.target.value);
            setOpen(true);
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
      <div className="sr-only" role="status" aria-live="polite">
        {status}
      </div>
      {open ? (
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
            ? rows.map((row) =>
                row.kind === "create" ? (
                  <div
                    key={row.id}
                    id={optionId(row.id)}
                    role="option"
                    aria-selected={false}
                    className={styles.option}
                    data-active={row.id === activeId || undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => {
                      if (!disabled) setActiveId(row.id);
                    }}
                    onClick={() => select(row)}
                  >
                    <Plus size={16} aria-hidden="true" />
                    <span className={styles.optionText}>Create “{row.name}”</span>
                  </div>
                ) : row.kind === "load-more" ? (
                  <div
                    key={row.id}
                    id={optionId(row.id)}
                    role="option"
                    aria-selected={false}
                    aria-disabled={loadingMore}
                    className={styles.option}
                    data-active={row.id === activeId || undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => {
                      if (!disabled) setActiveId(row.id);
                    }}
                    onClick={() => select(row)}
                  >
                    <Plus size={16} aria-hidden="true" />
                    <span className={styles.optionText}>
                      {loadingMore ? "Loading more libraries..." : "Load more libraries"}
                    </span>
                  </div>
                ) : (
                  <div
                    key={row.id}
                    id={optionId(row.id)}
                    role="option"
                    aria-selected={selectedIds.has(row.destination.id)}
                    className={styles.option}
                    data-active={row.id === activeId || undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => {
                      if (!disabled) setActiveId(row.id);
                    }}
                    onClick={() => select(row)}
                  >
                    <LibraryColorDot color={row.destination.color} size="sm" />
                    <span className={styles.optionText}>{row.destination.name}</span>
                    {selectedIds.has(row.destination.id) ? (
                      <Check size={16} aria-hidden="true" />
                    ) : null}
                  </div>
                ),
              )
            : null}
        </div>
      ) : null}
    </div>
  );
}
