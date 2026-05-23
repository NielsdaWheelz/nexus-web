"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import Button from "@/components/ui/Button";
import PaletteBody from "./PaletteBody";
import type { PaletteCommand, PaletteView } from "./types";
import styles from "./PaletteMobileShell.module.css";

interface PaletteMobileShellProps {
  query: string;
  view: PaletteView;
  searchLoading: boolean;
  scopeLabel: string | null;
  onQueryChange(query: string): void;
  onClearScope(): void;
  onSelect(command: PaletteCommand): void;
  onClose(): void;
}

const SWIPE_DISMISS_THRESHOLD_PX = 96;
const PALETTE_HISTORY_OPEN_KEY = "__nexusCommandPaletteOpen";

function readHistoryState(): Record<string, unknown> {
  return typeof history.state === "object" && history.state !== null
    ? (history.state as Record<string, unknown>)
    : {};
}

function historyStateHasPaletteMarker(): boolean {
  return readHistoryState()[PALETTE_HISTORY_OPEN_KEY] === true;
}

export default function PaletteMobileShell({
  query,
  view,
  searchLoading,
  scopeLabel,
  onQueryChange,
  onClearScope,
  onSelect,
  onClose,
}: PaletteMobileShellProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = useState<number | null>(
    () => window.visualViewport?.height ?? null,
  );
  const dragStartYRef = useRef<number | null>(null);
  const historyEntryActiveRef = useRef(false);
  const ignoreNextPopStateRef = useRef(false);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  // visualViewport resizing is browser/device behavior; component tests cover the
  // shell contract, while device verification covers keyboard resizing.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setViewportHeight(viewport.height);
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);

  useEffect(() => {
    if (historyStateHasPaletteMarker()) {
      historyEntryActiveRef.current = true;
    } else {
      history.pushState(
        { ...readHistoryState(), [PALETTE_HISTORY_OPEN_KEY]: true },
        "",
      );
      historyEntryActiveRef.current = true;
    }

    const onPopState = () => {
      if (ignoreNextPopStateRef.current) {
        ignoreNextPopStateRef.current = false;
        return;
      }
      historyEntryActiveRef.current = false;
      onClose();
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, [onClose]);

  function popPaletteHistoryEntry() {
    if (!historyEntryActiveRef.current && !historyStateHasPaletteMarker()) return;
    historyEntryActiveRef.current = false;
    ignoreNextPopStateRef.current = true;
    history.back();
  }

  function closeFromUi() {
    popPaletteHistoryEntry();
    onClose();
  }

  function selectFromUi(command: PaletteCommand) {
    popPaletteHistoryEntry();
    onSelect(command);
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Start the drag only at the top of the surface, or when the body's scrollable
    // list is already at its top, so the gesture never fights list scrolling.
    const list = panelRef.current?.querySelector("#palette-listbox") ?? null;
    const startsAtTop = event.target instanceof Element && event.target.closest("header") !== null;
    if (!startsAtTop && (list?.scrollTop ?? 0) > 0) return;
    dragStartYRef.current = event.clientY;
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const start = dragStartYRef.current;
    if (start === null || !panelRef.current) return;
    const delta = Math.max(0, event.clientY - start);
    panelRef.current.style.transform = `translateY(${delta}px)`;
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const start = dragStartYRef.current;
    dragStartYRef.current = null;
    if (start === null || !panelRef.current) return;
    panelRef.current.style.transform = "";
    if (event.clientY - start > SWIPE_DISMISS_THRESHOLD_PX) closeFromUi();
  }

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      style={{ height: viewportHeight !== null ? `${viewportHeight}px` : "100dvh" }}
      aria-label="Command palette"
      onCancel={(event) => {
        event.preventDefault();
        closeFromUi();
      }}
    >
      <div
        ref={panelRef}
        className={styles.panel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <header className={styles.header}>
          <Button
            iconOnly
            variant="ghost"
            size="lg"
            type="button"
            aria-label="Close command palette"
            onClick={closeFromUi}
          >
            <X size={20} aria-hidden="true" />
          </Button>
        </header>

        <PaletteBody
          view={view}
          query={query}
          searchLoading={searchLoading}
          scopeLabel={scopeLabel}
          activeCommandId={null}
          showShortcuts={false}
          autoFocusInput={false}
          onQueryChange={onQueryChange}
          onClearScope={onClearScope}
          onSelect={selectFromUi}
        />
      </div>
    </dialog>
  );
}
