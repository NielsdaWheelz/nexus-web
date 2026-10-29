"use client";

// Pane-specific gesture ownership and content shared by the two existing presenters.
import { DndContext, DragOverlay, MouseSensor, TouchSensor, closestCenter, useDndContext, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronUp, RotateCcw } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import Button from "@/components/ui/Button";
import type { NexusRow } from "@/lib/nexus/model";
import { rowFacts, rowName } from "@/lib/nexus/rows";
import { suppressDragReleaseClick, TOUCH_DRAG_CLAIMED } from "@/lib/ui/dragGesture";
import { useOverlayContainer } from "@/lib/ui/overlay";
import { NexusRowBody } from "./NexusRow";
import type { NexusController } from "./useNexusController";
import styles from "./Nexus.module.css";

type DragBody = ReturnType<typeof useSortable> & { begin(event: PointerEvent<HTMLElement>): void; enabled: boolean };

export function paneRowName(controller: NexusController, row: NexusRow): string {
  const index = controller.panes.findIndex(pane => row.key === `Pane:${pane.id}`);
  const duplicate = controller.panes.filter(pane => pane.presentation.title === row.label).length > 1;
  return [row.label, duplicate ? row.detail : null, duplicate && index >= 0 ? `pane ${index + 1} of ${controller.panes.length}` : null].filter(Boolean).join(", ");
}

export function paneCandidateName(controller: NexusController, row: NexusRow, index: number): string {
  const placement = controller.reorder.placement;
  if (placement?.kind === "ChoosePosition") return `place ${controller.reorder.sourceName} at position ${index + 1} of ${controller.panes.length}; currently ${row.label}`;
  const name = paneRowName(controller, row);
  const duplicate = controller.panes.filter(pane => pane.presentation.title === row.label).length > 1;
  return placement?.kind === "ChoosePane" ? `move ${name}` : rowName([name, duplicate ? row.state?.toLowerCase() : rowFacts(row, false)]);
}

export function NexusPaneSortable({ controller, row, children }: {
  controller: NexusController; row: NexusRow; children(drag: DragBody): ReactNode;
}) {
  const enabled = controller.paneListComplete && controller.reorder.available && controller.reorder.placement === null && row.secondary?.kind === "ClosePane";
  const paneId = row.secondary?.kind === "ClosePane" ? row.secondary.paneId : row.key;
  const sortable = useSortable({ id: paneId, disabled: { draggable: !enabled, droppable: !enabled }, transition: null });
  return children({ ...sortable, enabled, begin(event) {
    if (enabled && event.isPrimary && event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.currentTarget.dataset.dragPointer = String(event.pointerId);
    }
  } });
}

export function paneDragStyle(drag: DragBody) {
  return { transform: CSS.Translate.toString(drag.transform), opacity: drag.isDragging ? 0.35 : undefined };
}

export function NexusPaneDrag({ controller, scrollport, mobile, children }: {
  controller: NexusController; scrollport(): HTMLElement | null; mobile: boolean; children: ReactNode;
}) {
  const overlay = useOverlayContainer();
  const retired = useRef(false);
  const getScrollport = useRef(scrollport);
  getScrollport.current = scrollport;
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const dragged = controller.reorder.draggingPaneId;
  const row = controller.groups.find(group => group.id === "Open")?.rows.find(item => item.key === `Pane:${dragged}`);
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 8 } }), useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }));
  useLayoutEffect(() => {
    retired.current = false;
    return () => {
      retired.current = true;
      suppressHeldRelease(getScrollport.current());
    };
  }, []);
  return <DndContext sensors={sensors}
    accessibility={{ announcements: { onDragStart: () => undefined, onDragOver: () => undefined, onDragEnd: () => undefined, onDragCancel: () => undefined }, screenReaderInstructions: { draggable: "" }, restoreFocus: false }}
    autoScroll={{ canScroll: element => element === scrollport(), layoutShiftCompensation: false }}
    modifiers={[({ transform }) => ({ ...transform, x: 0, scaleX: 1, scaleY: 1 })]}
    collisionDetection={args => {
      const rect = scrollport()?.getBoundingClientRect();
      const point = args.pointerCoordinates;
      return rect && point && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom ? closestCenter(args) : [];
    }}
    onDragStart={event => {
      const port = scrollport();
      suppressHeldRelease(port);
      if (event.activatorEvent instanceof TouchEvent) port?.dispatchEvent(new Event(TOUCH_DRAG_CLAIMED));
      if (!controllerRef.current.reorder.startDrag(String(event.active.id))) controllerRef.current.reorder.cancelDrag();
    }}
    onDragCancel={() => { if (!retired.current) controllerRef.current.reorder.cancelDrag(); }}
    onDragEnd={event => {
      const latest = controllerRef.current;
      const index = event.over ? latest.panes.findIndex(pane => pane.id === String(event.over!.id)) : -1;
      if (index < 0) latest.reorder.cancelDrag();
      else latest.reorder.endDrag(String(event.active.id), index);
    }}>
    <PaneSensorRetirement epoch={controller.reorder.sensorEpoch} scrollport={scrollport} retired={retired} />
    <SortableContext items={controller.paneListComplete ? controller.panes.map(pane => pane.id) : []} strategy={verticalListSortingStrategy}>{children}</SortableContext>
    {overlay ? createPortal(<DragOverlay adjustScale={false} dropAnimation={null} style={{ pointerEvents: "none" }}>{row ? <div className={`${styles.paneDragPreview} ${mobile ? styles.mobile : ""}`} aria-hidden inert><NexusRowBody row={row} desktop={!mobile} /></div> : null}</DragOverlay>, overlay) : null}
  </DndContext>;
}

function suppressHeldRelease(port: HTMLElement | null) {
  const held = port?.querySelector<HTMLElement>("[data-drag-pointer]");
  if (held?.dataset.dragPointer) suppressDragReleaseClick(Number(held.dataset.dragPointer));
}

function PaneSensorRetirement({ epoch, scrollport, retired }: { epoch: number; scrollport(): HTMLElement | null; retired: { current: boolean } }) {
  const { cancel } = useDndContext();
  const previous = useRef(epoch);
  useLayoutEffect(() => {
    if (previous.current === epoch) return;
    previous.current = epoch;
    suppressHeldRelease(scrollport());
    retired.current = true;
    cancel();
    retired.current = false;
  }, [epoch, cancel, scrollport, retired]);
  return null;
}

export function NexusPaneListHeader({ controller, mobile }: { controller: NexusController; mobile: boolean }) {
  const placement = controller.reorder.placement;
  const listId = mobile ? "mobile-nexus-open-panes" : "desktop-nexus-open-panes";
  return <>
    <div className={styles.paneListHeading}>
      <h3 id={mobile ? "mobile-nexus-group-Open" : "desktop-nexus-section-Open"}>open panes · {controller.panes.length}</h3>
      <div className={styles.paneListActions}>
        {controller.reorder.available || placement !== null ? <Button className={styles.paneListAction} data-nexus-control="Reorder"
          onKeyDown={event => { if ((event.key === "Enter" || event.key === " ") && (event.repeat || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)) event.preventDefault(); }}
          onClick={event => { if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) { if (placement === null) controller.reorder.start(); else controller.reorder.cancel(); } }}>{placement === null ? "reorder" : "cancel"}</Button> : null}
        {controller.panePreviewCount < controller.panes.length ? <Button className={styles.paneListAction} data-nexus-control="PanesDisclosure" aria-controls={listId} aria-expanded={controller.panesExpanded}
          aria-label={controller.panesExpanded ? `collapse open panes, show ${controller.panePreviewCount} of ${controller.panes.length}` : `expand open panes, show all ${controller.panes.length}`}
          onClick={controller.togglePanesExpanded} icon={controller.panesExpanded ? <ChevronUp size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}><span className={styles.paneDisclosureText}><span aria-hidden>collapse</span><span>{controller.panesExpanded ? "collapse" : "expand"}</span></span></Button> : null}
      </div>
    </div>
    {placement !== null ? <p className={styles.paneMoveHelp}>{placement.kind === "ChoosePane" ? "choose a pane to move" : `choose a position for “${controller.reorder.sourceName}”`}</p> : controller.reorder.available ? <p className={styles.paneMoveHelp}><span className={styles.mouseDragHint}>drag to reorder</span><span className={styles.touchDragHint}>hold and drag to reorder</span></p> : null}
  </>;
}

export function NexusClosedPanes({ controller, mobile }: { controller: NexusController; mobile: boolean }) {
  if (!controller.paneListPresented || controller.closedPanes.length === 0) return null;
  const id = mobile ? "mobile-nexus-closed-panes" : "desktop-nexus-closed-panes";
  const disclosure = <Button className={styles.paneListAction} data-nexus-control="RecentlyClosedDisclosure" aria-expanded={controller.recentlyClosedExpanded} aria-controls={id}
    onClick={controller.toggleRecentlyClosed} icon={controller.recentlyClosedExpanded ? <ChevronUp size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}>recently closed · {controller.closedPanes.length}</Button>;
  const buttons = controller.closedPanes.map(pane => {
    const button = <button type="button" className={styles.paneRecovery} data-nexus-control={`ClosedPane:${pane.id}`} aria-label={`reopen ${pane.presentation.title}`}
      onKeyDown={event => { if ((event.key === "Enter" || event.key === " ") && (event.repeat || event.nativeEvent.isComposing)) event.preventDefault(); }}
      onClick={() => controller.restoreClosedPane(pane.id)}><RotateCcw size={16} aria-hidden /><span>{pane.presentation.title}</span>{pane.presentation.detail ? <small>{pane.presentation.detail}</small> : null}</button>;
    return mobile ? <li key={pane.id}>{button}</li> : <div key={pane.id} role="row"><div role="gridcell">{button}</div></div>;
  });
  return mobile ? <section className={styles.section} aria-label="recently closed">{disclosure}<ul id={id} className={styles.closedPaneRows} hidden={!controller.recentlyClosedExpanded}>{controller.recentlyClosedExpanded ? buttons : null}</ul></section>
    : <div role="rowgroup" aria-label="recently closed" className={styles.closedPanes}><div role="row"><div role="gridcell">{disclosure}</div></div><div id={id} role="presentation" hidden={!controller.recentlyClosedExpanded}>{controller.recentlyClosedExpanded ? buttons : null}</div></div>;
}
