"use client";

import { useEffect } from "react";
import LibraryChooserSurface from "@/components/libraries/LibraryChooserSurface";
import LibraryEntryEditor from "@/components/libraries/LibraryEntryEditor";
import type { LibraryPlacementSession } from "@/lib/libraries/placementController";
import { useLibraryPlacement } from "@/lib/libraries/useLibraryPlacement";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { usePaneMobileChromeController } from "@/lib/workspace/mobileChrome";

interface LibraryPlacementOverlayProps {
  session: LibraryPlacementSession | null;
  onClose: () => void;
}

function MobileChromeLock() {
  const { acquireVisibleLock } = usePaneMobileChromeController();
  useEffect(() => acquireVisibleLock("library-picker"), [acquireVisibleLock]);
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
        ? { message: state.failure.message, onRetry: state.failure.retry }
        : { message: state.failure.message, onRetry: null };

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
            libraries={state.libraries}
            loading={state.loading}
            busy={state.commandsDisabled}
            pendingLibraryId={state.pendingLibraryId}
            error={error}
            onAddToLibrary={state.addToLibrary}
            onRemoveFromLibrary={state.removeFromLibrary}
            selectedGroupLabel="In these libraries"
            otherGroupLabel="Other libraries"
            searchLabel="Search libraries"
            searchPlaceholder="Search libraries"
            listLabel="Library options"
            emptyInventory="No libraries to place this in."
          />
        ) : null}
      </LibraryChooserSurface>
    </>
  );
}
