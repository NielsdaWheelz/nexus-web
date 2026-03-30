"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import PaneShell, { type PaneBodyMode } from "@/components/workspace/PaneShell";
import PaneStrip from "@/components/workspace/PaneStrip";
import WorkspaceTabsBar from "@/components/workspace/WorkspaceTabsBar";
import WorkspaceTabsSheet from "@/components/workspace/WorkspaceTabsSheet";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import type { SurfaceHeaderOption } from "@/components/ui/SurfaceHeader";
import styles from "./WorkspaceShell.module.css";

export interface WorkspaceShellPane {
  paneId: string;
  title: string;
  subtitle?: React.ReactNode;
  toolbar?: React.ReactNode;
  actions?: React.ReactNode;
  options?: SurfaceHeaderOption[];
  bodyMode: PaneBodyMode;
  widthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
  isActive: boolean;
  content: React.ReactNode;
}

interface WorkspaceShellProps {
  panes: WorkspaceShellPane[];
  activePaneId: string;
  onActivatePane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onResizePane: (paneId: string, widthPx: number) => void;
}

export default function WorkspaceShell({
  panes,
  activePaneId,
  onActivatePane,
  onClosePane,
  onResizePane,
}: WorkspaceShellProps) {
  const isMobile = useIsMobileViewport();
  const [sheetOpen, setSheetOpen] = useState(false);
  const mobileSwitcherButtonRef = useRef<HTMLButtonElement>(null);
  const paneWrapRefById = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingPaneChromeFocusPaneIdRef = useRef<string | null>(null);

  const tabs = useMemo(
    () =>
      panes.map((pane) => ({
        paneId: pane.paneId,
        title: pane.title,
        isActive: pane.isActive,
      })),
    [panes]
  );

  const activePane = panes.find((pane) => pane.paneId === activePaneId) ?? panes[0] ?? null;
  const visiblePanes = isMobile ? (activePane ? [activePane] : []) : panes;

  useEffect(() => {
    if (sheetOpen) {
      return;
    }
    const pendingPaneId = pendingPaneChromeFocusPaneIdRef.current;
    if (!pendingPaneId) {
      return;
    }
    const paneWrap = paneWrapRefById.current.get(pendingPaneId);
    if (!paneWrap) {
      return;
    }
    paneWrap.scrollIntoView({ block: "nearest", inline: "nearest" });
    const chrome = paneWrap.querySelector<HTMLElement>(
      '[data-pane-chrome-focus="true"]'
    );
    if (!chrome) {
      return;
    }
    chrome.focus({ preventScroll: true });
    pendingPaneChromeFocusPaneIdRef.current = null;
  }, [activePaneId, sheetOpen]);

  const handleActivatePane = (
    paneId: string,
    options?: { focusPaneChrome?: boolean }
  ) => {
    const shouldFocusPaneChrome = options?.focusPaneChrome !== false;
    onActivatePane(paneId);
    const paneWrap = paneWrapRefById.current.get(paneId);
    paneWrap?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (!shouldFocusPaneChrome) {
      return;
    }
    if (!paneWrap) {
      pendingPaneChromeFocusPaneIdRef.current = paneId;
      return;
    }
    const chrome = paneWrap.querySelector<HTMLElement>(
      '[data-pane-chrome-focus="true"]'
    );
    if (!chrome) {
      pendingPaneChromeFocusPaneIdRef.current = paneId;
      return;
    }
    chrome.focus({ preventScroll: true });
    pendingPaneChromeFocusPaneIdRef.current = null;
  };

  return (
    <section className={styles.host} aria-label="Workspace host">
      <WorkspaceTabsBar
        tabs={tabs}
        onActivatePane={handleActivatePane}
        onClosePane={onClosePane}
        mobileSwitcherLabel="Open panes"
        onOpenMobileSwitcher={() => setSheetOpen(true)}
        mobileSwitcherButtonRef={mobileSwitcherButtonRef}
      />
      <PaneStrip>
        {visiblePanes.map((pane) => (
          <div
            key={pane.paneId}
            className={styles.paneWrap}
            id={`workspace-panel-${pane.paneId}`}
            aria-labelledby={`workspace-tab-${pane.paneId}`}
            data-active={pane.isActive ? "true" : "false"}
            data-mobile={isMobile ? "true" : "false"}
            ref={(element) => {
              if (element) {
                paneWrapRefById.current.set(pane.paneId, element);
              } else {
                paneWrapRefById.current.delete(pane.paneId);
              }
            }}
            onMouseDown={() => handleActivatePane(pane.paneId, { focusPaneChrome: false })}
          >
            <PaneShell
              paneId={pane.paneId}
              title={pane.title}
              subtitle={pane.subtitle}
              toolbar={pane.toolbar}
              actions={pane.actions}
              options={pane.options}
              widthPx={pane.widthPx}
              minWidthPx={pane.minWidthPx}
              maxWidthPx={pane.maxWidthPx}
              bodyMode={pane.bodyMode}
              onResizePane={onResizePane}
              isActive={pane.isActive}
              isMobile={isMobile}
            >
              {pane.content}
            </PaneShell>
          </div>
        ))}
      </PaneStrip>
      <WorkspaceTabsSheet
        open={isMobile && sheetOpen}
        tabs={tabs}
        triggerRef={mobileSwitcherButtonRef}
        onActivatePane={(paneId) => {
          handleActivatePane(paneId);
          setSheetOpen(false);
        }}
        onClosePane={onClosePane}
        onRequestClose={() => setSheetOpen(false)}
      />
    </section>
  );
}
