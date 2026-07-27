"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ChevronLeft, ChevronRight, Command, Plus } from "lucide-react";
import AsterismMark from "@/components/AsterismMark";
import ActionBar from "@/components/ui/ActionBar";
import ActionMenu from "@/components/ui/ActionMenu";
import PaneHeaderIdentity from "@/components/ui/PaneHeaderIdentity";
import {
  useMobileChrome,
  useMobileChromeSurface,
} from "@/lib/workspace/mobileChrome";
import { usePaneWarm } from "@/lib/panes/paneWarm";
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
  const { motionPhase, paneChrome, acquireVisibleLock, finishSettle } =
    useMobileChrome();
  const warmPane = usePaneWarm();
  const navigation = paneChrome?.navigation;
  const actions = paneChrome?.actions ?? [];
  const options = paneChrome?.options ?? [];
  const releaseLockRef = useRef<(() => void) | null>(null);
  const releaseFocusLockRef = useRef<(() => void) | null>(null);
  const topBarRef = useRef<HTMLElement>(null);
  useMobileChromeSurface(topBarRef, "AppBar");

  useEffect(
    () => () => {
      releaseLockRef.current?.();
      releaseLockRef.current = null;
      releaseFocusLockRef.current?.();
      releaseFocusLockRef.current = null;
    },
    [],
  );

  const showPaneCount = paneCount > 0;
  const commandLabel = showPaneCount
    ? `Search or ask anything (${pluralize(paneCount, "open tab")})`
    : "Search or ask anything";
  const controlsHidden = motionPhase.kind === "Hidden";
  const handleActionMenuOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        if (releaseLockRef.current) return;
        releaseLockRef.current = acquireVisibleLock("action-menu");
        return;
      }
      releaseLockRef.current?.();
      releaseLockRef.current = null;
    },
    [acquireVisibleLock],
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
      onFocusCapture={() => {
        if (releaseFocusLockRef.current) return;
        releaseFocusLockRef.current = acquireVisibleLock("chrome-focus");
      }}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        releaseFocusLockRef.current?.();
        releaseFocusLockRef.current = null;
      }}
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
        aria-hidden={controlsHidden || undefined}
        inert={controlsHidden || undefined}
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
          onClick={(event) =>
            navigation?.onBack(event.detail === 0 ? "Keyboard" : "Pointer")
          }
          disabled={!navigation?.canGoBack}
          aria-label="Go back"
        >
          <ChevronLeft size={20} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`${styles.topBarButton} ${styles.topBarForward}`}
          onClick={(event) =>
            navigation?.onForward(
              event.detail === 0 ? "Keyboard" : "Pointer",
            )
          }
          disabled={!navigation?.canGoForward}
          aria-label="Go forward"
        >
          <ChevronRight size={20} aria-hidden="true" />
        </button>
      </div>

      <div
        className={styles.topBarTitle}
        onClickCapture={handleIdentityClickCapture}
        onMouseOverCapture={handleIdentityIntentCapture}
        onFocusCapture={handleIdentityIntentCapture}
      >
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
        aria-hidden={controlsHidden || undefined}
        inert={controlsHidden || undefined}
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
            onOpenChange={handleActionMenuOpenChange}
          />
        )}
      </div>
    </header>
  );
}
