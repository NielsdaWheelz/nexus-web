"use client";

import { useEffect } from "react";
import LibraryEntryEditor from "@/components/libraries/LibraryEntryEditor";
import Dialog from "@/components/ui/Dialog";
import MobileSheet from "@/components/ui/MobileSheet";
import type { LibraryPlacementSession } from "@/lib/libraries/placementController";
import { useLibraryPlacement } from "@/lib/libraries/useLibraryPlacement";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { usePaneMobileChromeController } from "@/lib/workspace/mobileChrome";
import styles from "./LibraryPlacementOverlay.module.css";

interface LibraryPlacementOverlayProps {
  session: LibraryPlacementSession | null;
  onClose: () => void;
}

function focusSearch(container: HTMLElement) {
  const activeElement = document.activeElement;
  if (
    activeElement instanceof HTMLElement &&
    container.contains(activeElement)
  ) {
    return activeElement;
  }
  return container.querySelector<HTMLInputElement>(
    'input[aria-label="Search libraries"]',
  );
}

function focusChrome(container: HTMLElement) {
  return container;
}

function returnFocusFallback(session: LibraryPlacementSession | null) {
  const fallback = session?.options.returnFocusFallback;
  return fallback?.kind === "Present" ? fallback.value : undefined;
}

function MobileChromeLock() {
  const { acquireVisibleLock } = usePaneMobileChromeController();
  useEffect(
    () => acquireVisibleLock("library-picker"),
    [acquireVisibleLock],
  );
  return null;
}

export default function LibraryPlacementOverlay({
  session,
  onClose,
}: LibraryPlacementOverlayProps) {
  const isMobile = useIsMobileViewport();
  const state = useLibraryPlacement(session);
  const active = session !== null;
  const editor = session ? (
    <LibraryEntryEditor
      key={session.key}
      libraries={state.libraries}
      loading={state.loading}
      busy={state.busy}
      busyLibraryId={state.busyLibraryId}
      error={state.error}
      onRetry={state.retry}
      onAddToLibrary={state.addToLibrary}
      onRemoveFromLibrary={state.removeFromLibrary}
    />
  ) : null;

  return (
    <>
      {active && isMobile ? <MobileChromeLock /> : null}
      <Dialog
        open={active && !isMobile}
        onClose={onClose}
        title="Libraries"
        initialFocus={focusSearch}
        returnFocusTo={session?.options.returnFocusTo}
        returnFocusFallback={returnFocusFallback(session)}
      >
        {editor}
      </Dialog>
      <MobileSheet
        active={active && isMobile}
        onDismiss={onClose}
        ariaLabel="Libraries"
        initialFocus={focusChrome}
        focusKey={session?.key}
        returnFocusTo={session?.options.returnFocusTo}
        returnFocusFallback={returnFocusFallback(session)}
        panelTestId="library-placement-sheet"
      >
        <div className={styles.sheetHeader}>
          <h2 className={styles.sheetTitle}>Libraries</h2>
        </div>
        <div className={styles.sheetBody}>{editor}</div>
      </MobileSheet>
    </>
  );
}
