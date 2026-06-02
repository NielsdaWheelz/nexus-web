"use client";

import { useRef } from "react";
import { ChevronLeft, ChevronRight, Command, Plus } from "lucide-react";
import AsterismMark from "@/components/AsterismMark";
import ActionMenu from "@/components/ui/ActionMenu";
import { useMobileChrome } from "@/lib/workspace/mobileChrome";
import { pluralize } from "@/lib/text/pluralize";
import styles from "./AppNav.module.css";

export default function NavTopBar({
  onOpenSheet,
  onOpenCommand,
  onOpenAdd,
  paneCount,
}: {
  onOpenSheet: () => void;
  onOpenCommand: () => void;
  onOpenAdd: () => void;
  paneCount: number;
}) {
  const { hidden, paneChrome, acquireVisibleLock } = useMobileChrome();
  const navigation = paneChrome?.navigation;
  const options = paneChrome?.options ?? [];
  const releaseLockRef = useRef<(() => void) | null>(null);

  const showPaneCount = paneCount > 0;
  const commandLabel = showPaneCount
    ? `Search or ask anything (${pluralize(paneCount, "open tab")})`
    : "Search or ask anything";

  return (
    <header className={styles.topBar} data-hidden={hidden ? "true" : "false"}>
      <button
        type="button"
        className={`${styles.topBarButton} ${styles.topBarBrand}`}
        onClick={onOpenSheet}
        aria-label="Open navigation"
        aria-haspopup="dialog"
      >
        <AsterismMark size={20} />
      </button>
      <button
        type="button"
        className={styles.topBarButton}
        onClick={() => navigation?.onBack()}
        disabled={!navigation?.canGoBack}
        aria-label="Go back"
      >
        <ChevronLeft size={20} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={styles.topBarButton}
        onClick={() => navigation?.onForward()}
        disabled={!navigation?.canGoForward}
        aria-label="Go forward"
      >
        <ChevronRight size={20} aria-hidden="true" />
      </button>

      <span className={styles.topBarTitle}>{paneChrome?.title}</span>

      <button
        type="button"
        className={styles.topBarButton}
        onClick={onOpenCommand}
        aria-label={commandLabel}
        aria-haspopup="dialog"
      >
        <span className={styles.topBarCommandIcon}>
          <Command size={20} aria-hidden="true" />
          {showPaneCount ? (
            <span className={styles.topBarCommandBadge} aria-hidden="true">
              {paneCount}
            </span>
          ) : null}
        </span>
      </button>
      <button
        type="button"
        className={`${styles.topBarButton} ${styles.topBarAdd}`}
        onClick={onOpenAdd}
        aria-label="Add content"
        aria-haspopup="dialog"
      >
        <Plus size={20} aria-hidden="true" />
      </button>
      {options.length > 0 && (
        <ActionMenu
          options={options}
          label="Pane options"
          onOpenChange={(open) => {
            if (open) {
              releaseLockRef.current = acquireVisibleLock("action-menu");
            } else {
              releaseLockRef.current?.();
              releaseLockRef.current = null;
            }
          }}
        />
      )}
    </header>
  );
}
