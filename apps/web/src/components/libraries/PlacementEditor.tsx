"use client";

import type { RefObject } from "react";
import LibraryChooser from "@/components/libraries/LibraryChooser";
import type { LibraryPlacementTarget } from "@/lib/libraries/api";
import { useLibraryPlacements } from "@/lib/libraries/placementController";

export default function PlacementEditor({ targets, scrollRef }: { readonly targets: readonly LibraryPlacementTarget[]; readonly scrollRef?: RefObject<HTMLDivElement | null> }) {
  const view = useLibraryPlacements(targets);
  return <LibraryChooser
    scrollRef={scrollRef}
    context={JSON.stringify(targets.map(target => `${target.kind}:${target.id}`).toSorted())}
    membershipKind="Confirmed"
    rows={view.items}
    onToggle={view.onToggle}
    loading={view.loading}
    summary={targets.length > 1 ? `applies to ${targets.length} items${view.summary === null ? "" : ` · ${view.summary}`}` : null}
    failure={view.failure}
    create={{ available: view.creationAvailable, pendingNames: view.pendingNames, onCreate: view.onCreate }}
    empty="no libraries yet."
  />;
}
