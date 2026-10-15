"use client";

import { useMemo } from "react";
import LibraryChooser from "@/components/libraries/LibraryChooser";
import LibraryChooserSurface from "@/components/libraries/LibraryChooserSurface";
import { useLibraryPlacements, type LibraryPlacementSession } from "@/lib/libraries/placementController";
import { useMobileChromeHold } from "@/lib/mobileShell/chrome";

export default function LibraryPlacementOverlay({ session, onClose }: {
  session: LibraryPlacementSession | null;
  onClose: () => void;
}) {
  useMobileChromeHold(session !== null);
  const fallback = session?.options.returnFocusFallback;
  return (
    <LibraryChooserSurface
      active={session !== null}
      presentation="Responsive"
      onClose={onClose}
      anchor={session ? session.options.anchor : () => null}
      returnFocusFallback={fallback?.kind === "Present" ? fallback.value : undefined}
      title="libraries"
      focusKey={session?.key}
    >
      {session ? <PlacementEditor key={session.key} session={session} /> : null}
    </LibraryChooserSurface>
  );
}

function PlacementEditor({ session }: { session: LibraryPlacementSession }) {
  const targets = useMemo(() => [session.target], [session.target]);
  const view = useLibraryPlacements(targets);
  return (
    <LibraryChooser
      items={view.items}
      loading={view.loading}
      summary={view.summary}
      error={view.error}
      status={view.status}
      onCommit={view.onCommit}
      creation={{ available: view.creationAvailable, pendingNames: view.pendingNames, onCreate: view.onCreate }}
      emptyInventory="no libraries yet. type a name to create one."
    />
  );
}
