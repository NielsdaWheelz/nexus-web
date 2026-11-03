"use client";

import LibraryChooser from "@/components/libraries/LibraryChooser";
import type { LibraryPlacementTarget } from "@/lib/libraries/api";
import { useLibraryPlacements } from "@/lib/libraries/placementController";

export default function PlacementEditor({ targets }: { readonly targets: readonly LibraryPlacementTarget[] }) {
  const view = useLibraryPlacements(targets);
  return <>
    <LibraryChooser
      context={JSON.stringify(targets.map(target => `${target.kind}:${target.id}`).toSorted())}
      membershipKind="Confirmed"
      rows={view.items}
      onToggle={view.onToggle}
      loading={view.loading}
      summary={targets.length > 1 ? `applies to ${targets.length} items · ${view.summary}` : null}
      error={view.error}
      create={{ available: view.creationAvailable, pendingNames: view.pendingNames, onCreate: view.onCreate }}
      empty="no libraries match"
    />
  </>;
}
