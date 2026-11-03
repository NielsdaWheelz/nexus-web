"use client";
import * as Icon from "@/lib/ui/icons";

// The phone's palette: a sheet that opens keyboard-down on the armed row and reads upward to its field.
// Rank 1 touches the field; continuations, places and the account sit farthest. Pages render in the
// same sheet with their headers.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type MouseEvent } from "react";
import AccountMenu from "@/components/appnav/AccountMenu";
import { isAccountDestinationId } from "@/components/appnav/navModel";
import { NexusQuerySpinner, NexusNotices, NexusRowBody, nexusRowAlias, nexusRowName, nexusRowVerbs } from "@/components/nexus/NexusRow";
import NexusPages from "@/components/nexus/NexusPages";
import { NexusPaneDrag, NexusPaneSortable, NexusPaneListHeader, NexusClosedPanes, paneCandidateName, paneRowName, paneDragStyle } from "@/components/nexus/NexusPaneList";
import NexusVerbRail from "@/components/nexus/NexusVerbRail";
import type { NexusController } from "@/components/nexus/useNexusController";
import { ExcerptDialog } from "@/components/resources/ExcerptDisclosure";
import Button from "@/components/ui/Button";
import MobileSheet from "@/components/ui/MobileSheet";
import OverflowMenuButton from "@/components/ui/OverflowMenuButton";
import collection from "@/components/ui/Collection.module.css";
import type { NexusGroup, NexusRow } from "@/lib/nexus/model";
import { ARRIVAL_ONSET_MS } from "@/lib/nexus/policy";
import { placeChipRows } from "@/lib/nexus/rows";
import { sectionDestinationIdForHref } from "@/lib/panes/paneRouteModel";
import type { ResourceItem } from "@/lib/resources/items";
import { cx } from "@/lib/ui/cx";
import { isTopmostInteractionOwner } from "@/lib/ui/overlay";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import nexus from "@/components/nexus/Nexus.module.css";
import styles from "./Switchboard.module.css";

const GRID_ID = "mobile-nexus-results";
const CONTINUATIONS_ID = "mobile-nexus-continuations";
const RAIL_ID = "mobile-nexus-rail";
const NOTICE_ID = "mobile-nexus-notices";
const PLACES = placeChipRows();

function candidateId(key: string): string {
  return `mobile-nexus-candidate-${encodeURIComponent(key)}`;
}

export default function SwitchboardTask({ controller }: { controller: NexusController }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const addBody = useRef<HTMLElement>(null);
  const composing = useRef(false);
  const placementPress = useRef<string | null>(null);
  const taskPointerId = useRef<number | null>(null);
  const [excerpt, setExcerpt] = useState<ResourceItem | null>(null);
  if (!controller.open && excerpt !== null) setExcerpt(null);
  const typed = controller.rootMode === "Typed";
  const pinned = typed && controller.continuations.length > 0;
  useLayoutEffect(() => { taskPointerId.current = null; placementPress.current = null; }, [controller.open]);
  useEffect(() => {
    const release = () => { placementPress.current = null; };
    window.addEventListener("blur", release);
    return () => window.removeEventListener("blur", release);
  }, []);
  // A mode's rows compose after the commit that enters it, so restore once they exist.
  // A restore can clamp without a scroll event; the position then records where it landed.
  const composed = controller.groups.length > 0;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!controller.open || controller.page.kind !== "Root" || !list || !composed) return;
    const positions = controller.rootScroll.current;
    list.scrollTop = positions[controller.rootMode];
    positions[controller.rootMode] = list.scrollTop;
  }, [controller.open, controller.page.kind, controller.rootMode, controller.query, controller.rootScroll, composed]);

  const paneFocusRevision = useRef(controller.paneFocusRevision);
  useLayoutEffect(() => {
    if (paneFocusRevision.current === controller.paneFocusRevision) return;
    paneFocusRevision.current = controller.paneFocusRevision;
    if (!controller.open || !isTopmostInteractionOwner("Nexus")) return;
    const target = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-nexus-control]") ?? []).find(node => node.dataset.nexusControl === controller.paneFocusKey);
    (target ?? headingRef.current)?.focus({ preventScroll: true });
  }, [controller.paneFocusRevision, controller.paneFocusKey, controller.open]);
  // A row control that leaves the tree hands focus to the heading, so the keyboard stays down.
  const focusedControl = useRef<HTMLElement | null>(null);
  const trackFocus = (event: FocusEvent<HTMLDivElement>) => { if (event.target instanceof HTMLElement) focusedControl.current = event.target; };
  useLayoutEffect(() => {
    if (!focusedControl.current || focusedControl.current.isConnected) return;
    focusedControl.current = null;
    if (document.activeElement !== document.body && document.activeElement?.isConnected) return;
    if (controller.open && isTopmostInteractionOwner("Nexus")) headingRef.current?.focus({ preventScroll: true });
  });

  const results = controller.list.rows.length;
  const rail = controller.rail;
  const lookup = controller.lookupGuidance !== null;
  const listed = new Set(controller.list.rows.map(row => row.key));
  const held = new Set(controller.list.held);
  const activeHref = controller.panes.find((pane) => pane.current)?.href;
  const section = activeHref ? sectionDestinationIdForHref(activeHref) : null;
  const accountId = isAccountDestinationId(section) ? section : null;
  const control = (key: string) => Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-nexus-control]") ?? []).find(node => node.dataset.nexusControl === key) ?? null;
  const activate = (row: NexusRow, event: TargetActivationEvent) => {
    if ("key" in event && placementPress.current === event.key) { event.preventDefault(); return; }
    if (controller.reorder.placement !== null) {
      if ("key" in event && event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || ("key" in event && (event.repeat || event.nativeEvent?.isComposing || event.keyCode === 229))) return;
      if ("key" in event) placementPress.current = event.key;
      controller.arm(row.key);
      controller.activate(row.action, { disposition: { kind: "Follow" } }, row);
      return;
    }
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Consume") return;
    controller.arm(row.key);
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
  // The rail returns focus to the `…` that toggled it; leaving it never raises the keyboard.
  const closeRail = (restoreFocus: boolean) => {
    const key = rail?.key;
    controller.closeRail();
    if (restoreFocus && key !== undefined) control(`Rail:${key}`)?.focus({ preventScroll: true });
  };

  const row = (item: NexusRow, group: NexusGroup["id"], rowIndex: number) => {
    const here = item.state === "Current";
    const alias = nexusRowAlias(item, lookup);
    const name = group === "Open" && controller.paneListPresented ? paneCandidateName(controller, item, rowIndex) : nexusRowName(item, here, alias);
    const verbs = rail?.key === item.key ? nexusRowVerbs(item, here, controller, paneRowName(controller, item), setExcerpt) : null;
    const selected = item.key === controller.armed;
    return (
      <NexusPaneSortable key={item.key} controller={controller} row={item}>{drag => <div
        ref={drag.setNodeRef}
        style={paneDragStyle(drag)}
        data-move-source={controller.reorder.placement?.kind === "ChoosePosition" && item.key === `Pane:${controller.reorder.placement.paneId}` || undefined}
        data-drag-over={drag.isSorting && !drag.isDragging && drag.over?.id === (item.secondary?.kind === "ClosePane" ? item.secondary.paneId : item.key) ? drag.activeIndex < drag.overIndex ? "after" : "before" : undefined}
        role="row"
        aria-selected={selected}
        className={cx(collection.row, nexus.row, styles.row)}
        data-active={selected || undefined}
        data-band={listed.has(item.key) ? held.has(item.key) ? "held" : "arriving" : undefined}
        onPointerDown={() => controller.arm(item.key)}
      >
        <div id={candidateId(item.key)} role="gridcell" aria-label={name} className={nexus.cell}>
          <button
            type="button"
            ref={drag.setActivatorNodeRef}
            onPointerDown={drag.begin}
            onPointerUp={event => { delete event.currentTarget.dataset.dragPointer; }}
            onPointerCancel={event => { delete event.currentTarget.dataset.dragPointer; }}
            onMouseDown={event => { if (drag.enabled && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && isTopmostInteractionOwner("Nexus")) drag.listeners?.onMouseDown?.(event); }}
            onTouchStart={event => { if (drag.enabled && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && isTopmostInteractionOwner("Nexus")) drag.listeners?.onTouchStart?.(event); }}
            className={cx(nexus.primary, styles.primary)}
            data-nexus-control={item.key}
            aria-labelledby={candidateId(item.key)}
            aria-current={here ? "page" : undefined}
            aria-disabled={item.action.kind === "Unavailable" || undefined}
            onFocus={() => controller.arm(item.key)}
            onClick={(event) => activate(item, event)}
            onKeyDown={(event) => activate(item, event)}
            onKeyUp={event => { if (placementPress.current === event.key) { placementPress.current = null; event.preventDefault(); } }}
          >
            <NexusRowBody row={item} here={here} query={controller.query} position={controller.reorder.placement?.kind === "ChoosePosition" && group === "Open" ? rowIndex + 1 : undefined} />
          </button>
          <div className={cx(nexus.trailing, styles.trailing)}>
            {alias ? <kbd className={nexus.kbd} aria-hidden="true">{alias}</kbd> : null}
            {item.action.kind === "Available" && item.action.target.kind === "PaneOpen" && item.secondary?.kind === "ClosePane" ? (
              <Button iconOnly data-nexus-control={`ClosePane:${item.secondary.paneId}`} aria-label={`close ${paneRowName(controller, item)}`}
                onKeyDown={(event) => { if (event.repeat && event.key === "Enter") event.preventDefault(); }}
                onClick={event => { event.currentTarget.focus({ preventScroll: true }); if (item.secondary?.kind === "ClosePane") controller.closePane(item.secondary.paneId); }}
                icon={<Icon.Dismiss aria-hidden="true" />} />
            ) : item.secondary?.kind === "TargetMenu" ? (
              <OverflowMenuButton data-nexus-control={`Rail:${item.key}`} aria-label={`more actions for ${item.label}`}
                aria-expanded={verbs !== null} aria-controls={verbs !== null ? RAIL_ID : undefined}
                onClick={() => {
                  controller.arm(item.key);
                  if (verbs !== null) controller.closeRail();
                  else controller.openRail(item.key);
                }} />
            ) : null}
          </div>
          {verbs && rail ? <NexusVerbRail id={RAIL_ID} label={`more actions for ${item.label}`} verbs={verbs} rail={rail} controller={controller}
            mobile className={styles.rail} onClose={closeRail} returnFocusTo={() => control(`Rail:${item.key}`)} /> : null}
        </div>
      </div>}</NexusPaneSortable>
    );
  };

  const root = <>
    <h2 ref={headingRef} className="sr-only" tabIndex={-1} data-switchboard-heading>Nexus</h2>
    <div className="sr-only" role="status" aria-label="search status" aria-live="polite" aria-atomic="true">
      {typed && !controller.pending ? `${results} results shown.` : null}
    </div>
    <NexusPaneDrag controller={controller} scrollport={() => listRef.current} mobile>
      {/* Typed, the continuations are a band above the scrollport: farthest, and arrivals never move them. */}
      {pinned ? <div id={CONTINUATIONS_ID} role="rowgroup" aria-label="query actions" className={cx(nexus.grid, styles.grid, styles.continuations)} onFocusCapture={trackFocus}>
        {controller.continuations.map((item, rowIndex) => row(item, "Continuations", rowIndex))}
      </div> : null}
      <div ref={listRef} onScroll={event => { controller.rootScroll.current[controller.rootMode] = event.currentTarget.scrollTop; }} className={styles.list} aria-busy={controller.busy || undefined} onFocusCapture={trackFocus}>
        <div id={GRID_ID} role="grid" aria-label={typed ? "find results" : "nexus options"} aria-colcount={1} aria-owns={pinned ? CONTINUATIONS_ID : undefined} className={cx(nexus.grid, styles.grid)}
          style={{ "--arrival-onset": `${ARRIVAL_ONSET_MS}ms` } as CSSProperties}>
          {controller.groups.filter(group => (controller.reorder.placement === null || group.id === "Open") && !(pinned && group.id === "Continuations")).map(group => <Fragment key={group.id}>
            <div role="rowgroup" aria-labelledby={group.label ? `mobile-nexus-group-${group.id}` : undefined}
              aria-label={group.label ? undefined : group.id === "Results" ? "results" : group.id === "Here" ? "here" : "query actions"}
              id={group.id === "Open" && controller.paneListPresented ? "mobile-nexus-open-panes" : undefined} className={styles.group}>
              {group.rows.map((item, rowIndex) => row(item, group.id, rowIndex))}
              {group.label ? <div role="row"><div role="gridcell">
                {group.id === "Open" && controller.paneListPresented ? <NexusPaneListHeader controller={controller} mobile />
                  : <h3 id={`mobile-nexus-group-${group.id}`} className={nexus.head}>{group.label}</h3>}
              </div></div> : null}
            </div>
            {group.id === "Open" ? <NexusClosedPanes controller={controller} mobile /> : null}
          </Fragment>)}
          {typed || controller.reorder.placement !== null ? null : <div role="rowgroup" aria-label="places" className={styles.group}>
            <div role="row"><div role="gridcell" className={styles.chips}>
              {PLACES.map(place => <button key={place.key} type="button" className={styles.chip} data-nexus-control={place.key} onClick={event => {
                const activation = workspaceTargetActivationIntent(event);
                if (activation.kind !== "Open") return;
                event.preventDefault();
                controller.activate(place.action, { disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } }, place);
              }}>
                <span className={nexus.glyph} aria-hidden="true"><place.icon size={16} aria-hidden="true" /></span>{place.label}
              </button>)}
            </div></div>
            <div role="row" className={styles.account}><div role="gridcell">
              <AccountMenu activeId={accountId} placement="above" align="start"
                renderTrigger={(trigger, mark) => <button {...trigger} className={cx(nexus.primary, styles.primary)} aria-current={accountId === null ? undefined : "page"}>
                  <span className={nexus.gutter}>{mark}</span>
                  <span className={nexus.text}><span className={nexus.title}>account</span></span>
                </button>}
                onNavigate={(event, destination) => {
                  const activation = workspaceTargetActivationIntent(event);
                  if (activation.kind === "Unowned") return "unhandled";
                  event.preventDefault();
                  if (activation.kind === "Consume") return "consumed";
                  if (!controller.openTarget({ kind: "InternalHref", href: destination.href, labelHint: destination.label }, activation.intent === "new_pane" ? { disposition: { kind: "Fork" } } : undefined)) return "consumed";
                  return "handled-destination-focus";
                }} />
            </div></div>
          </div>}
        </div>
        <NexusNotices controller={controller} id={NOTICE_ID} returnFocus={() => headingRef.current} />
      </div>
    </NexusPaneDrag>
    <div className={styles.field} data-feedback-controls="true">
      <span className={cx(nexus.gutter, styles.fieldGutter)} aria-hidden="true"><NexusQuerySpinner pending={controller.pending} /></span>
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-label="find anything…"
        aria-autocomplete="list"
        aria-controls={GRID_ID}
        aria-expanded="true"
        aria-describedby={lookup ? `${NOTICE_ID}-guidance` : undefined}
        value={controller.query}
        placeholder="find anything…"
        autoComplete="off"
        enterKeyHint="go"
        data-mobile-nexus-search
        data-nexus-control="Search"
        onFocus={() => { if (controller.rail !== null) controller.closeRail(); }}
        onChange={(event) => controller.setQuery(event.currentTarget.value)}
        onCompositionStart={() => { composing.current = true; controller.setComposing(true); }}
        onCompositionEnd={() => { composing.current = false; controller.setComposing(false); }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || event.key === "Process") {
            event.stopPropagation();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            controller.escape();
          } else if (event.key === "Enter") {
            // Go fires the armed row under law 2.
            const activation = workspaceTargetActivationIntent(event, "activate");
            if (activation.kind === "Unowned") return;
            event.preventDefault();
            if (activation.kind === "Open") controller.submit({ disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } });
          }
        }}
      />
      {controller.query ? <Button iconOnly icon={<Icon.Dismiss aria-hidden="true" />} className={styles.clear} aria-label="clear search" onClick={() => { controller.setQuery(""); inputRef.current?.focus(); }} /> : <span />}
    </div>
    {excerpt ? <ExcerptDialog item={excerpt} onClose={() => setExcerpt(null)} returnFocusTo={() => controller.armed === null ? headingRef.current : control(controller.armed)} /> : null}
  </>;

  return (
    <MobileSheet active={controller.open} panelId="Nexus" handleLabel="close nexus" heightLimit="available" flushBottom={controller.page.kind === "Root"}
      slipContent={controller.page.kind === "Root" ? listRef : controller.page.kind === "Add" ? addBody : undefined}
      interactionLayer={controller.interactionLayer} onDismiss={controller.dismissAccepted} onDismissRequest={controller.guardClose}
      ariaLabel={controller.addDefect ? "Add needs attention" : controller.dialogLabel} initialFocus={controller.initialFocus}
      returnFocusTo={controller.returnFocusTo} returnFocusFallback={controller.returnFocusFallback} skipReturnFocus={controller.suppressReturnFocus} focusKey={controller.focusKey}>
      <div className={cx(styles.sheet, controller.page.kind === "Root" && typed && styles.typed)}
        onPointerDownCapture={(event) => { taskPointerId.current = event.pointerId; }}
        onPointerCancelCapture={(event) => { if (taskPointerId.current === event.pointerId) taskPointerId.current = null; }}
        onClickCapture={admitClick}>
        {controller.page.kind === "Root" ? root : <NexusPages scrollRef={addBody} controller={controller} mobile />}
      </div>
    </MobileSheet>
  );
}
