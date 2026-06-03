"use client";

import { useRef } from "react";
import Input from "@/components/ui/Input";
import {
  activePaletteItem,
  PALETTE_LISTBOX_ID,
  PALETTE_OPTION_ID_PREFIX,
  paletteRowIds,
  type PaletteLane,
} from "./paletteModel";
import { LANE_SIGIL } from "./paletteIntent";
import type { PaletteController } from "./usePaletteController";
import styles from "./palette.module.css";

const LANE_LABEL: Record<Exclude<PaletteLane, "all">, string> = {
  actions: "Actions",
  content: "Content",
  ask: "Ask",
};

export default function PaletteInput({ controller }: { controller: PaletteController }) {
  const { view, intent, query, activeId } = controller;
  const composingRef = useRef(false);
  const sigilLane = intent.lane === "all" ? null : intent.lane;
  const value = sigilLane ? intent.term : query;

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (composingRef.current) return;
    const key = event.key;

    if (key === "Enter") {
      event.preventDefault();
      if (view.state === "actions") {
        const action = view.actions.find((a) => a.id === activeId) ?? view.actions[0];
        if (action) controller.runAction(action);
      } else {
        const item = activePaletteItem(view, activeId);
        if (item) controller.select(item);
      }
      return;
    }

    if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
      event.preventDefault();
      const ids = paletteRowIds(view);
      if (ids.length === 0) return;
      const current = ids.indexOf(activeId ?? "");
      const start = current >= 0 ? current : 0;
      const last = ids.length - 1;
      const next =
        key === "Home"
          ? 0
          : key === "End"
            ? last
            : key === "ArrowDown"
              ? Math.min(last, start + 1)
              : Math.max(0, start - 1);
      controller.setActiveId(ids[next]!);
      return;
    }

    if (key === "ArrowRight" || key === "Tab") {
      if (view.state !== "actions") {
        const item = activePaletteItem(view, activeId);
        if (item?.hasActions) {
          event.preventDefault();
          controller.drill(item);
          return;
        }
      }
      if (key === "Tab") event.preventDefault(); // keep focus trapped on the input
      return;
    }

    if (key === "ArrowLeft" && view.state === "actions") {
      event.preventDefault();
      controller.back();
      return;
    }

    const atStart =
      event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0;
    if (key === "Backspace" && atStart) {
      if (sigilLane) {
        event.preventDefault();
        controller.clearLane();
      } else if (view.state === "actions") {
        event.preventDefault();
        controller.back();
      }
      return;
    }

    if (key === "Delete" && value === "") {
      const item = activePaletteItem(view, activeId);
      if (item?.trailingAction) {
        event.preventDefault();
        controller.trailing(item);
      }
    }
  }

  return (
    <div className={styles.inputRow}>
      {sigilLane ? <span className={styles.laneChip}>{LANE_LABEL[sigilLane]} ›</span> : null}
      <Input
        variant="bare"
        role="combobox"
        aria-label="Search commands"
        aria-expanded="true"
        aria-controls={PALETTE_LISTBOX_ID}
        aria-autocomplete="list"
        aria-activedescendant={activeId ? `${PALETTE_OPTION_ID_PREFIX}${activeId}` : undefined}
        className={styles.input}
        value={value}
        placeholder="Search or run an action…"
        enterKeyHint="search"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) =>
          controller.setQuery(
            sigilLane ? LANE_SIGIL[sigilLane] + event.target.value : event.target.value,
          )
        }
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
