"use client";

import { useCallback, useEffect, useRef } from "react";
import styles from "./WorkspaceTabsSheet.module.css";

interface WorkspaceTabsSheetTab {
  paneId: string;
  title: string;
  isActive: boolean;
}

interface WorkspaceTabsSheetProps {
  open: boolean;
  tabs: WorkspaceTabsSheetTab[];
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onActivatePane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onRequestClose: () => void;
}

export default function WorkspaceTabsSheet({
  open,
  tabs,
  triggerRef,
  onActivatePane,
  onClosePane,
  onRequestClose,
}: WorkspaceTabsSheetProps) {
  const firstButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  const skipReturnFocusRef = useRef(false);

  const getFocusableElements = useCallback(() => {
    const sheet = sheetRef.current;
    if (!sheet) {
      return [] as HTMLElement[];
    }
    return Array.from(
      sheet.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );
  }, []);

  useEffect(() => {
    if (open) {
      skipReturnFocusRef.current = false;
      const focusableElements = getFocusableElements();
      focusableElements[0]?.focus();
    } else if (wasOpenRef.current) {
      if (!skipReturnFocusRef.current) {
        triggerRef.current?.focus();
      }
      skipReturnFocusRef.current = false;
    }
    wasOpenRef.current = open;
  }, [getFocusableElements, open, triggerRef]);

  if (!open) {
    return null;
  }

  return (
    <div className={styles.overlay}>
      <div
        ref={sheetRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Workspace panes"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onRequestClose();
            return;
          }
          if (event.key !== "Tab") {
            return;
          }
          const focusableElements = getFocusableElements();
          if (focusableElements.length === 0) {
            event.preventDefault();
            return;
          }
          const firstFocusableElement = focusableElements[0];
          const lastFocusableElement = focusableElements[focusableElements.length - 1];
          const activeElement = document.activeElement;
          const focusInsideSheet =
            activeElement instanceof HTMLElement && sheetRef.current?.contains(activeElement);
          if (event.shiftKey) {
            if (!focusInsideSheet || activeElement === firstFocusableElement) {
              event.preventDefault();
              lastFocusableElement?.focus();
            }
            return;
          }
          if (!focusInsideSheet || activeElement === lastFocusableElement) {
            event.preventDefault();
            firstFocusableElement?.focus();
          }
        }}
      >
        <div className={styles.header}>
          <h2 className={styles.title}>Workspace panes</h2>
        </div>
        <div className={styles.list}>
          {tabs.map((tab, index) => (
            <div className={styles.row} key={tab.paneId}>
              <button
                ref={index === 0 ? firstButtonRef : undefined}
                type="button"
                className={`${styles.item} ${tab.isActive ? styles.active : ""}`}
                onClick={() => {
                  skipReturnFocusRef.current = true;
                  onActivatePane(tab.paneId);
                }}
              >
                {tab.title}
              </button>
              <button
                type="button"
                className={styles.closePane}
                aria-label={`Close ${tab.title}`}
                onClick={() => onClosePane(tab.paneId)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className={styles.footer}>
          <button
            ref={closeButtonRef}
            type="button"
            className={styles.close}
            onClick={onRequestClose}
          >
            Close panes
          </button>
        </div>
      </div>
    </div>
  );
}
