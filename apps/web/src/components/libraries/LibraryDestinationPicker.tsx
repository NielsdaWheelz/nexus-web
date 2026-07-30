"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import LibraryChooser, {
  type LibraryChooserItem,
} from "@/components/libraries/LibraryChooser";
import LibraryChooserSurface from "@/components/libraries/LibraryChooserSurface";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import {
  isLibraryDestinationDefect,
  searchWritableLibraryDestinations,
  type LibraryDestinationSelection,
} from "@/lib/libraries/client";
import {
  isReservedLibraryName,
  RESERVED_LIBRARY_NAME_MESSAGE,
} from "@/lib/libraries/presentation";
import type { ReturnFocusTarget } from "@/lib/ui/useReturnFocus";

const DESTINATION_QUERY_DELAY_MS = 180;
const DESTINATION_PAGE_LIMIT = 25;

export interface LibraryDestinationPickerProps {
  open: boolean;
  onClose: () => void;
  anchor: ReturnFocusTarget;
  layer: "modal" | "palette";
  title: string;
  selectedGroupLabel: string;
  selected: readonly LibraryDestinationSelection[];
  onChange: (next: readonly LibraryDestinationSelection[]) => void;
  interaction:
    | { kind: "Enabled" }
    | { kind: "Disabled" }
    | { kind: "Creating" };
  onCreateDestination: (name: string) => Promise<LibraryDestinationSelection>;
  panelId?: string;
}

function toItem(
  destination: LibraryDestinationSelection,
  selected: boolean,
): LibraryChooserItem {
  return {
    id: destination.id,
    name: destination.name,
    color: destination.color,
    selected,
    interaction: { kind: "Enabled" },
  };
}

/**
 * The writable-destination adapter (docs/cutovers/library-chooser-interaction-
 * hard-cutover.md §4). It owns the server search state (one request generation +
 * abort owner over open/search/Load More), edits a parent-owned local selection,
 * and renders the shared chooser inside the responsive surface. It is always
 * mounted by LibraryDestinationField, so query and last-good results survive a
 * close and reopening re-issues the preserved query immediately.
 */
export default function LibraryDestinationPicker({
  open,
  onClose,
  anchor,
  layer,
  title,
  selectedGroupLabel,
  selected,
  onChange,
  interaction,
  onCreateDestination,
  panelId,
}: LibraryDestinationPickerProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LibraryDestinationSelection[]>([]);
  const [resultsQuery, setResultsQuery] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);

  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const prevOpenRef = useRef(false);
  const prevRetryRef = useRef(retryNonce);
  const normalizedQuery = useMemo(() => query.trim().toLowerCase(), [query]);
  const normalizedQueryRef = useRef(normalizedQuery);
  normalizedQueryRef.current = normalizedQuery;

  const enabled = interaction.kind !== "Disabled";
  const creating = interaction.kind === "Creating";

  useEffect(() => () => abortRef.current?.abort(), []);

  // One request-generation/abort owner over open, search, and Load More. Open,
  // a retry, and an empty query fetch immediately (bypass debounce); a non-empty
  // query change debounces. Closing aborts the read but keeps query + last-good
  // results. Latest generation wins; a stale response cannot commit.
  useEffect(() => {
    const justOpened = open && !prevOpenRef.current;
    prevOpenRef.current = open;
    const forced = retryNonce !== prevRetryRef.current;
    prevRetryRef.current = retryNonce;
    const generation = ++genRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    setLoadingMore(false);
    if (!open || !enabled) return;
    const requestedQuery = normalizedQuery;
    const run = () => {
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);
      setMoreError(null);
      // A new search supersedes any prior page: drop the stale Load More
      // affordance until this response commits its own cursor.
      setNextCursor(null);
      void searchWritableLibraryDestinations({
        q: requestedQuery,
        limit: DESTINATION_PAGE_LIMIT,
        signal: controller.signal,
      })
        .then((page) => {
          if (generation !== genRef.current) return;
          setResults(page.data);
          setResultsQuery(requestedQuery);
          setNextCursor(page.page.next_cursor);
        })
        .catch((caught) => {
          if (controller.signal.aborted || generation !== genRef.current) return;
          if (handleUnauthenticatedApiError(caught)) return;
          if (isLibraryDestinationDefect(caught)) {
            setDefect({ error: caught });
            return;
          }
          setError(
            caught instanceof Error
              ? caught.message
              : "Couldn’t load your libraries.",
          );
          setResults([]);
          setNextCursor(null);
        })
        .finally(() => {
          if (generation === genRef.current) setLoading(false);
        });
    };
    if (justOpened || forced || requestedQuery === "") {
      run();
      return;
    }
    const timer = window.setTimeout(run, DESTINATION_QUERY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [open, normalizedQuery, enabled, retryNonce]);

  async function loadMore() {
    if (loadingMore || nextCursor === null) return;
    const generation = genRef.current;
    const requestedQuery = resultsQuery;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await searchWritableLibraryDestinations({
        q: requestedQuery,
        cursor: nextCursor,
        limit: DESTINATION_PAGE_LIMIT,
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        generation !== genRef.current ||
        requestedQuery !== normalizedQueryRef.current
      ) {
        return;
      }
      setResults((current) => {
        const seen = new Set(current.map((d) => d.id));
        return [...current, ...page.data.filter((d) => !seen.has(d.id))];
      });
      setNextCursor(page.page.next_cursor);
    } catch (caught) {
      if (controller.signal.aborted || generation !== genRef.current) return;
      if (handleUnauthenticatedApiError(caught)) return;
      if (isLibraryDestinationDefect(caught)) {
        setDefect({ error: caught });
        return;
      }
      setMoreError(
        caught instanceof Error
          ? caught.message
          : "Couldn’t load more libraries.",
      );
    } finally {
      if (!controller.signal.aborted && generation === genRef.current) {
        setLoadingMore(false);
      }
    }
  }

  const selectedIds = useMemo(
    () => new Set(selected.map((d) => d.id)),
    [selected],
  );
  const byId = useMemo(() => {
    const map = new Map<string, LibraryDestinationSelection>();
    for (const d of selected) map.set(d.id, d);
    for (const d of results) if (!map.has(d.id)) map.set(d.id, d);
    return map;
  }, [selected, results]);

  function toggle(id: string) {
    if (selectedIds.has(id)) {
      onChange(selected.filter((d) => d.id !== id));
      return;
    }
    const destination = byId.get(id);
    if (destination) onChange([...selected, destination]);
  }

  async function runCreate(name: string) {
    setError(null);
    try {
      const destination = await onCreateDestination(name);
      setResults((current) => [
        destination,
        ...current.filter((d) => d.id !== destination.id),
      ]);
      if (!selectedIds.has(destination.id)) onChange([...selected, destination]);
      setQuery("");
    } catch (caught) {
      if (isAbortError(caught)) return;
      if (handleUnauthenticatedApiError(caught)) return;
      if (isLibraryDestinationDefect(caught)) {
        setDefect({ error: caught });
        return;
      }
      setError(
        caught instanceof Error ? caught.message : "Couldn’t create the library.",
      );
    }
  }

  const createName = query.trim();
  const normalizedCreateName = createName.toLowerCase();
  const createNameReserved =
    createName.length > 0 && isReservedLibraryName(createName);
  const selectedItems = selected.map((d) => toItem(d, true));
  const otherItems = results
    .filter((d) => !selectedIds.has(d.id))
    .map((d) => toItem(d, false));

  const canCreate =
    createName.length > 0 &&
    createName.length <= 100 &&
    !createNameReserved &&
    !loading &&
    !loadingMore &&
    !error &&
    nextCursor === null &&
    resultsQuery === normalizedCreateName &&
    !selected.some(
      (d) => d.name.trim().toLowerCase() === normalizedCreateName,
    ) &&
    !results.some((d) => d.name.trim().toLowerCase() === normalizedCreateName);

  const count = selectedItems.length + otherItems.length;
  const status = creating
    ? "Creating library…"
    : loading
      ? "Loading libraries…"
      : loadingMore
        ? "Loading more libraries…"
        : createNameReserved
          ? RESERVED_LIBRARY_NAME_MESSAGE
          : count === 1
            ? "1 library"
            : `${count} libraries`;

  const emptyState = loading
    ? null
    : createNameReserved
      ? RESERVED_LIBRARY_NAME_MESSAGE
      : count === 0
        ? normalizedQuery === ""
          ? "No libraries yet. Type a name to create one."
          : "No libraries match your search."
        : null;

  const chooserError = error
    ? { message: error, onRetry: () => setRetryNonce((n) => n + 1) }
    : moreError
      ? { message: moreError, onRetry: () => void loadMore() }
      : null;

  if (defect) throw defect.error;

  return (
    <LibraryChooserSurface
      active={open}
      onClose={onClose}
      layer={layer}
      anchor={anchor}
      title={title}
      panelId={panelId}
    >
      <LibraryChooser
        query={query}
        onQueryChange={setQuery}
        searchPlaceholder="Search or create"
        searchLabel="Search or create a library"
        listLabel="Library options"
        selectedGroup={{ label: selectedGroupLabel, items: selectedItems }}
        otherGroup={{ label: "Other libraries", items: otherItems }}
        onToggle={toggle}
        busy={creating}
        loading={loading}
        status={status}
        emptyState={emptyState}
        error={chooserError}
        create={
          canCreate
            ? {
                name: createName,
                pending: creating,
                onCreate: () => void runCreate(createName),
              }
            : null
        }
        loadMore={
          nextCursor !== null
            ? { pending: loadingMore, onLoadMore: () => void loadMore() }
            : null
        }
      />
    </LibraryChooserSurface>
  );
}
