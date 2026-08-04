"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import ActionMenu from "@/components/ui/ActionMenu";
import PaneHeaderIdentity from "@/components/ui/PaneHeaderIdentity";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import type {
  ActionDescriptor,
  PaneHeaderAction,
} from "@/lib/ui/actionDescriptor";
import {
  useMobileChrome,
  useMobileChromeSurface,
  useMobileChromeVisibleLocks,
} from "@/lib/workspace/mobileChrome";
import { usePaneWarm } from "@/lib/panes/paneWarm";
import styles from "./AppNav.module.css";

function activeCollapsedFilterAction(
  actions: readonly PaneHeaderAction[],
): PaneHeaderAction | null {
  return (
    actions.find(
      (action) =>
        action.kind === "command" &&
        action.id === "Pane.Search" &&
        action.state?.kind === "disclosure" &&
        !action.state.expanded &&
        action.indicator?.kind === "Status",
    ) ?? null
  );
}

export default function MobilePaneBar() {
  const { motionPhase, paneChrome } = useMobileChrome();
  const { acquire } = useMobileChromeVisibleLocks();
  const warmPane = usePaneWarm();
  const navigation = paneChrome?.navigation;
  const releaseLockRef = useRef<(() => void) | null>(null);
  const topBarRef = useRef<HTMLElement>(null);
  useMobileChromeSurface(topBarRef, "AppBar", true);

  useEffect(
    () => () => {
      releaseLockRef.current?.();
      releaseLockRef.current = null;
    },
    [],
  );

  // The mobile "Pane options" menu carries ONLY non-resource pane furniture:
  // forward navigation + promoted actions (Companion, Search). The resource
  // dropdown is rendered separately as the canonical ResourceActionMenu — nav
  // and actions are never folded into it (AC4).
  const menuOptions = useMemo<readonly ActionDescriptor[]>(() => {
    const forward: ActionDescriptor[] = navigation?.canGoForward
      ? [
          {
            kind: "command",
            id: "pane-forward",
            label: "Go forward",
            icon: <ChevronRight size={18} aria-hidden="true" />,
            onSelect: () => navigation.onForward("Pointer"),
          },
        ]
      : [];
    return [...forward, ...(paneChrome?.actions ?? [])];
  }, [navigation, paneChrome?.actions]);
  const viewMenu = paneChrome?.viewMenu;
  const resourceTarget = paneChrome?.resourceTarget;
  const activeFilterAction = activeCollapsedFilterAction(
    paneChrome?.actions ?? [],
  );
  const optionsLabel = activeFilterAction
    ? `Pane options, ${activeFilterAction.label}`
    : "Pane options";
  const interactive =
    motionPhase.kind === "Visible" || motionPhase.kind === "Pinned";
  const handleActionMenuOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        if (releaseLockRef.current) return;
        releaseLockRef.current = acquire("action-menu");
        return;
      }
      releaseLockRef.current?.();
      releaseLockRef.current = null;
    },
    [acquire],
  );
  // Every anchor the active pane publishes into this bar — identity credits and
  // header actions alike — must reach the workspace router. Portalled menu
  // content still bubbles here through the React tree, and the desktop chrome
  // gets the same treatment from `PaneRouteBoundary`.
  const handleChromeClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest("a[href]");
      if (anchor instanceof HTMLAnchorElement) {
        paneChrome?.activateChromeAnchor(event, anchor);
      }
    },
    [paneChrome],
  );
  const handleChromeIntentCapture = useCallback(
    (
      event: ReactMouseEvent<HTMLElement> | ReactFocusEvent<HTMLElement>,
    ) => {
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const href = anchor.getAttribute("href");
      if (href && !href.startsWith("#")) warmPane(href);
    },
    [warmPane],
  );

  return (
    <header
      ref={topBarRef}
      className={styles.topBar}
      data-mobile-chrome-phase={motionPhase.kind}
      data-pane-chrome-for={paneChrome?.paneId}
      aria-hidden={!interactive || undefined}
      inert={!interactive || undefined}
      style={{ pointerEvents: interactive ? undefined : "none" }}
      onClickCapture={handleChromeClickCapture}
      onMouseOverCapture={handleChromeIntentCapture}
      onFocusCapture={handleChromeIntentCapture}
    >
      <div
        className={styles.topBarControls}
        data-testid="top-bar-controls"
      >
        {navigation?.canGoBack ? (
          <button
            type="button"
            className={styles.topBarButton}
            onClick={(event) =>
              navigation.onBack(event.detail === 0 ? "Keyboard" : "Pointer")
            }
            aria-label="Go back"
          >
            <ChevronLeft size={20} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className={styles.topBarTitle}>
        {paneChrome ? (
          <PaneHeaderIdentity
            id={paneChrome.identityId}
            model={paneChrome.header}
            projection="Mobile"
          />
        ) : null}
      </div>

      <div
        className={styles.topBarControls}
        data-testid="top-bar-controls"
      >
        {paneChrome?.controls}
        {viewMenu ? (
          <ActionMenu
            options={viewMenu.actions}
            label={viewMenu.label}
            className={styles.topBarOptions}
            onOpenChange={handleActionMenuOpenChange}
            renderTrigger={(props) => (
              <button {...props}>{viewMenu.icon}</button>
            )}
          />
        ) : null}
        {paneChrome ? (
          <ActionMenu
            options={menuOptions}
            label={optionsLabel}
            className={styles.topBarOptions}
            triggerAttributes={{
              "data-pane-options-trigger": paneChrome?.paneId,
            }}
            onOpenChange={handleActionMenuOpenChange}
            renderTrigger={
              activeFilterAction
                ? (props) => (
                    <button {...props}>
                      &hellip;
                      <span
                        className={styles.topBarFilterMarker}
                        data-testid="pane-filter-active-marker"
                        aria-hidden="true"
                      />
                    </button>
                  )
                : undefined
            }
          />
        ) : null}
        {resourceTarget ? (
          <ResourceActionMenu target={resourceTarget} label="Actions" />
        ) : null}
      </div>
    </header>
  );
}
