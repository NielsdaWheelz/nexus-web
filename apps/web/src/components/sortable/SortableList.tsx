"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEventHandler,
  type ReactNode,
  type TouchEventHandler,
} from "react";
import { createPortal } from "react-dom";
import { GripVertical } from "lucide-react";
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
import styles from "./SortableList.module.css";

// The list owns truthful announcements, including the asynchronous acknowledgement.
const SILENT = {
  onDragStart: () => undefined,
  onDragMove: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

export interface SortableActivatorProps {
  readonly setActivatorNodeRef: (node: HTMLButtonElement | null) => void;
  readonly listeners: {
    readonly onMouseDown?: MouseEventHandler<HTMLButtonElement>;
    readonly onTouchStart?: TouchEventHandler<HTMLButtonElement>;
  };
  readonly canDrag: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly disabled: boolean;
  readonly disabledReason?: string;
  readonly isDragging: boolean;
  readonly moveUp: () => void;
  readonly moveDown: () => void;
}

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
  readonly gripBox: Box;
  readonly titleStyle: Pick<CSSProperties,
    "fontFamily" | "fontSize" | "fontWeight" | "fontStyle" | "lineHeight" | "letterSpacing">;
  readonly titleLineClamp: string;
  readonly titleWraps: boolean;
  point: Point;
  release: Point | null;
};

function point(event: Event): Point | null {
  if (event instanceof MouseEvent) return { x: event.clientX, y: event.clientY };
  if (event instanceof TouchEvent) {
    const touch = event.touches[0] ?? event.changedTouches[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }
  return null;
}

function controlsVisible(order: OrderPresentation): boolean {
  return order.state.kind === "Ready" ||
    ("controls" in order.state && order.state.controls === "Visible");
}

function disabledReason(order: OrderPresentation): string | undefined {
  switch (order.state.kind) {
    case "Saving": return "saving order…";
    case "Checking": return "checking order…";
    case "Unconfirmed": return "check order before moving another item.";
    default: return undefined;
  }
}

function Row({ item, index, ids, order, renderItem, nodes, handles, move }: {
  readonly item: CollectionRowView;
  readonly index: number;
  readonly ids: readonly string[];
  readonly order: OrderPresentation;
  readonly renderItem: (item: CollectionRowView, reorder?: SortableActivatorProps) => ReactNode;
  readonly nodes: Map<string, HTMLLIElement>;
  readonly handles: Map<string, HTMLButtonElement>;
  readonly move: (id: string, beforeId: string | null) => void;
}) {
  const disabled = order.state.kind !== "Ready";
  const draggable = useDraggable({ id: item.id, disabled: disabled || ids.length < 2 });
  return (
    <li
      ref={(node) => {
        draggable.setNodeRef(node);
        if (node) nodes.set(item.id, node);
        else nodes.delete(item.id);
      }}
      className={styles.item}
      data-dragging={draggable.isDragging || undefined}
    >
      {renderItem(item, controlsVisible(order) ? {
        setActivatorNodeRef: (node) => {
          draggable.setActivatorNodeRef(node);
          if (node) handles.set(item.id, node);
          else handles.delete(item.id);
        },
        listeners: {
          onMouseDown: draggable.listeners && ((event) => draggable.listeners?.onMouseDown?.(event)),
          onTouchStart: draggable.listeners && ((event) => draggable.listeners?.onTouchStart?.(event)),
        },
        canDrag: !disabled && ids.length > 1,
        canMoveUp: !disabled && index > 0,
        canMoveDown: !disabled && index < ids.length - 1,
        disabled,
        disabledReason: disabledReason(order),
        isDragging: draggable.isDragging,
        moveUp: () => {
          if (index > 0) move(item.id, ids[index - 1]!);
        },
        moveDown: () => {
          if (index < ids.length - 1) move(item.id, ids[index + 2] ?? null);
        },
      } : undefined)}
    </li>
  );
}

/** Stationary rows, one visible insertion boundary, and one semantic move. */
export default function SortableList({ items, order, renderItem, ariaLabel, busy }: {
  readonly items: readonly CollectionRowView[];
  readonly order: OrderPresentation;
  readonly renderItem: (item: CollectionRowView, reorder?: SortableActivatorProps) => ReactNode;
  readonly ariaLabel: string;
  readonly busy?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLLIElement>()).current;
  const handles = useRef(new Map<string, HTMLButtonElement>()).current;
  const current = useRef({ items, order });
  current.current = { items, order };
  const [drag, setDrag] = useState<Drag | null>(null);
  const active = useRef<Drag | null>(null);
  const [destination, setDestination] = useState<Destination | null>(null);
  const painted = useRef<Destination | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const overlay = useOverlayContainer();
  const ids = items.map((item) => item.id);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );
  useLayoutEffect(() => { painted.current = destination; }, [destination]);

  const visible = () => Boolean(root.current?.isConnected && !root.current.closest("[inert]"));
  const cancel = useCallback(() => {
    const session = active.current;
    if (!session) return;
    active.current = null;
    setDrag(null);
    setDestination(null);
    if (root.current?.isConnected && !root.current.closest("[inert]") &&
        current.current.order.scopeKey === session.scopeKey) {
      setAnnouncement("move cancelled.");
      handles.get(session.id)?.focus({ preventScroll: true });
    }
  }, [handles]);

  const valid = (session: Drag) => {
    const latest = current.current;
    return visible() && latest.order.scopeKey === session.scopeKey &&
      latest.order.state.kind === "Ready" && latest.order.state.revision === session.revision &&
      latest.items.length === session.ids.length &&
      latest.items.every((item, index) => item.id === session.ids[index]);
  };

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
          current.current.order.scopeKey === scopeKey && handles.get(id)?.isConnected) {
        setAnnouncement(`“${title}” moved to position ${next.indexOf(id) + 1} of ${next.length}.`);
      }
    }, (error: unknown) => setDefect({ error }));
  };

  const start = (event: DragStartEvent) => {
    const latest = current.current;
    const id = String(event.active.id);
    const node = nodes.get(id);
    const title = node?.querySelector<HTMLElement>("[data-row-title]");
    const grip = handles.get(id);
    const port = root.current?.closest<HTMLElement>('[data-pane-content][data-body-mode="standard"]');
    const origin = point(event.activatorEvent);
    if (latest.order.state.kind !== "Ready" || latest.items.length < 2 ||
        !node || !title || !grip || !port || !origin || !visible()) return;
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
      titleBox: relative(title), gripBox: relative(grip),
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
    if (active.current && !valid(active.current)) cancel();
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
          port.width !== portRect.width || port.height !== portRect.height) cancel();
    });
    resized.observe(source);
    resized.observe(drag.port);
    const changed = new MutationObserver(cancel);
    changed.observe(list, { childList: true, characterData: true, subtree: true });
    const scrolled = (event: Event) => {
      if (event.target !== drag.port) cancel();
    };
    const released = (event: Event) => { drag.release = point(event); };
    document.addEventListener("scroll", scrolled, true);
    document.addEventListener("mouseup", released, true);
    document.addEventListener("touchend", released, true);
    window.addEventListener("resize", cancel);
    list.addEventListener("load", cancel, true);
    return () => {
      resized.disconnect();
      changed.disconnect();
      document.removeEventListener("scroll", scrolled, true);
      document.removeEventListener("mouseup", released, true);
      document.removeEventListener("touchend", released, true);
      window.removeEventListener("resize", cancel);
      list.removeEventListener("load", cancel, true);
    };
  }, [drag, nodes, cancel]);

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
      onDragCancel={cancel}
      onDragEnd={() => {
        const session = active.current;
        if (!session) return;
        const target = locate(session, session.release ?? session.point);
        const shown = painted.current;
        if (!target || !shown || target.beforeId !== shown.beforeId) return cancel();
        active.current = null;
        setDrag(null);
        setDestination(null);
        move(session.id, shown.beforeId);
      }}
    >
      <div ref={root} className={styles.root}>
        <ResourceList ariaLabel={ariaLabel} busy={busy}>
          {items.map((item, index) => (
            <Row key={item.id} item={item} index={index} ids={ids} order={order}
              renderItem={renderItem} nodes={nodes} handles={handles} move={move} />
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
            <span className={styles.previewGrip} style={drag.gripBox}><GripVertical size={16} /></span>
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
