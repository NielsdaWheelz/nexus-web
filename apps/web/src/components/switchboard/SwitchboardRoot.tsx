"use client";

import { X } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import SwitchboardRow from "./SwitchboardRow";
import type { SwitchboardQuickAction } from "@/lib/launcher/quickActions";
import type { Destination } from "@/lib/navigation/destinations";
import type { WorkspaceActivationRouteId } from "@/lib/panes/paneIdentity";
import {
  completeSwitchboardPerformanceAfterPaint,
  NEXUS_OPEN_PERFORMANCE,
} from "@/lib/switchboard/performance";
import styles from "./switchboard.module.css";

export interface SwitchboardPaneRow {
  id: string;
  label: string;
  metadata: string;
  current: boolean;
  activationRouteId: WorkspaceActivationRouteId;
}

export interface SwitchboardClosedPaneRow {
  id: string;
  label: string;
  metadata: string;
}

export default function SwitchboardRoot({
  places,
  quickActions,
  panes,
  recentlyClosed,
  accountMenu,
  retainedTarget,
  manageTabs = false,
  onDone,
  onFind,
  onPlace,
  onQuickAction,
  onOpenPane,
  onClosePane,
  onRestorePane,
  onRetryRetained,
}: {
  places: readonly Destination[];
  quickActions: readonly SwitchboardQuickAction[];
  panes: readonly SwitchboardPaneRow[];
  recentlyClosed: readonly SwitchboardClosedPaneRow[];
  accountMenu: ReactNode;
  retainedTarget?: string;
  manageTabs?: boolean;
  onDone: () => void;
  onFind: () => void;
  onPlace: (destination: Destination) => void;
  onQuickAction: (action: SwitchboardQuickAction) => void;
  onOpenPane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onRestorePane: (paneId: string) => void;
  onRetryRetained?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    completeSwitchboardPerformanceAfterPaint(NEXUS_OPEN_PERFORMANCE);
  }, []);

  const closePaneAndMoveFocus = (
    paneId: string,
    triggerElement: HTMLButtonElement | null,
  ) => {
    const row = triggerElement?.closest("li");
    const nextRow = row?.nextElementSibling?.querySelector<HTMLElement>(
      "[data-switchboard-row-id]",
    );
    const previousRow = row?.previousElementSibling?.querySelector<HTMLElement>(
      "[data-switchboard-row-id]",
    );
    const fallbackRowId =
      nextRow?.dataset.switchboardRowId ??
      previousRow?.dataset.switchboardRowId ??
      null;
    onClosePane(paneId);
    requestAnimationFrame(() => {
      const root = rootRef.current;
      const fallbackRow = fallbackRowId
        ? Array.from(
            root?.querySelectorAll<HTMLElement>("[data-switchboard-row-id]") ??
              [],
          ).find(
            (candidate) =>
              candidate.dataset.switchboardRowId === fallbackRowId,
          )
        : null;
      (
        fallbackRow ??
        root?.querySelector<HTMLElement>("#switchboard-open")
      )?.focus();
    });
  };

  return (
    <div
      ref={rootRef}
      className={`${styles.page} ${styles.rootPage}`}
      data-switchboard-ready="Root"
    >
      <header className={styles.header}>
        <h2 tabIndex={-1} data-switchboard-heading>
          Nexus
        </h2>
        <div className={styles.headerActions}>
          {accountMenu}
          <button type="button" className={styles.textButton} onClick={onDone}>
            Done
          </button>
        </div>
      </header>

      <div className={styles.rootScroll} data-testid="switchboard-root-scroll">
        {retainedTarget ? (
          <section
            className={styles.recoveryBanner}
            aria-labelledby="retained-title"
          >
            <h3 id="retained-title">Ready to open</h3>
            <p>{retainedTarget}</p>
            <button type="button" onClick={onRetryRetained}>
              Open
            </button>
          </section>
        ) : null}

        {!manageTabs ? (
          <section
            className={styles.section}
            aria-labelledby="switchboard-places"
          >
            <h3 id="switchboard-places">Places</h3>
            <div className={styles.compactGrid}>
              {places.map((place) => {
                const Icon = place.icon;
                return (
                  <button
                    key={place.id}
                    type="button"
                    className={styles.compactAction}
                    onClick={() => onPlace(place)}
                  >
                    {Icon ? <Icon size={18} aria-hidden="true" /> : null}
                    <span>{place.label}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}

        {!manageTabs ? (
          <section
            className={styles.section}
            aria-labelledby="switchboard-quick"
          >
            <h3 id="switchboard-quick">Quick</h3>
            <div className={styles.compactGrid}>
              {quickActions.map((action) => {
                const Icon = action.icon;
                return (
                  <button
                    key={action.id}
                    type="button"
                    className={styles.compactAction}
                    onClick={() => onQuickAction(action)}
                  >
                    <Icon size={18} aria-hidden="true" />
                    <span>{action.label}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}

        <section className={styles.section} aria-labelledby="switchboard-open">
          <h3
            id="switchboard-open"
            tabIndex={-1}
            data-switchboard-open-heading={manageTabs || undefined}
          >
            Open
          </h3>
          <ul className={styles.rows}>
            {panes.map((pane) => (
              <SwitchboardRow
                key={pane.id}
                id={`OpenPane:${pane.id}`}
                label={pane.label}
                metadata={pane.metadata}
                current={pane.current}
                performanceTargetId={pane.activationRouteId}
                onSelect={() => onOpenPane(pane.id)}
                actions={[
                  {
                    kind: "command",
                    id: `close-${pane.id}`,
                    label: `Close ${pane.label}`,
                    icon: <X size={16} aria-hidden="true" />,
                    restoreFocusOnClose: false,
                    onSelect: ({ triggerEl }) =>
                      closePaneAndMoveFocus(pane.id, triggerEl),
                  },
                ]}
              />
            ))}
          </ul>
        </section>

        {!manageTabs && recentlyClosed.length > 0 ? (
          <section
            className={styles.section}
            aria-labelledby="switchboard-recently-closed"
          >
            <h3 id="switchboard-recently-closed">Recently closed</h3>
            <ul className={styles.rows}>
              {recentlyClosed.map((pane) => (
                <SwitchboardRow
                  key={pane.id}
                  id={`ClosedPane:${pane.id}`}
                  label={pane.label}
                  metadata={pane.metadata}
                  onSelect={() => onRestorePane(pane.id)}
                />
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      {!manageTabs ? (
        <button type="button" className={styles.findButton} onClick={onFind}>
          Find anything…
        </button>
      ) : null}
    </div>
  );
}
