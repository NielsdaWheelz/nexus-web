"use client";

import { useEffect } from "react";
import LibraryChooserSurface from "@/components/libraries/LibraryChooserSurface";
import LibraryEntryEditor from "@/components/libraries/LibraryEntryEditor";
import type { LibraryPlacementSession } from "@/lib/libraries/placementController";
import { useLibraryPlacement } from "@/lib/libraries/useLibraryPlacement";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useMobileChromeVisibleLocks } from "@/lib/workspace/mobileChrome";

interface LibraryPlacementOverlayProps {
  session: LibraryPlacementSession | null;
  onClose: () => void;
}

function MobileChromeLock() {
  const { acquire } = useMobileChromeVisibleLocks();
  useEffect(() => acquire("library-picker"), [acquire]);
  return null;
}

export default function LibraryPlacementOverlay({
  session,
  onClose,
}: LibraryPlacementOverlayProps) {
  const isMobile = useIsMobileViewport();
  const state = useLibraryPlacement(session);
  const active = session !== null;
  const fallback = session?.options.returnFocusFallback;
  const error =
    state.failure === null
      ? null
      : state.failure.kind === "Retry"
        ? { content: state.failure.content, onRetry: state.failure.retry }
        : { content: state.failure.content, onRetry: null };

  return (
    <>
      {active && isMobile ? <MobileChromeLock /> : null}
      <LibraryChooserSurface
        active={active}
        onClose={onClose}
        layer="modal"
        anchor={session ? session.options.anchor : () => null}
        returnFocusFallback={
          fallback && fallback.kind === "Present" ? fallback.value : undefined
        }
        title="Libraries"
        focusKey={session?.key}
        panelTestId="library-placement-sheet"
      >
        {session ? (
          <LibraryEntryEditor
            key={session.key}
            placements={state.placements}
            loading={state.loading}
            busy={state.commandsDisabled}
            creating={state.creating}
            pendingDestinationKey={state.pendingDestinationKey}
            error={error}
            onToggle={state.toggle}
            onCreateLibrary={state.createLibraryAndAdd}
            selectedGroupLabel="In these libraries"
            otherGroupLabel="Other libraries"
            searchLabel="Search or create a library"
            searchPlaceholder="Search or create"
            listLabel="Library options"
            emptyInventory="No libraries yet. Type a name to create one."
          />
        ) : null}
      </LibraryChooserSurface>
    </>
  );
}
