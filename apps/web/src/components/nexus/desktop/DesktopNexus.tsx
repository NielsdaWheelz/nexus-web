"use client";

// The desktop palette: a card with the query, one scrollport of rows and, while typed, the
// continuations pinned below it so arrivals never move them. The query edits text and arms rows;
// → or tab opens the armed row's rail; native controls own their actions.
import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import { ExcerptDialog } from "@/components/resources/ExcerptDisclosure";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import ModalFrame from "@/components/ui/ModalFrame";
import OverflowMenuButton from "@/components/ui/OverflowMenuButton";
import collection from "@/components/ui/Collection.module.css";
import type { NexusGroup, NexusRow } from "@/lib/nexus/model";
import { ARRIVAL_ONSET_MS } from "@/lib/nexus/policy";
import type { ResourceItem } from "@/lib/resources/items";
import { revealCollectionItem } from "@/lib/ui/collection";
import { cx } from "@/lib/ui/cx";
import { isTopmostInteractionOwner } from "@/lib/ui/overlay";
import { workspaceTargetActivationIntent } from "@/lib/ui/targetActivation";
import { NexusQuerySpinner, NexusNotices, NexusRowBody, nexusRowAlias, nexusRowName, nexusRowVerbs } from "../NexusRow";
import NexusPages from "../NexusPages";
import { NexusPaneDrag, NexusPaneSortable, NexusPaneListHeader, NexusClosedPanes, paneCandidateName, paneRowName, paneDragStyle } from "../NexusPaneList";
import NexusVerbRail from "../NexusVerbRail";
import type { NexusController } from "../useNexusController";
import styles from "../Nexus.module.css";

const GRID_ID = "desktop-nexus-results";
const CONTINUATIONS_ID = "desktop-nexus-continuations";
const RAIL_ID = "desktop-nexus-rail";
const NOTICE_ID = "desktop-nexus-notices";
const HELP_ID = "desktop-nexus-help";
const CLOSE_HELP_ID = "desktop-nexus-close-help";

function candidateId(key: string): string {
  return `desktop-nexus-candidate-${encodeURIComponent(key)}`;
}

function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

export default function DesktopNexus({ controller }: { controller: NexusController }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const workflowRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  /** The query's text selection when the rail opened; the rail's exit restores it. */
  const caret = useRef<{ readonly start: number; readonly end: number; readonly direction: "forward" | "backward" | "none" } | null>(null);
  const [excerpt, setExcerpt] = useState<ResourceItem | null>(null);
  if (!controller.open && excerpt !== null) setExcerpt(null);
  const composed = controller.groups.length > 0;
  useLayoutEffect(() => {
    const port = listRef.current;
    if (!controller.open || controller.page.kind !== "Root" || !port || !composed) return;
    const positions = controller.rootScroll.current;
    port.scrollTop = positions[controller.rootMode];
    positions[controller.rootMode] = port.scrollTop;
  }, [controller.open, controller.page.kind, controller.rootMode, controller.query, controller.rootScroll, composed]);
  const pointerPress = useRef<{ readonly key: string; readonly x: number; readonly y: number; moved: boolean } | null>(null);
  // Law 3: the pointer is deliberate once it has travelled 8px since the last keystroke; at rest it is not.
  const pointerRest = useRef<{ readonly x: number; readonly y: number } | "Travelled" | null>(null);
  useLayoutEffect(() => { pointerRest.current = null; }, [controller.open]);
  const focusedNative = useRef<HTMLElement | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const typed = controller.rootMode === "Typed";
  const groups = controller.groups.filter(group => controller.reorder.placement === null || group.id === "Open");
  const rows = groups.flatMap(group => group.rows);
  const index = rows.findIndex((row) => row.key === controller.armed);
  const active = rows[index];
  const rail = controller.rail;
  const listed = new Set(controller.list.rows.map(row => row.key));
  const held = new Set(controller.list.held);
  const lookup = controller.lookupGuidance !== null;
  const verbsOf = (row: NexusRow) => nexusRowVerbs(row, row.state === "Current", controller, paneRowName(controller, row), setExcerpt);

  // A row control that leaves the tree (a closed pane, a retired rail) hands focus back to the query.
  useLayoutEffect(() => {
    const control = focusedNative.current;
    if (!control || control.isConnected) return;
    focusedNative.current = null;
    const focus = document.activeElement;
    if (focus instanceof HTMLElement && focus !== document.body && focus.isConnected && !focus.closest("[hidden], [inert]")) return;
    if (isTopmostInteractionOwner("Nexus")) inputRef.current?.focus({ preventScroll: true });
  });
  useLayoutEffect(() => {
    const port = listRef.current;
    const item = controller.armed === null ? null : document.getElementById(candidateId(controller.armed));
    if (port && item) revealCollectionItem(port, item);
  }, [controller.open, controller.page.kind, controller.armed, index]);

  const paneFocusRevision = useRef(controller.paneFocusRevision);
  useLayoutEffect(() => {
    if (paneFocusRevision.current === controller.paneFocusRevision) return;
    paneFocusRevision.current = controller.paneFocusRevision;
    if (!controller.open || !isTopmostInteractionOwner("Nexus")) return;
    const key = controller.paneFocusKey;
    const target = key !== null && !key.startsWith("Pane:")
      ? Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-nexus-control]") ?? []).find(node => node.dataset.nexusControl === key)
      : null;
    (target ?? inputRef.current)?.focus({ preventScroll: true });
  }, [controller.paneFocusRevision, controller.paneFocusKey, controller.open]);

  function openRail(key: string) {
    const input = inputRef.current;
    caret.current = input ? { start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0, direction: input.selectionDirection ?? "none" } : null;
    controller.openRail(key);
  }
  function closeRail(restoreFocus: boolean) {
    controller.closeRail();
    const input = inputRef.current;
    if (!restoreFocus || !input) return;
    input.focus({ preventScroll: true });
    const saved = caret.current;
    if (saved) input.setSelectionRange(saved.start, saved.end, saved.direction);
  }

  const results = controller.list.rows.length;
  const status = typed
    ? `${count(results, "result")}. ${count(controller.continuations.length, "query action")}.`
    : `${count(rows.length, "item")} in ${count(groups.length, "section")}`;

  const row = (item: NexusRow, group: NexusGroup["id"], rowIndex: number) => {
    const selected = item.key === controller.armed;
    const here = item.state === "Current";
    const alias = nexusRowAlias(item, lookup);
    const name = group === "Open" && controller.paneListPresented ? paneCandidateName(controller, item, rowIndex) : nexusRowName(item, here, alias);
    const reason = item.action.kind === "Unavailable" ? item.action.reason : undefined;
    const verbs = rail?.key === item.key ? verbsOf(item) : null;
    return (
      <NexusPaneSortable key={item.key} controller={controller} row={item}>{drag => <div
        ref={drag.setNodeRef}
        style={paneDragStyle(drag)}
        data-move-source={controller.reorder.placement?.kind === "ChoosePosition" && item.key === `Pane:${controller.reorder.placement.paneId}` || undefined}
        data-drag-over={drag.isSorting && !drag.isDragging && drag.over?.id === (item.secondary?.kind === "ClosePane" ? item.secondary.paneId : item.key) ? drag.activeIndex < drag.overIndex ? "after" : "before" : undefined}
        role="row"
        aria-selected={selected}
        className={cx(collection.row, styles.row)}
        data-active={selected || undefined}
        data-band={listed.has(item.key) ? held.has(item.key) ? "held" : "arriving" : undefined}
      >
        <div
          id={candidateId(item.key)}
          role="gridcell"
          aria-label={name}
          className={styles.cell}
          onPointerMove={event => {
            const press = pointerPress.current;
            if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) press.moved = true;
            if (event.pointerType === "touch") return;
            const rest = pointerRest.current;
            if (rest === null) {
              pointerRest.current = { x: event.clientX, y: event.clientY };
              return;
            }
            if (rest !== "Travelled") {
              if (Math.hypot(event.clientX - rest.x, event.clientY - rest.y) < 8) return;
              pointerRest.current = "Travelled";
            }
            if (document.activeElement === inputRef.current) controller.arm(item.key);
          }}
        >
          <div
            ref={drag.setActivatorNodeRef}
            data-nexus-control={item.key}
            className={styles.primary}
            onMouseDown={event => { if (drag.enabled && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && isTopmostInteractionOwner("Nexus")) drag.listeners?.onMouseDown?.(event); }}
            onTouchStart={event => { if (drag.enabled && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && isTopmostInteractionOwner("Nexus")) drag.listeners?.onTouchStart?.(event); }}
            aria-disabled={reason ? true : undefined}
            onPointerDown={event => {
              if (!event.isPrimary || event.button !== 0) return;
              pointerPress.current = { key: item.key, x: event.clientX, y: event.clientY, moved: false };
              drag.begin(event);
              if (event.pointerType !== "touch" && !drag.enabled) event.preventDefault();
            }}
            onPointerUp={event => { delete event.currentTarget.dataset.dragPointer; }}
            onPointerCancel={event => { pointerPress.current = null; delete event.currentTarget.dataset.dragPointer; }}
            onClick={(event) => {
              const press = pointerPress.current;
              pointerPress.current = null;
              if (event.detail !== 0 && (!press || press.key !== item.key || press.moved)) return;
              if (controller.reorder.placement !== null) {
                event.preventDefault();
                if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) { controller.arm(item.key); controller.activate(item.action, { disposition: { kind: "Follow" } }, item); }
                return;
              }
              const activation = workspaceTargetActivationIntent(event);
              if (activation.kind === "Unowned") return;
              event.preventDefault();
              if (activation.kind === "Consume") return;
              controller.arm(item.key);
              controller.activate(item.action, { disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } }, item);
            }}
          >
            <NexusRowBody row={item} here={here} query={controller.query} position={controller.reorder.placement?.kind === "ChoosePosition" && group === "Open" ? rowIndex + 1 : undefined} />
          </div>
          <div className={styles.trailing}>
            {alias ? <kbd className={styles.kbd} aria-hidden="true">{alias}</kbd> : null}
            {item.action.kind === "Available" && item.action.target.kind === "PaneOpen" && item.secondary?.kind === "ClosePane" ? <Button
              iconOnly
              tabIndex={-1}
              data-nexus-control={`ClosePane:${item.secondary.paneId}`}
              aria-label={`close ${paneRowName(controller, item)}`}
              aria-describedby={CLOSE_HELP_ID}
              onKeyDown={(event) => { if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault(); }}
              onClick={event => {
                event.currentTarget.focus({ preventScroll: true });
                controller.arm(item.key);
                if (item.secondary?.kind === "ClosePane") controller.closePane(item.secondary.paneId);
              }}
              icon={<X size={16} aria-hidden="true" />} />
            : item.secondary?.kind === "TargetMenu" ? <OverflowMenuButton
              tabIndex={-1}
              aria-label={`options for ${item.label}`}
              aria-expanded={verbs !== null}
              aria-controls={verbs !== null ? RAIL_ID : undefined}
              onClick={() => {
                controller.arm(item.key);
                if (verbs !== null) closeRail(true);
                else openRail(item.key);
              }} /> : null}
          </div>
          {verbs && rail ? <NexusVerbRail id={RAIL_ID} label={`options for ${item.label}`} verbs={verbs} rail={rail} controller={controller}
            mobile={false} onClose={closeRail} returnFocusTo={() => inputRef.current} /> : null}
        </div>
      </div>}</NexusPaneSortable>
    );
  };

  const root = (
    <>
      <h2 className="sr-only" tabIndex={-1} data-switchboard-heading>Nexus</h2>
      <div className={styles.query} data-feedback-controls="true">
        <span className={styles.gutter} aria-hidden="true"><NexusQuerySpinner pending={controller.pending} /></span>
        <Input
          ref={inputRef}
          bare
          role="combobox"
          aria-label="find anything…"
          aria-autocomplete="list"
          aria-haspopup="grid"
          aria-controls={GRID_ID}
          aria-expanded="true"
          aria-activedescendant={inputFocused && active ? candidateId(active.key) : undefined}
          aria-describedby={controller.lookupGuidance === null ? HELP_ID : `${HELP_ID} ${NOTICE_ID}-guidance`}
          className={styles.input}
          value={controller.query}
          placeholder="find anything…"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={() => {
            setInputFocused(true);
            // Focus back in the query leaves the rail: its keys and enter are the query's again.
            if (controller.rail !== null) controller.closeRail();
          }}
          onBlur={() => setInputFocused(false)}
          onChange={(event) => controller.setQuery(event.currentTarget.value)}
          onCompositionStart={() => {
            composing.current = true;
            controller.setComposing(true);
          }}
          onCompositionEnd={() => {
            composing.current = false;
            controller.setComposing(false);
          }}
          onKeyDown={(event) => {
            pointerRest.current = null;
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
              // The modal's document-level Escape owner must not see an IME key.
              event.stopPropagation();
              return;
            }
            if (event.defaultPrevented || !isTopmostInteractionOwner("Nexus")) return;
            const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
            const input = event.currentTarget;
            const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
            if (plain && controller.reorder.placement === null && (event.key === "Tab" || (event.key === "ArrowRight" && atEnd))) {
              // Law 6: tab, or → at the end of the text, opens the armed row's verbs; tab never leaves the query.
              if (event.key === "Tab") event.preventDefault();
              if (!active || verbsOf(active) === null) return;
              event.preventDefault();
              openRail(active.key);
            } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && plain && rows.length > 0) {
              event.preventDefault();
              const down = event.key === "ArrowDown";
              const next = rows[index < 0 ? (down ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, index + (down ? 1 : -1)))]!;
              controller.arm(next.key);
              if (next.key === controller.armed) {
                const port = listRef.current;
                const item = document.getElementById(candidateId(next.key));
                if (port && item) revealCollectionItem(port, item);
              }
            } else if (event.key === "Enter") {
              if (controller.reorder.placement !== null) {
                event.preventDefault();
                if (!event.repeat && plain && active) controller.activate(active.action, { disposition: { kind: "Follow" } }, active);
                return;
              }
              const activation = workspaceTargetActivationIntent(event, "activate");
              if (activation.kind === "Unowned") return;
              event.preventDefault();
              if (activation.kind === "Consume") return;
              controller.submit({ disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } });
            } else if (event.key === "Escape") {
              event.preventDefault();
              controller.escape();
            }
          }}
        />
      </div>
      <span id={HELP_ID} className="sr-only">
        {controller.reorder.placement !== null ? controller.reorder.placement.kind === "ChoosePane" ? "choose a pane to move. arrows select; enter chooses." : `choose a position for “${controller.reorder.sourceName}”. arrows select; enter places.`
          : "arrows select results. enter activates; shift plus enter opens in a new pane. right arrow or tab shows the selected result's options."}
      </span>
      <span id={CLOSE_HELP_ID} className="sr-only">enter or space closes this pane.</span>
      <NexusPaneDrag controller={controller} scrollport={() => listRef.current} mobile={false}>
        <div className={styles.body}>
          <div
            ref={listRef}
            onScroll={event => { controller.rootScroll.current[controller.rootMode] = event.currentTarget.scrollTop; }}
            aria-busy={controller.busy || undefined}
            className={styles.list}
            onFocusCapture={event => { if (event.target instanceof HTMLElement) focusedNative.current = event.target; }}
          >
            <div id={GRID_ID} role="grid" aria-label={typed ? "find results" : "nexus options"} aria-colcount={1} aria-owns={typed && controller.continuations.length > 0 ? CONTINUATIONS_ID : undefined} className={styles.grid}
              style={{ "--arrival-onset": `${ARRIVAL_ONSET_MS}ms` } as CSSProperties}>
              {groups.filter(group => !(typed && group.id === "Continuations")).map((group) => (
                <Fragment key={group.id}>
                  <div role="rowgroup" aria-labelledby={group.label ? `desktop-nexus-section-${group.id}` : undefined} aria-label={group.label ? undefined : group.id === "Results" ? "results" : group.id === "Here" ? "here" : "query actions"}>
                    {group.label ? <div role="row">
                      <div role="gridcell">
                        {group.id === "Open" && controller.paneListPresented ? <NexusPaneListHeader controller={controller} mobile={false} /> : <h3 id={`desktop-nexus-section-${group.id}`} className={styles.head}>{group.label}</h3>}
                      </div>
                    </div> : null}
                    <div id={group.id === "Open" && controller.paneListPresented ? "desktop-nexus-open-panes" : undefined} role="presentation">
                      {group.rows.map((item, rowIndex) => row(item, group.id, rowIndex))}
                    </div>
                  </div>
                  {group.id === "Open" ? <NexusClosedPanes controller={controller} mobile={false} /> : null}
                </Fragment>
              ))}
            </div>
          </div>
          {typed && controller.continuations.length > 0 ? <div id={CONTINUATIONS_ID} role="rowgroup" aria-label="query actions" className={cx(styles.grid, styles.continuations)} data-nexus-continuations="">
            {controller.continuations.map((item, rowIndex) => row(item, "Continuations", rowIndex))}
          </div> : null}
        </div>
      </NexusPaneDrag>
      <NexusNotices controller={controller} id={NOTICE_ID} returnFocus={() => inputRef.current} />
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {[controller.announcement, controller.pending ? null : status].filter(Boolean).join(" ")}
      </div>
      {excerpt ? <ExcerptDialog item={excerpt} onClose={() => setExcerpt(null)} returnFocusTo={() => inputRef.current} /> : null}
    </>
  );

  // Every root dismissal uses the controller; child pages keep their guarded back step.
  return (
    <ModalFrame
      open={controller.open}
      interactionLayer={controller.interactionLayer}
      scope="Nexus"
      onDismiss={controller.escape}
      label={controller.dialogLabel}
      slipContent={controller.page.kind === "Root" ? listRef : workflowRef}
      initialFocus={controller.initialFocus}
      skipReturnFocus={controller.suppressReturnFocus}
      returnFocusTo={controller.returnFocusTo}
      returnFocusFallback={controller.returnFocusFallback}
      focusKey={controller.focusKey}
      backdropClassName={styles.backdrop}
      className={cx(styles.surface, controller.page.kind === "Root" && typed && styles.typed)}
    >
      {controller.page.kind === "Root" ? (
        root
      ) : (
        <div ref={workflowRef} className={styles.workflow}>
          <NexusPages controller={controller} mobile={false} />
        </div>
      )}
    </ModalFrame>
  );
}
