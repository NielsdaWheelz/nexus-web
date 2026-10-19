"use client";

import { useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import Button from "@/components/ui/Button";
import OverflowMenuButton from "@/components/ui/OverflowMenuButton";
import PaneHeaderIdentity from "@/components/ui/PaneHeaderIdentity";
import Tooltip from "@/components/ui/Tooltip";
import {
  useMobileChrome,
  useMobileChromeState,
  useMobileChromeSurface,
  useMobilePaneChrome,
} from "@/lib/mobileShell/chrome";
import { projectActionControlState } from "@/lib/ui/actionDescriptor";
import { cx } from "@/lib/ui/cx";
import styles from "./AppNav.module.css";

/** The active pane's history, identity, More and companion. */
export default function MobilePaneBar() {
  const chrome = useMobilePaneChrome();
  const mobileChrome = useMobileChrome();
  const visibility = useMobileChromeState();
  const recovery = visibility === null ? null : {
    Shown: { label: "hide reader controls", expanded: true, disabled: false },
    Hidden: { label: "show reader controls", expanded: false, disabled: false },
    Held: { label: "hide reader controls", expanded: true, disabled: true },
  }[visibility];
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
    <>
      {recovery !== null ? (
        <Button
          variant="secondary"
          className={cx("sr-only", styles.readerChromeToggle)}
          aria-expanded={recovery.expanded}
          disabled={recovery.disabled}
          onClick={mobileChrome.toggleReaderChrome}
        >
          {recovery.label}
        </Button>
      ) : null}
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
          {chrome && (paneActions.length > 0 || menuActions.length > 0 || chrome.resourceRef) ? (
            <ContextualActionMenu
              label={`More actions for ${chrome.header.title}`}
              sections={[
                { id: "Pane", actions: paneActions },
                { id: "View", actions: menuActions },
              ]}
              resourceRef={chrome.resourceRef}
              onDefect={chrome.onDefect}
              triggerAttributes={{ "data-pane-menu-trigger": chrome.paneId }}
              renderTrigger={(props) => (
                <OverflowMenuButton {...props} className={styles.overflowButton}>
                  {hiddenStatus ? <span className={styles.statusMarker} aria-hidden="true" /> : null}
                </OverflowMenuButton>
              )}
            />
          ) : null}
          {companion && companionState ? (
            <Tooltip
              text={companionState.menuLabel}
              renderTrigger={(props) => (
                <button
                  {...props}
                  type="button"
                  className={cx(styles.topBarButton, companionState.active && styles.topBarButtonActive)}
                  aria-label={companion.label}
                  aria-expanded={companionState.barExpanded}
                  aria-controls={companionState.barControls}
                  disabled={companion.disabled}
                  onClick={(event) => companion.onSelect({ triggerEl: event.currentTarget })}
                >
                  {companion.icon}
                </button>
              )}
            />
          ) : null}
        </div>
      </header>
    </>
  );
}
