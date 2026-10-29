"use client";

// The query edits text and selects candidates; native secondary buttons own their actions.
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import ModalFrame from "@/components/ui/ModalFrame";
import OverflowMenuButton from "@/components/ui/OverflowMenuButton";
import { assertNever } from "@/lib/assertNever";
import { workspaceTargetActivationIntent } from "@/lib/ui/targetActivation";
import { rowFacts, rowName } from "@/lib/nexus/rows";
import { resourceMetadataText } from "@/lib/resources/metadata";
import { revealCollectionItem, useCollectionLayout } from "@/lib/ui/collection";
import { PANE_TITLES_FAILED } from "@/lib/workspace/presentations";
import collection from "@/components/ui/Collection.module.css";
import { isTopmostInteractionOwner } from "@/lib/ui/overlay";
import { NexusRowBody, NexusRowMenu, NexusSearchStatus, NexusTitleFailure } from "../NexusRow";
import NexusPages from "../NexusPages";
import { NexusPaneDrag, NexusPaneSortable, NexusPaneListHeader, NexusClosedPanes, paneCandidateName, paneRowName, paneDragStyle } from "../NexusPaneList";
import type { NexusController } from "../useNexusController";
import styles from "../Nexus.module.css";

const GRID_ID = "desktop-nexus-results";
const HELP_ID = "desktop-nexus-help";
const MENU_HELP_ID = "desktop-nexus-menu-help";
const CLOSE_HELP_ID = "desktop-nexus-close-help";

function candidateId(key: string): string {
  return `desktop-nexus-candidate-${encodeURIComponent(key)}`;
}

function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

export default function DesktopNexus({ controller }: { controller: NexusController }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLElement | null>(null);
  useCollectionLayout(surfaceRef, controller.open && controller.page.kind === "Root");
  const composing = useRef(false);
  const markSearchInteraction = controller.interact;
  const refreshRevision = useRef(controller.searchRefreshRevision);
  useLayoutEffect(() => {
    if (refreshRevision.current === controller.searchRefreshRevision) return;
    refreshRevision.current = controller.searchRefreshRevision;
    if (gridRef.current) gridRef.current.scrollTop = 0;
  }, [controller.searchRefreshRevision]);
  const pointerPress = useRef<{ readonly key: string; readonly x: number; readonly y: number; moved: boolean } | null>(null);
  const focusedSecondary = useRef<HTMLButtonElement | null>(null);
  const focusedNative = useRef<HTMLElement | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const rows = controller.groups.filter(group => controller.reorder.placement === null || group.id === "Open").flatMap((group) => group.rows);
  const index = rows.findIndex((row) => row.key === controller.activeKey);
  const active = rows[index];

  useLayoutEffect(() => {
    const button = focusedSecondary.current ?? focusedNative.current;
    if (!button || button.isConnected) return;
    focusedSecondary.current = null;
    focusedNative.current = null;
    const focus = document.activeElement;
    if (focus instanceof HTMLElement && focus !== document.body && focus.isConnected && !focus.closest("[hidden], [inert]")) return;
    if (isTopmostInteractionOwner("Nexus")) inputRef.current?.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (!controller.open || controller.page.kind !== "Root") return;
    const selected = () => {
      const selection = window.getSelection();
      if (selection !== null && !selection.isCollapsed && (gridRef.current?.contains(selection.anchorNode) || gridRef.current?.contains(selection.focusNode))) markSearchInteraction();
    };
    document.addEventListener("selectionchange", selected);
    return () => document.removeEventListener("selectionchange", selected);
  }, [controller.open, controller.page.kind, markSearchInteraction]);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    const item = controller.activeKey === null ? null : document.getElementById(candidateId(controller.activeKey));
    if (grid && item) revealCollectionItem(grid, item);
  }, [controller.open, controller.page.kind, controller.activeKey, index]);

  const paneFocusRevision = useRef(controller.paneFocusRevision);
  useLayoutEffect(() => {
    if (paneFocusRevision.current === controller.paneFocusRevision) return;
    paneFocusRevision.current = controller.paneFocusRevision;
    if (!controller.open || !isTopmostInteractionOwner("Nexus")) return;
    const key = controller.paneFocusKey;
    const target = key !== null && !key.startsWith("Pane:")
      ? Array.from(gridRef.current?.querySelectorAll<HTMLElement>("[data-nexus-control]") ?? []).find(node => node.dataset.nexusControl === key)
      : null;
    (target ?? inputRef.current)?.focus({ preventScroll: true });
  }, [controller.paneFocusRevision, controller.paneFocusKey, controller.open]);
  const typed = controller.query.trim().length > 0;
  const queryActions = controller.groups.find((group) => group.id === "QuickActions")?.rows.length ?? 0;
  const status = typed
    ? `${count(rows.length - queryActions, "result")}. ${count(queryActions, "query action")}.`
    : `${count(rows.length, "item")} in ${count(controller.groups.length, "section")}`;
  const canSelect = active?.action.kind === "Available";
  let opensDestination = false;
  if (active?.action.kind === "Available") {
    const target = active.action.target;
    switch (target.kind) {
      case "Resource":
      case "InternalHref":
      case "PaneOpen":
      case "OpenAcceptedSource":
      case "OpenDailyPage":
      case "CreatePage":
      case "CreateLibrary":
      case "ChooseCreate":
      case "ChooseBrowse":
        opensDestination = true;
        break;
      case "ResumeCurrentPlayback":
      case "OpenAdd":
        break;
      default: assertNever(target);
    }
  }
  const menuAvailable = active?.secondary?.kind === "ResourceMenu";
  const help = controller.reorder.placement !== null ? controller.reorder.placement.kind === "ChoosePane" ? "choose a pane to move · up/down browse · enter choose" : `choose a position for “${controller.reorder.sourceName}” · up/down browse · enter place` : [rows.length > 0 ? "up/down browse" : null, canSelect ? opensDestination ? "enter open · shift+enter new pane" : "enter select" : null, menuAvailable ? "tab for options" : null].filter(Boolean).join(" · ");

  const root = (
    <>
      <h2 className="sr-only" tabIndex={-1} data-switchboard-heading>Nexus</h2>
      <label className={styles.inputRow}>
        <span className="sr-only">Find anything…</span>
        <Input
          ref={inputRef}
          bare
          role="combobox"
          aria-label="Find anything…"
          aria-autocomplete="list"
          aria-haspopup="grid"
          aria-controls={GRID_ID}
          aria-expanded="true"
          aria-activedescendant={inputFocused && active ? candidateId(active.key) : undefined}
          aria-describedby={controller.lookupGuidance === null ? HELP_ID : `${HELP_ID} desktop-nexus-guidance`}
          className={styles.input}
          value={controller.query}
          placeholder="Find anything…"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={() => setInputFocused(true)}
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
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
              // The modal's document-level Escape owner must not see an IME key.
              event.stopPropagation();
              return;
            }
            if (event.defaultPrevented || !isTopmostInteractionOwner("Nexus")) return;
            const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && plain && rows.length > 0) {
              event.preventDefault();
              const down = event.key === "ArrowDown";
              const next = rows[index < 0 ? (down ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, index + (down ? 1 : -1)))]!;
              controller.setActive(next.key);
              if (next.key === controller.activeKey) {
                const grid = gridRef.current;
                const item = document.getElementById(candidateId(next.key));
                if (grid && item) revealCollectionItem(grid, item);
              }
            } else if (event.key === "Enter") {
              if (controller.reorder.placement !== null) {
                event.preventDefault();
                if (!event.repeat && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && active) controller.activate(active.action, { disposition: { kind: "Follow" } }, active);
                return;
              }
              const activation = workspaceTargetActivationIntent(event, "activate");
              if (activation.kind === "Unowned") return;
              event.preventDefault();
              if (activation.kind === "Consume") return;
              controller.submitInput({ disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } });
            } else if (event.key === "Escape") {
              event.preventDefault();
              if (controller.reorder.placement !== null || controller.reorder.draggingPaneId !== null) controller.escape();
              else if (controller.query) controller.setQuery("");
              else controller.escape();
            }
          }}
        />
      </label>
      <div className={styles.help} aria-hidden="true">{help}</div>
      <span id={HELP_ID} className="sr-only">
        {controller.reorder.placement !== null ? `${help}.` : null}
        {controller.reorder.placement === null && rows.length > 0 ? "up and down arrows browse results. " : ""}
        {controller.reorder.placement === null && canSelect ? opensDestination ? "enter opens the selected result. shift plus enter opens in a new pane. " : "enter selects the highlighted action. " : ""}
        {menuAvailable ? "tab reaches options for the selected result." : ""}
      </span>
      <span id={MENU_HELP_ID} className="sr-only">enter or space opens options. escape returns to the query.</span>
      <span id={CLOSE_HELP_ID} className="sr-only">enter or space closes this pane.</span>
      {controller.lookupGuidance === null ? null : <div id="desktop-nexus-guidance" className={styles.help}>{controller.lookupGuidance}</div>}
      <NexusSearchStatus controller={controller} returnFocus={() => inputRef.current} />
      <NexusTitleFailure failed={controller.titlesFailed} retry={controller.retryTitles} returnFocus={() => inputRef.current} announce={false} />
      <NexusPaneDrag controller={controller} scrollport={() => gridRef.current} mobile={false}>
      <div
        ref={node => { gridRef.current = node; surfaceRef.current = node?.parentElement ?? null; }}
        id={GRID_ID}
        role="grid"
        aria-label={typed ? "Find results" : "Nexus options"}
        aria-colcount={1}
        aria-busy={controller.busy || undefined}
        className={`${collection.fillViewport} ${styles.grid}`}
        data-collection-viewport=""
        onPointerDownCapture={controller.interact}
        onFocusCapture={event => { focusedNative.current = event.target instanceof HTMLElement ? event.target : null; controller.interact(); }}
        onWheelCapture={controller.interact}
        onTouchMoveCapture={controller.interact}
        onKeyDownCapture={controller.interact}
      >
        {controller.groups.map((group) => (
          <Fragment key={group.id}>
          <div role="rowgroup" aria-labelledby={`desktop-nexus-section-${group.id}`} className={styles.group}>
            <div role="row" className={styles.headingRow}>
              <div role="gridcell">
                {group.id === "Open" && controller.paneListPresented ? <NexusPaneListHeader controller={controller} mobile={false} /> : <h3 id={`desktop-nexus-section-${group.id}`}>{group.label}</h3>}
              </div>
            </div>
            <div id={group.id === "Open" && controller.paneListPresented ? "desktop-nexus-open-panes" : undefined} role="presentation">
            {group.rows.map((row, rowIndex) => {
              const selected = row.key === controller.activeKey;
              const ownExcerpt = row.match?.excerpt.text;
              const snippet = row.matchingPassage?.match?.excerpt.text
                ?? ((row.item?.preview.body.kind === "named" && ownExcerpt === row.item.preview.body.title) || (row.item?.preview.body.kind === "media" && ownExcerpt === row.item.preview.body.media_summary.title) ? undefined : ownExcerpt);
              const passageFacts = row.matchingPassage
                ? resourceMetadataText(row.matchingPassage.item, row.matchingPassage.match_method)
                : undefined;
              const reason = row.action.kind === "Unavailable" ? row.action.reason : undefined;
              return (
                <NexusPaneSortable key={row.key} controller={controller} row={row}>{drag => <div
                  ref={drag.setNodeRef}
                  style={paneDragStyle(drag)}
                  data-move-source={controller.reorder.placement?.kind === "ChoosePosition" && row.key === `Pane:${controller.reorder.placement.paneId}` || undefined}
                  data-drag-over={drag.isSorting && !drag.isDragging && drag.over?.id === (row.secondary?.kind === "ClosePane" ? row.secondary.paneId : row.key) ? drag.activeIndex < drag.overIndex ? "after" : "before" : undefined}
                  role="row"
                  aria-selected={selected}
                  className={`${collection.row} ${styles.gridRow}`}
                  data-active={selected || undefined}
                  data-nested={row.parent ? true : undefined}
                >
                  <div
                    id={candidateId(row.key)}
                    role="gridcell"
                    aria-label={group.id === "Open" && controller.paneListPresented ? paneCandidateName(controller, row, rowIndex) : rowName([row.label, rowFacts(row, true), snippet, passageFacts, reason])}
                    className={styles.candidateCell}
                    aria-disabled={reason ? true : undefined}
                    onPointerMove={event => {
                      const press = pointerPress.current;
                      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) press.moved = true;
                      if (event.pointerType !== "touch" && event.buttons === 0 && (event.movementX !== 0 || event.movementY !== 0)
                        && document.activeElement === inputRef.current) controller.setActive(row.key, false);
                    }}
                  >
                    <div
                      ref={drag.setActivatorNodeRef}
                      data-nexus-control={row.key}
                      className={styles.primaryCell}
                      onMouseDown={event => { if (drag.enabled && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && isTopmostInteractionOwner("Nexus")) drag.listeners?.onMouseDown?.(event); }}
                      onTouchStart={event => { if (drag.enabled && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && isTopmostInteractionOwner("Nexus")) drag.listeners?.onTouchStart?.(event); }}
                      aria-disabled={reason ? true : undefined}
                      onPointerDown={event => {
                        if (!event.isPrimary || event.button !== 0) return;
                        pointerPress.current = { key: row.key, x: event.clientX, y: event.clientY, moved: false };
                        drag.begin(event);
                        if (event.pointerType !== "touch" && !drag.enabled) event.preventDefault();
                      }}
                      onPointerUp={event => { delete event.currentTarget.dataset.dragPointer; }}
                      onPointerCancel={event => { pointerPress.current = null; delete event.currentTarget.dataset.dragPointer; }}
                      onClick={(event) => {
                        const press = pointerPress.current;
                        pointerPress.current = null;
                        if (event.detail !== 0 && (!press || press.key !== row.key || press.moved)) return;
                        if (controller.reorder.placement !== null) {
                          event.preventDefault();
                          if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) { controller.setActive(row.key); controller.activate(row.action, { disposition: { kind: "Follow" } }, row); }
                          return;
                        }
                        const activation = workspaceTargetActivationIntent(event);
                        if (activation.kind === "Unowned") return;
                        event.preventDefault();
                        if (activation.kind === "Consume") return;
                        controller.setActive(row.key);
                        controller.activate(
                          row.action,
                          { disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } },
                          row,
                        );
                      }}
                    >
                      {controller.reorder.placement?.kind === "ChoosePosition" && group.id === "Open" ? <span className={styles.panePosition} aria-hidden>{rowIndex + 1}</span> : null}
                      <NexusRowBody row={row} desktop />
                    </div>
                    {row.secondary?.kind === "ClosePane" ? (
                      <Button
                        iconOnly
                        tabIndex={selected ? 0 : -1}
                        className={styles.actionsButton}
                        data-nexus-control={`ClosePane:${row.secondary.paneId}`}
                        aria-label={`close ${paneRowName(controller, row)}`}
                        aria-describedby={CLOSE_HELP_ID}

                        onFocus={(event) => {
                          focusedSecondary.current = event.currentTarget;
                          controller.setActive(row.key);
                        }}
                        onBlur={() => { focusedSecondary.current = null; }}
                        onKeyDown={(event) => {
                          if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
                        }}
                        onClick={event => {
                          event.currentTarget.focus({ preventScroll: true });
                          controller.setActive(row.key);
                          if (row.secondary?.kind === "ClosePane") controller.closePane(row.secondary.paneId);
                        }}
                        icon={<X size={18} aria-hidden="true" />} />
                    ) : row.secondary?.kind === "ResourceMenu" ? <NexusRowMenu
                      row={row}
                      activate={controller.activate}
                      closePane={controller.closePane}
                      menuProps={{
                        label: `options for ${row.label}`,
                        align: "end",
                        className: styles.rowMenu,
                        triggerAttributes: { tabIndex: selected ? 0 : -1 },
                        returnFocusTo: () => inputRef.current,
                        renderTrigger: (trigger) => (
                          <OverflowMenuButton
                            {...trigger}
                            aria-describedby={MENU_HELP_ID}
                            className={styles.actionsButton}
                            onFocus={(event) => {
                              focusedSecondary.current = event.currentTarget;
                              controller.setActive(row.key);
                            }}
                            onBlur={() => { focusedSecondary.current = null; }}
                            onClick={(event) => {
                              controller.setActive(row.key);
                              trigger.onClick(event);
                            }}
                          />
                        ),
                      }}
                    /> : null}
                  </div>
                </div>}</NexusPaneSortable>
              );
            })}
            </div>
          </div>
          {group.id === "Open" ? <NexusClosedPanes controller={controller} mobile={false} /> : null}
          </Fragment>
        ))}
      </div>
      </NexusPaneDrag>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {[controller.announcement || controller.lookupGuidance, controller.searchProgress.text, controller.titlesFailed ? PANE_TITLES_FAILED : null, !controller.pending ? status : null].filter(Boolean).join(" ")}
      </div>
    </>
  );

  // Escape, Back and the scrim all take one step back: a page, the query, then the palette.
  return (
    <ModalFrame
      open={controller.open}
      interactionLayer={controller.interactionLayer}
      scope="Nexus"
      onDismiss={controller.escape}
      label={controller.dialogLabel}
      initialFocus={controller.initialFocus}
      skipReturnFocus={controller.suppressReturnFocus}
      returnFocusTo={controller.returnFocusTo}
      returnFocusFallback={controller.returnFocusFallback}
      focusKey={controller.focusKey}
      backdropClassName={styles.backdrop}
      className={styles.surface}
    >
      {controller.page.kind === "Root" ? (
        root
      ) : (
        <div className={styles.workflow}>
          <NexusPages controller={controller} mobile={false} />
        </div>
      )}
    </ModalFrame>
  );
}
