"use client";

import {
  useCallback,
  useMemo,
  useRef,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import ActionMenu from "@/components/ui/ActionMenu";
import PaneHeaderIdentity from "@/components/ui/PaneHeaderIdentity";
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
  const { motionPhase, paneChrome, finishSettle } = useMobileChrome();
  const visibleLocks = useMobileChromeVisibleLocks();
  const warmPane = usePaneWarm();
  const navigation = paneChrome?.navigation;
  const releaseLockRef = useRef<(() => void) | null>(null);
  const topBarRef = useRef<HTMLElement>(null);
  useMobileChromeSurface(topBarRef, "AppBar", true);

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
    return [
      ...forward,
      ...(paneChrome?.actions ?? []),
      ...(paneChrome?.options ?? []),
    ];
  }, [navigation, paneChrome?.actions, paneChrome?.options]);
  const activeFilterAction = activeCollapsedFilterAction(
    paneChrome?.actions ?? [],
  );
  const optionsLabel = activeFilterAction
    ? `Pane options, ${activeFilterAction.label}`
    : "Pane options";
  const controlsInert =
    motionPhase.kind !== "Visible" && motionPhase.kind !== "Pinned";
  const handleActionMenuOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        if (releaseLockRef.current) return;
        releaseLockRef.current = visibleLocks.acquire("action-menu");
        return;
      }
      releaseLockRef.current?.();
      releaseLockRef.current = null;
    },
    [visibleLocks],
  );
  const handleIdentityClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest("a[href]");
      if (anchor instanceof HTMLAnchorElement) {
        paneChrome?.activateIdentityAnchor(event, anchor);
      }
    },
    [paneChrome],
  );
  const handleIdentityIntentCapture = useCallback(
    (
      event: ReactMouseEvent<HTMLDivElement> | ReactFocusEvent<HTMLDivElement>,
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
      data-header-kind={paneChrome?.header.kind}
      data-pane-chrome-for={paneChrome?.paneId}
      onTransitionEnd={(event) => {
        if (
          event.target === event.currentTarget &&
          event.propertyName === "--mobile-chrome-collapse"
        ) {
          finishSettle();
        }
      }}
    >
      <div
        className={styles.topBarControls}
        data-testid="top-bar-controls"
        aria-hidden={controlsInert || undefined}
        inert={controlsInert || undefined}
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

      <div
        className={styles.topBarTitle}
        onClickCapture={handleIdentityClickCapture}
        onMouseOverCapture={handleIdentityIntentCapture}
        onFocusCapture={handleIdentityIntentCapture}
      >
        {paneChrome ? (
          <PaneHeaderIdentity
            creditsInert={controlsInert}
            id={paneChrome.identityId}
            model={paneChrome.header}
            projection="Mobile"
          />
        ) : null}
      </div>

      <div
        className={styles.topBarControls}
        data-testid="top-bar-controls"
        aria-hidden={controlsInert || undefined}
        inert={controlsInert || undefined}
      >
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
      </div>
    </header>
  );
}
