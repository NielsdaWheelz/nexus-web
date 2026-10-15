"use client";

import { useCallback } from "react";
import LibraryChooser, {
  type LibraryChooserAdmission,
  type LibraryChooserError,
  type LibraryChooserItem,
} from "@/components/libraries/LibraryChooser";
import LibraryChooserSurface from "@/components/libraries/LibraryChooserSurface";
import {
  useLibraryDestinationCatalog,
  type LibraryDestinationCatalogResult,
} from "@/components/libraries/useLibraryDestinationCatalog";
import { useChangeStamp } from "@/lib/api/changes";
import { isUnauthenticatedApiError } from "@/lib/api/client";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isLibraryDestinationDefect, listWritableLibraryDestinations } from "@/lib/libraries/client";
import type { LibraryDestinationSelection } from "@/lib/libraries/destinationContract";
import { libraryRequestErrorMessage } from "@/lib/libraries/libraryRequestErrorMessage";
import { compareLibraryNames } from "@/lib/libraries/presentation";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";

export type DestinationChange = { destination: LibraryDestinationSelection; included: boolean };
export type DestinationSelection = (
  | { kind: "Item"; selected: readonly LibraryDestinationSelection[] }
  | {
      kind: "Bulk";
      total: number;
      entries: readonly { destination: LibraryDestinationSelection; included: number }[];
    }
) & { onSet: (change: DestinationChange) => LibraryChooserAdmission };

export interface LibraryDestinationPickerProps {
  open: boolean;
  presentation: "Responsive" | "Inline";
  onClose: () => void;
  anchor: ReturnFocusTarget;
  skipReturnFocus?: () => boolean;
  title: string;
  selection: DestinationSelection;
  interaction: { kind: "Enabled" } | { kind: "Disabled" };
  onCreateDestination: (name: string) => LibraryChooserAdmission;
  pendingCreateNames: readonly string[];
  error?: LibraryChooserError | null;
  status?: string;
  panelId?: string;
}

/** Draft selection is a delta against form-owned state; creation has that same
 * form lifetime. Closing this surface never cancels accepted work. */
export default function LibraryDestinationPicker({
  open,
  presentation,
  onClose,
  anchor,
  skipReturnFocus,
  title,
  selection,
  interaction,
  onCreateDestination,
  pendingCreateNames,
  error = null,
  status,
  panelId,
}: LibraryDestinationPickerProps) {
  const handleUnauthenticatedApiError = useUnauthenticatedApiHandler();
  const readDestinations = useCallback(async ({ signal }: { signal: AbortSignal }): Promise<LibraryDestinationCatalogResult<unknown>> => {
    try {
      return { kind: "catalog", destinations: await listWritableLibraryDestinations({ signal }) };
    } catch (error) {
      return handleUnauthenticatedApiError(error)
        ? { kind: "handled" } : { kind: "failure", failure: error };
    }
  }, [handleUnauthenticatedApiError]);
  const changeStamp = useChangeStamp("Libraries");
  const catalog = useLibraryDestinationCatalog({ active: open, changeStamp, read: readDestinations });
  const selected = selection.kind === "Item"
    ? selection.selected.map((destination) => ({ destination, included: 1 }))
    : selection.entries;
  const total = selection.kind === "Item" ? 1 : selection.total;
  const coverage = new Map(selected.map((entry) => [entry.destination.id, entry.included]));
  const available = new Set(catalog.destinations?.map(({ id }) => id));
  const destinations = new Map(catalog.destinations?.map((destination) => [destination.id, destination]));
  // Missing selected ids remain removable after an authoritative catalog read.
  if (catalog.destinations !== null) {
    for (const { destination } of selected) {
      if (!destinations.has(destination.id)) destinations.set(destination.id, destination);
    }
  }
  const items: LibraryChooserItem[] = [...destinations.values()].map((destination) => {
    const included = coverage.get(destination.id) ?? 0;
    const nextIncluded = available.has(destination.id) && included < total;
    const membership = { included, total };
    return {
      ...destination,
      ...(!available.has(destination.id) ? { note: "unavailable" } : {}),
      confirmed: membership,
      intended: membership,
      progress: "Settled",
      exclusions: [],
      provenance: [],
      action: interaction.kind === "Disabled"
        ? { kind: "Blocked", reason: "library choices cannot be changed right now" }
        : total === 0
          ? { kind: "Blocked", reason: "no editable items" }
          : { kind: "Set", included: nextIncluded, targetCount: nextIncluded ? total - included : included },
    };
  });
  if (catalog.failure !== null && isLibraryDestinationDefect(catalog.failure)) throw catalog.failure;
  const catalogError = catalog.failure === null ? null : {
    content: libraryRequestErrorMessage(catalog.failure, {
      title: catalog.destinations === null ? "couldn’t load libraries" : "couldn’t refresh libraries",
      request: "LibraryCollectionRead",
    }),
    onRetry: isUnauthenticatedApiError(catalog.failure) ? null : catalog.retry,
  };
  const names = selected.map(({ destination }) => destination).toSorted(compareLibraryNames).map(({ name }) => name);

  return (
    <LibraryChooserSurface active={open} presentation={presentation} onClose={onClose}
      anchor={anchor} skipReturnFocus={skipReturnFocus} title={title} panelId={panelId}>
      <LibraryChooser
        items={items}
        onCommit={({ choiceId, included }) => {
          const destination = destinations.get(choiceId);
          if (!destination || interaction.kind === "Disabled") return "Rejected";
          if (included && !available.has(choiceId)) return "Rejected";
          return selection.onSet({ destination, included });
        }}
        loading={catalog.loading}
        summary={selection.kind === "Bulk"
          ? `libraries for ${total} items · selected libraries: ${names.join(", ") || "none"}`
          : `selected libraries: ${names.join(", ") || "none"}`}
        error={error ?? catalogError}
        status={status}
        creation={{
          available: catalog.ready && interaction.kind === "Enabled" && total > 0,
          pendingNames: pendingCreateNames,
          onCreate: onCreateDestination,
        }}
        emptyInventory="no libraries yet. type a name to create one."
      />
    </LibraryChooserSurface>
  );
}
