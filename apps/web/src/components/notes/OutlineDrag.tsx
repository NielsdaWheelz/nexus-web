"use client";

/** A bullet press lifts the row, or the topmost selection it belongs to; x chooses
 * the depth between the rows around the gap; release places through the controller,
 * which announces and selects. The kernel is SortableList's, reduced to one
 * draggable, no keyboard sensor and silent announcements. Nothing is written by
 * lifting: a cancel leaves the outline as it was. */
import {useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject} from "react";
import {createPortal} from "react-dom";
import {DndContext, DragOverlay, MouseSensor, TouchSensor, useDndContext, useDraggable, useSensor, useSensors, type DragEndEvent, type DragMoveEvent, type DragStartEvent} from "@dnd-kit/core";
import type {OutlineController, OutlineRow} from "@/lib/notes/outlineController";
import type {Destination} from "@/lib/notes/outlineSelection";
import {suppressDragReleaseClick} from "@/lib/ui/dragGesture";
import {useOverlayContainer} from "@/lib/ui/overlay";
import styles from "./OutlineDrag.module.css";

const SILENT = {onDragStart: () => undefined, onDragMove: () => undefined, onDragOver: () => undefined, onDragEnd: () => undefined, onDragCancel: () => undefined};
const TOLERANCE = 8;

type Point = {x: number; y: number};
type Press = {row_id: string; bullet: HTMLElement; roots: readonly string[]; lifted: ReadonlySet<string>; pointerId: number; pointerType: "mouse" | "touch"; port: HTMLElement; epoch: number; invalidated: boolean};
type Target = Destination & {depth: number; top: number; left: number; width: number};
type Session = Press & {origin: Point; point: Point; scrollTop: number; mirror: boolean; label: string; ring: number};

function point(event: Event): Point | null {
  if (event instanceof MouseEvent) return {x: event.clientX, y: event.clientY};
  if (event instanceof TouchEvent) {const touch = event.touches[0] ?? event.changedTouches[0]; return touch ? {x: touch.clientX, y: touch.clientY} : null;}
  return null;
}
const same = (a: Destination, b: Destination) => a.parent_id === b.parent_id && a.after_id === b.after_id && a.before_id === b.before_id && a.mirror === b.mirror;
const length = (token: string) => token.endsWith("rem") ? parseFloat(token) * parseFloat(getComputedStyle(document.documentElement).fontSize) : parseFloat(token);
/** The indent step: the presentation's token when it names one, else a nested row's padding over its depth, else the spacing token the row css uses. */
function indentStep(dom: HTMLElement, depth: number): number {
  const token = getComputedStyle(dom).getPropertyValue("--outline-indent").trim();
  if (token) return length(token);
  if (depth > 0) return parseFloat(getComputedStyle(dom).paddingInlineStart) / depth;
  return length(getComputedStyle(document.documentElement).getPropertyValue("--space-4").trim());
}
/** The pressed row's roots: the topmost selected rows when it is selected, else itself; lifted rows are the roots and their descendants. */
function liftedRows(controller: OutlineController, row_id: string): {roots: string[]; lifted: Set<string>} {
  const ancestors = (id: string) => {const chain: string[] = []; let parent = controller.rows.get(id)?.parent_id ?? null; while (parent) {chain.push(parent); parent = controller.rows.get(parent)?.parent_id ?? null;} return chain;};
  const selected = controller.selected;
  const roots = selected.has(row_id) ? [...controller.rows.keys()].filter(id => selected.has(id) && !ancestors(id).some(parent => selected.has(parent))) : [row_id];
  const lifted = new Set(roots);
  for (const id of controller.rows.keys()) if (ancestors(id).some(parent => lifted.has(parent))) lifted.add(id);
  return {roots, lifted};
}

/** One registered actor binds the admitted bullet before the unchanged sensor starts. */
function GestureSurface({rootRef, begin, canActivate, children}: {
  rootRef: RefObject<HTMLDivElement | null>; begin(event: ReactPointerEvent<HTMLDivElement>): HTMLElement | null; canActivate(event: MouseEvent | TouchEvent): boolean; children: ReactNode;
}) {
  const draggable = useDraggable({id: "outline"});
  useLayoutEffect(() => {
    if (draggable.node.current && !rootRef.current?.contains(draggable.node.current)) {draggable.setNodeRef(null); draggable.setActivatorNodeRef(null);}
  });
  return <div ref={rootRef} className={styles.surface}
    onPointerDownCapture={event => {const bullet = begin(event); if (!bullet) return; draggable.setNodeRef(bullet); draggable.setActivatorNodeRef(bullet);}}
    // a bullet is never a native drag source: a press the drag refuses would carry its link into the text.
    onDragStart={event => {if (event.nativeEvent.composedPath().some(node => node instanceof Element && node.matches("[data-outline-bullet]"))) event.preventDefault();}}
    // an admitted press leaves focus where it was: a focused bullet would swallow the keys that follow the drop.
    onMouseDown={event => {if (canActivate(event.nativeEvent)) {draggable.listeners?.onMouseDown?.(event); event.preventDefault();}}}
    onTouchStart={event => {if (canActivate(event.nativeEvent)) draggable.listeners?.onTouchStart?.(event);}}>
    {children}
  </div>;
}

/** Invalidation retires the sensor's own gesture through the patched context. */
function Retirement({signal}: {signal: number}) {
  const {cancel} = useDndContext();
  const seen = useRef(signal);
  useLayoutEffect(() => {if (seen.current !== signal) {seen.current = signal; cancel();}}, [signal, cancel]);
  return null;
}

export default function OutlineDrag({controller, children}: {controller: OutlineController; children: ReactNode}) {
  const root = useRef<HTMLDivElement>(null);
  const held = useRef<Press | null>(null);
  const active = useRef<Session | null>(null);
  const painted = useRef<Target | null>(null);
  const [drag, setDrag] = useState<Session | null>(null);
  const [destination, setDestination] = useState<Target | null>(null);
  const [mirror, setMirror] = useState(false);
  const [retire, setRetire] = useState(0);
  const overlay = useOverlayContainer();
  const sensors = useSensors(useSensor(MouseSensor, {activationConstraint: {distance: 8}}), useSensor(TouchSensor, {activationConstraint: {delay: 250, tolerance: TOLERANCE}}));
  useLayoutEffect(() => {painted.current = destination;}, [destination]);

  const visible = () => Boolean(root.current?.isConnected && root.current.getClientRects().length && !root.current.closest("[inert]"));
  const valid = (press: Press) => !press.invalidated && visible() && controller.epoch === press.epoch && press.port.isConnected && controller.mounts.get(press.row_id)?.dom.isConnected === true;
  const finish = useCallback(() => {
    const session = active.current; if (!session) return;
    active.current = null; painted.current = null;
    for (const id of session.lifted) delete controller.mounts.get(id)?.dom.dataset.dragging;
    setDrag(null); setDestination(null); setMirror(false);
  }, [controller]);
  const invalidate = useCallback(() => {
    if (held.current) held.current.invalidated = true;
    if (active.current) {finish(); setRetire(value => value + 1);}
  }, [finish]);

  const begin = (event: ReactPointerEvent<HTMLDivElement>): HTMLElement | null => {
    const bullet = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-outline-bullet]") : null;
    const element = bullet?.closest<HTMLElement>("[data-outline-row]"), id = element?.dataset.outlineRow;
    const row = id ? controller.rows.get(id) : undefined, mount = id ? controller.mounts.get(id) : undefined;
    const port = root.current?.closest<HTMLElement>('[data-pane-content][data-body-mode="standard"]');
    // only the row's own bullet in its leading slot lifts it; an embed's bullet inside the row's text does not.
    if (held.current || active.current || !bullet || !id || !row || !mount || !mount.leading.contains(bullet) || row.gap || row.tail || !port || !visible() ||
      event.defaultPrevented || !event.isPrimary || event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey ||
      (event.pointerType !== "mouse" && event.pointerType !== "touch") || !controller.canArrange()) return null;
    held.current = {row_id: id, bullet, ...liftedRows(controller, id), pointerId: event.pointerId, pointerType: event.pointerType, port, epoch: controller.epoch, invalidated: false};
    return bullet;
  };
  const canActivate = (event: MouseEvent | TouchEvent) => {
    const press = held.current;
    if (!press || press.invalidated || event.defaultPrevented || !(event.target instanceof Node) || !press.bullet.contains(event.target)) return false;
    if (event instanceof MouseEvent) return press.pointerType === "mouse" && event.button === 0 && !event.shiftKey && !event.metaKey && !event.ctrlKey;
    return press.pointerType === "touch" && event.touches.length === 1;
  };
  useLayoutEffect(() => {
    const released = (event: PointerEvent) => {if (event.pointerId === held.current?.pointerId) held.current = null;};
    document.addEventListener("pointerup", released, true); document.addEventListener("pointercancel", released, true);
    return () => {held.current = null; active.current = null; document.removeEventListener("pointerup", released, true); document.removeEventListener("pointercancel", released, true);};
  }, []);

  /** Geometry from the row dom: the gap by y among the item rows that are not lifted, the depth by x within
   * [depth of the row below, depth of the row above + 1], the anchors by walking up from the row above. */
  const locate = (session: Session, at: Point): Target | null => {
    const surface = root.current; if (!surface || !valid(session)) return null;
    const bounds = surface.getBoundingClientRect(), port = session.port.getBoundingClientRect();
    if (at.x < Math.max(bounds.left, port.left) || at.x > Math.min(bounds.right, port.right) || at.y < Math.max(bounds.top, port.top) || at.y > Math.min(bounds.bottom, port.bottom)) return null;
    let above: {row: OutlineRow; box: DOMRect} | null = null, below: {row: OutlineRow; box: DOMRect} | null = null;
    for (const row of controller.rows.values()) {
      if (row.root) continue;
      const dom = controller.mounts.get(row.row_id)?.dom; if (!dom) return null;
      const box = dom.getBoundingClientRect();
      if (session.lifted.has(row.row_id)) {if (at.y >= box.top && at.y < box.bottom) return null; continue;}
      if (row.tail || row.gap) continue;
      if (at.y < box.top + box.height / 2) {below = {row, box}; break;}
      above = {row, box};
    }
    const anchor = above ?? below; if (!anchor) return null;
    const mount = controller.mounts.get(anchor.row.row_id)!;
    const step = indentStep(mount.dom, anchor.row.depth), start = mount.content.getBoundingClientRect().left - anchor.row.depth * step;
    const eligible = above !== null && above.row.kind === "body" && !above.row.terminal;
    const depth = Math.min(above ? above.row.depth + (eligible ? 1 : 0) : 0, Math.max(below?.row.depth ?? 0, Math.round((at.x - start) / step)));
    let parent_id: string, after_id: string | null, before_id: string | null;
    if (above && depth > above.row.depth) {parent_id = above.row.row_id; after_id = null; before_id = below?.row.parent_id === parent_id ? below.row.row_id : null;}
    else if (above) {
      let ancestor: OutlineRow | undefined = above.row;
      while (ancestor && ancestor.depth > depth) ancestor = ancestor.parent_id ? controller.rows.get(ancestor.parent_id) : undefined;
      if (!ancestor?.parent_id) return null;
      parent_id = ancestor.parent_id; after_id = ancestor.row_id; before_id = below?.row.parent_id === parent_id ? below.row.row_id : null;
    } else {if (!below!.row.parent_id) return null; parent_id = below!.row.parent_id; after_id = null; before_id = below!.row.row_id;}
    if (session.lifted.has(parent_id)) return null;
    // the roots' own place is no destination: every root already under the parent and the first right after the same sibling.
    if (session.roots.every(id => controller.rows.get(id)?.parent_id === parent_id)) {
      let preceding: string | null = null;
      for (const row of controller.rows.values()) {
        if (row.row_id === session.roots[0]) break;
        if (row.parent_id === parent_id && !row.tail && !row.gap && !session.lifted.has(row.row_id)) preceding = row.row_id;
      }
      if (after_id === preceding) return null;
    }
    const y = above && below ? (above.box.bottom + below.box.top) / 2 : above ? above.box.bottom : below!.box.top;
    const text = start + depth * step;
    return {parent_id, after_id, before_id, mirror: session.mirror, depth, top: y - bounds.top - 1, left: text - bounds.left, width: bounds.right - text};
  };
  const paint = (session: Session) => {
    const next = locate(session, session.point);
    setDestination(previous => previous !== null && next !== null && same(previous, next) && previous.top === next.top && previous.left === next.left && previous.width === next.width ? previous : next);
  };

  const start = (event: DragStartEvent) => {
    const press = held.current; if (!press) return;
    // Claim the physical gesture before asking whether its snapshot still lives.
    suppressDragReleaseClick(press.pointerId);
    const origin = point(event.activatorEvent), mount = controller.mounts.get(press.row_id);
    if (press.invalidated || !valid(press) || !origin || !mount) return;
    const content = mount.content.getBoundingClientRect(), bullet = press.bullet.getBoundingClientRect();
    const session: Session = {...press, origin, point: origin, scrollTop: press.port.scrollTop, mirror: "altKey" in event.activatorEvent && event.activatorEvent.altKey === true,
      label: controller.chrome().get(press.roots[0]!)?.label ?? "", ring: bullet.left + bullet.width / 2 - content.left};
    for (const id of press.lifted) {const dom = controller.mounts.get(id)?.dom; if (dom) dom.dataset.dragging = "true";}
    active.current = session; setDrag(session); setMirror(session.mirror); setDestination(null);
  };
  /** A touch press the sensor abandons while the finger is down (a resize, a slip past tolerance) is no tap: its release
   * must not open the item. A tap's abort follows its pointerup, which has already cleared the press. */
  const claim = () => {const press = held.current; if (press?.pointerType === "touch") suppressDragReleaseClick(press.pointerId);};
  const moved = (event: DragMoveEvent) => {
    const session = active.current; if (!session) return;
    if (!valid(session)) return invalidate();
    // Core includes ancestor scroll in delta; pointer coordinates do not.
    session.point = {x: session.origin.x + event.delta.x, y: session.origin.y + event.delta.y - (session.port.scrollTop - session.scrollTop)};
    paint(session);
  };
  const end = (event: DragEndEvent) => {
    const session = active.current; if (!session) return;
    const at = {x: session.origin.x + event.delta.x, y: session.origin.y + event.delta.y - (session.port.scrollTop - session.scrollTop)};
    const target = valid(session) ? locate(session, at) : null, shown = painted.current;
    finish();
    if (session.pointerType === "touch" && Math.hypot(at.x - session.origin.x, at.y - session.origin.y) <= TOLERANCE) {controller.mounts.get(session.row_id)?.openMenu?.(); return;}
    if (!target || !shown || !same(target, shown)) return;
    controller.place(session.roots, {parent_id: shown.parent_id, after_id: shown.after_id, before_id: shown.before_id, mirror: shown.mirror});
  };

  useLayoutEffect(() => {
    if (held.current && !valid(held.current)) invalidate();
    if (active.current && !valid(active.current)) invalidate();
  });
  useLayoutEffect(() => {
    if (!drag) return;
    const source = controller.mounts.get(drag.row_id)?.dom, editor = source?.closest(".ProseMirror"), pane = root.current?.closest("[data-pane-shell]");
    if (!source || !editor) return;
    const portRect = drag.port.getBoundingClientRect(), sourceRect = source.getBoundingClientRect();
    const resized = new ResizeObserver(() => {
      const rect = source.getBoundingClientRect(), port = drag.port.getBoundingClientRect();
      if (rect.width !== sourceRect.width || rect.height !== sourceRect.height || port.width !== portRect.width || port.height !== portRect.height) invalidate();
    });
    resized.observe(source); resized.observe(drag.port);
    // the rows' own text and structure; the status region and receipts beside the editor are not the projection.
    const changed = new MutationObserver(invalidate);
    changed.observe(editor, {childList: true, characterData: true, subtree: true});
    const deactivated = new MutationObserver(() => {if (pane?.getAttribute("data-active") !== "true") invalidate();});
    if (pane) deactivated.observe(pane, {attributes: true, attributeFilter: ["data-active"]});
    const scrolled = (event: Event) => {if (event.target !== drag.port) invalidate();};
    // escape reaches the document in capture only: the focused bullet's row stops the bubble at react's root before the sensor's listener.
    const modifier = (event: PointerEvent | KeyboardEvent) => {
      const session = active.current; if (!session) return;
      if (event instanceof KeyboardEvent && event.key === "Escape") {event.preventDefault(); event.stopPropagation(); if (event.type === "keydown") invalidate(); return;}
      const next = event instanceof KeyboardEvent ? event.key === "Alt" ? event.type === "keydown" : session.mirror : event.altKey;
      if (next === session.mirror) return;
      session.mirror = next; setMirror(next); paint(session);
    };
    document.addEventListener("scroll", scrolled, true); window.addEventListener("resize", invalidate); window.addEventListener("blur", invalidate);
    document.addEventListener("pointermove", modifier, true); document.addEventListener("keydown", modifier, true); document.addEventListener("keyup", modifier, true);
    return () => {
      resized.disconnect(); changed.disconnect(); deactivated.disconnect();
      document.removeEventListener("scroll", scrolled, true); window.removeEventListener("resize", invalidate); window.removeEventListener("blur", invalidate);
      document.removeEventListener("pointermove", modifier, true); document.removeEventListener("keydown", modifier, true); document.removeEventListener("keyup", modifier, true);
    };
  // paint reads only refs and the controller; the session is the dependency.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, invalidate, controller]);

  return <DndContext sensors={sensors} accessibility={{announcements: SILENT, restoreFocus: false, screenReaderInstructions: {draggable: ""}}}
    autoScroll={{enabled: drag !== null, layoutShiftCompensation: false, threshold: {x: 0, y: 0.15}, canScroll: element => element === active.current?.port}}
    onDragStart={start} onDragMove={moved} onDragCancel={invalidate} onDragEnd={end} onDragAbort={claim}>
    <Retirement signal={retire}/>
    <GestureSurface rootRef={root} begin={begin} canActivate={canActivate}>
      {children}
      {drag ? <div className={styles.indicator} aria-hidden="true" data-outline-drop-indicator="true" hidden={destination === null} data-mirror={mirror || undefined}
        style={destination ? {top: destination.top, left: destination.left, width: destination.width, "--outline-ring-offset": `${drag.ring}px`} as CSSProperties : undefined}/> : null}
    </GestureSurface>
    {overlay ? createPortal(<DragOverlay adjustScale={false} dropAnimation={null} style={{pointerEvents: "none"}}>
      {drag ? <div className={styles.ghost} inert aria-hidden="true" data-outline-drag-ghost="true" data-mirror={mirror || undefined}>{drag.label}{drag.roots.length > 1 ? ` +${drag.roots.length - 1}` : null}</div> : null}
    </DragOverlay>, overlay) : null}
  </DndContext>;
}
