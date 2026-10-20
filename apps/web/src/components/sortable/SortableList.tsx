"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
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
  point: Point;
  release: Point | null;
};
type Press = Pick<Drag, "id" | "ids" | "revision" | "scopeKey" | "port"> & {
  readonly pointerId: number;
  readonly pointerType: string;
  touchId: number | null;
  invalidated: boolean;
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

function Row({ item, enabled, dragging, renderItem, nodes, begin, canActivate }: {
  readonly item: CollectionRowView;
  readonly enabled: boolean;
  readonly dragging: boolean;
  readonly renderItem: (item: CollectionRowView) => ReactNode;
  readonly nodes: Map<string, HTMLLIElement>;
  readonly begin: (id: string, event: ReactPointerEvent<HTMLLIElement>) => void;
  readonly canActivate: (id: string, event: MouseEvent | TouchEvent) => boolean;
}) {
  const draggable = useDraggable({ id: item.id, disabled: !enabled });
  return (
    <li
      ref={(node) => {
        draggable.setNodeRef(node);
        draggable.setActivatorNodeRef(node);
        if (node) nodes.set(item.id, node);
        else nodes.delete(item.id);
      }}
      className={styles.item}
      data-draggable={enabled || undefined}
      data-dragging={dragging || undefined}
      onPointerDownCapture={(event) => begin(item.id, event)}
      onMouseDown={(event) => {
        if (canActivate(item.id, event.nativeEvent)) draggable.listeners?.onMouseDown?.(event);
      }}
      onTouchStart={(event) => {
        if (canActivate(item.id, event.nativeEvent)) draggable.listeners?.onTouchStart?.(event);
      }}
    >
      {renderItem(item)}
    </li>
  );
}

/**
 * The own row surface admits mouse/touch dragging; independent controls retain
 * their intent. A physical press outlives semantic cancellation. Rows stay put,
 * and release commits only the painted insertion boundary in its captured order.
 */
export default function SortableList({ items, order, renderItem, ariaLabel, busy }: {
  readonly items: readonly CollectionRowView[];
  readonly order: OrderPresentation;
  readonly renderItem: (item: CollectionRowView) => ReactNode;
  readonly ariaLabel: string;
  readonly busy?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLLIElement>()).current;
  const held = useRef<Press | null>(null);
  const current = useRef({ items, order });
  current.current = { items, order };
  const [drag, setDrag] = useState<Drag | null>(null);
  const active = useRef<Drag | null>(null);
  const [destination, setDestination] = useState<Destination | null>(null);
  const painted = useRef<Destination | null>(null);
  const [announcement, setAnnouncement] = useState("");
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
  }, [nodes]);

  const invalidate = useCallback(() => {
    if (held.current) held.current.invalidated = true;
    cancel();
  }, [cancel]);

  const valid = (session: Pick<Drag, "id" | "scopeKey" | "revision" | "ids">) => {
    const latest = current.current;
    return visible() && nodes.get(session.id)?.isConnected === true && latest.order.scopeKey === session.scopeKey &&
      latest.order.state.kind === "Ready" && latest.order.state.revision === session.revision &&
      latest.items.length === session.ids.length &&
      latest.items.every((item, index) => item.id === session.ids[index]);
  };

  const begin = (id: string, event: ReactPointerEvent<HTMLLIElement>) => {
    const latest = current.current;
    const port = root.current?.closest<HTMLElement>('[data-pane-content][data-body-mode="standard"]');
    if (held.current || event.defaultPrevented || !event.isPrimary || event.button !== 0 ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        (event.pointerType !== "mouse" && event.pointerType !== "touch") ||
        latest.order.state.kind !== "Ready" || latest.items.length < 2 || !port || !visible() ||
        !acceptsTarget(event.currentTarget, event.target)) return;
    held.current = { id, pointerId: event.pointerId, pointerType: event.pointerType, port,
      scopeKey: latest.order.scopeKey, revision: latest.order.state.revision,
      ids: latest.items.map((item) => item.id), touchId: null, invalidated: false };
  };

  const canActivate = (id: string, event: MouseEvent | TouchEvent) => {
    const press = held.current;
    if (!press || press.id !== id || press.invalidated || event.defaultPrevented) return false;
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
      held.current = null;
    };
    const contact = (event: TouchEvent) => {
      const press = held.current;
      if (press?.pointerType === "touch" && (event.touches.length !== 1 ||
          (press.touchId !== null && event.touches[0]?.identifier !== press.touchId))) invalidate();
    };
    const blurred = () => { invalidate(); held.current = null; };
    document.addEventListener("pointerdown", added, true);
    document.addEventListener("pointerup", released, true);
    document.addEventListener("pointercancel", released, true);
    document.addEventListener("touchstart", contact, true);
    document.addEventListener("touchmove", contact, true);
    document.addEventListener("touchend", contact, true);
    document.addEventListener("touchcancel", invalidate, true);
    window.addEventListener("blur", blurred);
    return () => {
      held.current = null;
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
    setDestination(next);
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
    const id = String(event.active.id);
    const node = nodes.get(id);
    const title = node?.querySelector<HTMLElement>("[data-row-title]");
    const port = press.port;
    const origin = point(event.activatorEvent);
    if (press.invalidated || press.id !== id || !valid(press) ||
        latest.order.state.kind !== "Ready" || latest.items.length < 2 ||
        !node || !title || !port.isConnected || !origin ||
        !acceptsTarget(node, event.activatorEvent.target)) return;
    const source = node.getBoundingClientRect();
    const relative = (element: HTMLElement): Box => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left - source.left, top: rect.top - source.top,
        width: rect.width, height: rect.height };
    };
    const font = getComputedStyle(title);
    const session: Drag = {
      id, title: latest.items.find((item) => item.id === id)!.title.text,
      ids: latest.items.map((item) => item.id), revision: latest.order.state.revision,
      scopeKey: latest.order.scopeKey, port, scrollTop: port.scrollTop,
      origin, point: origin, release: null, source,
      titleBox: relative(title),
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
    const changed = new MutationObserver(invalidate);
    changed.observe(list, { childList: true, characterData: true, subtree: true });
    const scrolled = (event: Event) => {
      if (event.target !== drag.port) invalidate();
    };
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", invalidate);
    list.addEventListener("load", invalidate, true);
    return () => {
      resized.disconnect();
      changed.disconnect();
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", invalidate);
      list.removeEventListener("load", invalidate, true);
    };
  }, [drag, nodes, invalidate]);

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
      <div ref={root} className={styles.root}>
        <ResourceList ariaLabel={ariaLabel} busy={busy}>
          {items.map((item) => (
            <Row key={item.id} item={item} enabled={order.state.kind === "Ready" && items.length > 1}
              dragging={drag?.id === item.id} renderItem={renderItem} nodes={nodes}
              begin={begin} canActivate={canActivate} />
          ))}
        </ResourceList>
        {destination ? <div className={styles.insertion} aria-hidden="true"
          data-append={destination.beforeId === null || undefined}
          style={{ top: destination.top, left: destination.left, width: destination.width }} /> : null}
      </div>
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
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    </DndContext>
  );
}
