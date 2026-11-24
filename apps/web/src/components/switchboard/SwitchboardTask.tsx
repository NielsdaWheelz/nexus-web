"use client";

// The thumb index reads down: a page above a fixed legend and field. A tap follows;
// a held target opens beside. Open panes own their separate hold-and-drag gesture.
import * as Icon from "@/lib/ui/icons";
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type MouseEvent, type PointerEvent, type KeyboardEvent } from "react";
import AccountMenu from "@/components/appnav/AccountMenu";
import { isAccountDestinationId } from "@/components/appnav/navModel";
import AsterismMark from "@/components/AsterismMark";
import { NexusNotices, NexusRowBody, nexusRowAlias, nexusRowName, typedSideHead, windowed } from "@/components/nexus/NexusRow";
import NexusPages from "@/components/nexus/NexusPages";
import { NexusPaneDrag, NexusPaneSortable, paneCandidateName, paneRowName, paneDragStyle } from "@/components/nexus/NexusPaneList";
import type { NexusController } from "@/components/nexus/useNexusController";
import { ExcerptText } from "@/components/resources/ResourceBody";
import Button from "@/components/ui/Button";
import MobileSheet from "@/components/ui/MobileSheet";
import collection from "@/components/ui/Collection.module.css";
import type { NexusRow } from "@/lib/nexus/model";
import { ARRIVAL_ONSET_MS, RESULT_CAP, STAR_GRACE_MS, STAR_ONSET_MS } from "@/lib/nexus/policy";
import { flattenedPaste, NEXUS_COMMANDS } from "@/lib/nexus/query";
import { rowPrimaryText } from "@/lib/nexus/rowText";
import { placeRows, rowName } from "@/lib/nexus/rows";
import { sectionDestinationIdForHref } from "@/lib/panes/paneRouteModel";
import { cx } from "@/lib/ui/cx";
import { getInteractionGeneration, isTopmostInteractionOwner } from "@/lib/ui/overlay";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import nexus from "@/components/nexus/Nexus.module.css";
import styles from "./Switchboard.module.css";

const GRID_ID = "mobile-nexus-results";
const PASSAGES_ID = "mobile-nexus-passages";
const EARLIER_ID = "mobile-nexus-earlier";
const ECHO_ID = "mobile-nexus-echo";
const NOTICE_ID = "mobile-nexus-notices";
const HOLD_MS = 500;
const HOLD_SLOP_PX = 8;
const PLACES = placeRows();
const ImportGlyph = NEXUS_COMMANDS["Nexus.Quick.Import"].icon;

function candidateId(key: string): string {
  return `mobile-nexus-candidate-${encodeURIComponent(key)}`;
}

/** The release belongs to the hold even when its activation unmounts the origin. */
function suppressHeldClick(pointerId: number) {
  const lifetime = new AbortController();
  const options = { capture: true, signal: lifetime.signal };
  const release = () => lifetime.abort();
  window.addEventListener("click", event => {
    if (event instanceof globalThis.PointerEvent && event.pointerId > 0 && event.pointerId !== pointerId) return;
    event.preventDefault(); event.stopImmediatePropagation(); release();
  }, options);
  window.addEventListener("pointerdown", release, options);
  window.addEventListener("pointercancel", release, options);
  window.addEventListener("keydown", release, options);
}

/** One stationary touch; scrolling, a second pointer and a change of page retire it. */
function useBesideHold({ open, query, page }: { open: boolean; query: string; page: NexusController["page"]["kind"] }) {
  const pending = useRef<{
    pointer: number; x: number; y: number; generation: number; element: HTMLElement;
    timer: ReturnType<typeof setTimeout>; run(): void;
  } | null>(null);
  const touchPress = useRef(false);
  const cancel = useCallback(() => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
  }, []);
  useLayoutEffect(() => {
    const lifetime = new AbortController();
    const options = { capture: true, signal: lifetime.signal };
    const fresh = (event: Event) => { cancel(); touchPress.current = event instanceof globalThis.PointerEvent && event.pointerType === "touch"; };
    window.addEventListener("pointerdown", fresh, options);
    window.addEventListener("keydown", fresh, options);
    window.addEventListener("pointermove", event => {
      const press = pending.current;
      if (press && (event.pointerId !== press.pointer || Math.hypot(event.clientX - press.x, event.clientY - press.y) > HOLD_SLOP_PX)) cancel();
    }, options);
    window.addEventListener("pointerup", cancel, options);
    window.addEventListener("pointercancel", cancel, options);
    window.addEventListener("scroll", cancel, options);
    window.addEventListener("blur", cancel, { signal: lifetime.signal });
    return () => { cancel(); lifetime.abort(); };
  }, [cancel]);
  useLayoutEffect(cancel, [open, query, page, cancel]);
  return (run: () => void) => ({
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (event.pointerType !== "touch" || !event.isPrimary || event.button !== 0) return;
      const { pointerId: pointer, clientX: x, clientY: y, currentTarget: element } = event;
      const press = { pointer, x, y, element, generation: getInteractionGeneration(), run,
        timer: setTimeout(() => {
          if (pending.current !== press) return;
          cancel();
          if (!element.isConnected || press.generation !== getInteractionGeneration() || !isTopmostInteractionOwner("Nexus")) return;
          suppressHeldClick(pointer); run();
        }, HOLD_MS) };
      pending.current = press;
    },
    onContextMenu(event: MouseEvent<HTMLElement>) {
      event.preventDefault(); event.stopPropagation();
      const press = pending.current;
      cancel();
      if (!isTopmostInteractionOwner("Nexus")) return;
      if (touchPress.current || event.nativeEvent instanceof globalThis.PointerEvent && event.nativeEvent.pointerType === "touch") {
        if (!press || press.element !== event.currentTarget || press.generation !== getInteractionGeneration() || !press.element.isConnected) return;
        suppressHeldClick(press.pointer); press.run();
      } else run();
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat && !event.nativeEvent.isComposing && isTopmostInteractionOwner("Nexus")) run();
    },
  });
}

export default function SwitchboardTask({ controller }: { controller: NexusController }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const importBody = useRef<HTMLElement>(null);
  const composing = useRef(false);
  const taskPointerId = useRef<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  if (!controller.open && expanded) setExpanded(false);
  const hold = useBesideHold({ open: controller.open, query: controller.query, page: controller.page.kind });
  const typed = controller.rootMode === "Typed";
  useLayoutEffect(() => {
    taskPointerId.current = null;
    if (controller.open && stripRef.current) stripRef.current.scrollLeft = 0;
  }, [controller.open]);
  // A mode's rows compose after the commit that enters it, so restore once they exist.
  // A restore can clamp without a scroll event; the position records where it landed.
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
  // A control that leaves the tree hands focus to the heading; the keyboard stays down.
  const focusedControl = useRef<HTMLElement | null>(null);
  const trackFocus = (event: FocusEvent<HTMLDivElement>) => { if (event.target instanceof HTMLElement) focusedControl.current = event.target; };
  useLayoutEffect(() => {
    if (!focusedControl.current || focusedControl.current.isConnected) return;
    focusedControl.current = null;
    if (document.activeElement !== document.body && document.activeElement?.isConnected) return;
    if (controller.open && isTopmostInteractionOwner("Nexus")) headingRef.current?.focus({ preventScroll: true });
  });

  const lookup = controller.lookupGuidance !== null;
  const results = controller.groups.find(group => group.id === "Results")?.rows ?? [];
  const names = results.filter(row => row.class !== "Passage");
  const passages = results.filter(row => row.class === "Passage");
  const settled = controller.sources.device !== "Waiting" && controller.sources.names !== "Waiting" && controller.sources.texts !== "Waiting";
  const passagesOpen = settled || names.length >= RESULT_CAP || controller.list.selection.kind === "Deliberate" && controller.submitRow?.class === "Passage";
  const [passageGate, setPassageGate] = useState({ identity: controller.list.identity, shown: passagesOpen });
  const passagesShown = passagesOpen || passageGate.identity === controller.list.identity && passageGate.shown;
  if (passageGate.identity !== controller.list.identity || passagesShown !== passageGate.shown) {
    setPassageGate({ identity: controller.list.identity, shown: passagesShown });
  }
  const count = names.length + (passagesShown ? passages.length : 0);
  const listed = new Set(controller.list.rows.map(row => row.key));
  const held = new Set(controller.list.held);
  const activeHref = controller.panes.find(pane => pane.current)?.href;
  const section = activeHref ? sectionDestinationIdForHref(activeHref) : null;
  const accountId = isAccountDestinationId(section) ? section : null;
  const catchword = typed ? controller.continuations[0] ?? null : null;
  const search = typed && controller.parsed.intent.kind === "Search";
  const { submitRow } = controller;
  const echo = !typed || !submitRow ? null : submitRow.action.kind === "Unavailable" ? submitRow.action.reason
    : `go · ${submitRow.key === catchword?.key && !lookup ? "all results" : rowPrimaryText(submitRow)}`;
  const earlier = controller.groups.filter(group => group.id === "Recent" || group.id === "Closed").flatMap(group => group.rows);
  const closedCount = earlier.filter(row => row.action.kind === "Available" && row.action.target.kind === "RestorePane").length;
  const selection = controller.groups.find(group => group.id === "Continuations")?.rows ?? [];
  const openRows = controller.groups.find(group => group.id === "Open")?.rows ?? [];
  const activate = (row: NexusRow, event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Consume") return;
    controller.selectRow(row.key);
    controller.activate(row.action, { disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } }, row);
  };
  const beside = (row: NexusRow) => {
    controller.selectRow(row.key);
    controller.activate(row.action, { disposition: { kind: "Fork" } }, row);
  };
  // Admit only gestures begun inside this task; the opening pointer-up is not a row click.
  const admitClick = (event: MouseEvent<HTMLDivElement>) => {
    const pointerId = "pointerId" in event.nativeEvent && typeof event.nativeEvent.pointerId === "number" ? event.nativeEvent.pointerId : null;
    const admitted = event.detail === 0 || (pointerId !== null && taskPointerId.current === pointerId);
    taskPointerId.current = null;
    if (admitted) return;
    event.preventDefault(); event.stopPropagation();
  };

  const row = (item: NexusRow, sideHead = "") => {
    const pane = item.key.startsWith("Pane:");
    const here = item.state === "Current";
    const marked = item.secondary?.kind === "ClosePane" && controller.marked.includes(item.secondary.paneId);
    const restores = item.action.kind === "Available" && item.action.target.kind === "RestorePane";
    const alias = nexusRowAlias(item, lookup);
    const name = rowName([pane ? paneCandidateName(controller, item) : nexusRowName(item, here, alias), marked ? "closed. activate to keep it open" : restores ? "closed" : null]);
    const selected = item.key === controller.selectedKey;
    const trailing = [sideHead, marked || restores ? "closed" : here ? "here" : null].filter(Boolean).join(" · ");
    const gesture = hold(() => beside(item));
    const excerpt = item.class === "Passage" && item.match ? windowed(item.match) : null;
    return <NexusPaneSortable key={item.key} controller={controller} row={item}>{drag => <div
      ref={drag.setNodeRef} style={paneDragStyle(drag)}
      data-drag-over={drag.isSorting && !drag.isDragging && drag.over?.id === (item.secondary?.kind === "ClosePane" ? item.secondary.paneId : item.key) ? drag.activeIndex < drag.overIndex ? "after" : "before" : undefined}
      role="row" aria-selected={selected} className={cx(collection.row, nexus.row, styles.row)}
      data-active={selected || undefined} data-marked={marked || undefined} data-passage={item.class === "Passage" || undefined}
      data-band={listed.has(item.key) ? held.has(item.key) ? "held" : "arriving" : undefined}>
      <div id={candidateId(item.key)} role="gridcell" aria-label={name} className={nexus.cell}>
        <button type="button" ref={drag.setActivatorNodeRef}
          onPointerDown={pane ? drag.begin : gesture.onPointerDown}
          onPointerUp={event => { delete event.currentTarget.dataset.dragPointer; }}
          onPointerCancel={event => { delete event.currentTarget.dataset.dragPointer; }}
          onMouseDown={event => { if (drag.enabled && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && isTopmostInteractionOwner("Nexus")) drag.listeners?.onMouseDown?.(event); }}
          onTouchStart={event => { if (drag.enabled && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && isTopmostInteractionOwner("Nexus")) drag.listeners?.onTouchStart?.(event); }}
          onContextMenu={pane ? event => event.preventDefault() : gesture.onContextMenu}
          className={cx(nexus.primary, styles.primary)} data-nexus-control={item.key}
          aria-labelledby={candidateId(item.key)} aria-current={here ? "page" : undefined}
          aria-disabled={item.action.kind === "Unavailable" || undefined}
          onClick={event => activate(item, event)}
          onKeyDown={event => { if (!pane) gesture.onKeyDown(event); activate(item, event); }}>
          {item.class === "Passage" ? <span className={styles.passage}>
            <span className={styles.excerpt}>{item.action.kind === "Unavailable" ? item.action.reason : excerpt ? <ExcerptText excerpt={excerpt.excerpt} match={excerpt} /> : item.label}</span>
            <span className={styles.work}>{rowPrimaryText(item)}</span>
          </span> : <NexusRowBody row={item} query={controller.query} />}
        </button>
        <div className={cx(nexus.trailing, styles.trailing)}>
          {trailing ? <span aria-hidden="true">{trailing}</span> : null}
          {alias ? <kbd className={nexus.kbd} aria-hidden="true">{alias}</kbd> : null}
          {!typed && pane && !marked && item.secondary?.kind === "ClosePane" ? <Button iconOnly className={styles.closePane}
            data-nexus-control={`ClosePane:${item.secondary.paneId}`} aria-label={`close ${paneRowName(controller, item)}`}
            onKeyDown={event => { if (event.repeat && event.key === "Enter") event.preventDefault(); }}
            onClick={event => {
              event.currentTarget.focus({ preventScroll: true });
              const secondary = item.secondary;
              if (secondary?.kind !== "ClosePane") return;
              if (here) controller.closeCurrentPane(); else controller.markPane(secondary.paneId);
            }} icon={<Icon.Dismiss size="1rem" aria-hidden="true" />} /> : null}
        </div>
      </div>
    </div>}</NexusPaneSortable>;
  };
  const activateImport = (event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Open") controller.runLegend("Nexus.Quick.Import", { disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } });
  };
  const importHold = hold(() => controller.runLegend("Nexus.Quick.Import", { disposition: { kind: "Fork" } }));
  const catchwordHold = catchword ? hold(() => beside(catchword)) : null;
  const bands: { label: string; sideHead: string; rows: NexusRow[] }[] = [];
  for (const item of names) {
    const sideHead = lookup ? "" : typedSideHead(item, controller.list.first);
    const label = lookup ? "do" : sideHead || "first";
    const last = bands.at(-1);
    if (last?.label === label) last.rows.push(item);
    else bands.push({ label, sideHead, rows: [item] });
  }
  const head = (text: string) => <div role="row" className={styles.sideHead} aria-hidden="true"><div role="gridcell">{text}</div></div>;
  const root = <>
    <h2 ref={headingRef} className="sr-only" tabIndex={-1} data-switchboard-heading>Nexus</h2>
    <div className="sr-only" role="status" aria-label="search status" aria-live="polite" aria-atomic="true">{typed && !controller.pending ? `${count} results shown.` : null}</div>
    <NexusPaneDrag controller={controller} scrollport={() => listRef.current}>
      <div ref={listRef} onScroll={event => { controller.rootScroll.current[controller.rootMode] = event.currentTarget.scrollTop; }} className={styles.list} aria-busy={controller.busy || undefined} onFocusCapture={trackFocus}
        style={{ "--arrival-onset": `${ARRIVAL_ONSET_MS}ms` } as CSSProperties}>
        <div id={GRID_ID} role="grid" aria-label={typed ? "find results" : "nexus options"} aria-colcount={1}
          aria-owns={typed && passagesShown && passages.length > 0 ? PASSAGES_ID : undefined} className={cx(nexus.grid, styles.grid)}>
          {typed ? bands.map(band => <div key={band.rows[0]!.key} role="rowgroup" aria-label={band.label} className={styles.group}>{band.rows.map((item, at) => row(item, at === 0 ? band.sideHead : ""))}</div>) : <>
            {selection.length > 0 ? <div role="rowgroup" aria-label="selection" className={styles.group}>{head("selection")}{selection.map(item => row(item))}</div> : null}
            <div role="rowgroup" aria-label="open" id="mobile-nexus-open-panes" className={styles.group}>
              {head(`open · ${controller.panes.filter(pane => !controller.marked.includes(pane.id)).length}`)}{openRows.map(item => row(item))}
            </div>
            <div role="rowgroup" aria-label="earlier" className={styles.group}>
              <div role="row" aria-selected={false}><div role="gridcell"><button type="button" className={styles.earlier} data-nexus-control="Earlier"
                aria-label={`earlier, ${earlier.length} items`} aria-expanded={expanded} aria-controls={EARLIER_ID} onClick={() => setExpanded(value => !value)}>
                <span className={styles.disclosure}><Icon.Disclose open={expanded} size="0.875rem" aria-hidden="true" /></span>
                <span className={styles.earlierText}>earlier{!expanded && earlier.length > 0 ? <span className={styles.earlierTitles}>{earlier.map(rowPrimaryText).join(" · ")}</span> : null}</span>
                {closedCount > 0 ? <span className={styles.earlierCount}>{closedCount} closed</span> : null}
              </button></div></div>
              <div id={EARLIER_ID} role="presentation" hidden={!expanded}>{earlier.map(item => row(item))}</div>
            </div>
          </>}
        </div>
        {typed && controller.parsed.intent.kind === "Search" && names.length === 0 && controller.sources.device !== "Waiting" && controller.sources.names !== "Waiting" ? <p className={styles.empty}>nothing by that name.</p> : null}
        {typed || expanded ? <NexusNotices controller={controller} id={NOTICE_ID} set="Block" returnFocus={() => headingRef.current} /> : null}
        {typed && passagesShown && passages.length > 0 ? <div id={PASSAGES_ID} role="rowgroup" aria-label="passages" className={cx(nexus.grid, styles.grid)}>{head("passages")}{passages.map(item => row(item))}</div> : null}
        {typed ? <NexusNotices controller={controller} id={`${NOTICE_ID}-apparatus`} set="Apparatus" returnFocus={() => headingRef.current} /> : null}
      </div>
    </NexusPaneDrag>
    <div role="group" aria-label="places" className={styles.legend} onFocusCapture={trackFocus}>
      <div ref={stripRef} className={styles.strip}>
        {PLACES.map(place => {
          const gesture = hold(() => beside(place));
          return <button key={place.key} type="button" className={styles.sign} data-nexus-control={place.key} aria-label={place.label}
            {...gesture} onClick={event => activate(place, event)} onKeyDown={event => { gesture.onKeyDown(event); activate(place, event); }}><place.icon size="1.25rem" aria-hidden="true" /></button>;
        })}
        <button type="button" className={cx(styles.sign, styles.importSign)} data-nexus-control="QuickAction:Nexus.Quick.Import"
          aria-label={controller.importing > 0 ? `import, ${controller.importing} importing` : "import"}
          {...importHold} onClick={activateImport} onKeyDown={event => { importHold.onKeyDown(event); activateImport(event); }}><ImportGlyph size="1.25rem" aria-hidden="true" />{controller.importing > 0 ? <span className={styles.importCount}>{controller.importing}</span> : null}</button>
        {!typed || catchword && (search || lookup) ? <div className={styles.legendEnd}>
          {!typed ? <AccountMenu activeId={accountId} placement="above" align="end"
            renderTrigger={(trigger, mark) => <button {...trigger} className={styles.sign} aria-current={accountId === null ? undefined : "page"}>{mark}</button>}
            onNavigate={(event, destination) => {
              const activation = workspaceTargetActivationIntent(event);
              if (activation.kind === "Unowned") return "unhandled";
              event.preventDefault();
              if (activation.kind === "Consume") return "consumed";
              if (!controller.openTarget({ kind: "InternalHref", href: destination.href, labelHint: destination.label }, activation.intent === "new_pane" ? { disposition: { kind: "Fork" } } : undefined)) return "consumed";
              return "handled-destination-focus";
            }} /> : catchword ? <>
            <button type="button" className={cx(styles.sign, styles.catchword)} data-nexus-control={catchword.key}
              aria-label={lookup ? catchword.label : `all results for “${controller.parsed.text}”`} data-active={controller.selectedKey === catchword.key || undefined}
              aria-disabled={catchword.action.kind === "Unavailable" || undefined}
              {...catchwordHold} onClick={event => activate(catchword, event)}
              onKeyDown={event => { catchwordHold?.onKeyDown(event); activate(catchword, event); }}><Icon.Search size="1.25rem" aria-hidden="true" /></button>
            {search ? <><button type="button" className={styles.key} aria-label="ask the librarian" onClick={() => controller.askLibrarian()}>ask</button>
              <button type="button" className={styles.key} aria-label="save note to today" onClick={() => controller.runLegend("Nexus.Quick.Note", { disposition: { kind: "Follow" } })}>note</button></> : null}
          </> : null}
        </div> : null}
      </div>
    </div>
    <div className={styles.field}>
      <span className={styles.star} aria-hidden="true" style={{ "--star-grace": `${STAR_GRACE_MS}ms`, "--star-onset": `${STAR_ONSET_MS}ms` } as CSSProperties}>
        <AsterismMark size="1.25rem" lit={[controller.sources.device === "Idle" || controller.sources.device === "Answered", controller.sources.names === "Idle" || controller.sources.names === "Answered", controller.sources.texts === "Idle" || controller.sources.texts === "Answered"]} />
      </span>
      <input ref={inputRef} type="search" role="combobox" aria-label="find anything…" aria-autocomplete="list" aria-haspopup="grid" aria-controls={GRID_ID} aria-expanded="true"
        aria-describedby={`${ECHO_ID}${lookup ? ` ${NOTICE_ID}-guidance` : ""}`} value={controller.query} placeholder="find anything…" autoComplete="off" enterKeyHint="go"
        data-mobile-nexus-search data-nexus-control="Search"
        onChange={event => controller.setQuery(event.currentTarget.value)}
        onPaste={event => { const value = flattenedPaste(event); if (value !== null) controller.setQuery(value); }}
        onCompositionStart={() => { composing.current = true; controller.setComposing(true); }}
        onCompositionEnd={() => { composing.current = false; controller.setComposing(false); }}
        onKeyDown={event => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || event.key === "Process") { event.stopPropagation(); return; }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); controller.escape(); }
          else if (event.key === "Enter") {
            const activation = workspaceTargetActivationIntent(event, "activate");
            if (activation.kind === "Unowned") return;
            event.preventDefault();
            if (activation.kind === "Open") controller.submit({ disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } });
          }
        }} />
      <span id={ECHO_ID} className={styles.echo}>{echo}</span>
      {controller.query ? <Button iconOnly icon={<Icon.Dismiss aria-hidden="true" />} className={styles.clear} aria-label="clear search" onClick={() => { controller.setQuery(""); inputRef.current?.focus(); }} /> : <span />}
    </div>
  </>;

  return <MobileSheet active={controller.open} panelId="Nexus" handleLabel="close nexus" heightLimit="available" flushBottom={controller.page.kind === "Root"}
    slipContent={controller.page.kind === "Root" ? listRef : controller.page.kind === "Import" ? importBody : undefined}
    interactionLayer={controller.interactionLayer} onDismiss={controller.dismissAccepted} onDismissRequest={controller.guardClose}
    ariaLabel={controller.dialogLabel} initialFocus={controller.initialFocus} returnFocusTo={controller.returnFocusTo} returnFocusFallback={controller.returnFocusFallback}
    skipReturnFocus={controller.suppressReturnFocus} focusKey={controller.focusKey}>
    <div className={cx(styles.sheet, controller.page.kind === "Root" && typed && styles.typed)}
      onPointerDownCapture={event => { taskPointerId.current = event.pointerId; }}
      onPointerCancelCapture={event => { if (taskPointerId.current === event.pointerId) taskPointerId.current = null; }} onClickCapture={admitClick}>
      {controller.page.kind === "Root" ? root : <NexusPages scrollRef={importBody} controller={controller} mobile />}
    </div>
  </MobileSheet>;
}
