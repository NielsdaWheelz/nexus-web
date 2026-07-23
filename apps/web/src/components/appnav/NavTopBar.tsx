"use client";

import { useRef } from "react";
import { ChevronLeft, ChevronRight, Command, Plus } from "lucide-react";
import AsterismMark from "@/components/AsterismMark";
import ActionBar from "@/components/ui/ActionBar";
import ActionMenu from "@/components/ui/ActionMenu";
import PaneHeaderIdentity from "@/components/ui/PaneHeaderIdentity";
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
  const actions = paneChrome?.actions ?? [];
  const options = paneChrome?.options ?? [];
  const releaseLockRef = useRef<(() => void) | null>(null);

  const showPaneCount = paneCount > 0;
  const commandLabel = showPaneCount
    ? `Search or ask anything (${pluralize(paneCount, "open tab")})`
    : "Search or ask anything";

  return (
    <header
      className={styles.topBar}
      data-hidden={hidden ? "true" : "false"}
      data-header-kind={paneChrome?.header.kind}
      data-pane-chrome-for={paneChrome?.paneId}
    >
      <div
        className={styles.topBarControls}
        data-testid="top-bar-controls"
        aria-hidden={hidden || undefined}
        inert={hidden || undefined}
      >
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
          className={`${styles.topBarButton} ${styles.topBarForward}`}
          onClick={() => navigation?.onForward()}
          disabled={!navigation?.canGoForward}
          aria-label="Go forward"
        >
          <ChevronRight size={20} aria-hidden="true" />
        </button>
      </div>

      <div className={styles.topBarTitle}>
        {paneChrome ? (
          <PaneHeaderIdentity id={paneChrome.identityId} model={paneChrome.header} />
        ) : null}
      </div>

      <div
        className={styles.topBarControls}
        data-testid="top-bar-controls"
        aria-hidden={hidden || undefined}
        inert={hidden || undefined}
      >
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
        {actions.length > 0 && (
          <ActionBar options={actions} label="Pane actions" />
        )}
        {options.length > 0 && (
          <ActionMenu
            options={options}
            label="Pane options"
            className={styles.topBarOptions}
            triggerAttributes={{
              "data-pane-options-trigger": paneChrome?.paneId,
            }}
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
      </div>
    </header>
  );
}
