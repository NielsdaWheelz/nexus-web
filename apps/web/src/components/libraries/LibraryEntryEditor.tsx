"use client";

import { useMemo, useState } from "react";
import LibraryChooser, {
  type LibraryChooserItem,
} from "@/components/libraries/LibraryChooser";
import type { LibraryPlacementOption } from "@/lib/libraries/libraryPlacement";

const READ_ONLY_REASON =
  "Only this library’s owners and editors can change what’s in it.";

export interface LibraryEntryEditorProps {
  libraries: readonly LibraryPlacementOption[];
  /** A read is in flight → chooser `loading`. */
  loading: boolean;
  /** Commands disabled → chooser `busy`. */
  busy: boolean;
  pendingLibraryId: string | null;
  error: { message: string; onRetry: (() => void) | null } | null;
  onAddToLibrary: (libraryId: string) => void;
  onRemoveFromLibrary: (libraryId: string) => void;
  selectedGroupLabel: string;
  otherGroupLabel: string;
  searchLabel: string;
  searchPlaceholder: string;
  listLabel: string;
  emptyInventory: string;
}

/**
 * The shared placement adapter (docs/cutovers/library-chooser-interaction-hard-
 * cutover.md §2): it owns the search query for client-side substring filtering of
 * the complete inventory, projects LibraryPlacementOption[] into chooser groups,
 * and renders LibraryChooser. It neither fetches nor mutates — those belong to
 * useLibraryPlacement and the caller.
 */
export default function LibraryEntryEditor({
  libraries,
  loading,
  busy,
  pendingLibraryId,
  error,
  onAddToLibrary,
  onRemoveFromLibrary,
  selectedGroupLabel,
  otherGroupLabel,
  searchLabel,
  searchPlaceholder,
  listLabel,
  emptyInventory,
}: LibraryEntryEditorProps) {
  const [query, setQuery] = useState("");

  const { selectedItems, otherItems } = useMemo(() => {
    const toItem = (library: LibraryPlacementOption): LibraryChooserItem => {
      const actionable = library.isInLibrary
        ? library.canRemove
        : library.canAdd;
      const interaction: LibraryChooserItem["interaction"] =
        pendingLibraryId === library.id
          ? { kind: "Pending" }
          : actionable
            ? { kind: "Enabled" }
            : { kind: "ReadOnly", reason: READ_ONLY_REASON };
      return {
        id: library.id,
        name: library.name,
        color: library.color,
        selected: library.isInLibrary,
        interaction,
      };
    };

    const q = query.trim().toLocaleLowerCase();
    const selected: LibraryChooserItem[] = [];
    const other: LibraryChooserItem[] = [];
    for (const library of libraries) {
      // Selected rows are always visible; only the other group is filtered.
      if (library.isInLibrary) {
        selected.push(toItem(library));
      } else if (q === "" || library.name.toLocaleLowerCase().includes(q)) {
        other.push(toItem(library));
      }
    }
    return { selectedItems: selected, otherItems: other };
  }, [libraries, query, pendingLibraryId]);

  const status =
    loading && libraries.length === 0
      ? "Loading libraries…"
      : busy || loading
        ? "Updating libraries…"
        : libraries.length === 1
          ? "1 library"
          : `${libraries.length} libraries`;

  const emptyState =
    selectedItems.length === 0 && otherItems.length === 0
      ? libraries.length === 0
        ? emptyInventory
        : "No libraries match your search."
      : null;

  function onToggle(id: string) {
    const library = libraries.find((candidate) => candidate.id === id);
    if (!library) return;
    if (library.isInLibrary) onRemoveFromLibrary(id);
    else onAddToLibrary(id);
  }

  return (
    <LibraryChooser
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder={searchPlaceholder}
      searchLabel={searchLabel}
      listLabel={listLabel}
      selectedGroup={{ label: selectedGroupLabel, items: selectedItems }}
      otherGroup={{ label: otherGroupLabel, items: otherItems }}
      onToggle={onToggle}
      busy={busy}
      loading={loading}
      status={status}
      emptyState={emptyState}
      error={error}
      create={null}
      loadMore={null}
    />
  );
}
