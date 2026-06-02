"use client";

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import SurfaceHeader, {
  type SurfaceHeaderNavigation,
} from "@/components/ui/SurfaceHeader";
import type { PaneSecondaryPublication } from "@/components/workspace/PaneSecondary";
import type { PaneFixedChromePublication } from "@/components/workspace/PaneFixedChrome";
import SecondaryPaneShell from "@/components/workspace/SecondaryPaneShell";
import { useResizeHandle } from "@/components/workspace/useResizeHandle";
import { useMobileChrome } from "@/lib/workspace/mobileChrome";
import type { PaneBodyMode } from "@/lib/panes/paneRouteModel";
import type { EffectivePaneSizing } from "@/lib/workspace/paneSizing";
import type {
  WorkspaceSecondarySizing,
  WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import type { WorkspaceAttachedSecondaryPaneState } from "@/lib/workspace/schema";
import styles from "./PaneShell.module.css";

// ---------------------------------------------------------------------------
// Chrome override — lets body components push toolbar/options/meta into the
// PaneShell chrome without routing through the workspace store.
// ---------------------------------------------------------------------------

interface PaneChromeOverrides {
  toolbar?: React.ReactNode;
  actions?: React.ReactNode;
  options?: ActionMenuOption[];
  meta?: React.ReactNode;
}

const EMPTY_PANE_CHROME_OVERRIDES: PaneChromeOverrides = {};

function fallbackCopyText(value: string): void {
  if (typeof document === "undefined") return;
  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "true");
  textArea.style.position = "fixed";
  textArea.style.top = "-1000px";
  document.body.appendChild(textArea);
  textArea.select();
  document.execCommand("copy");
  document.body.removeChild(textArea);
}

function copyText(value: string): void {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(value).catch(() => fallbackCopyText(value));
    return;
  }
  fallbackCopyText(value);
}

const PaneChromeOverrideContext = createContext<
  ((overrides: PaneChromeOverrides) => void) | null
>(null);

function arePaneChromeOverridesEqual(
  left: PaneChromeOverrides,
  right: PaneChromeOverrides,
): boolean {
  return (
    left.toolbar === right.toolbar &&
    left.actions === right.actions &&
    areActionMenuOptionsEqual(left.options, right.options) &&
    left.meta === right.meta
  );
}

function areActionMenuOptionsEqual(
  left: ActionMenuOption[] | undefined,
  right: ActionMenuOption[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((option, index) => {
    const other = right[index];
    return (
      other?.id === option.id &&
      other.label === option.label &&
      other.render === option.render &&
      other.onSelect === option.onSelect &&
      other.href === option.href &&
      other.disabled === option.disabled &&
      other.tone === option.tone &&
      other.restoreFocusOnClose === option.restoreFocusOnClose &&
      other.separatorBefore === option.separatorBefore
    );
  });
}

const noopResizeSecondaryPane = () => {};
const noopCloseSecondary = () => {};
const noopSetActiveSecondarySurface = () => {};

/**
 * Call from a body component rendered inside PaneShell to push toolbar,
 * options, meta, or actions into the pane chrome.
 */
export function usePaneChromeOverride(overrides: PaneChromeOverrides): void {
  const setOverrides = useContext(PaneChromeOverrideContext);
  const { actions, meta, options, toolbar } = overrides;
  const lastPublishedRef = useRef<PaneChromeOverrides | null>(null);
  useEffect(() => {
    if (!setOverrides) {
      return;
    }
    const next = { actions, meta, options, toolbar };
    if (
      lastPublishedRef.current &&
      arePaneChromeOverridesEqual(lastPublishedRef.current, next)
    ) {
      return;
    }
    lastPublishedRef.current = next;
    setOverrides(next);
  }, [actions, meta, options, setOverrides, toolbar]);

  useEffect(() => {
    if (!setOverrides) {
      return;
    }
    return () => {
      lastPublishedRef.current = null;
      setOverrides(EMPTY_PANE_CHROME_OVERRIDES);
    };
  }, [setOverrides]);
}

const PaneShellBodyProviders = memo(function PaneShellBodyProviders({
  children,
  setChromeOverrides,
}: {
  children: React.ReactNode;
  setChromeOverrides: (overrides: PaneChromeOverrides) => void;
}) {
  return (
    <PaneChromeOverrideContext.Provider value={setChromeOverrides}>
      {children}
    </PaneChromeOverrideContext.Provider>
  );
});

type PaneShellStyle = CSSProperties & {
  "--mobile-pane-chrome-height"?: string;
};

interface PaneShellProps {
  paneId: string;
  href?: string;
  title: string;
  titlePending?: boolean;
  subtitle?: React.ReactNode;
  toolbar?: React.ReactNode;
  actions?: React.ReactNode;
  options?: ActionMenuOption[];
  navigation: SurfaceHeaderNavigation;
  sizing: EffectivePaneSizing;
  bodyMode: PaneBodyMode;
  secondaryPane?: WorkspaceAttachedSecondaryPaneState | null;
  secondarySizing?: WorkspaceSecondarySizing | null;
  secondaryPublication?: PaneSecondaryPublication | null;
  fixedChromePublication?: PaneFixedChromePublication | null;
  onResizePrimaryPane: (paneId: string, widthPx: number) => void;
  onResizeSecondaryPane?: (secondaryPaneId: string, widthPx: number) => void;
  onCloseSecondaryPane?: (secondaryPaneId: string) => void;
  onSetSecondarySurface?: (
    secondaryPaneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
  ) => void;
  onChromeMouseDown?: (event: React.MouseEvent<HTMLElement>) => void;
  isActive?: boolean;
  isMobile?: boolean;
  children: React.ReactNode;
}

export default function PaneShell({
  paneId,
  href = "/",
  title,
  titlePending,
  subtitle,
  toolbar,
  actions,
  options,
  navigation,
  sizing,
  bodyMode,
  secondaryPane = null,
  secondarySizing = null,
  secondaryPublication = null,
  fixedChromePublication = null,
  onResizePrimaryPane,
  onResizeSecondaryPane = noopResizeSecondaryPane,
  onCloseSecondaryPane = noopCloseSecondary,
  onSetSecondarySurface = noopSetActiveSecondarySurface,
  onChromeMouseDown,
  isActive = false,
  isMobile = false,
  children,
}: PaneShellProps) {
  const { handleResizeMouseDown, handleResizeKeyDown } = useResizeHandle({
    id: paneId,
    widthPx: sizing.primaryWidthPx,
    minWidthPx: sizing.primaryMinWidthPx,
    maxWidthPx: sizing.primaryMaxWidthPx,
    onResize: onResizePrimaryPane,
  });
  const chromeRef = useRef<HTMLDivElement>(null);
  const [mobileChromeHeight, setMobileChromeHeight] = useState(0);
  const [chromeOverrides, setChromeOverrides] = useState<PaneChromeOverrides>(
    EMPTY_PANE_CHROME_OVERRIDES
  );
  const publishChromeOverrides = useCallback((overrides: PaneChromeOverrides) => {
    setChromeOverrides((current) =>
      arePaneChromeOverridesEqual(current, overrides) ? current : overrides
    );
  }, []);
  const { hidden, setPaneChrome } = useMobileChrome();

  const effectiveToolbar = chromeOverrides.toolbar ?? toolbar;
  const effectiveActions = chromeOverrides.actions ?? actions;
  const effectiveOptions = chromeOverrides.options ?? options;
  const mobileChromeHidden = isMobile && hidden;

  // Measure the mobile toolbar bar so document readers can reserve top space.
  useLayoutEffect(() => {
    if (!isMobile || !chromeRef.current) {
      setMobileChromeHeight(0);
      return;
    }
    const node = chromeRef.current;
    const update = () => {
      setMobileChromeHeight(Math.max(0, Math.round(node.getBoundingClientRect().height)));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [isMobile, effectiveToolbar]);

  const copyPaneLink = useCallback(() => {
    const link =
      typeof window === "undefined"
        ? href
        : new URL(href, window.location.origin).toString();
    copyText(link);
  }, [href]);
  const paneMenuOptions = useMemo<ActionMenuOption[]>(() => {
    const routeOptions = effectiveOptions ?? [];
    const contextualOptions = routeOptions.map((option, index) =>
      index === 0
        ? { ...option, separatorBefore: option.separatorBefore ?? true }
        : option
    );
    return [
      {
        id: "copy-pane-link",
        label: "Copy pane link",
        onSelect: copyPaneLink,
      },
      ...contextualOptions,
    ];
  }, [copyPaneLink, effectiveOptions]);

  // Publish the active pane's chrome to the lifted mobile top bar.
  useEffect(() => {
    if (!isMobile) return;
    setPaneChrome({
      paneId,
      title,
      navigation,
      options: paneMenuOptions,
    });
    return () => setPaneChrome(null);
  }, [isMobile, paneId, title, navigation, paneMenuOptions, setPaneChrome]);

  const shellClass = mobileChromeHidden
    ? `${styles.paneShell} ${styles.mobileChromeHidden}`
    : styles.paneShell;

  const bodyId = `${paneId}-body`;
  const visibleSecondary =
    !isMobile &&
    secondaryPane?.visibility === "visible" &&
    secondarySizing &&
    secondaryPublication?.groupId === secondaryPane.groupId &&
    secondaryPublication.surfaces.some(
      (surface) => surface.id === secondaryPane.activeSurfaceId
    )
      ? { state: secondaryPane, sizing: secondarySizing, publication: secondaryPublication }
      : null;
  const visibleSecondaryWidthPx = visibleSecondary?.sizing.widthPx ?? 0;
  const visibleFixedChrome = !isMobile ? fixedChromePublication : null;
  const shellStyle: PaneShellStyle = isMobile
    ? { width: "100%", minWidth: "100%", maxWidth: "100%" }
    : {
        width: `${sizing.renderedPrimarySlotWidthPx + visibleSecondaryWidthPx}px`,
        minWidth: `${sizing.renderedPrimarySlotMinWidthPx + visibleSecondaryWidthPx}px`,
        maxWidth: `${sizing.renderedPrimarySlotMaxWidthPx + visibleSecondaryWidthPx}px`,
      };
  if (isMobile && mobileChromeHeight > 0) {
    shellStyle["--mobile-pane-chrome-height"] = `${mobileChromeHeight}px`;
  }

  let bodyStyle: CSSProperties;
  switch (bodyMode) {
    case "standard":
      bodyStyle = {
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflowY: "auto",
        overflowX: "hidden",
        ...(isMobile && { overscrollBehavior: "contain" }),
      };
      break;
    case "document":
      bodyStyle = {
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
        ...(isMobile && { overscrollBehavior: "contain" }),
      };
      break;
    case "contained":
      bodyStyle = {
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
        ...(isMobile && { overscrollBehavior: "contain" }),
      };
      break;
    default: {
      const exhaustive: never = bodyMode;
      throw new Error(`Unhandled pane body mode: ${exhaustive}`);
    }
  }

  return (
    <section
      className={shellClass}
      data-testid="pane-shell-root"
      data-pane-shell="true"
      data-active={isActive ? "true" : "false"}
      data-mobile-chrome-hidden={mobileChromeHidden ? "true" : "false"}
      data-mobile={isMobile ? "true" : "false"}
      style={shellStyle}
    >
      <div
        className={styles.primaryPane}
        style={{
          width: isMobile ? "100%" : `${sizing.renderedPrimarySlotWidthPx}px`,
          minWidth: isMobile
            ? "100%"
            : `${sizing.renderedPrimarySlotMinWidthPx}px`,
          maxWidth: isMobile
            ? "100%"
            : `${sizing.renderedPrimarySlotMaxWidthPx}px`,
        }}
      >
        <div
          ref={chromeRef}
          className={styles.chrome}
          data-testid="pane-shell-chrome"
          data-pane-chrome-focus="true"
          tabIndex={-1}
          onMouseDown={onChromeMouseDown}
        >
          {!isMobile ? (
            <SurfaceHeader
              title={title}
              titlePending={titlePending}
              subtitle={subtitle}
              meta={chromeOverrides.meta}
              options={paneMenuOptions}
              actions={effectiveActions}
              navigation={navigation}
            />
          ) : null}
          {effectiveToolbar ? (
            <div className={styles.toolbar}>{effectiveToolbar}</div>
          ) : null}
        </div>
        <div
          className={styles.primaryContentRow}
          style={{
            gridTemplateColumns: isMobile
              ? "minmax(0, 1fr)"
              : visibleFixedChrome
              ? `${sizing.primaryWidthPx}px ${visibleFixedChrome.widthPx}px`
              : `${sizing.primaryWidthPx}px`,
          }}
        >
          <div
            className={styles.body}
            id={bodyId}
            data-testid="pane-shell-body"
            data-body-mode={bodyMode}
            data-pane-content="true"
            style={bodyStyle}
          >
            <PaneShellBodyProviders setChromeOverrides={publishChromeOverrides}>
              {children}
            </PaneShellBodyProviders>
          </div>
          {visibleFixedChrome ? (
            <div className={styles.fixedChrome} data-testid="pane-fixed-chrome">
              {visibleFixedChrome.body}
            </div>
          ) : null}
        </div>
        <div
          className={styles.resizeHandle}
          role="separator"
          aria-label={`Resize pane ${title}`}
          aria-controls={bodyId}
          aria-orientation="vertical"
          aria-valuemin={sizing.primaryMinWidthPx}
          aria-valuemax={sizing.primaryMaxWidthPx}
          aria-valuenow={sizing.primaryWidthPx}
          tabIndex={0}
          onMouseDown={handleResizeMouseDown}
          onKeyDown={handleResizeKeyDown}
        />
      </div>
      {visibleSecondary ? (
        <SecondaryPaneShell
          secondaryPaneId={visibleSecondary.state.id}
          publication={visibleSecondary.publication}
          state={visibleSecondary.state}
          sizing={visibleSecondary.sizing}
          onActiveSurfaceChange={onSetSecondarySurface}
          onClose={onCloseSecondaryPane}
          onResize={onResizeSecondaryPane}
        />
      ) : null}
    </section>
  );
}
