"use client";

import { useRef, type Ref } from "react";
import Input from "@/components/ui/Input";
import {
  nexusEntryKeyValue,
  type NexusEntry,
  type NexusEntryKey,
} from "@/lib/nexus/model";
import {
  beginNexusPerformance,
  NEXUS_LOCAL_FIND_PERFORMANCE,
} from "@/lib/nexus/performance";
import type {
  DesktopNexusActionsOpener,
  DesktopNexusCell,
  DesktopNexusController,
} from "./types";
import styles from "./desktopNexus.module.css";

export const DESKTOP_NEXUS_GRID_ID = "desktop-nexus-results";

export function desktopNexusCellId(
  key: NexusEntryKey,
  cell: DesktopNexusCell,
): string {
  return `desktop-nexus-${cell.toLowerCase()}-${encodeURIComponent(nexusEntryKeyValue(key))}`;
}

function projectionEntries(
  controller: DesktopNexusController,
): readonly NexusEntry[] {
  return controller.projection.groups.flatMap((group) => group.entries);
}

export default function DesktopNexusInput({
  controller,
  inputRef,
  activeCell,
  setActiveCell,
  openActions,
}: {
  controller: DesktopNexusController;
  inputRef: Ref<HTMLInputElement>;
  activeCell: DesktopNexusCell;
  setActiveCell(cell: DesktopNexusCell): void;
  openActions: DesktopNexusActionsOpener;
}) {
  const composing = useRef(false);
  const entries = projectionEntries(controller);
  const activeKeyValue = controller.projection.activeKey
    ? nexusEntryKeyValue(controller.projection.activeKey)
    : null;
  const activeIndex = entries.findIndex(
    (entry) => nexusEntryKeyValue(entry.key) === activeKeyValue,
  );
  const activeEntry = activeIndex < 0 ? undefined : entries[activeIndex];

  const moveActive = (delta: -1 | 1) => {
    if (entries.length === 0) return;
    const nextIndex =
      activeIndex < 0
        ? delta === 1
          ? 0
          : entries.length - 1
        : Math.max(0, Math.min(entries.length - 1, activeIndex + delta));
    const next = entries[nextIndex];
    if (!next) return;
    controller.setActiveEntry(next.key);
    if (activeCell === "Actions" && next.secondaryActions.length === 0) {
      setActiveCell("Primary");
    }
  };

  return (
    <label className={styles.inputRow}>
      <span className="sr-only">Find anything…</span>
      <Input
        ref={inputRef}
        variant="bare"
        role="combobox"
        aria-label="Find anything…"
        aria-autocomplete="list"
        aria-haspopup="grid"
        aria-controls={DESKTOP_NEXUS_GRID_ID}
        aria-expanded="true"
        aria-activedescendant={
          activeEntry ? desktopNexusCellId(activeEntry.key, activeCell) : undefined
        }
        className={styles.input}
        value={controller.query}
        placeholder="Find anything…"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => {
          beginNexusPerformance(NEXUS_LOCAL_FIND_PERFORMANCE);
          setActiveCell("Primary");
          controller.setQuery(event.currentTarget.value);
        }}
        onFocus={() => controller.inputReady?.()}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (
            composing.current ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229
          ) {
            // The modal's document-level Escape owner must not observe an IME
            // composition key. The browser/IME still owns its default behavior.
            event.stopPropagation();
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            moveActive(1);
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            moveActive(-1);
            return;
          }
          if (
            (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
            activeEntry &&
            activeEntry.secondaryActions.length > 0
          ) {
            event.preventDefault();
            setActiveCell(event.key === "ArrowRight" ? "Actions" : "Primary");
            return;
          }
          if (event.key === "Enter" && activeEntry) {
            event.preventDefault();
            if (activeCell === "Actions") {
              openActions(activeEntry, "Keyboard");
            } else {
              controller.activatePrimary({
                entry: activeEntry,
                disposition: event.shiftKey ? "Fork" : "Follow",
                modality: "Keyboard",
              });
            }
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            if (controller.query) {
              setActiveCell("Primary");
              controller.setQuery("");
            } else {
              controller.escape();
            }
          }
        }}
      />
    </label>
  );
}
