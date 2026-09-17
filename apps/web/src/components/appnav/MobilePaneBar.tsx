"use client";

import { useCallback, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import PaneHeaderIdentity from "@/components/ui/PaneHeaderIdentity";
import {
  projectActionControlState,
  type ActionDescriptor,
} from "@/lib/ui/actionDescriptor";
import {
  useMobileChrome,
  useMobileChromeSurface,
} from "@/lib/workspace/mobileChrome";
import { usePaneWarmOnIntent } from "@/lib/panes/paneWarm";
import styles from "./AppNav.module.css";
import { pointerModality } from "@/lib/ui/pointerModality";

function activeCollapsedFilterAction(
  actions: readonly ActionDescriptor[],
): ActionDescriptor | null {
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
  const handleChromeIntentCapture = usePaneWarmOnIntent();
  const navigation = paneChrome?.navigation;
  const topBarRef = useRef<HTMLElement>(null);
  useMobileChromeSurface(topBarRef, "AppBar", true);

  const paneActions = paneChrome?.paneActions ?? [];
  const menuActions = paneChrome?.menuActions ?? [];
  const activeFilterAction = activeCollapsedFilterAction(paneActions);
  const hasHiddenStatus = [...paneActions, ...menuActions].some(
    (action) => action.indicator?.kind === "Status",
  );
  const hasMoreContent =
    paneActions.length > 0 ||
    menuActions.length > 0 ||
    paneChrome?.actionSubject !== undefined;
  const interactive =
    motionPhase.kind === "Visible" || motionPhase.kind === "Pinned";
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
  const companionAction = paneChrome?.companionAction;
  const companionState = companionAction
    ? projectActionControlState(companionAction.label, companionAction.state)
    : null;

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
      <div className={styles.topBarControls}>
        <button
          type="button"
          className={styles.topBarButton}
          onClick={(event) =>
            navigation?.onBack(pointerModality(event))
          }
          disabled={!navigation?.canGoBack}
          aria-label="Go back"
        >
          <ChevronLeft size={20} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.topBarButton}
          onClick={(event) =>
            navigation?.onForward(pointerModality(event))
          }
          disabled={!navigation?.canGoForward}
          aria-label="Go forward"
        >
          <ChevronRight size={20} aria-hidden="true" />
        </button>
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

      <div className={styles.topBarControls}>
        {companionAction && companionState ? (
          <button
            type="button"
            className={styles.topBarButton}
            aria-label={companionAction.label}
            aria-pressed={companionState.barPressed}
            aria-expanded={companionState.barExpanded}
            aria-controls={companionState.barControls}
            disabled={companionAction.disabled}
            onClick={(event) =>
              companionAction.onSelect({ triggerEl: event.currentTarget })
            }
          >
            {companionAction.icon}
          </button>
        ) : null}
        {paneChrome && hasMoreContent ? (
          <ContextualActionMenu
            label={
              activeFilterAction
                ? `More, ${activeFilterAction.label}`
                : "More"
            }
            sections={[
              { id: "Pane", actions: paneActions },
              { id: "View", actions: menuActions },
            ]}
            actionSubject={paneChrome.actionSubject}
            triggerAttributes={{
              "data-pane-menu-trigger": paneChrome.paneId,
            }}
            renderTrigger={(props) => (
              <button
                {...props}
                className={`${props.className} ${styles.topBarButton}`}
              >
                &hellip;
                {hasHiddenStatus ? (
                  <span
                    className={styles.topBarStatusMarker}
                    aria-hidden="true"
                  />
                ) : null}
              </button>
            )}
          />
        ) : null}
      </div>
    </header>
  );
}
