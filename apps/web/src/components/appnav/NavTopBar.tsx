"use client";

import { useRef } from "react";
import { ChevronLeft, ChevronRight, Plus, Search } from "lucide-react";
import AsterismMark from "@/components/AsterismMark";
import ActionMenu from "@/components/ui/ActionMenu";
import { useMobileChrome } from "@/lib/workspace/mobileChrome";
import styles from "./AppNav.module.css";

export default function NavTopBar({
  onOpenSheet,
  onOpenCommand,
  onOpenAdd,
}: {
  onOpenSheet: () => void;
  onOpenCommand: () => void;
  onOpenAdd: () => void;
}) {
  const { hidden, paneChrome, acquireVisibleLock } = useMobileChrome();
  const navigation = paneChrome?.navigation;
  const options = paneChrome?.options ?? [];
  const releaseLockRef = useRef<(() => void) | null>(null);

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
        aria-label="Search or ask anything"
        aria-haspopup="dialog"
      >
        <Search size={20} aria-hidden="true" />
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
