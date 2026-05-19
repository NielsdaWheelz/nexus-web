"use client";

import { Maximize2, Minus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { getPaneRouteIcon } from "@/lib/panes/paneRouteRegistry";
import styles from "./WorkspacePaneStrip.module.css";

interface WorkspacePaneStripItem {
  paneId: string;
  href: string;
  title: string;
  titleState: "resolved" | "pending";
  isActive: boolean;
  isInView: boolean;
  visibility: "visible" | "minimized";
  canMinimize: boolean;
}

interface WorkspacePaneStripProps {
  items: WorkspacePaneStripItem[];
  onActivatePane: (paneId: string) => void;
  onMinimizePane: (paneId: string) => void;
  onRestorePane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
}

function PaneTab({
  item,
  isFocusable,
  activatorRef,
  onActivate,
  onMinimize,
  onRestore,
  onClose,
  onActivatorKeyDown,
  onActivatorFocus,
}: {
  item: WorkspacePaneStripItem;
  isFocusable: boolean;
  activatorRef: (el: HTMLButtonElement | null) => void;
  onActivate: () => void;
  onMinimize: () => void;
  onRestore: () => void;
  onClose: () => void;
  onActivatorKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onActivatorFocus: () => void;
}) {
  const title = item.title.trim() || "Pane";
  const isMinimized = item.visibility === "minimized";
  const isPending = item.titleState === "pending";
  const RouteIcon = getPaneRouteIcon(item.href);

  return (
    <div
      className={[
        styles.tab,
        item.isActive ? styles.active : "",
        item.isInView ? styles.inView : "",
        isMinimized ? styles.minimized : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        ref={activatorRef}
        className={styles.activator}
        tabIndex={isFocusable ? 0 : -1}
        aria-current={item.isActive ? "page" : undefined}
        aria-label={isPending ? title : undefined}
        aria-busy={isPending || undefined}
        title={isPending ? undefined : title}
        onClick={onActivate}
        onFocus={onActivatorFocus}
        onKeyDown={onActivatorKeyDown}
      >
        <RouteIcon aria-hidden size={14} strokeWidth={2} className={styles.icon} />
        {isPending ? (
          <span className={styles.titleSkeleton} aria-hidden />
        ) : (
          <span className={styles.title}>{title}</span>
        )}
        {item.isActive && <span className="sr-only"> Active pane.</span>}
        {isMinimized && <span className="sr-only"> Minimized. Restore.</span>}
      </button>
      <div className={styles.actions}>
        <button
          type="button"
          tabIndex={-1}
          className={styles.action}
          aria-label={`${isMinimized ? "Restore" : "Minimize"} ${title}`}
          disabled={!isMinimized && !item.canMinimize}
          onClick={isMinimized ? onRestore : onMinimize}
        >
          {isMinimized ? (
            <Maximize2 aria-hidden size={16} strokeWidth={2} />
          ) : (
            <Minus aria-hidden size={16} strokeWidth={2} />
          )}
        </button>
        <button
          type="button"
          tabIndex={-1}
          className={styles.action}
          aria-label={`Close ${title}`}
          onClick={onClose}
        >
          <X aria-hidden size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

export default function WorkspacePaneStrip({
  items,
  onActivatePane,
  onMinimizePane,
  onRestorePane,
  onClosePane,
}: WorkspacePaneStripProps) {
  const primaryButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [rovingPaneId, setRovingPaneId] = useState<string | null>(null);
  const [pendingFocusPaneId, setPendingFocusPaneId] = useState<string | null>(null);

  const paneIds = useMemo(() => items.map((item) => item.paneId), [items]);
  const focusablePaneId = useMemo(
    () =>
      (rovingPaneId && paneIds.includes(rovingPaneId) ? rovingPaneId : null) ??
      items.find((item) => item.isActive)?.paneId ??
      paneIds[0] ??
      null,
    [items, paneIds, rovingPaneId]
  );

  const focusPrimaryButton = (paneId: string) => {
    setRovingPaneId(paneId);
    primaryButtonRefs.current.get(paneId)?.focus();
  };

  const focusPrimaryButtonByIndex = (index: number) => {
    if (!items.length) {
      return;
    }
    const normalizedIndex = ((index % items.length) + items.length) % items.length;
    const nextPaneId = items[normalizedIndex]?.paneId;
    if (!nextPaneId) {
      return;
    }
    focusPrimaryButton(nextPaneId);
  };

  const nextSurvivingPaneId = (paneId: string): string | null => {
    const currentIndex = items.findIndex((item) => item.paneId === paneId);
    if (currentIndex < 0) {
      return null;
    }
    return items[currentIndex + 1]?.paneId ?? items[currentIndex - 1]?.paneId ?? null;
  };

  const nearestVisiblePaneIdAfterMinimize = (paneId: string): string | null => {
    const currentIndex = items.findIndex((item) => item.paneId === paneId);
    if (currentIndex < 0) {
      return null;
    }

    const nextVisible = items
      .slice(currentIndex + 1)
      .find((item) => item.visibility === "visible");
    if (nextVisible) {
      return nextVisible.paneId;
    }

    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item?.visibility === "visible") {
        return item.paneId;
      }
    }

    return null;
  };

  const activatePrimaryButton = (item: WorkspacePaneStripItem) => {
    if (item.visibility === "minimized") {
      setPendingFocusPaneId(item.paneId);
      onRestorePane(item.paneId);
      return;
    }
    onActivatePane(item.paneId);
  };

  const handleMinimizePane = (item: WorkspacePaneStripItem) => {
    if (!item.canMinimize) {
      return;
    }
    setPendingFocusPaneId(
      item.isActive ? nearestVisiblePaneIdAfterMinimize(item.paneId) : item.paneId
    );
    onMinimizePane(item.paneId);
  };

  const handleRestorePane = (paneId: string) => {
    setPendingFocusPaneId(paneId);
    onRestorePane(paneId);
  };

  const handleClosePane = (paneId: string) => {
    setPendingFocusPaneId(nextSurvivingPaneId(paneId));
    onClosePane(paneId);
  };

  const handlePrimaryKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    item: WorkspacePaneStripItem
  ) => {
    const currentIndex = items.findIndex((candidate) => candidate.paneId === item.paneId);
    if (currentIndex < 0) {
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      focusPrimaryButtonByIndex(currentIndex + 1);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusPrimaryButtonByIndex(currentIndex - 1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusPrimaryButtonByIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusPrimaryButtonByIndex(items.length - 1);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      handleClosePane(item.paneId);
    }
  };

  useEffect(() => {
    if (!pendingFocusPaneId) {
      return;
    }
    const nextPaneId = paneIds.includes(pendingFocusPaneId)
      ? pendingFocusPaneId
      : paneIds[0] ?? null;
    if (nextPaneId) {
      setRovingPaneId(nextPaneId);
      primaryButtonRefs.current.get(nextPaneId)?.focus();
    }
    setPendingFocusPaneId(null);
  }, [paneIds, pendingFocusPaneId]);

  return (
    <div className={styles.root}>
      <div className={styles.switcher} role="toolbar" aria-label="Workspace panes">
        {items.map((item) => (
          <PaneTab
            key={item.paneId}
            item={item}
            isFocusable={item.paneId === focusablePaneId}
            activatorRef={(element) => {
              if (element) {
                primaryButtonRefs.current.set(item.paneId, element);
              } else {
                primaryButtonRefs.current.delete(item.paneId);
              }
            }}
            onActivate={() => activatePrimaryButton(item)}
            onMinimize={() => handleMinimizePane(item)}
            onRestore={() => handleRestorePane(item.paneId)}
            onClose={() => handleClosePane(item.paneId)}
            onActivatorKeyDown={(event) => handlePrimaryKeyDown(event, item)}
            onActivatorFocus={() => setRovingPaneId(item.paneId)}
          />
        ))}
      </div>
    </div>
  );
}
