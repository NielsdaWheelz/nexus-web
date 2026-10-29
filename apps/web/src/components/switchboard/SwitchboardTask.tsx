"use client";

// One mobile task: a keyboard-down workspace index, or explicitly entered search.
import { useEffect, useLayoutEffect, useRef, type MouseEvent } from "react";
import { ArrowLeft, Search, X } from "lucide-react";
import AccountMenu from "@/components/appnav/AccountMenu";
import { isAccountDestinationId } from "@/components/appnav/navModel";
import { NexusRowBody, NexusRowEvidence, NexusRowMenu, NexusQueryStatus, NexusNotices, nexusRowEvidenceText, nexusRowPrimaryText } from "@/components/nexus/NexusRow";
import NexusPages from "@/components/nexus/NexusPages";
import { NexusPaneDrag, NexusPaneSortable, NexusPaneListHeader, NexusClosedPanes, paneCandidateName, paneRowName, paneDragStyle } from "@/components/nexus/NexusPaneList";
import { isTopmostInteractionOwner } from "@/lib/ui/overlay";
import type { NexusController } from "@/components/nexus/useNexusController";
import Button from "@/components/ui/Button";
import MobileFullScreenTask from "@/components/ui/MobileFullScreenTask";
import OverflowMenuButton from "@/components/ui/OverflowMenuButton";
import type { NexusRow } from "@/lib/nexus/model";
import { rowFacts, rowName } from "@/lib/nexus/rows";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { useCollectionLayout } from "@/lib/ui/collection";
import { sectionDestinationIdForHref } from "@/lib/panes/paneRouteModel";
import styles from "@/components/nexus/Nexus.module.css";
import collection from "@/components/ui/Collection.module.css";

const NOTICE_ID = "mobile-nexus-notices";

export default function SwitchboardTask({ controller }: { controller: NexusController }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useCollectionLayout(bodyRef, controller.open && controller.page.kind === "Root");
  const composing = useRef(false);
  const placementPress = useRef<string | null>(null);
  const markSearchInteraction = controller.interact;
  const refreshRevision = useRef(controller.searchRefreshRevision);
  useLayoutEffect(() => {
    if (refreshRevision.current === controller.searchRefreshRevision) return;
    refreshRevision.current = controller.searchRefreshRevision;
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [controller.searchRefreshRevision]);
  const taskPointerId = useRef<number | null>(null);
  useEffect(() => {
    if (!controller.open || controller.page.kind !== "Root") return;
    const selected = () => {
      const selection = window.getSelection();
      if (selection !== null && !selection.isCollapsed && (listRef.current?.contains(selection.anchorNode) || listRef.current?.contains(selection.focusNode))) markSearchInteraction();
    };
    document.addEventListener("selectionchange", selected);
    return () => document.removeEventListener("selectionchange", selected);
  }, [controller.open, controller.page.kind, markSearchInteraction]);
  const previousQuery = useRef(controller.query);
  const searching = controller.rootMode === "Search";
  useLayoutEffect(() => { taskPointerId.current = null; placementPress.current = null; }, [controller.open]);
  useEffect(() => {
    const release = () => { placementPress.current = null; };
    window.addEventListener("blur", release);
    return () => window.removeEventListener("blur", release);
  }, []);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!controller.open || controller.page.kind !== "Root" || !list) return;
    const mode = controller.rootMode;
    const positions = controller.rootScroll.current;
    if (previousQuery.current !== controller.query) positions.Search = 0;
    previousQuery.current = controller.query;
    list.scrollTop = positions[mode];
    return () => { positions[mode] = list.scrollTop; };
  }, [controller.open, controller.page.kind, controller.rootMode, controller.query, controller.rootScroll]);

  const paneFocusRevision = useRef(controller.paneFocusRevision);
  useLayoutEffect(() => {
    if (paneFocusRevision.current === controller.paneFocusRevision) return;
    paneFocusRevision.current = controller.paneFocusRevision;
    if (!controller.open || !isTopmostInteractionOwner("Nexus")) return;
    const target = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>("[data-nexus-control]") ?? []).find(node => node.dataset.nexusControl === controller.paneFocusKey);
    (target ?? headingRef.current)?.focus({ preventScroll: true });
  }, [controller.paneFocusRevision, controller.paneFocusKey, controller.open]);
  const focusedControl = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!focusedControl.current || focusedControl.current.isConnected) return;
    focusedControl.current = null;
    if (document.activeElement !== document.body && document.activeElement?.isConnected) return;
    if (controller.open && isTopmostInteractionOwner("Nexus")) headingRef.current?.focus({ preventScroll: true });
  });

  const typed = controller.query.trim().length > 0;
  const results = controller.groups.filter((group) => group.id === "Results").reduce((count, group) => count + group.rows.length, 0);
  const activeHref = controller.panes.find((pane) => pane.current)?.href;
  const section = activeHref ? sectionDestinationIdForHref(activeHref) : null;
  const accountId = isAccountDestinationId(section) ? section : null;
  const activate = (row: NexusRow, event: TargetActivationEvent) => {
    if ("key" in event && placementPress.current === event.key) { event.preventDefault(); return; }
    if (controller.reorder.placement !== null) {
      if ("key" in event && event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || ("key" in event && (event.repeat || event.nativeEvent?.isComposing || event.keyCode === 229))) return;
      if ("key" in event) placementPress.current = event.key;
      controller.setActive(row.key);
      controller.activate(row.action, { disposition: { kind: "Follow" } }, row);
      return;
    }
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Consume") return;
    controller.setActive(row.key);
    controller.activate(row.action, { disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } }, row);
  };
  // Admit only gestures begun inside this task; the opening pointer-up is not a row click.
  const admitClick = (event: MouseEvent<HTMLDivElement>) => {
    const pointerId = "pointerId" in event.nativeEvent && typeof event.nativeEvent.pointerId === "number" ? event.nativeEvent.pointerId : null;
    const admitted = event.detail === 0 || (pointerId !== null && taskPointerId.current === pointerId);
    taskPointerId.current = null;
    if (admitted) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const root = (
    <div ref={bodyRef} className={`${styles.page} ${styles.searchPage}`} onFocusCapture={event => { if (event.target instanceof HTMLElement && bodyRef.current?.contains(event.target)) focusedControl.current = event.target; }}>
      <header className={styles.header}>
        {searching ? <Button iconOnly icon={<ArrowLeft />} className={styles.iconButton} aria-label="back to workspace" onClick={controller.escape} /> : null}
        <h2 ref={headingRef} tabIndex={-1} data-switchboard-heading>{searching ? "search" : "workspace"}</h2>
        <div className={styles.headerActions}>
          <AccountMenu
            activeId={accountId}
            placement="below"
            align="end"
            renderTrigger={(trigger, accountMark) => (
              <Button {...trigger} iconOnly icon={accountMark} className={styles.iconButton} aria-current={accountId === null ? undefined : "page"} />
            )}
            onNavigate={(event, destination) => {
              const activation = workspaceTargetActivationIntent(event);
              if (activation.kind === "Unowned") return "unhandled";
              event.preventDefault();
              if (activation.kind === "Consume") return "consumed";
              if (!controller.openTarget({ kind: "InternalHref", href: destination.href, labelHint: destination.label }, activation.intent === "new_pane" ? { disposition: { kind: "Fork" } } : undefined)) return "consumed";
              return "handled-destination-focus";
            }}
          />
          <Button iconOnly icon={<X />} className={styles.iconButton} aria-label="close nexus" onClick={controller.close} />
        </div>
      </header>
      <div className={styles.searchInput}>
        <div className={styles.searchField} onPointerDownCapture={controller.interact}>
          <Search size={19} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            aria-label="search"
            aria-describedby={searching && controller.lookupGuidance !== null ? `${NOTICE_ID}-guidance` : undefined}
            value={controller.query}
            placeholder="find anything…"
            autoComplete="off"
            enterKeyHint={controller.explicitIntent ? "go" : "search"}
            data-mobile-nexus-search
            data-nexus-control="Search"
            onFocus={controller.enterSearch}
            onChange={(event) => controller.setQuery(event.currentTarget.value)}
            onCompositionStart={() => { composing.current = true; controller.setComposing(true); }}
            onCompositionEnd={() => { composing.current = false; controller.setComposing(false); }}
            onKeyDown={(event) => {
              if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || event.key === "Process") {
                event.stopPropagation();
                return;
              }
              controller.interact();
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                controller.escape();
              } else if (event.key === "Enter") {
                const activation = workspaceTargetActivationIntent(event, "activate");
                if (activation.kind === "Unowned") return;
                event.preventDefault();
                if (activation.kind === "Open") controller.submitInput({ disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } });
              }
            }}
          />
          {searching ? <NexusQueryStatus controller={controller} noticeId={NOTICE_ID} /> : null}
          {controller.query ? <Button iconOnly icon={<X />} className={styles.iconButton} aria-label="clear search" onClick={() => { controller.setQuery(""); inputRef.current?.focus(); }} /> : null}
        </div>
      </div>
      <NexusPaneDrag controller={controller} scrollport={() => listRef.current} mobile>
      <div ref={listRef} className={`${collection.fillViewport} ${styles.searchScroll}`} data-collection-viewport="" aria-busy={controller.busy || undefined} data-mode={controller.rootMode} onPointerDownCapture={controller.interact} onFocusCapture={controller.interact} onWheelCapture={controller.interact} onTouchMoveCapture={controller.interact} onKeyDownCapture={controller.interact}>
        {controller.groups.map((group) => (
          <section key={group.id} className={styles.section} data-group={group.id} aria-labelledby={group.label ? `mobile-nexus-group-${group.id}` : undefined}>
            {group.id === "Open" && controller.paneListPresented ? <NexusPaneListHeader controller={controller} mobile /> : group.label ? <h3 id={`mobile-nexus-group-${group.id}`}>{group.label}</h3> : null}
            <ul className={styles.rows} id={group.id === "Open" && controller.paneListPresented ? "mobile-nexus-open-panes" : undefined}>
              {group.rows.map((row, rowIndex) => {
                const unavailable = row.action.kind === "Unavailable" ? row.action.reason : null;
                const name = rowName([nexusRowPrimaryText(row), rowFacts(row), unavailable]);
                const hasEvidence = nexusRowEvidenceText(row) !== null;
                return (
                  <NexusPaneSortable key={row.key} controller={controller} row={row}>{drag => <li ref={drag.setNodeRef} style={paneDragStyle(drag)} data-move-source={controller.reorder.placement?.kind === "ChoosePosition" && row.key === `Pane:${controller.reorder.placement.paneId}` || undefined} data-drag-over={drag.isSorting && !drag.isDragging && drag.over?.id === (row.secondary?.kind === "ClosePane" ? row.secondary.paneId : row.key) ? drag.activeIndex < drag.overIndex ? "after" : "before" : undefined} className={styles.row} data-current={row.state === "Current" || undefined} onPointerDown={() => controller.setActive(row.key)}>
                    <button
                      type="button"
                      ref={drag.setActivatorNodeRef}
                      onPointerDown={drag.begin}
                      onPointerUp={event => { delete event.currentTarget.dataset.dragPointer; }}
                      onPointerCancel={event => { delete event.currentTarget.dataset.dragPointer; }}
                      onMouseDown={event => { if (drag.enabled && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && isTopmostInteractionOwner("Nexus")) drag.listeners?.onMouseDown?.(event); }}
                      onTouchStart={event => { if (drag.enabled && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && isTopmostInteractionOwner("Nexus")) drag.listeners?.onTouchStart?.(event); }}
                      className={`${collection.row} ${styles.rowMain}`}
                      data-selected={row.state === "Current" || undefined}
                      data-nexus-control={row.key === "QuickAction:New" ? "New" : row.key}
                      aria-current={row.state === "Current" ? "page" : undefined}
                      aria-disabled={unavailable !== null || undefined}
                      aria-label={group.id === "Open" && controller.paneListPresented ? paneCandidateName(controller, row, rowIndex) : name}
                      aria-describedby={hasEvidence ? `mobile-nexus-excerpt-${encodeURIComponent(row.key)}` : undefined}
                      onFocus={() => controller.setActive(row.key)}
                      onClick={(event) => activate(row, event)}
                      onKeyDown={(event) => activate(row, event)}
                      onKeyUp={event => { if (placementPress.current === event.key) { placementPress.current = null; event.preventDefault(); } }}
                    >
                      {controller.reorder.placement?.kind === "ChoosePosition" && group.id === "Open" ? <span className={styles.panePosition} aria-hidden>{rowIndex + 1}</span> : null}
                      <NexusRowBody row={row} desktop={false} />
                    </button>
                    {row.secondary?.kind === "ClosePane" ? (
                      <Button iconOnly className={styles.rowMenu} data-nexus-control={`ClosePane:${row.secondary.paneId}`} aria-label={`close ${paneRowName(controller, row)}`}
                        onKeyDown={(event) => { if (event.repeat && event.key === "Enter") event.preventDefault(); }}
                        onClick={event => { event.currentTarget.focus({ preventScroll: true }); if (row.secondary?.kind === "ClosePane") controller.closePane(row.secondary.paneId); }}
                        icon={<X size={18} aria-hidden="true" />} />
                    ) : row.secondary?.kind === "ResourceMenu" ? (
                      <NexusRowMenu row={row} activate={controller.activate} closePane={controller.closePane} menuProps={{
                        label: `more actions for ${row.label}`,
                        align: "end",
                        onOpenChange: (open) => { if (open) controller.setActive(row.key); },
                        renderTrigger: (trigger) => <OverflowMenuButton {...trigger} className={styles.rowMenu} />,
                      }} />
                    ) : null}
                    <NexusRowEvidence row={row} />
                  </li>}</NexusPaneSortable>
                );
              })}
            </ul>
            {group.id === "Open" ? <NexusClosedPanes controller={controller} mobile /> : null}
          </section>
        ))}
        <NexusNotices controller={controller} id={NOTICE_ID} returnFocus={() => searching ? inputRef.current : headingRef.current} />
        {searching && !typed && controller.groups.length === 0 ? <p className={styles.empty}>search your panes, library and commands.</p> : null}
      </div>
      </NexusPaneDrag>
      <div className="sr-only" role="status" aria-label="search status" aria-live="polite" aria-atomic="true">
        {[controller.announcement, controller.noticeText, searching && controller.searchProgress.kind === "Pending" ? controller.searchProgress.text : null, searching && typed && !controller.pending ? `${results} results shown.` : null].filter(Boolean).join(" ")}
      </div>
    </div>
  );

  return (
    <MobileFullScreenTask interactionLayer={controller.interactionLayer} active={controller.open} scope="Nexus" onDismiss={controller.dismissAccepted} onDismissRequest={controller.guardClose}
      ariaLabel={controller.addDefect ? "Add needs attention" : controller.dialogLabel} initialFocus={controller.initialFocus}
      returnFocusTo={controller.returnFocusTo} returnFocusFallback={controller.returnFocusFallback} skipReturnFocus={controller.suppressReturnFocus} focusKey={controller.focusKey}>
      <div className={`${styles.admission} ${styles.mobile}`}
        onPointerDownCapture={(event) => { taskPointerId.current = event.pointerId; }}
        onPointerCancelCapture={(event) => { if (taskPointerId.current === event.pointerId) taskPointerId.current = null; }}
        onClickCapture={admitClick}>
        {controller.page.kind === "Root" ? root : <NexusPages controller={controller} mobile />}
      </div>
    </MobileFullScreenTask>
  );
}
