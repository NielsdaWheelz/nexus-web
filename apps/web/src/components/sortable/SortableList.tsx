"use client";

import {
  Fragment,
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import ResourceList from "@/components/ui/ResourceList";
import type { CollectionRowView, OrderPresentation } from "@/lib/collections/types";
import { moveBefore, type OrderRevision } from "@/lib/collections/order";
import { useOverlayContainer } from "@/lib/ui/overlay";
import { isInteractiveTarget } from "@/lib/ui/eventTarget";
import { suppressDragReleaseClick, TOUCH_DRAG_CLAIMED } from "@/lib/ui/dragGesture";
import styles from "./SortableList.module.css";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import type { MeasuredIndexWindow } from "@/lib/collections/measuredIndexWindow";

// The list owns truthful announcements, including the asynchronous acknowledgement.
const SILENT = {
  onDragStart: () => undefined,
  onDragMove: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

type Point = { readonly x: number; readonly y: number };
type Box = { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
type Destination = {
  readonly beforeId: string | null;
  readonly position: number;
  readonly top: number;
  readonly left: number;
  readonly width: number;
};
type Drag = {
  readonly id: string;
  readonly title: string;
  readonly ids: readonly string[];
  readonly revision: OrderRevision;
  readonly scopeKey: string;
  readonly port: HTMLElement;
  readonly scrollTop: number;
  readonly origin: Point;
  readonly source: Box;
  readonly titleBox: Box;
  readonly titleStyle: Pick<CSSProperties,
    "fontFamily" | "fontSize" | "fontWeight" | "fontStyle" | "lineHeight" | "letterSpacing">;
  readonly titleLineClamp: string;
  readonly titleWraps: boolean;
  readonly epoch: number | null;
  point: Point;
  release: Point | null;
};
type Press = Pick<Drag, "id" | "ids" | "revision" | "scopeKey" | "port" | "epoch"> & {
  readonly pointerId: number;
  readonly pointerType: string;
  touchId: number | null;
  invalidated: boolean;
  readonly releasePin: () => void;
};

function point(event: Event): Point | null {
  if (event instanceof MouseEvent) return { x: event.clientX, y: event.clientY };
  if (event instanceof TouchEvent) {
    const touch = event.touches[0] ?? event.changedTouches[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }
  return null;
}

function acceptsTarget(node: HTMLLIElement, target: EventTarget | null): boolean {
  if (!(target instanceof Element) || !node.contains(target)) return false;
  const row = node.querySelector("[data-collection-row-id]");
  if (!row || target.closest("[data-collection-row-id]") !== row ||
      target.closest("[data-row-expanded]")) return false;
  const primary = target.closest("[data-row-focusable]");
  return primary && row.contains(primary)
    ? !isInteractiveTarget(target, primary)
    : !isInteractiveTarget(target, row);
}

const Row = memo(function Row({ item, enabled, dragging, renderItem, nodes, position }: {
  readonly item: CollectionRowView;
  readonly enabled: boolean;
  readonly dragging: boolean;
  readonly renderItem: (item: CollectionRowView) => ReactNode;
  readonly nodes: Map<string, HTMLLIElement>;
  readonly position: { readonly index: number; readonly count: number } | null;
}) {
  return <li ref={node => {
    if (node) nodes.set(item.id, node);
    else nodes.delete(item.id);
  }} className={styles.item} data-sortable-row-id={item.id}
    aria-posinset={position ? position.index + 1 : undefined} aria-setsize={position?.count}
    data-draggable={enabled || undefined} data-dragging={dragging || undefined}>
    {renderItem(item)}
  </li>;
});

/** One registered actor binds the admitted row before the unchanged sensor starts. */
function GestureSurface({ rootRef, begin, canActivate, children }: {
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly begin: (event: ReactPointerEvent<HTMLDivElement>) => HTMLLIElement | null;
  readonly canActivate: (event: MouseEvent | TouchEvent) => boolean;
  readonly children: ReactNode;
}) {
  const draggable = useDraggable({ id: "collection" });
  useLayoutEffect(() => {
    if (draggable.node.current && !rootRef.current?.contains(draggable.node.current)) {
      draggable.setNodeRef(null);
      draggable.setActivatorNodeRef(null);
    }
  });
  return <div ref={rootRef} className={styles.root}
    onPointerDownCapture={event => {
      const row = begin(event);
      if (!row) return;
      draggable.setNodeRef(row);
      draggable.setActivatorNodeRef(row);
    }}
    onMouseDown={event => {
      if (canActivate(event.nativeEvent)) draggable.listeners?.onMouseDown?.(event);
    }}
    onTouchStart={event => {
      if (canActivate(event.nativeEvent)) draggable.listeners?.onTouchStart?.(event);
    }}>
    {children}
  </div>;
}

/**
 * The own row surface admits mouse/touch dragging; independent controls retain
 * their intent. A physical press outlives semantic cancellation. Rows stay put,
 * and release commits only the painted insertion boundary in its captured order.
 */
export default function SortableList({ items, order, renderItem, ariaLabel, busy, scrollport = null, onAnnouncement = null, window: indexWindow, listRef }: {
  readonly items: readonly CollectionRowView[];
  readonly order: OrderPresentation;
  readonly renderItem: (item: CollectionRowView) => ReactNode;
  readonly ariaLabel: string;
  readonly busy?: boolean;
  readonly scrollport?: (() => HTMLElement | null) | null;
  readonly onAnnouncement?: ((message: string) => void) | null;
  readonly window: MeasuredIndexWindow;
  readonly listRef: RefObject<HTMLUListElement | null>;
}) {
  const { readGeometry } = indexWindow;
  const root = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLLIElement>()).current;
  const held = useRef<Press | null>(null);
  const current = useRef({ items, order });
  useLayoutEffect(() => { current.current = { items, order }; });
  const [drag, setDrag] = useState<Drag | null>(null);
  const active = useRef<Drag | null>(null);
  const [destination, setDestination] = useState<Destination | null>(null);
  const painted = useRef<Destination | null>(null);
  const [announcement, publishAnnouncement] = useState("");
  const announce = useRef(onAnnouncement);
  announce.current = onAnnouncement;
  const setAnnouncement = useCallback((message: string) => {
    if (announce.current !== null) announce.current(message);
    else publishAnnouncement(message);
  }, []);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const overlay = useOverlayContainer();
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );
  useLayoutEffect(() => { painted.current = destination; }, [destination]);

  const visible = () => Boolean(root.current?.isConnected && root.current.getClientRects().length &&
    !root.current.closest("[inert]"));
  const cancel = useCallback(() => {
    const session = active.current;
    if (!session) return;
    active.current = null;
    painted.current = null;
    setDrag(null);
    setDestination(null);
    if (root.current?.isConnected && !root.current.closest("[inert]") &&
        current.current.order.scopeKey === session.scopeKey) {
      setAnnouncement("move cancelled.");
      const node = nodes.get(session.id);
      const row = node?.querySelector("[data-collection-row-id]");
      const candidate = row?.querySelector<HTMLElement>("[data-row-focusable]:not([disabled])");
      const primary = candidate?.closest("[data-collection-row-id]") === row ? candidate : null;
      const focused = document.activeElement;
      if (focused?.isConnected && focused !== document.body && focused !== primary) return;
      const target = primary ?? root.current.closest<HTMLElement>("[data-pane-focus-landmark]");
      if (target?.isConnected && !target.closest("[inert]")) target.focus({ preventScroll: true });
    }
  }, [nodes, setAnnouncement]);

  const invalidate = useCallback(() => {
    if (held.current) held.current.invalidated = true;
    cancel();
  }, [cancel]);

  const valid = (session: Pick<Drag, "id" | "scopeKey" | "revision" | "ids" | "epoch">) => {
    const latest = current.current;
    return visible() && nodes.get(session.id)?.isConnected === true && latest.order.scopeKey === session.scopeKey &&
      (session.epoch === null || readGeometry()?.epoch === session.epoch) &&
      latest.order.state.kind === "Ready" && latest.order.state.revision === session.revision &&
      latest.items.length === session.ids.length &&
      latest.items.every((item, index) => item.id === session.ids[index]);
  };

  const begin = (event: ReactPointerEvent<HTMLDivElement>): HTMLLIElement | null => {
    const node = event.target instanceof Element ? event.target.closest<HTMLLIElement>("[data-sortable-row-id]") : null;
    const id = node?.dataset.sortableRowId;
    if (!node || !id || nodes.get(id) !== node) return null;
    const latest = current.current;
    const port = scrollport === null ? root.current?.closest<HTMLElement>('[data-pane-content][data-body-mode="standard"]') : scrollport();
    if (held.current || event.defaultPrevented || !event.isPrimary || event.button !== 0 ||
        indexWindow.plan.kind === "Measure" ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        (event.pointerType !== "mouse" && event.pointerType !== "touch") ||
        latest.order.state.kind !== "Ready" || latest.items.length < 2 || !port || !visible() ||
        !acceptsTarget(node, event.target)) return null;
    held.current = { id, pointerId: event.pointerId, pointerType: event.pointerType, port,
      scopeKey: latest.order.scopeKey, revision: latest.order.state.revision,
      ids: latest.items.map((item) => item.id), touchId: null, invalidated: false,
      epoch: readGeometry()?.epoch ?? null, releasePin: indexWindow.pin(id) };
    return node;
  };

  const canActivate = (event: MouseEvent | TouchEvent) => {
    const press = held.current;
    const node = press ? nodes.get(press.id) : null;
    if (!press || !node || press.invalidated || event.defaultPrevented || !acceptsTarget(node, event.target)) return false;
    if (event instanceof MouseEvent) {
      if (press.pointerType !== "mouse" || event.button !== 0 ||
          event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    } else {
      if (press.pointerType !== "touch" || event.touches.length !== 1) return false;
      press.touchId = event.touches[0]!.identifier;
    }
    return true;
  };

  useLayoutEffect(() => {
    const added = (event: PointerEvent) => {
      const press = held.current;
      if (press?.pointerType === "touch" && event.pointerType === "touch" &&
          event.pointerId !== press.pointerId) invalidate();
    };
    const released = (event: PointerEvent) => {
      if (event.pointerId !== held.current?.pointerId) return;
      if (event.type === "pointercancel") invalidate();
      else if (active.current) active.current.release = point(event);
      held.current?.releasePin(); held.current = null;
    };
    const contact = (event: TouchEvent) => {
      const press = held.current;
      if (press?.pointerType === "touch" && (event.touches.length !== 1 ||
          (press.touchId !== null && event.touches[0]?.identifier !== press.touchId))) invalidate();
    };
    const blurred = () => { invalidate(); held.current?.releasePin(); held.current = null; };
    document.addEventListener("pointerdown", added, true);
    document.addEventListener("pointerup", released, true);
    document.addEventListener("pointercancel", released, true);
    document.addEventListener("touchstart", contact, true);
    document.addEventListener("touchmove", contact, true);
    document.addEventListener("touchend", contact, true);
    document.addEventListener("touchcancel", invalidate, true);
    window.addEventListener("blur", blurred);
    return () => {
      held.current?.releasePin(); held.current = null;
      active.current = null;
      document.removeEventListener("pointerdown", added, true);
      document.removeEventListener("pointerup", released, true);
      document.removeEventListener("pointercancel", released, true);
      document.removeEventListener("touchstart", contact, true);
      document.removeEventListener("touchmove", contact, true);
      document.removeEventListener("touchend", contact, true);
      document.removeEventListener("touchcancel", invalidate, true);
      window.removeEventListener("blur", blurred);
    };
  }, [invalidate]);

  // All geometry comes from the rendered rows and the owning scrollport.
  const locate = (session: Drag, pointer: Point): Destination | null => {
    const list = root.current?.querySelector("ul");
    if (!list || !valid(session)) return null;
    const bounds = list.getBoundingClientRect();
    const port = session.port.getBoundingClientRect();
    const left = Math.max(bounds.left, port.left + session.port.clientLeft);
    const right = Math.min(bounds.right, port.left + session.port.clientLeft + session.port.clientWidth);
    const top = Math.max(bounds.top, port.top + session.port.clientTop);
    const bottom = Math.min(bounds.bottom, port.top + session.port.clientTop + session.port.clientHeight);
    if (pointer.x < left || pointer.x > right || pointer.y < top || pointer.y > bottom) return null;
    const remaining = session.ids.filter((id) => id !== session.id);
    let beforeId: string | null = null;
    let edge = 0;
    const frame = readGeometry();
    if (frame !== null) {
      const sourceRank = session.ids.indexOf(session.id);
      let rank = Math.max(0, Math.floor((pointer.y - bounds.top) / frame.height + 0.5));
      if (rank === sourceRank) rank += 1;
      if (rank < session.ids.length) {
        beforeId = session.ids[rank]!;
        edge = bounds.top + rank * frame.height;
      } else {
        const last = sourceRank === session.ids.length - 1 ? session.ids.length - 2 : session.ids.length - 1;
        edge = bounds.top + (last + 1) * frame.height;
      }
    } else {
      for (const id of remaining) {
        const rect = nodes.get(id)?.getBoundingClientRect();
        if (!rect) return null;
        edge = rect.bottom;
        if (pointer.y < rect.top + rect.height / 2) {
          beforeId = id;
          edge = rect.top;
          break;
        }
      }
    }
    if (beforeId === null ? edge <= top || edge > bottom : edge < top || edge >= bottom) return null;
    const next = moveBefore(session.ids, session.id, beforeId);
    if (next === session.ids) return null;
    const origin = root.current!.getBoundingClientRect();
    return { beforeId, position: next.indexOf(session.id) + 1,
      top: edge - origin.top, left: left - origin.left, width: right - left };
  };

  const showDestination = (session: Drag) => {
    const next = locate(session, session.point);
    const previous = painted.current;
    if (next && (!previous || next.beforeId !== previous.beforeId)) {
      const target = current.current.items.find((item) => item.id === next.beforeId);
      setAnnouncement(target
        ? `before “${target.title.text}”, position ${next.position} of ${session.ids.length}.`
        : `last, position ${session.ids.length} of ${session.ids.length}.`);
    }
    setDestination(previous => {
      if (previous === null || next === null) return next;
      return previous.beforeId === next.beforeId && previous.top === next.top && previous.left === next.left && previous.width === next.width
        ? previous : next;
    });
  };

  const move = (id: string, beforeId: string | null) => {
    const latest = current.current;
    if (latest.order.state.kind !== "Ready" || !visible()) return;
    const ids = latest.items.map((item) => item.id);
    const next = moveBefore(ids, id, beforeId);
    if (next === ids) return;
    const title = latest.items.find((item) => item.id === id)!.title.text;
    const scopeKey = latest.order.scopeKey;
    setAnnouncement("");
    void latest.order.state.move({ itemId: id, beforeId,
      expectedRevision: latest.order.state.revision }).then((outcome) => {
      if (outcome === "Acknowledged" && visible() &&
          current.current.order.scopeKey === scopeKey && nodes.get(id)?.isConnected) {
        setAnnouncement(`“${title}” moved to position ${next.indexOf(id) + 1} of ${next.length}.`);
      }
    }, (error: unknown) => setDefect({ error }));
  };

  const start = (event: DragStartEvent) => {
    const press = held.current;
    if (!press) return;
    // Claim the physical gesture before asking whether its snapshot still lives.
    suppressDragReleaseClick(press.pointerId);
    if (press.pointerType === "touch") press.port.dispatchEvent(new Event(TOUCH_DRAG_CLAIMED));
    const latest = current.current;
    const id = press.id;
    const node = nodes.get(id);
    const title = node?.querySelector<HTMLElement>("[data-row-title]");
    const port = press.port;
    const origin = point(event.activatorEvent);
    if (press.invalidated || press.id !== id || !valid(press) ||
        latest.order.state.kind !== "Ready" || latest.items.length < 2 ||
        !node || !title || !port.isConnected || !origin ||
        !acceptsTarget(node, event.activatorEvent.target)) return;
    const source = node.getBoundingClientRect();
    const font = getComputedStyle(title);
    const titleRect = title.getBoundingClientRect();
    const session: Drag = {
      id, title: latest.items.find((item) => item.id === id)!.title.text,
      ids: latest.items.map((item) => item.id), revision: latest.order.state.revision,
      scopeKey: latest.order.scopeKey, port, scrollTop: port.scrollTop,
      epoch: press.epoch,
      origin, point: origin, release: null, source,
      titleBox: { left: titleRect.left - source.left, top: titleRect.top - source.top,
        width: titleRect.width, height: titleRect.height },
      titleStyle: {
        fontFamily: font.fontFamily,
        fontSize: font.fontSize,
        fontWeight: font.fontWeight,
        fontStyle: font.fontStyle,
        lineHeight: font.lineHeight,
        letterSpacing: font.letterSpacing,
      },
      titleWraps: font.whiteSpace !== "nowrap",
      titleLineClamp: font.webkitLineClamp,
    };
    active.current = session;
    setDrag(session);
    setDestination(null);
    setAnnouncement(`moving “${session.title}”, position ${session.ids.indexOf(id) + 1} of ${session.ids.length}.`);
  };
  const moved = (event: DragMoveEvent) => {
    const session = active.current;
    if (!session) return;
    if (!valid(session)) return cancel();
    // Core includes ancestor scroll in delta; pointer coordinates do not.
    session.point = { x: session.origin.x + event.delta.x,
      y: session.origin.y + event.delta.y - (session.port.scrollTop - session.scrollTop) };
    showDestination(session);
  };

  useLayoutEffect(() => {
    if (held.current && !valid(held.current)) invalidate();
    if (active.current && !valid(active.current)) invalidate();
  });
  useLayoutEffect(() => {
    if (!drag) return;
    const list = root.current?.querySelector("ul");
    const source = nodes.get(drag.id);
    if (!list || !source) return;
    const portRect = drag.port.getBoundingClientRect();
    const resized = new ResizeObserver(() => {
      const rect = source.getBoundingClientRect();
      const port = drag.port.getBoundingClientRect();
      if (rect.width !== drag.source.width || rect.height !== drag.source.height ||
          port.width !== portRect.width || port.height !== portRect.height) invalidate();
    });
    resized.observe(source);
    resized.observe(drag.port);
    const changed = new MutationObserver(records => {
      // Window mounts change the list's children without changing its full order.
      if (readGeometry() === null || records.some(record => record.target !== list &&
        record.target.isConnected && (record.target instanceof Element ? record.target : record.target.parentElement)?.closest("[data-collection-row-id]"))) invalidate();
    });
    changed.observe(list, { childList: true, characterData: true, subtree: true });
    const scrolled = (event: Event) => {
      if (event.target !== drag.port) invalidate();
    };
    const loaded = (event: Event) => {
      if (event.target instanceof HTMLImageElement &&
          event.target.parentElement?.hasAttribute("data-row-fixed-artwork")) return;
      invalidate();
    };
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", invalidate);
    list.addEventListener("load", loaded, true);
    return () => {
      resized.disconnect();
      changed.disconnect();
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", invalidate);
      list.removeEventListener("load", loaded, true);
    };
  }, [drag, nodes, invalidate, readGeometry]);

  if (defect) throw defect.error;
  return (
    <DndContext
      sensors={sensors}
      accessibility={{ announcements: SILENT, restoreFocus: false, screenReaderInstructions: { draggable: "" } }}
      autoScroll={{
        enabled: drag !== null,
        layoutShiftCompensation: false,
        threshold: { x: 0, y: 0.15 },
        canScroll: (element) => {
          const session = active.current;
          const rect = root.current?.getBoundingClientRect();
          return Boolean(session && element === session.port && rect &&
            session.point.x > Math.max(rect.left, session.port.getBoundingClientRect().left) &&
            session.point.x < Math.min(rect.right, session.port.getBoundingClientRect().right) &&
            session.point.y >= Math.max(rect.top, session.port.getBoundingClientRect().top) &&
            session.point.y <= Math.min(rect.bottom, session.port.getBoundingClientRect().bottom));
        },
      }}
      onDragStart={start}
      onDragMove={moved}
      onDragCancel={invalidate}
      onDragEnd={() => {
        const session = active.current;
        if (!session) return;
        if (!session.release) return cancel();
        const target = locate(session, session.release);
        const shown = painted.current;
        if (!target || !shown || target.beforeId !== shown.beforeId) return cancel();
        active.current = null;
        painted.current = null;
        setDrag(null);
        setDestination(null);
        move(session.id, shown.beforeId);
      }}
    >
      <GestureSurface rootRef={root} begin={begin} canActivate={canActivate}>
        {indexWindow.plan.kind === "Measure" ? <PaneLoadingState label={`Loading ${ariaLabel}…`} announcement="None" /> : null}
        <ResourceList ref={listRef} ariaLabel={ariaLabel} busy={busy || indexWindow.plan.kind === "Measure"} windowed={indexWindow.plan.kind !== "Intrinsic"} measuring={indexWindow.plan.kind === "Measure"}>
          {(indexWindow.plan.kind === "Measure" ? [{ id: indexWindow.plan.sampleId, index: 0, gapBeforePx: 0 }] : indexWindow.plan.slots).map(slot => {
            const item = items[slot.index];
            return item ? <Fragment key={item.id}>
              {slot.gapBeforePx > 0 ? <li role="presentation" aria-hidden="true" style={{ height: slot.gapBeforePx, flexShrink: 0 }} /> : null}
              <Row item={item} enabled={order.state.kind === "Ready" && items.length > 1 && indexWindow.plan.kind !== "Measure"}
                dragging={drag?.id === item.id} renderItem={renderItem} nodes={nodes}
                position={indexWindow.plan.kind === "Intrinsic" ? null : { index: slot.index, count: items.length }} />
            </Fragment> : null;
          })}
          {indexWindow.plan.kind === "Ready" && indexWindow.plan.tailGapPx > 0 ? <li role="presentation" aria-hidden="true" style={{ height: indexWindow.plan.tailGapPx, flexShrink: 0 }} /> : null}
        </ResourceList>
        {destination ? <div className={styles.insertion} aria-hidden="true"
          data-append={destination.beforeId === null || undefined}
          style={{ top: destination.top, left: destination.left, width: destination.width }} /> : null}
      </GestureSurface>
      {overlay ? createPortal(
        <DragOverlay adjustScale={false} dropAnimation={null} style={{ pointerEvents: "none" }}>
          {drag ? <div className={styles.preview} inert aria-hidden="true"
            style={{ width: drag.source.width, height: drag.source.height }}>
            <span className={styles.previewTitle} dir="auto" style={{ ...drag.titleBox, ...drag.titleStyle,
              display: drag.titleLineClamp !== "none" ? "-webkit-box" : "block",
              WebkitBoxOrient: drag.titleLineClamp !== "none" ? "vertical" : undefined,
              WebkitLineClamp: drag.titleLineClamp,
              whiteSpace: drag.titleWraps ? "normal" : "nowrap" }}>{drag.title}</span>
          </div> : null}
        </DragOverlay>, overlay,
      ) : null}
      {onAnnouncement === null ? <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span> : null}
    </DndContext>
  );
}
