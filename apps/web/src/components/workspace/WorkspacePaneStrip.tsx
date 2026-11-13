"use client";

import { DndContext, DragOverlay, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import * as Icon from "@/lib/ui/icons";
import Button from "@/components/ui/Button";
import { Announcement } from "@/components/feedback/Announcement";
import compact from "@/components/ui/CompactChrome.module.css";
import tabs from "@/components/ui/Tabs.module.css";
import { cx } from "@/lib/ui/cx";
import { assertNever } from "@/lib/assertNever";
import type { MediaKind } from "@/lib/media/kind";
import { paneGlyph } from "@/lib/resources/type";
import { NEW_PANE_HINT, PANE_STRIP_DESCRIPTION } from "@/lib/shortcuts";
import { suppressDragReleaseClick } from "@/lib/ui/dragGesture";
import { hasWorkspaceNavigationBlocker } from "@/lib/ui/overlay";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { useIndicator } from "@/lib/ui/useIndicator";
import type { WorkspaceState } from "@/lib/workspace/model";
import { activePaneControls } from "@/lib/workspace/paneControls";
import type { WorkspaceTargetActivationResult, WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import { useLatestWorkspace, type WorkspaceSelection } from "@/lib/workspace/store";
import type { PaneSpans } from "./usePaneCanvas";
import styles from "./WorkspacePaneStrip.module.css";

interface StripItem {
  readonly paneId: string;
  readonly href: string;
  readonly label: string;
  readonly mediaKind: MediaKind | undefined;
  readonly isActive: boolean;
  readonly minimized: boolean;
}

type Control = "activate" | "close" | "visibility" | "layout";
type FocusTarget = { paneId: string | null; control: Control };
type ButtonKey = KeyboardEvent<HTMLButtonElement>;

const SILENT_DRAG = {
  onDragStart: () => undefined, onDragOver: () => undefined,
  onDragEnd: () => undefined, onDragCancel: () => undefined,
};

function ChipIdentity({ item }: { readonly item: StripItem }) {
  const Glyph = paneGlyph(item.href, item.mediaKind);
  return <>
    <Glyph aria-hidden size={16} className={styles.icon} />
    <span className={styles.title}><span aria-hidden="true" className={styles.reserve}>{item.label}</span><span>{item.label}</span></span>
  </>;
}

/** The title alone starts a drag; close keeps one held target beside it. */
function PaneChip(props: {
  readonly item: StripItem;
  readonly maximized: boolean;
  readonly focusable: Control | null;
  readonly descriptionId: string;
  readonly cancelled: boolean;
  readonly register: (control: Control, node: HTMLButtonElement | null) => void;
  readonly onFocus: (control: Control) => void;
  readonly onKeyDown: (event: ButtonKey, control: Control) => void;
  readonly onActivate: (event: TargetActivationEvent) => void;
  readonly onClose: () => void;
}) {
  const { item } = props;
  const sortable = useSortable({ id: item.paneId, transition: null });
  return <div
    ref={sortable.setNodeRef}
    className={styles.chip}
    style={{ transform: props.cancelled ? undefined : CSS.Translate.toString(sortable.transform) }}
    data-strip-pane-id={item.paneId}
    data-active={item.isActive || undefined}
    data-indicated={item.isActive || undefined}
    data-minimized={item.minimized || undefined}
    data-sorting={sortable.isSorting || undefined}
    data-dragging={(sortable.isDragging && !props.cancelled) || undefined}
    onMouseDownCapture={event => { if (event.button === 1) event.preventDefault(); }}
    onAuxClick={event => {
      if (event.button !== 1) return;
      event.preventDefault();
      if (!hasWorkspaceNavigationBlocker()) props.onClose();
    }}
  >
    <button
      type="button"
      ref={node => { sortable.setActivatorNodeRef(node); props.register("activate", node); }}
      className={styles.activator}
      tabIndex={props.focusable === "activate" ? 0 : -1}
      aria-current={item.isActive ? "page" : undefined}
      aria-describedby={props.descriptionId}
      aria-keyshortcuts="ArrowLeft ArrowRight Home End Shift+Enter Delete Backspace Shift+M Shift+H"
      title={`${item.label} · ${NEW_PANE_HINT}`}
      onMouseDown={event => {
        if (event.button === 0 && !hasWorkspaceNavigationBlocker()) sortable.listeners?.onMouseDown?.(event);
      }}
      onTouchStart={event => { if (!hasWorkspaceNavigationBlocker()) sortable.listeners?.onTouchStart?.(event); }}
      onClick={props.onActivate}
      onFocus={() => props.onFocus("activate")}
      onKeyDown={event => props.onKeyDown(event, "activate")}
    >
      <ChipIdentity item={item} />
      {item.isActive ? <span className="sr-only"> Active pane.</span> : null}
      {item.minimized ? <span className="sr-only"> Minimized.</span> : null}
      {props.maximized ? <span className="sr-only"> Maximized.</span> : null}
    </button>
    <Button ref={node => props.register("close", node)} iconOnly icon={<Icon.Dismiss aria-hidden />}
      className={styles.close} tabIndex={props.focusable === "close" ? 0 : -1}
      aria-label={`Close ${item.label}`} tooltip={{ text: "close pane" }} aria-describedby={props.descriptionId}
      onFocus={() => props.onFocus("close")} onKeyDown={event => props.onKeyDown(event, "close")}
      onClick={props.onClose} />
  </div>;
}

/** One roving toolbar: pane titles and closes, then the active pane's commands. */
export default function WorkspacePaneStrip(props: {
  readonly state: WorkspaceState;
  readonly items: readonly StripItem[];
  readonly isMaximized: boolean;
  readonly subscribeSpans: (listener: (value: PaneSpans) => void) => () => void;
  readonly onActivate: (paneId: string, disposition: WorkspaceTargetDisposition) => WorkspaceTargetActivationResult | null;
  readonly onRestoreCanvas: (paneId: string) => WorkspaceSelection | null;
  readonly onMinimize: (paneId: string) => void;
  readonly onClose: (paneId: string) => WorkspaceSelection | null;
  readonly onMaximize: (paneId: string) => WorkspaceSelection | null;
  readonly onMove: (input: { paneId: string; beforePaneId: string | null }) => boolean;
}) {
  const { items, subscribeSpans, isMaximized } = props;
  const latestWorkspace = useLatestWorkspace();
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [roving, setRoving] = useState<FocusTarget | null>(null);
  const [focusAfter, setFocusAfter] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<{ readonly text: string } | null>(null);
  const announce = (text: string) => setAnnouncement({ text });
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const draggedOrder = useRef<readonly string[] | null>(null);
  const heldPointer = useRef<number | null>(null);
  const descriptionId = useId();
  const ids = items.map(item => item.paneId);
  const active = items.find(item => item.isActive)!;
  const activeId = active.paneId;
  const controls = activePaneControls({ state: props.state, title: active.label, desktopMaximized: isMaximized });
  const targets: FocusTarget[] = [
    ...items.flatMap(item => [{ paneId: item.paneId, control: "activate" as const }, { paneId: item.paneId, control: "close" as const }]),
    { paneId: null, control: "visibility" }, { paneId: null, control: "layout" },
  ];
  const focusable: FocusTarget = roving && targets.some(target => target.paneId === roving.paneId && target.control === roving.control)
    ? roving : { paneId: activeId, control: "activate" };
  const dragValid = draggedOrder.current !== null && ids.length === draggedOrder.current.length &&
    ids.every((id, index) => id === draggedOrder.current![index]);
  const draggedItem = dragValid ? items.find(item => item.paneId === draggedId) : null;
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );
  useIndicator(scroller, activeId);

  useLayoutEffect(() => subscribeSpans(spans => {
    for (const chip of scroller.current?.querySelectorAll<HTMLElement>("[data-strip-pane-id]") ?? []) {
      const id = chip.dataset.stripPaneId!;
      const span = chip.hasAttribute("data-minimized") ? null
        : isMaximized ? (id === activeId ? [0, 1] : null) : spans.get(id);
      if (span) {
        chip.style.setProperty("--bracket-from", String(span[0]));
        chip.style.setProperty("--bracket-to", String(span[1]));
        chip.setAttribute("data-bracket-end", "");
      } else {
        chip.style.removeProperty("--bracket-from");
        chip.style.removeProperty("--bracket-to");
        chip.removeAttribute("data-bracket-end");
      }
    }
  }), [subscribeSpans, isMaximized, activeId, items]);

  useEffect(() => {
    const clear = () => { heldPointer.current = null; };
    const release = (event: PointerEvent) => { if (event.pointerId === heldPointer.current) clear(); };
    document.addEventListener("pointerup", release, true);
    document.addEventListener("pointercancel", release, true);
    window.addEventListener("blur", clear);
    return () => {
      document.removeEventListener("pointerup", release, true);
      document.removeEventListener("pointercancel", release, true);
      window.removeEventListener("blur", clear);
    };
  }, []);

  const reveal = useCallback((paneId: string) => {
    const viewport = scroller.current;
    const chip = buttons.current.get(`${paneId}:activate`)?.parentElement;
    if (!viewport || !chip) return;
    const frame = viewport.getBoundingClientRect();
    const rect = chip.getBoundingClientRect();
    const left = frame.left + viewport.clientLeft;
    const right = left + viewport.clientWidth;
    if (rect.left < left) viewport.scrollLeft += rect.left - left;
    else if (rect.right > right) viewport.scrollLeft += rect.right - right;
  }, []);
  const focus = (target: FocusTarget) => {
    setRoving(target);
    buttons.current.get(`${target.paneId}:${target.control}`)?.focus({ preventScroll: true });
    if (target.paneId !== null) reveal(target.paneId);
  };
  useLayoutEffect(() => {
    if (!root.current?.contains(document.activeElement)) reveal(activeId);
  }, [activeId, reveal]);
  useLayoutEffect(() => {
    if (focusAfter === null) return;
    setFocusAfter(null);
    if (hasWorkspaceNavigationBlocker()) return;
    const paneId = items.find(item => item.paneId === focusAfter)?.paneId ?? activeId;
    setRoving({ paneId, control: "activate" });
    buttons.current.get(`${paneId}:activate`)?.focus({ preventScroll: true });
    reveal(paneId);
  }, [focusAfter, items, activeId, reveal]);

  const close = (paneId: string) => {
    if (!latestWorkspace().state.panes.some(pane => pane.id === paneId)) return;
    const index = items.findIndex(item => item.paneId === paneId);
    if (index < 0) return;
    const next = items[index + 1]?.paneId ?? items[index - 1]?.paneId;
    const selection = props.onClose(paneId);
    if (selection !== null) setFocusAfter(next ?? selection.paneId);
  };
  const minimize = (paneId: string) => {
    const state = latestWorkspace().state;
    if (state.panes.find(pane => pane.id === paneId)?.visibility !== "visible") return;
    if (state.panes.filter(pane => pane.visibility === "visible").length === 1) {
      announce("keep at least one pane visible");
      return;
    }
    props.onMinimize(paneId);
    announce(`minimized ${items.find(item => item.paneId === paneId)!.label}.`);
  };
  const activate = (paneId: string, event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Consume" || hasWorkspaceNavigationBlocker()) return;
    const result = props.onActivate(paneId, { kind: activation.intent === "new_pane" ? "Fork" : "Follow" });
    if (result && result.kind !== "Cancelled" && result.kind !== "CreatedPane") reveal(result.paneId);
  };
  const onKeyDown = (event: ButtonKey, paneId: string | null, control: Control) => {
    if (event.defaultPrevented) return;
    const activationKey = event.key === "Enter" || event.key === " ";
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey ||
      event.altKey || hasWorkspaceNavigationBlocker() || !(event.target instanceof Node) ||
      !root.current?.contains(event.target) || activationKey && event.repeat) {
      if (activationKey) event.preventDefault();
      return;
    }
    if (paneId === null) {
      if (event.shiftKey && activationKey) event.preventDefault();
      if (activationKey) return;
    } else {
      if (control === "activate" && event.key === "Enter") { activate(paneId, event); return; }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (!event.repeat) event.currentTarget.click();
        return;
      }
      if (event.shiftKey && event.key.toLowerCase() === "h") {
        event.preventDefault();
        if (!event.repeat) minimize(paneId);
        return;
      }
      if (event.shiftKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        if (!event.repeat) {
          if (isMaximized && paneId === activeId) props.onRestoreCanvas(paneId);
          else props.onMaximize(paneId);
        }
        return;
      }
      if (!event.shiftKey && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        if (!event.repeat) close(paneId);
        return;
      }
    }
    if (event.shiftKey) return;
    const index = targets.findIndex(target => target.paneId === paneId && target.control === control);
    const last = targets.length - 1;
    const byKey: Partial<Record<string, number>> = {
      ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last,
    };
    const target = byKey[event.key];
    if (target !== undefined) { event.preventDefault(); focus(targets[target]!); }
  };
  const finishDrag = (paneId: string) => {
    draggedOrder.current = null;
    if (!root.current) return;
    setDraggedId(null);
    if (document.activeElement === document.body && !hasWorkspaceNavigationBlocker()) {
      const state = latestWorkspace().state;
      setFocusAfter(state.panes.some(pane => pane.id === paneId) ? paneId : state.active_primary_pane_id);
    }
  };

  return <DndContext
    sensors={sensors}
    accessibility={{ announcements: SILENT_DRAG, screenReaderInstructions: { draggable: "" }, restoreFocus: false }}
    autoScroll={{ canScroll: element => element === scroller.current, layoutShiftCompensation: false }}
    collisionDetection={args => {
      const rect = scroller.current?.getBoundingClientRect();
      const point = args.pointerCoordinates;
      if (!rect || !point || point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom) return [];
      return closestCenter(args);
    }}
    modifiers={[({ transform }) => ({ ...transform, y: 0, scaleX: 1, scaleY: 1 })]}
    onDragStart={event => {
      const paneId = String(event.active.id);
      draggedOrder.current = ids;
      if (heldPointer.current !== null) suppressDragReleaseClick(heldPointer.current);
      setDraggedId(paneId);
      setAnnouncement(null);
      focus({ paneId, control: "activate" });
    }}
    onDragCancel={event => finishDrag(String(event.active.id))}
    onDragEnd={event => {
      const paneId = String(event.active.id);
      const liveIds = latestWorkspace().state.panes.map(pane => pane.id);
      const original = draggedOrder.current;
      const unchanged = original !== null && liveIds.length === original.length && liveIds.every((id, index) => id === original[index]);
      const from = liveIds.indexOf(paneId);
      const to = event.over ? liveIds.indexOf(String(event.over.id)) : -1;
      if (root.current && unchanged && from >= 0 && to >= 0 && !hasWorkspaceNavigationBlocker()) {
        const order = arrayMove(liveIds, from, to);
        if (props.onMove({ paneId, beforePaneId: order[to + 1] ?? null })) {
          const panes = latestWorkspace().state.panes;
          const label = items.find(item => item.paneId === paneId)!.label;
          announce(`moved ${label} to position ${panes.findIndex(pane => pane.id === paneId) + 1} of ${panes.length}.`);
        }
      }
      finishDrag(paneId);
    }}
  >
    <div ref={root} className={cx(styles.root, compact.compact)} role="toolbar" aria-label="Workspace panes"
      aria-describedby={descriptionId} data-dragging={draggedItem ? "true" : undefined}
      onPointerDownCapture={event => { if (heldPointer.current === null && event.button === 0) heldPointer.current = event.pointerId; }}>
      <div ref={scroller} className={styles.switcher}>
        <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
          {items.map(item => <PaneChip key={item.paneId} item={item} maximized={isMaximized && item.isActive}
            focusable={focusable.paneId === item.paneId ? focusable.control : null} descriptionId={descriptionId}
            cancelled={draggedId !== null && !dragValid}
            register={(control, node) => {
              const key = `${item.paneId}:${control}`;
              if (node) buttons.current.set(key, node); else buttons.current.delete(key);
            }}
            onFocus={control => { setRoving({ paneId: item.paneId, control }); if (heldPointer.current === null) reveal(item.paneId); }}
            onKeyDown={(event, control) => onKeyDown(event, item.paneId, control)}
            onActivate={event => activate(item.paneId, event)} onClose={() => close(item.paneId)} />)}
        </SortableContext>
        <span aria-hidden="true" data-indicator className={tabs.mark} />
      </div>
      <div className={styles.end}
        onClickCapture={event => {
          const reason = controls[0].disabledReason;
          if (reason !== null && event.target instanceof Element && event.target.closest('button[aria-disabled="true"]')) announce(reason);
        }}
        onKeyDownCapture={event => {
          const reason = controls[0].disabledReason;
          if (reason !== null && !event.defaultPrevented && !event.nativeEvent.isComposing && event.keyCode !== 229 &&
            !event.repeat && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey &&
            (event.key === "Enter" || event.key === " ") && event.target instanceof Element &&
            event.target.closest('button[aria-disabled="true"]')) announce(reason);
        }}>
        {controls.map(control => {
          const Glyph = control.icon;
          return <Button key={control.slot} ref={node => {
            const key = `null:${control.slot}`;
            if (node) buttons.current.set(key, node); else buttons.current.delete(key);
          }} iconOnly icon={<Glyph aria-hidden />} tabIndex={focusable.control === control.slot ? 0 : -1}
            aria-label={control.label} aria-disabled={control.disabledReason !== null || undefined}
            tooltip={{ text: control.disabledReason ?? control.tooltip }}
            onPointerDown={event => event.currentTarget.focus({ preventScroll: true })}
            onFocus={() => setRoving({ paneId: null, control: control.slot })}
            onKeyDown={event => onKeyDown(event, null, control.slot)}
            onClick={event => {
              event.currentTarget.focus({ preventScroll: true });
              switch (control.command) {
                case "minimize": minimize(activeId); return;
                case "maximize": props.onMaximize(activeId); return;
                case "restore_canvas": props.onRestoreCanvas(activeId); return;
                default: assertNever(control);
              }
            }} />;
        })}
      </div>
      <span id={descriptionId} className="sr-only">{PANE_STRIP_DESCRIPTION}</span>
      <Announcement text={announcement?.text ?? ""} level="Polite" occurrence={announcement ?? undefined} />
    </div>
    {draggedItem ? createPortal(<DragOverlay adjustScale={false} dropAnimation={null}>
      <div className={cx(styles.chip, styles.dragOverlay, compact.compact)} data-active={draggedItem.isActive || undefined}
        data-minimized={draggedItem.minimized || undefined} aria-hidden inert>
        <span className={styles.activator}><ChipIdentity item={draggedItem} /></span>
        <span className={styles.close}><Icon.Dismiss aria-hidden size={16} /></span>
      </div>
    </DragOverlay>, document.body) : null}
  </DndContext>;
}
