"use client";

import { useMemo, useState } from "react";
import LibraryChooser, {
  type LibraryChooserItem,
} from "@/components/libraries/LibraryChooser";
import LibraryChooserSurface from "@/components/libraries/LibraryChooserSurface";
import { useLibraryDestinationSearch } from "@/components/libraries/useLibraryDestinationSearch";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import {
  isLibraryDestinationDefect,
  searchWritableLibraryDestinations,
} from "@/lib/libraries/client";
import type { LibraryDestinationSelection } from "@/lib/libraries/destinationContract";
import {
  isReservedLibraryName,
  RESERVED_LIBRARY_NAME_MESSAGE,
} from "@/lib/libraries/presentation";
import type { ReturnFocusTarget } from "@/lib/ui/useReturnFocus";

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
    selected,
    interaction: { kind: "Enabled" },
  };
}

/**
 * The writable-destination adapter (docs/cutovers/library-chooser-interaction-
 * hard-cutover.md §4). It runs the shared destination search over the web
 * transport, edits a parent-owned local selection, offers create, and renders
 * the shared chooser inside the responsive surface. It is always mounted by
 * LibraryDestinationField, so query and last-good results survive a close and
 * reopening re-issues the preserved query immediately.
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
  const [createError, setCreateError] = useState<string | null>(null);
  const [createDefect, setCreateDefect] = useState<{ error: unknown } | null>(
    null,
  );
  const enabled = interaction.kind !== "Disabled";
  const creating = interaction.kind === "Creating";
  const {
    query,
    setQuery,
    normalizedQuery,
    results,
    resultsQuery,
    nextCursor,
    loading,
    loadingMore,
    failure,
    retry,
    loadMore,
  } = useLibraryDestinationSearch<unknown>({
    active: open && enabled,
    search: ({ q, cursor, signal }) =>
      searchWritableLibraryDestinations({
        q,
        cursor,
        limit: DESTINATION_PAGE_LIMIT,
        signal,
      }).then(
        (page) => ({ kind: "page" as const, page }),
        (caught: unknown) =>
          handleUnauthenticatedApiError(caught)
            ? { kind: "handled" as const }
            : { kind: "failure" as const, failure: caught },
      ),
  });

  const selectedIds = useMemo(
    () => new Set(selected.map((d) => d.id)),
    [selected],
  );

  function toggle(id: string) {
    if (selectedIds.has(id)) {
      onChange(selected.filter((d) => d.id !== id));
      return;
    }
    const destination = results.find((d) => d.id === id);
    if (destination) onChange([...selected, destination]);
  }

  async function runCreate(name: string) {
    setCreateError(null);
    try {
      const destination = await onCreateDestination(name);
      if (!selectedIds.has(destination.id)) onChange([...selected, destination]);
      setQuery("");
    } catch (caught) {
      if (isAbortError(caught)) return;
      if (handleUnauthenticatedApiError(caught)) return;
      if (isLibraryDestinationDefect(caught)) {
        setCreateDefect({ error: caught });
        return;
      }
      setCreateError(
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
    failure === null &&
    createError === null &&
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

  const chooserError =
    failure !== null
      ? {
          content: {
            tone: "Danger" as const,
            title:
              failure instanceof Error
                ? failure.message
                : "Couldn’t load your libraries.",
          },
          onRetry: retry,
        }
      : createError !== null
        ? {
            content: { tone: "Danger" as const, title: createError },
            onRetry: () => {
              setCreateError(null);
              retry();
            },
          }
        : null;

  if (failure !== null && isLibraryDestinationDefect(failure)) throw failure;
  if (createDefect) throw createDefect.error;

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
            ? { pending: loadingMore, onLoadMore: loadMore }
            : null
        }
      />
    </LibraryChooserSurface>
  );
}
