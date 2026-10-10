"use client";

import {
  FileText,
  GitBranch,
  ListTree,
  Network,
  PanelRight,
  Search,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { FindResults } from "@/components/find/FindBar";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
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
  COMPANION_MAX_WIDTH_PX,
  COMPANION_MIN_WIDTH_PX,
  companionWidthPx,
  paneSecondaryRegionId,
  SECONDARY_SURFACES,
  type WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { WorkspaceSecondaryPane } from "@/lib/workspace/model";
import {
  findPaneChromeFocusTarget,
  findPaneLandmarkFocusTarget,
} from "@/lib/workspace/paneDom";
import type { SecondaryPanePatch } from "@/lib/workspace/store";
import styles from "./Companion.module.css";

type TabId = WorkspaceSecondarySurfaceId | "find-results";
const ICONS: Record<TabId, LucideIcon> = {
  "resource-contents": ListTree,
  "resource-members": Users,
  "resource-connections": Network,
  "resource-forks": GitBranch,
  "resource-dossier": FileText,
  "import-detail": FileText,
  "find-results": Search,
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
  return published(companion, secondary.activeSurfaceId)
    ? secondary.activeSurfaceId
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
    readonly isMobile: boolean;
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
  const focusLater = (target: HTMLElement | null) =>
    requestAnimationFrame(() => target?.focus({ preventScroll: true }));
  const update = (patch: SecondaryPanePatch) => {
    const { secondary } = latest();
    if (secondary) input.updateSecondaryPane(secondary.id, patch);
  };
  const open = (surfaceId: WorkspaceSecondarySurfaceId) => {
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
        (companion && secondary?.groupId === companion.groupId
          ? shownSurface(companion, secondary)
          : companion?.defaultSurfaceId);
      if (!target || !published(companion, target)) return;
      const opener = options?.returnFocusTo;
      chrome.returnFocus = opener?.isConnected ? opener : null;
      open(target);
    },
    /** Collapses it; focus goes to `focusAfterClose`, else its opener, else the pane chrome. */
    closeSecondaryPane(options?: {
      readonly focusAfterClose?: HTMLElement | null;
    }) {
      const destination = options?.focusAfterClose;
      const opener = chrome.returnFocus;
      chrome.returnFocus = destination?.isConnected
        ? destination
        : opener?.isConnected
          ? opener
          : null;
      update({ visibility: "collapsed" });
      // on mobile the sheet returns focus to `returnFocus` as it closes.
      if (latest().isMobile) return;
      focusLater(chrome.returnFocus ?? findPaneChromeFocusTarget(paneId));
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
      else update({ activeSurfaceId: surfaceId });
    },
    /** One width per pane: the durable record's once it exists. */
    resize(widthPx: number) {
      const { results } = chrome.get();
      if (latest().secondary) update({ widthPx });
      else if (results) chrome.set({ results: { ...results, widthPx } });
    },
    showResults(opener: HTMLElement) {
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
      if (!latest().isMobile) focusLater(opener);
    },
    /** A match shown on mobile hides the sheet; the results live on. */
    previewed() {
      const { results } = chrome.get();
      if (results && latest().isMobile)
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
    icon: <PanelRight size={16} aria-hidden="true" />,
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
    !(results !== null && chrome?.search?.kind === "Find") &&
    companion !== null &&
    secondary?.groupId === companion.groupId &&
    secondary.visibility === "visible"
  );
}

/**
 * The pane's one Companion: a resizable column right of the primary on
 * desktop, a soft-scrim sheet on mobile, holding the published tabs plus Find's
 * transient "Search results" tab while it is shown.
 */
export default function Companion(props: {
  readonly paneId: string;
  readonly isMobile: boolean;
  readonly chrome: PaneChromeStore;
  readonly controller: CompanionController;
  readonly secondary: WorkspaceSecondaryPane | null;
  readonly find: FindController | null;
  readonly actionSubject: ResourceActionSubject | undefined;
}): ReactNode {
  const { paneId, isMobile, chrome, controller, secondary, find } = props;
  const { companion, results } = usePaneChromeState(chrome);
  const baseId = useId();
  const tabRefs = useRef(new Map<TabId, HTMLButtonElement>());
  const asideRef = useRef<HTMLElement>(null);
  const resultsShown = results !== null && find !== null;
  const durable =
    companion && secondary?.groupId === companion.groupId ? companion : null;
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
  const widthPx = secondary
    ? companionWidthPx(secondary.widthPx)
    : (results?.widthPx ?? 0);

  // a command opening the desktop column scrolls it into the canvas, so its ✕
  // is reachable. this follows what the commands wrote, not the column showing:
  // a mount, a late publication or a breakpoint round trip reveals nothing.
  const opened = results
    ? results.expanded && "find-results"
    : secondary?.visibility === "visible" && secondary.groupId;
  const wasOpened = useRef(opened);
  useLayoutEffect(() => {
    if (opened && opened !== wasOpened.current && !isMobile)
      asideRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    wasOpened.current = opened;
  }, [opened, isMobile]);
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

  if (activeId === null) {
    // the sheet stays mounted on mobile (its history and focus contract).
    return isMobile ? (
      <MobileSheet active={false} onDismiss={close} ariaLabel="">
        {null}
      </MobileSheet>
    ) : null;
  }
  const select = (id: TabId) => {
    if (id !== "find-results") controller.select(id);
    requestAnimationFrame(() => tabRefs.current.get(id)?.focus());
  };
  const header = (
    <header className={styles.header}>
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
        <span className={styles.soloTitle}>{title(activeId)}</span>
      )}
      {isMobile && props.actionSubject ? (
        <ResourceActionMenu
          actionSubject={props.actionSubject}
          label="Actions"
        />
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={`Close ${title(activeId).toLowerCase()}`}
        data-companion-close="true"
        onClick={close}
      >
        <X size={15} aria-hidden="true" />
      </Button>
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

  if (isMobile) {
    return (
      <MobileSheet
        active={open}
        panelId={paneSecondaryRegionId(paneId)}
        onDismiss={close}
        ariaLabel={title(activeId)}
        layer="overlay"
        scrim="soft"
        initialFocus={(container) =>
          container.querySelector<HTMLElement>(
            '[role="tab"][aria-selected="true"], [data-companion-close="true"]',
          )
        }
        returnFocusTo={() =>
          chrome.returnFocus && {
            element: chrome.returnFocus,
            preventScroll: true,
          }
        }
        returnFocusFallback={() => findPaneLandmarkFocusTarget(paneId)}
        skipReturnFocus={() => resultsShown && !results.expanded}
        focusKey={activeId}
      >
        {header}
        {panels}
      </MobileSheet>
    );
  }
  if (!open) return null;
  return (
    <aside
      ref={asideRef}
      id={paneSecondaryRegionId(paneId)}
      className={styles.column}
      style={{ width: widthPx }}
      aria-label={title(activeId)}
      onKeyDown={(event) => {
        // Escape from inside the column only: a portaled overlay opened from
        // here bubbles its own Escape through React, and owns it.
        if (
          event.key !== "Escape" ||
          event.defaultPrevented ||
          !event.currentTarget.contains(event.target as Node)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      {header}
      {panels}
      <ResizeHandle
        label={`Resize ${title(activeId)}`}
        controls={`${baseId}-${activeId}-panel`}
        widthPx={widthPx}
        minWidthPx={COMPANION_MIN_WIDTH_PX}
        maxWidthPx={COMPANION_MAX_WIDTH_PX}
        onResize={controller.resize}
      />
    </aside>
  );
}
