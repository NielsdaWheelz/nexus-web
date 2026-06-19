"use client";

import { activeLauncherItem } from "@/lib/launcher/model";
import type { LauncherController } from "./useLauncherController";
import styles from "./launcher.module.css";

export default function LauncherFooter({ controller }: { controller: LauncherController }) {
  const { view, activeId } = controller;
  const activeItem = activeLauncherItem(view, activeId);

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
        <kbd className={styles.kbd}>⇧↩</kbd> ask
      </span>
      <span className={styles.hint}>
        <kbd className={styles.kbd}>esc</kbd> close
      </span>
      {activeItem?.shortcutLabel ? (
        <span className={styles.hintShortcut}>{activeItem.shortcutLabel}</span>
      ) : null}
    </footer>
  );
}
