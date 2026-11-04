"use client";

import { useRef, type RefObject } from "react";
import PickerSurface from "@/components/ui/PickerSurface";
import LibraryChooser from "@/components/libraries/LibraryChooser";
import type { LibraryPlacementTarget } from "@/lib/libraries/api";
import { useLibraryPlacements, type LibraryPlacementSession } from "@/lib/libraries/placementController";
import { useMobileChromeHold } from "@/lib/mobileShell/chrome";

export default function PlacementOverlay({
  session, onClose, inline, panelId, skipReturnFocus,
}: {
  readonly session: LibraryPlacementSession | null;
  readonly onClose: () => void;
  readonly inline?: boolean;
  readonly panelId?: string;
  readonly skipReturnFocus?: () => boolean;
}) {
  useMobileChromeHold(session !== null);
  const slipContent = useRef<HTMLDivElement>(null);
  return <PickerSurface
    slipContent={slipContent}
    active={session !== null}
    inline={inline}
    onClose={onClose}
    anchor={session?.options.anchor ?? (() => null)}
    returnFocusFallback={session?.options.returnFocusFallback ?? undefined}
    skipReturnFocus={skipReturnFocus}
    title="libraries"
    focusKey={session?.key}
    panelId={panelId}
  >
    {session ? <PlacementEditor scrollRef={slipContent} key={session.key} targets={session.targets} /> : null}
  </PickerSurface>;
}

export function PlacementEditor({ targets, scrollRef }: { readonly targets: readonly LibraryPlacementTarget[]; readonly scrollRef?: RefObject<HTMLDivElement | null> }) {
  const view = useLibraryPlacements(targets);
  return <>
    <LibraryChooser
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
    />
  </>;
}
