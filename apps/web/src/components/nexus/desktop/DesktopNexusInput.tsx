"use client";

import { useRef } from "react";
import Input from "@/components/ui/Input";
import type { DesktopNexusController } from "./types";
import styles from "./desktopNexus.module.css";

export const DESKTOP_NEXUS_LISTBOX_ID = "desktop-nexus-results";
export const desktopNexusOptionId = (key: string) => `desktop-nexus-option-${key}`;

export default function DesktopNexusInput({
  controller,
}: {
  controller: DesktopNexusController;
}) {
  const composing = useRef(false);
  const activeIndex = controller.entries.findIndex(
    (entry) => entry.key === controller.activeEntryKey,
  );

  const moveActive = (delta: number) => {
    if (controller.entries.length === 0) return;
    const start = activeIndex < 0 ? 0 : activeIndex;
    const next = Math.max(
      0,
      Math.min(controller.entries.length - 1, start + delta),
    );
    controller.setActiveEntry(controller.entries[next]!.key);
  };

  return (
    <label className={styles.inputRow}>
      <span className="sr-only">Find anything</span>
      <Input
        variant="bare"
        role="combobox"
        aria-label="Find anything"
        aria-autocomplete="list"
        aria-controls={DESKTOP_NEXUS_LISTBOX_ID}
        aria-expanded="true"
        aria-activedescendant={
          controller.activeEntryKey
            ? desktopNexusOptionId(controller.activeEntryKey)
            : undefined
        }
        className={styles.input}
        value={controller.query}
        placeholder="Find anything…"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => controller.setQuery(event.currentTarget.value)}
        onFocus={() => controller.inputReady?.()}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
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
          if (event.key === "Enter") {
            const key = controller.activeEntryKey;
            if (!key) return;
            event.preventDefault();
            controller.selectEntry(
              key,
              event.shiftKey ? "Fork" : "Follow",
              "Keyboard",
            );
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            if (controller.query) controller.setQuery("");
            else controller.escape();
          }
        }}
      />
    </label>
  );
}
