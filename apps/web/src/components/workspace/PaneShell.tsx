"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import SurfaceHeader, {
  type SurfaceHeaderNavigation,
} from "@/components/ui/SurfaceHeader";
import { PanePrimaryChromeProvider } from "@/components/workspace/PanePrimaryChrome";
import SecondaryPaneShell from "@/components/workspace/SecondaryPaneShell";
import { useResizeHandle } from "@/components/workspace/useResizeHandle";
import {
  paneHeaderAccessibleName,
  resolvePaneHeaderModel,
} from "@/lib/panes/paneHeaderModel";
import {
  arePanePrimaryChromePublicationsEqual,
  secondaryPublicationIncludesSurface,
  type PaneFixedChromePublication,
  type PanePrimaryChromePublication,
  type PanePrimaryChromePublicationUpdate,
  type PaneSecondaryPublication,
} from "@/lib/panes/panePublications";
import type {
  PaneBodyMode,
  PaneRouteHeaderContract,
} from "@/lib/panes/paneRouteModel";
import { stripCoarseReaderQuery } from "@/lib/reader/readerLocationHref";
import { copyText } from "@/lib/ui/copyText";
import type {
  ActionDescriptor,
  PaneHeaderAction,
} from "@/lib/ui/actionDescriptor";
import { useMobileChrome } from "@/lib/workspace/mobileChrome";
import type { EffectivePaneSizing } from "@/lib/workspace/paneSizing";
import {
  isPaneSecondaryRegionId,
  paneSecondaryRegionId,
  type WorkspaceSecondarySizing,
  type WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import type { WorkspaceAttachedSecondaryPaneState } from "@/lib/workspace/schema";
import styles from "./PaneShell.module.css";

const noopResizeSecondaryPane = () => {};
const noopCloseSecondary = () => {};
const noopSetActiveSecondarySurface = () => {};
const EMPTY_HEADER_ACTIONS: readonly PaneHeaderAction[] = [];
const EMPTY_OPTIONS: readonly ActionDescriptor[] = [];

type PaneShellStyle = CSSProperties & {
  "--mobile-pane-chrome-height"?: string;
};

interface PaneShellProps {
  paneId: string;
  routeKey: string;
  routeHeader: PaneRouteHeaderContract;
  href?: string;
  label: string;
  labelPending?: boolean;
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
  routeKey,
  routeHeader,
  href = "/",
  label,
  labelPending = false,
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
  const currentRouteKeyRef = useRef(routeKey);
  currentRouteKeyRef.current = routeKey;
  const [mobileChromeHeight, setMobileChromeHeight] = useState(0);
  const [primaryChromeRecord, setPrimaryChromeRecord] = useState<{
    readonly routeKey: string;
    readonly publication: PanePrimaryChromePublication;
  } | null>(null);
  const { hidden, setPaneChrome } = useMobileChrome();
  const identityId = useId();
  const landmarkLabelId = useId();

  const publishPrimaryChrome = useCallback(
    (update: PanePrimaryChromePublicationUpdate) => {
      setPrimaryChromeRecord((current) => {
        if (update.routeKey !== currentRouteKeyRef.current) return current;
        if (!update.publication) {
          return current?.routeKey === update.routeKey ? null : current;
        }
        if (
          current?.routeKey === update.routeKey &&
          arePanePrimaryChromePublicationsEqual(
            current.publication,
            update.publication,
          )
        ) {
          return current;
        }
        return { routeKey: update.routeKey, publication: update.publication };
      });
    },
    [],
  );

  const acceptedPrimaryChrome =
    primaryChromeRecord !== null && primaryChromeRecord.routeKey === routeKey
      ? primaryChromeRecord.publication
      : null;
  // The mobile chrome provider re-renders active PaneShell consumers when a pane
  // publishes. Keep this projection referentially stable across that feedback render;
  // otherwise the publication effect below sees a new header, republishes, and can
  // starve the lazy pane body behind its Suspense fallback.
  const header = useMemo(
    () =>
      resolvePaneHeaderModel({
        currentRouteKey: routeKey,
        routeHeader,
        paneLabel: label,
        paneLabelPending: labelPending,
        publication: primaryChromeRecord
          ? {
              routeKey: primaryChromeRecord.routeKey,
              header: primaryChromeRecord.publication.header,
            }
          : null,
      }),
    [label, labelPending, primaryChromeRecord, routeHeader, routeKey],
  );
  const accessibleName = paneHeaderAccessibleName(header);
  const effectiveToolbar = acceptedPrimaryChrome?.toolbar;
  const effectiveActions =
    acceptedPrimaryChrome?.actions ?? EMPTY_HEADER_ACTIONS;
  const effectiveOptions = acceptedPrimaryChrome?.options ?? EMPTY_OPTIONS;
  const mobileChromeHidden = isMobile && hidden;
  const secondaryPresentation =
    secondaryPane &&
    secondaryPublication?.groupId === secondaryPane.groupId &&
    secondaryPublicationIncludesSurface(
      secondaryPublication,
      secondaryPane.activeSurfaceId,
    )
      ? { state: secondaryPane, publication: secondaryPublication }
      : null;
  const secondaryRegionId = secondaryPresentation
    ? paneSecondaryRegionId(paneId, secondaryPresentation.publication.groupId)
    : null;
  const reconciledActions = useMemo(
    () =>
      effectiveActions.filter((action) => {
        if (
          action.kind !== "command" ||
          action.state?.kind !== "disclosure" ||
          !action.state.expanded ||
          !isPaneSecondaryRegionId(paneId, action.state.controls)
        ) {
          return true;
        }
        return action.state.controls === secondaryRegionId;
      }),
    [effectiveActions, paneId, secondaryRegionId],
  );

  useLayoutEffect(() => {
    if (!isMobile || !chromeRef.current) {
      setMobileChromeHeight(0);
      return;
    }
    const node = chromeRef.current;
    const update = () => {
      setMobileChromeHeight(
        Math.max(0, Math.round(node.getBoundingClientRect().height)),
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [effectiveToolbar, isMobile]);

  const copyPaneLink = useCallback(() => {
    const repaired = stripCoarseReaderQuery(href);
    const link =
      typeof window === "undefined"
        ? repaired
        : new URL(repaired, window.location.origin).toString();
    copyText(link);
  }, [href]);
  const paneMenuOptions = useMemo<readonly ActionDescriptor[]>(() => {
    const copyOption: ActionDescriptor = {
      kind: "command",
      id: "copy-pane-link",
      label: "Copy pane link",
      onSelect: copyPaneLink,
    };
    const contextualOptions: ActionDescriptor[] = effectiveOptions.map(
      (option, index) =>
        index === 0 && option.separatorBefore === undefined
          ? { ...option, separatorBefore: true }
          : option,
    );
    const ordinaryOptions: ActionDescriptor[] = [
      copyOption,
      ...contextualOptions,
    ];
    return ordinaryOptions;
  }, [copyPaneLink, effectiveOptions]);
  useEffect(() => {
    if (!isMobile) return;
    // Direct header actions (e.g. the Companion toggle) travel on their own
    // channel so the mobile top bar renders them beside — never folded into —
    // the Options menu.
    setPaneChrome({
      paneId,
      identityId,
      header,
      navigation,
      actions: reconciledActions,
      options: paneMenuOptions,
    });
    return () => setPaneChrome(null);
  }, [
    header,
    identityId,
    isMobile,
    navigation,
    paneId,
    reconciledActions,
    paneMenuOptions,
    setPaneChrome,
  ]);

  const shellClass = mobileChromeHidden
    ? `${styles.paneShell} ${styles.mobileChromeHidden}`
    : styles.paneShell;
  const bodyId = `${paneId}-body`;
  const expandedActionRetainsSecondary = reconciledActions.some(
    (action) =>
      action.kind === "command" &&
      action.state?.kind === "disclosure" &&
      action.state.expanded &&
      action.state.controls === secondaryRegionId,
  );
  const visibleSecondary =
    !isMobile &&
    secondaryPresentation &&
    (secondaryPresentation.state.visibility === "visible" ||
      expandedActionRetainsSecondary) &&
    secondarySizing
      ? {
          state: secondaryPresentation.state,
          sizing: secondarySizing,
          publication: secondaryPresentation.publication,
        }
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
    case "contained":
      bodyStyle = {
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
        ...(isMobile && { overscrollBehavior: "contain" }),
      };
      break;
  }

  return (
    <section
      className={shellClass}
      aria-labelledby={landmarkLabelId}
      data-testid="pane-shell-root"
      data-pane-shell="true"
      data-header-kind={header.kind}
      data-active={isActive ? "true" : "false"}
      data-mobile-chrome-hidden={mobileChromeHidden ? "true" : "false"}
      data-mobile={isMobile ? "true" : "false"}
      style={shellStyle}
    >
      <span id={landmarkLabelId} className="sr-only">
        {accessibleName}
      </span>
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
              header={header}
              identityId={identityId}
              options={paneMenuOptions}
              actions={reconciledActions}
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
            <PanePrimaryChromeProvider publish={publishPrimaryChrome}>
              {children}
            </PanePrimaryChromeProvider>
          </div>
          {visibleFixedChrome ? (
            <div className={styles.fixedChrome} data-testid="pane-fixed-chrome">
              {visibleFixedChrome.body}
            </div>
          ) : null}
        </div>
        {!isMobile ? (
          <div
            className={styles.resizeHandle}
            role="separator"
            aria-label={`Resize pane ${label}`}
            aria-controls={bodyId}
            aria-orientation="vertical"
            aria-valuemin={sizing.primaryMinWidthPx}
            aria-valuemax={sizing.primaryMaxWidthPx}
            aria-valuenow={sizing.primaryWidthPx}
            tabIndex={0}
            onMouseDown={handleResizeMouseDown}
            onKeyDown={handleResizeKeyDown}
          />
        ) : null}
      </div>
      {visibleSecondary ? (
        <SecondaryPaneShell
          primaryPaneId={paneId}
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
