"use client";

import {
  FileText,
  GitBranch,
  ListTree,
  Network,
  PanelRight,
  TextSearch,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { FindResults } from "@/components/find/FindBar";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import Button from "@/components/ui/Button";
import MobileSheet from "@/components/ui/MobileSheet";
import ResizeHandle from "@/components/workspace/ResizeHandle";
import type { FindController } from "@/lib/find/useFind";
import {
  usePaneChromeState,
  type PaneChromeState,
  type PaneChromeStore,
  type PaneCompanion,
  type PaneCompanionAction,
} from "@/lib/panes/paneChrome";
import {
  COMPANION_MIN_WIDTH_PX,
  companionWidthPx,
  paneSecondaryRegionId,
  SECONDARY_SURFACES,
  type WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import {
  hasActiveInteractionOwner,
  isTopmostInteractionOwner,
  OverlayContext,
  useInteractionBlocked,
  type Layer,
} from "@/lib/ui/overlay";
import type { WorkspaceSecondaryPane } from "@/lib/workspace/model";
import {
  findPaneChromeFocusTarget,
  findPaneLandmarkFocusTarget,
} from "@/lib/workspace/paneDom";
import type { SecondaryPanePatch } from "@/lib/workspace/store";
import styles from "./Companion.module.css";

type TabId = WorkspaceSecondarySurfaceId | "find-results";
export type CompanionPresentation = "Column" | "Sheet";
const ICONS: Record<TabId, LucideIcon> = {
  "resource-contents": ListTree,
  "resource-members": Users,
  "resource-connections": Network,
  "resource-forks": GitBranch,
  "import-detail": FileText,
  "find-results": TextSearch,
};
const title = (id: TabId) =>
  id === "find-results" ? "Search results" : SECONDARY_SURFACES[id].title;

function published(
  companion: PaneCompanion | null,
  surfaceId: WorkspaceSecondarySurfaceId,
): boolean {
  return (
    companion?.surfaces.some((surface) => surface.id === surfaceId) ?? false
  );
}

/** A stored Companion shows its remembered tab while published, else the default. */
function shownSurface(
  companion: PaneCompanion,
  secondary: WorkspaceSecondaryPane,
): WorkspaceSecondarySurfaceId {
  return published(companion, secondary.active_surface_id)
    ? secondary.active_surface_id
    : companion.defaultSurfaceId;
}

export type CompanionController = ReturnType<typeof createCompanionController>;

/**
 * Every Companion command of one pane, stable for its life and acting on its
 * latest facts. The durable Companion is the store's `secondary`; Find's
 * results are this pane's transient tab. A command acts only on a surface the
 * pane publishes now, and nothing but a command opens, closes or retargets it.
 */
export function createCompanionController(input: {
  readonly paneId: string;
  readonly chrome: PaneChromeStore;
  readonly latest: () => {
    readonly secondary: WorkspaceSecondaryPane | null;
    readonly presentation: CompanionPresentation;
  };
  readonly requestSecondarySurface: (
    paneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
  ) => void;
  readonly updateSecondaryPane: (
    secondaryPaneId: string,
    patch: SecondaryPanePatch,
  ) => void;
}) {
  const { paneId, chrome, latest } = input;
  const focusLater = (target: HTMLElement | null) => {
    const from = document.activeElement;
    requestAnimationFrame(() => {
      if (!target?.isConnected || target.closest("[hidden], [inert]") ||
        hasActiveInteractionOwner() ||
        (document.activeElement !== from && document.activeElement !== document.body)) return;
      target.focus({ preventScroll: true });
    });
  };
  const update = (patch: SecondaryPanePatch) => {
    const { secondary } = latest();
    if (secondary) input.updateSecondaryPane(secondary.id, patch);
  };
  const open = (surfaceId: WorkspaceSecondarySurfaceId) => {
    chrome.skipReturnFocus = false;
    chrome.set({ results: null });
    input.requestSecondarySurface(paneId, surfaceId);
  };
  const controller = {
    /** null opens the remembered tab while published, else the default. */
    requestSecondarySurface(
      surfaceId: WorkspaceSecondarySurfaceId | null,
      options?: { readonly returnFocusTo?: HTMLElement | null },
    ) {
      const { companion } = chrome.get();
      const { secondary } = latest();
      const target =
        surfaceId ??
        (companion && secondary?.group_id === companion.groupId
          ? shownSurface(companion, secondary)
          : companion?.defaultSurfaceId);
      if (!target || !published(companion, target)) return;
      // commands without an invoker return to the pane, preserving its viewport.
      const opener = options?.returnFocusTo ?? findPaneLandmarkFocusTarget(paneId);
      chrome.returnFocus = opener?.isConnected ? opener : null;
      open(target);
    },
    /** Collapses it; focus goes to `focusAfterClose`, else its opener, else the pane chrome. */
    closeSecondaryPane(options?: {
      readonly focusAfterClose?: HTMLElement | null;
      readonly restoreFocus?: boolean;
    }) {
      chrome.skipReturnFocus = options?.restoreFocus === false;
      const results = chrome.get().results;
      if (results) chrome.set({ results: { ...results, expanded: false } });
      const destination = options?.focusAfterClose;
      const opener = chrome.returnFocus;
      chrome.returnFocus = destination?.isConnected
        ? destination
        : opener?.isConnected
          ? opener
          : null;
      update({ visibility: "collapsed" });
      // the sheet returns focus to `returnFocus` as it closes.
      if (latest().presentation === "Sheet") return;
      if (!chrome.skipReturnFocus) focusLater(chrome.returnFocus ?? findPaneChromeFocusTarget(paneId));
      chrome.returnFocus = null;
    },
    /** The Inspector: closes the durable Companion shown open, else opens it. */
    toggleSecondaryPane(options?: {
      readonly returnFocusTo?: HTMLElement | null;
    }) {
      if (companionExpanded(chrome.get(), latest().secondary))
        controller.closeSecondaryPane();
      else controller.requestSecondarySurface(null, options);
    },
    /** A tab: over Find's results it ends them and opens that durable tab. */
    select(surfaceId: WorkspaceSecondarySurfaceId) {
      const { companion, results } = chrome.get();
      if (!published(companion, surfaceId)) return;
      if (results) open(surfaceId);
      else update({ active_surface_id: surfaceId });
    },
    /** One width per pane: the durable record's once it exists. */
    resize(widthPx: number) {
      const { results } = chrome.get();
      if (latest().secondary) update({ width_px: widthPx });
      else if (results) chrome.set({ results: { ...results, widthPx } });
    },
    showResults(opener: HTMLElement) {
      chrome.skipReturnFocus = false;
      const { results } = chrome.get();
      chrome.returnFocus = opener;
      chrome.set({
        results: {
          expanded: true,
          widthPx: results?.widthPx ?? companionWidthPx(null),
        },
      });
    },
    closeResults() {
      const opener = chrome.returnFocus;
      chrome.returnFocus = null;
      chrome.set({ results: null });
      if (latest().presentation === "Column") focusLater(opener);
    },
    /** A match shown from a sheet hides it; the results live on. */
    previewed() {
      const { results } = chrome.get();
      if (results && latest().presentation === "Sheet")
        chrome.set({ results: { ...results, expanded: false } });
    },
  };
  return controller;
}

/** The Inspector header action: shown iff the pane publishes a Companion. */
export function companionAction(
  controller: CompanionController,
  paneId: string,
  expanded: boolean,
): PaneCompanionAction {
  const menuLabels = {
    collapsed: "Show inspector",
    expanded: "Hide inspector",
  };
  return {
    kind: "command",
    id: "resource-inspector-companion",
    label: "Inspector",
    icon: <PanelRight size={20} aria-hidden="true" />,
    // the controller owns focus return.
    restoreFocusOnClose: false,
    state: expanded
      ? {
          kind: "disclosure",
          expanded: true,
          controls: paneSecondaryRegionId(paneId),
          menuLabels,
        }
      : { kind: "disclosure", expanded: false, menuLabels },
    onSelect: ({ triggerEl }) =>
      controller.toggleSecondaryPane({ returnFocusTo: triggerEl }),
  };
}

/** Whether the durable Companion is shown open, not under Find's results. */
export function companionExpanded(
  { chrome, companion, results }: PaneChromeState,
  secondary: WorkspaceSecondaryPane | null,
): boolean {
  return (
    !(
      results !== null &&
      chrome?.query?.kind === "Find" &&
      chrome.query.find !== null
    ) &&
    companion !== null &&
    secondary?.group_id === companion.groupId &&
    secondary.visibility === "visible"
  );
}

/** The destination contributes its real modal ancestry to the retained subtree. */
function CompanionSlot({
  presentation,
  mount,
}: {
  readonly presentation: CompanionPresentation;
  readonly mount: (
    slot: HTMLDivElement,
    parent: Layer | null,
    presentation: CompanionPresentation,
  ) => (() => void) | undefined;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const parent = useContext(OverlayContext);
  useLayoutEffect(
    () => mount(slot.current!, parent, presentation),
    [mount, parent, presentation],
  );
  return <div ref={slot} className={styles.slot} />;
}

/** One inspector subtree moves between a column and a sheet without losing drafts. */
export default function Companion(props: {
  readonly paneId: string;
  readonly presentation: CompanionPresentation;
  readonly isVisible: boolean;
  readonly maxWidthPx: number;
  readonly chrome: PaneChromeStore;
  readonly controller: CompanionController;
  readonly secondary: WorkspaceSecondaryPane | null;
  readonly find: FindController | null;
  readonly resourceRef: CanonicalResourceRef | undefined;
  readonly resourceTitle: string;
}): ReactNode {
  const { paneId, presentation, isVisible, chrome, controller, secondary, find } = props;
  const { companion, results } = usePaneChromeState(chrome);
  const baseId = useId();
  const regionId = paneSecondaryRegionId(paneId);
  const tabRefs = useRef(new Map<TabId, HTMLButtonElement>());
  const closeRef = useRef<HTMLButtonElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const [host] = useState(() => {
    if (typeof document === "undefined") return null;
    const element = document.createElement("div");
    element.className = styles.host;
    return element;
  });
  const [portalParent, setPortalParent] = useState<Layer | null>(null);
  const focusAfterMove = useRef<HTMLElement | null>(null);
  const [admitted, setAdmitted] = useState(false);
  const blocked = useInteractionBlocked(regionId);
  const resultsShown = results !== null && find !== null;
  const durable =
    companion && secondary?.group_id === companion.groupId ? companion : null;
  const activeId: TabId | null = resultsShown
    ? "find-results"
    : durable && secondary
      ? shownSurface(durable, secondary)
      : null;
  const open = resultsShown
    ? results.expanded
    : durable !== null && secondary?.visibility === "visible";
  const tabs: { readonly id: TabId; readonly body: ReactNode }[] = [
    ...(companion?.surfaces ?? []),
  ];
  if (resultsShown)
    tabs.push({
      id: "find-results",
      body: <FindResults find={find} onPreviewed={controller.previewed} />,
    });
  const close = resultsShown
    ? controller.closeResults
    : () => controller.closeSecondaryPane();
  const widthPx = Math.min(
    props.maxWidthPx,
    companionWidthPx(secondary ? secondary.width_px : results?.widthPx ?? null),
  );
  const latest = useRef({ activeId, isVisible, open });
  latest.current = { activeId, isVisible, open };
  const headerRef = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    // Ref cleanup precedes DOM removal; the slot's cleanup can run afterward.
    return () => {
      const focused = document.activeElement;
      if (latest.current.open && focused instanceof HTMLElement && element.contains(focused))
        focusAfterMove.current = focused;
    };
  }, []);
  const mount = useCallback((
    slot: HTMLDivElement,
    parent: Layer | null,
    destination: CompanionPresentation,
  ) => {
    if (!host) return;
    slot.append(host);
    setPortalParent(parent);
    const from = document.activeElement;
    // The retained portal's replacement header refs commit after this slot.
    const frame = requestAnimationFrame(() => {
      if (destination !== "Column") return;
      const previous = focusAfterMove.current;
      focusAfterMove.current = null;
      if (!previous || !latest.current.isVisible || !latest.current.open ||
        (hasActiveInteractionOwner() && !isTopmostInteractionOwner(regionId)) ||
        (document.activeElement !== from && document.activeElement !== document.body)) return;
      const target = previous.isConnected && !previous.closest("[hidden], [inert]")
        ? previous
        : previous.matches('[data-companion-close="true"]')
          ? closeRef.current
          : (latest.current.activeId && tabRefs.current.get(latest.current.activeId)) ?? closeRef.current;
      target?.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      const focused = document.activeElement;
      if (!latest.current.open) focusAfterMove.current = null;
      else if (focused instanceof HTMLElement &&
        (host.contains(focused) || parent?.element?.contains(focused)))
        focusAfterMove.current = focused;
      // The frame ref may already be detached while its header still has focus.
      else if (focused !== document.body && focused !== focusAfterMove.current)
        focusAfterMove.current = null;
      host.remove();
    };
  }, [host, regionId]);

  const wantsSheet = presentation === "Sheet" && isVisible && open;
  useLayoutEffect(() => {
    if (!wantsSheet) {
      setAdmitted(false);
      return;
    }
    if (admitted || blocked ||
      (hasActiveInteractionOwner() && !isTopmostInteractionOwner(regionId))) return;
    // A promotion uses the live external opener; a focused inspector input
    // keeps the opener already recorded by the command that opened it.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== document.body &&
      !host?.contains(focused) && !focused.closest("[hidden], [inert]")) {
      chrome.returnFocus = focused;
    }
    setAdmitted(true);
  }, [wantsSheet, admitted, blocked, regionId, chrome, host]);
  const sheetActive = wantsSheet && admitted;

  // a command opening the desktop column scrolls it into the canvas, so its ✕
  // is reachable. this follows what the commands wrote, not the column showing:
  // a mount, a late publication or a breakpoint round trip reveals nothing.
  const opened = results
    ? results.expanded && "find-results"
    : secondary?.visibility === "visible" && secondary.group_id;
  const wasOpened = useRef(opened);
  useLayoutEffect(() => {
    if (opened && opened !== wasOpened.current && presentation === "Column" && isVisible)
      asideRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    wasOpened.current = opened;
  }, [opened, presentation, isVisible]);
  // reveal the active tab without moving focus or scrolling the pane's ancestors.
  useLayoutEffect(() => {
    const tab = activeId ? tabRefs.current.get(activeId) : undefined;
    const list = tab?.parentElement;
    if (!tab || !list) return;
    const reveal = () => {
      const t = tab.getBoundingClientRect();
      const l = list.getBoundingClientRect();
      if (t.left < l.left) list.scrollLeft += t.left - l.left;
      else if (t.right > l.right) list.scrollLeft += t.right - l.right;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    return () => observer.disconnect();
  }, [activeId, tabs.length]);

  const columnKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (presentation !== "Column" || !isVisible || event.key !== "Escape" ||
      event.defaultPrevented || event.nativeEvent.isComposing ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      hasActiveInteractionOwner() || !event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  const select = (id: TabId) => {
    if (id !== "find-results") controller.select(id);
    // Every target tab already exists; deferred focus could reclaim a later editor.
    if (latest.current.isVisible &&
      (!hasActiveInteractionOwner() || isTopmostInteractionOwner(regionId))) {
      tabRefs.current.get(id)?.focus({ preventScroll: true });
    }
  };
  const header = (requestDismiss: () => void) => (
    <header ref={headerRef} className={styles.header}>
      {companion ? (
        <div
          className={styles.tabs}
          role="tablist"
          aria-label="Secondary surfaces"
        >
          {tabs.map(({ id }, index) => {
            const Icon = ICONS[id];
            const selected = id === activeId;
            return (
              <button
                key={id}
                ref={(element) => {
                  if (element) tabRefs.current.set(id, element);
                  else tabRefs.current.delete(id);
                }}
                id={`${baseId}-${id}-tab`}
                type="button"
                role="tab"
                aria-controls={`${baseId}-${id}-panel`}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                className={styles.tab}
                onClick={() => select(id)}
                onKeyDown={(event) => {
                  const last = tabs.length - 1;
                  const byKey: Partial<Record<string, number>> = {
                    ArrowRight: index === last ? 0 : index + 1,
                    ArrowLeft: index === 0 ? last : index - 1,
                    Home: 0,
                    End: last,
                  };
                  const next = byKey[event.key];
                  if (next === undefined) return;
                  event.preventDefault();
                  select(tabs[next]!.id);
                }}
              >
                <Icon size={16} aria-hidden="true" />
                <span className={styles.tabLabel}>{title(id)}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <span className={styles.soloTitle}>{activeId && title(activeId)}</span>
      )}
      {presentation === "Sheet" && props.resourceRef ? (
        <ContextualActionMenu
          sections={[]}
          resourceRef={props.resourceRef}
          title={props.resourceTitle}
          subjectKey={`companion:${paneId}:${activeId}:${props.resourceRef}`}
        />
      ) : null}
      <Button
        ref={closeRef}
        iconOnly
        aria-label={activeId ? `close ${title(activeId)}` : "close inspector"}
        data-companion-close="true"
        className={styles.close}
        onClick={requestDismiss}
        icon={<X size={15} aria-hidden="true" />} />
    </header>
  );
  // every tab's panel stays in the dom; only the active one mounts its body.
  const panels = tabs.map(({ id, body }) => (
    <div
      key={id}
      id={`${baseId}-${id}-panel`}
      role={companion ? "tabpanel" : undefined}
      aria-labelledby={companion ? `${baseId}-${id}-tab` : undefined}
      className={styles.body}
      hidden={id !== activeId}
    >
      {id === activeId ? body : null}
    </div>
  ));

  return (
    <>
      {presentation === "Column" && open && activeId !== null ? (
        <aside
          ref={asideRef}
          id={regionId}
          className={styles.column}
          style={{ width: widthPx }}
          aria-label={title(activeId)}
          onKeyDown={columnKeyDown}
        >
          <CompanionSlot presentation="Column" mount={mount} />
          <ResizeHandle
            label={`Resize ${title(activeId)}`}
            controls={`${baseId}-${activeId}-panel`}
            widthPx={widthPx}
            minWidthPx={COMPANION_MIN_WIDTH_PX}
            maxWidthPx={props.maxWidthPx}
            onResize={controller.resize}
          />
        </aside>
      ) : null}
      <MobileSheet
        active={sheetActive}
        panelId={regionId}
        onDismiss={close}
        ariaLabel={activeId ? title(activeId) : "Inspector"}
        renderHeader={({ requestDismiss }) => header(requestDismiss)}
        scrim="soft"
        initialFocus={(container) => {
          const previous = focusAfterMove.current;
          focusAfterMove.current = null;
          if (previous?.isConnected && container.contains(previous) && !previous.closest("[hidden], [inert]"))
            return previous;
          return container.querySelector<HTMLElement>(
            '[role="tab"][aria-selected="true"], [data-companion-close="true"]',
          );
        }}
        returnFocusTo={() => {
          const target = chrome.returnFocus;
          return target?.isConnected && !host?.contains(target) &&
            !target.closest("[hidden], [inert]")
            ? { element: target, preventScroll: true }
            : null;
        }}
        returnFocusFallback={() => findPaneLandmarkFocusTarget(paneId)}
        skipReturnFocus={() => chrome.skipReturnFocus || !isVisible || presentation !== "Sheet" ||
          (resultsShown && !results.expanded)}
        focusKey={activeId}
      >
        <CompanionSlot presentation="Sheet" mount={mount} />
      </MobileSheet>
      {host && open && activeId !== null ? createPortal(
        <OverlayContext value={portalParent}>
          <div className={styles.contents} onKeyDown={columnKeyDown}>
            {presentation === "Column" ? header(close) : null}
            {panels}
          </div>
        </OverlayContext>,
        host,
      ) : null}
    </>
  );
}
