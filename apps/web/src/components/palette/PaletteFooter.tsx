"use client";

import type { PaletteController } from "./usePaletteController";
import styles from "./palette.module.css";

export default function PaletteFooter({ controller }: { controller: PaletteController }) {
  const { view, activeId } = controller;
  const activeItem =
    view.state === "resting"
      ? view.groups.flatMap((group) => group.items).find((item) => item.id === activeId)
      : view.state === "querying"
        ? view.results.find((item) => item.id === activeId)
        : undefined;

  return (
    <footer className={styles.footer} aria-hidden="true">
      <span className={styles.hint}>
        <kbd className={styles.kbd}>↩</kbd> open
      </span>
      {activeItem?.hasActions ? (
        <span className={styles.hint}>
          <kbd className={styles.kbd}>→</kbd> actions
        </span>
      ) : null}
      <span className={styles.hint}>
        <kbd className={styles.kbd}>esc</kbd> close
      </span>
      {activeItem?.shortcutLabel ? (
        <span className={styles.hintShortcut}>{activeItem.shortcutLabel}</span>
      ) : null}
    </footer>
  );
}
