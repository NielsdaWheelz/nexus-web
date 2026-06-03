"use client";

import { activePaletteItem } from "./paletteModel";
import type { PaletteController } from "./usePaletteController";
import styles from "./palette.module.css";

export default function PaletteFooter({ controller }: { controller: PaletteController }) {
  const { view, activeId } = controller;
  const activeItem = activePaletteItem(view, activeId);

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
