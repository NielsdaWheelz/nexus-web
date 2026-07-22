"use client";

import { useRef } from "react";
import Input from "@/components/ui/Input";
import {
  activeLauncherItem,
  LANE_LABEL,
  LANE_SIGIL,
  LAUNCHER_LISTBOX_ID,
  LAUNCHER_OPTION_ID_PREFIX,
  launcherRowIds,
} from "@/lib/launcher/model";
import type { LauncherController } from "./useLauncherController";
import styles from "./launcher.module.css";

export default function LauncherInput({
  controller,
}: {
  controller: LauncherController;
}) {
  const { view, input, lane, query, activeId } = controller;
  const composingRef = useRef(false);
  // A sigil-lane shows the text without its sigil and re-prefixes on change; a chip-selected
  // (sigil-less) lane shows the raw query and the chip alone carries the lane.
  const sigil = input.explicitLane ? LANE_SIGIL[input.explicitLane] : undefined;
  const value = sigil ? input.text : query;
  const showLegend = input.explicitLane === "ask" && input.text === "";

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (composingRef.current) return;
    const key = event.key;

    if (key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        controller.askCurrent();
        return;
      }
      if (view.state === "actions") {
        const action =
          view.actions.find((a) => a.id === activeId) ?? view.actions[0];
        if (action) controller.runAction(action);
      } else {
        const item = activeLauncherItem(view, activeId);
        if (item) controller.select(item);
      }
      return;
    }

    if (
      key === "ArrowDown" ||
      key === "ArrowUp" ||
      key === "Home" ||
      key === "End"
    ) {
      event.preventDefault();
      const ids = launcherRowIds(view);
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
        const item = activeLauncherItem(view, activeId);
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
      event.currentTarget.selectionStart === 0 &&
      event.currentTarget.selectionEnd === 0;
    if (key === "Backspace" && atStart) {
      if (view.state === "actions") {
        event.preventDefault();
        controller.back();
      } else if (lane !== "all") {
        event.preventDefault();
        controller.clearLane();
      }
      return;
    }

    if (key === "Delete" && value === "") {
      const item = activeLauncherItem(view, activeId);
      if (item?.trailingAction) {
        event.preventDefault();
        controller.trailing(item);
      }
    }
  }

  return (
    <>
      <div className={styles.inputRow}>
        {lane !== "all" ? (
          <span className={styles.laneChip}>{LANE_LABEL[lane]} ›</span>
        ) : null}
        <Input
          variant="bare"
          role="combobox"
          aria-label="Search, add, or ask"
          aria-expanded="true"
          aria-controls={LAUNCHER_LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={
            activeId ? `${LAUNCHER_OPTION_ID_PREFIX}${activeId}` : undefined
          }
          className={styles.input}
          value={value}
          placeholder="Search, add, or ask…"
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) =>
            controller.setQuery(
              sigil ? sigil + event.target.value : event.target.value,
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
      {showLegend ? (
        <div className={styles.legend}>
          <div className={styles.legendRow}>
            <kbd className={styles.kbd}>&gt;</kbd> Go to commands
          </div>
          <div className={styles.legendRow}>
            <kbd className={styles.kbd}>@</kbd> Open existing
          </div>
          <div className={styles.legendRow}>
            <kbd className={styles.kbd}>?</kbd> Ask AI
          </div>
        </div>
      ) : null}
    </>
  );
}
