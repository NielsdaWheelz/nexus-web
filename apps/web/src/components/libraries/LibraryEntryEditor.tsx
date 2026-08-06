"use client";

import { useMemo, useState } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import LibraryChooser, {
  type LibraryChooserItem,
} from "@/components/libraries/LibraryChooser";
import {
  libraryPlacementDestinationKey,
  type LibraryPlacementBlockedReason,
  type LibraryPlacementDestination,
  type LibraryPlacementDestinationKey,
  type LibraryPlacementOption,
} from "@/lib/libraries/libraryPlacement";
import {
  isReservedLibraryName,
  RESERVED_LIBRARY_NAME_MESSAGE,
} from "@/lib/libraries/presentation";

export interface LibraryEntryEditorProps {
  placements: readonly LibraryPlacementOption[];
  loading: boolean;
  busy: boolean;
  creating: boolean;
  pendingDestinationKey: LibraryPlacementDestinationKey | null;
  error: { content: FeedbackContent; onRetry: (() => void) | null } | null;
  onToggle: (destination: LibraryPlacementDestination) => void;
  onCreateLibrary: ((name: string) => void) | null;
  selectedGroupLabel: string;
  otherGroupLabel: string;
  searchLabel: string;
  searchPlaceholder: string;
  listLabel: string;
  emptyInventory: string;
}

function destinationPresentation(destination: LibraryPlacementDestination) {
  return destination.kind === "SavedInNexus"
    ? { name: "Saved in Nexus", color: null }
    : {
        name: destination.library.name,
        color: destination.library.color,
      };
}

function blockedReason(reason: LibraryPlacementBlockedReason): string {
  switch (reason) {
    case "RequiresAdmin":
      return "Only a library admin can change this placement.";
    case "RequiresSubscription":
      return "Subscribe to this podcast before adding it to a library.";
    case "SystemManaged":
      return "This system library is managed automatically.";
    case "Inherited":
      return "This placement is inherited from another library.";
  }
}

function placementDescription(option: LibraryPlacementOption): string | undefined {
  const provenance =
    option.relation.kind === "Inherited"
      ? `Inherited from ${option.relation.provenance.map(({ name }) => name).join(", ")}`
      : null;
  const reason =
    option.availability.kind === "Blocked"
      ? blockedReason(option.availability.reason)
      : null;
  if (provenance && reason) return `${provenance} · ${reason}`;
  return provenance ?? reason ?? undefined;
}

/**
 * Pure adapter from the canonical placement contract to the shared chooser.
 * Fetching, commands, and reconciliation remain owned by useLibraryPlacement.
 */
export default function LibraryEntryEditor({
  placements,
  loading,
  busy,
  creating,
  pendingDestinationKey,
  error,
  onToggle,
  onCreateLibrary,
  selectedGroupLabel,
  otherGroupLabel,
  searchLabel,
  searchPlaceholder,
  listLabel,
  emptyInventory,
}: LibraryEntryEditorProps) {
  const [query, setQuery] = useState("");

  const { selectedItems, otherItems } = useMemo(() => {
    const toItem = (option: LibraryPlacementOption): LibraryChooserItem => {
      const key = libraryPlacementDestinationKey(option.destination);
      const presentation = destinationPresentation(option.destination);
      const interaction: LibraryChooserItem["interaction"] =
        pendingDestinationKey === key
          ? { kind: "Pending" }
          : option.availability.kind === "Available"
            ? { kind: "Enabled" }
            : {
                kind: "ReadOnly",
                reason: blockedReason(option.availability.reason),
              };
      return {
        id: key,
        name: presentation.name,
        color: presentation.color,
        description: placementDescription(option),
        selected: option.relation.kind !== "Absent",
        interaction,
      };
    };

    const normalizedQuery = query.trim().toLocaleLowerCase();
    const selected: LibraryChooserItem[] = [];
    const other: LibraryChooserItem[] = [];
    for (const option of placements) {
      const item = toItem(option);
      // Existing relations stay visible while searching so a user never loses
      // the context or removal control they opened the editor to manage.
      if (item.selected) {
        selected.push(item);
      } else if (
        normalizedQuery === "" ||
        item.name.toLocaleLowerCase().includes(normalizedQuery)
      ) {
        other.push(item);
      }
    }
    return { selectedItems: selected, otherItems: other };
  }, [placements, query, pendingDestinationKey]);

  const byKey = useMemo(
    () =>
      new Map(
        placements.map((option) => [
          libraryPlacementDestinationKey(option.destination),
          option,
        ]),
      ),
    [placements],
  );
  const createName = query.trim();
  const normalizedCreateName = createName.toLocaleLowerCase();
  const createNameReserved =
    createName.length > 0 && isReservedLibraryName(createName);
  const duplicateName = placements.some((option) => {
    if (option.destination.kind !== "Library") return false;
    return (
      option.destination.library.name.trim().toLocaleLowerCase() ===
      normalizedCreateName
    );
  });
  const canCreate =
    createName.length > 0 &&
    createName.length <= 100 &&
    !createNameReserved &&
    !duplicateName &&
    !loading &&
    onCreateLibrary !== null &&
    error === null;

  const status = creating
    ? "Creating library…"
    : loading && placements.length === 0
      ? "Loading libraries…"
      : busy || loading
        ? "Updating libraries…"
        : createNameReserved
          ? RESERVED_LIBRARY_NAME_MESSAGE
          : placements.length === 1
            ? "1 destination"
            : `${placements.length} destinations`;

  const emptyState =
    selectedItems.length === 0 && otherItems.length === 0
      ? createNameReserved
        ? RESERVED_LIBRARY_NAME_MESSAGE
        : placements.length === 0 && query.trim() === ""
          ? emptyInventory
          : "No libraries match your search."
      : null;

  return (
    <LibraryChooser
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder={searchPlaceholder}
      searchLabel={searchLabel}
      listLabel={listLabel}
      selectedGroup={{ label: selectedGroupLabel, items: selectedItems }}
      otherGroup={{ label: otherGroupLabel, items: otherItems }}
      onToggle={(key) => {
        const option = byKey.get(key as LibraryPlacementDestinationKey);
        if (option) onToggle(option.destination);
      }}
      busy={busy}
      loading={loading}
      status={status}
      emptyState={emptyState}
      error={error}
      create={
        canCreate
          ? {
              name: createName,
              pending: creating,
              onCreate: () => onCreateLibrary?.(createName),
            }
          : null
      }
      loadMore={null}
    />
  );
}
