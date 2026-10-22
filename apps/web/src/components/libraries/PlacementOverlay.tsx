"use client";

import { FeedbackNotice } from "@/components/feedback/Feedback";
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
  return <PickerSurface
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
    {session ? <PlacementEditor key={session.key} targets={session.targets} /> : null}
  </PickerSurface>;
}

export function PlacementEditor({ targets }: { readonly targets: readonly LibraryPlacementTarget[] }) {
  const view = useLibraryPlacements(targets);
  return <>
    {view.conflicts.map(conflict => <FeedbackNotice
      key={conflict.key}
      content={{ tone: "Warning", title: "replace filed episodes?", message: `${conflict.name} already files episodes from this show. Adding the show replaces those entries; the episodes stay in All.` }}
      announcement="Assertive"
      actions={[{ label: "add the show", onClick: conflict.confirm }, { label: "cancel", onClick: conflict.cancel }]}
    />)}
    <LibraryChooser
      context={JSON.stringify(targets.map(target => `${target.kind}:${target.id}`).toSorted())}
      membershipKind="Confirmed"
      rows={view.items}
      onToggle={view.onToggle}
      loading={view.loading}
      summary={targets.length > 1 ? `applies to ${targets.length} items · ${view.summary}` : null}
      status={view.status}
      error={view.error}
      create={{ available: view.creationAvailable, pendingNames: view.pendingNames, onCreate: view.onCreate }}
      empty="no libraries match"
    />
  </>;
}
