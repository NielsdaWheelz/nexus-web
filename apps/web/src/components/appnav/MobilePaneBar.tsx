"use client";

import { useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import PaneHeaderIdentity from "@/components/ui/PaneHeaderIdentity";
import { useMobileChromeSurface, useMobilePaneChrome } from "@/lib/mobileShell/chrome";
import { projectActionControlState } from "@/lib/ui/actionDescriptor";
import { cx } from "@/lib/ui/cx";
import styles from "./AppNav.module.css";

/** The fixed mobile top bar: the active pane's history, identity, More and companion. */
export default function MobilePaneBar() {
  const chrome = useMobilePaneChrome();
  const ref = useRef<HTMLElement>(null);
  useMobileChromeSurface(ref, true);
  const paneActions = chrome?.paneActions ?? [];
  const menuActions = chrome?.menuActions ?? [];
  const hiddenStatus = [...paneActions, ...menuActions].some(
    (action) => action.indicator?.kind === "Status",
  );
  const companion = chrome?.companionAction;
  const companionState = companion
    ? projectActionControlState(companion.label, companion.state)
    : null;

  return (
    <header
      ref={ref}
      className={styles.topBar}
      data-pane-chrome-for={chrome?.paneId}
      onClickCapture={(event) => {
        const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
        if (chrome && anchor instanceof HTMLAnchorElement) chrome.activateChromeAnchor(event, anchor);
      }}
    >
      <div className={styles.topBarControls}>
        <button
          type="button"
          className={styles.topBarButton}
          aria-label="Go back"
          disabled={!chrome?.navigation.canGoBack}
          onClick={() => chrome?.navigation.onBack()}
        >
          <ChevronLeft size={20} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.topBarButton}
          aria-label="Go forward"
          disabled={!chrome?.navigation.canGoForward}
          onClick={() => chrome?.navigation.onForward()}
        >
          <ChevronRight size={20} aria-hidden="true" />
        </button>
      </div>
      <div className={styles.topBarTitle}>
        {chrome ? (
          <PaneHeaderIdentity id={chrome.identityId} model={chrome.header} projection="Mobile" />
        ) : null}
      </div>
      <div className={styles.topBarControls}>
        {chrome && (paneActions.length > 0 || menuActions.length > 0 || chrome.actionSubject) ? (
          <ContextualActionMenu
            label="More"
            sections={[
              { id: "Pane", actions: paneActions },
              { id: "View", actions: menuActions },
            ]}
            actionSubject={chrome.actionSubject}
            triggerAttributes={{ "data-pane-menu-trigger": chrome.paneId }}
            renderTrigger={(props) => (
              <button {...props} className={cx(props.className, styles.topBarButton)}>
                &hellip;
                {hiddenStatus ? <span className={styles.statusMarker} aria-hidden="true" /> : null}
              </button>
            )}
          />
        ) : null}
        {companion && companionState ? (
          <button
            type="button"
            className={cx(styles.topBarButton, companionState.active && styles.topBarButtonActive)}
            aria-label={companion.label}
            aria-pressed={companionState.barPressed}
            aria-expanded={companionState.barExpanded}
            aria-controls={companionState.barControls}
            disabled={companion.disabled}
            onClick={(event) => companion.onSelect({ triggerEl: event.currentTarget })}
          >
            {companion.icon}
          </button>
        ) : null}
      </div>
    </header>
  );
}
