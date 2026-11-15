"use client";

// The phone's pane drag: gesture ownership, sortable rows and one spoken outcome.
import { DndContext, DragOverlay, MouseSensor, TouchSensor, closestCenter, useDndContext, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useLayoutEffect, useRef, type ReactNode, type PointerEvent } from "react";
import { createPortal } from "react-dom";
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

export function paneCandidateName(controller: NexusController, row: NexusRow): string {
  const duplicate = controller.panes.filter(pane => pane.presentation.title === row.label).length > 1;
  return rowName([paneRowName(controller, row), duplicate ? row.state?.toLowerCase() : rowFacts(row)]);
}

export function NexusPaneSortable({ controller, row, children }: {
  controller: NexusController; row: NexusRow; children(drag: DragBody): ReactNode;
}) {
  const enabled = controller.paneListComplete && controller.reorder.available && row.secondary?.kind === "ClosePane";
  const paneId = row.secondary?.kind === "ClosePane" ? row.secondary.paneId : row.key;
  const draggable = enabled && !controller.marked.includes(paneId);
  const sortable = useSortable({ id: paneId, disabled: { draggable: !draggable, droppable: !enabled }, transition: null });
  return children({ ...sortable, enabled: draggable, begin(event) {
    if (draggable && event.isPrimary && event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.currentTarget.dataset.dragPointer = String(event.pointerId);
    }
  } });
}

export function paneDragStyle(drag: DragBody) {
  return { transform: CSS.Translate.toString(drag.transform), opacity: drag.isDragging ? 0.35 : undefined };
}

/** The root's pane drag and its one live region: dnd-kit's own
 * announcements are silenced, so the reorder's lines speak here. */
export function NexusPaneDrag({ controller, scrollport, children }: {
  controller: NexusController; scrollport(): HTMLElement | null; children: ReactNode;
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
    <div className="sr-only" role="status" aria-live="polite">{controller.reorderSpeech}</div>
    {overlay ? createPortal(<DragOverlay adjustScale={false} dropAnimation={null} style={{ pointerEvents: "none" }}>{row ? <div className={styles.paneDragPreview} aria-hidden inert><NexusRowBody row={row} query={controller.query} /></div> : null}</DragOverlay>, overlay) : null}
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
