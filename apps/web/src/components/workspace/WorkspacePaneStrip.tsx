"use client";

import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import Button from "@/components/ui/Button";
import { assertNever } from "@/lib/assertNever";
import { getPaneRouteIcon } from "@/lib/panes/paneRouteModel";
import { PANE_STRIP_DESCRIPTION } from "@/lib/shortcuts";
import { suppressDragReleaseClick } from "@/lib/ui/dragGesture";
import { hasActiveInteractionOwner } from "@/lib/ui/overlay";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import type { WorkspaceState } from "@/lib/workspace/model";
import { paneControls, type PaneControl } from "@/lib/workspace/paneControls";
import type { WorkspaceTargetActivationResult, WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import { useLatestWorkspace, type WorkspaceSelection } from "@/lib/workspace/store";
import styles from "./WorkspacePaneStrip.module.css";

interface StripItem {
  readonly paneId: string;
  readonly href: string;
  readonly label: string;
  readonly isActive: boolean;
  readonly isInView: boolean;
  readonly minimized: boolean;
}

type Control = "activate" | PaneControl["slot"];
type FocusTarget = { paneId: string; control: Control };
type Move = { paneId: string; beforePaneId: string | null };
type ButtonKey = KeyboardEvent<HTMLButtonElement>;

// Reorder completion has one announcement; drag movement itself stays silent.
const SILENT_DRAG = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

function TabIdentity({ item }: { readonly item: StripItem }) {
  const RouteIcon = getPaneRouteIcon(item.href);
  return (
    <>
      <RouteIcon aria-hidden size={16} strokeWidth={1.75} className={styles.icon} />
      <span className={styles.title}>{item.label}</span>
    </>
  );
}

/** A sortable chip; its title alone starts a drag. */
function StripTab(props: {
  readonly item: StripItem;
  readonly controls: readonly PaneControl[];
  readonly maximized: boolean;
  readonly focusable: Control | null;
  readonly descriptionId: string;
  readonly cancelled: boolean;
  readonly register: (control: Control, node: HTMLButtonElement | null) => void;
  readonly onFocus: (control: Control) => void;
  readonly onKeyDown: (
    event: ButtonKey,
    control: Control,
  ) => void;
  readonly onActivate: (event: TargetActivationEvent) => void;
  readonly onCommand: (command: PaneControl["command"]) => void;
}) {
  const { item } = props;
  const sortable = useSortable({ id: item.paneId, transition: null });
  return (
    <div
      ref={sortable.setNodeRef}
      className={styles.tab}
      style={{ transform: props.cancelled ? undefined : CSS.Translate.toString(sortable.transform) }}
      data-active={item.isActive || undefined}
      data-in-view={item.isInView || undefined}
      data-minimized={item.minimized || undefined}
      data-sorting={sortable.isSorting || undefined}
      data-dragging={(sortable.isDragging && !props.cancelled) || undefined}
    >
      <button
        type="button"
        ref={(node) => {
          sortable.setActivatorNodeRef(node);
          props.register("activate", node);
        }}
        className={styles.activator}
        tabIndex={props.focusable === "activate" ? 0 : -1}
        aria-current={item.isActive ? "page" : undefined}
        aria-describedby={props.descriptionId}
        aria-keyshortcuts="ArrowLeft ArrowRight Home End Delete Backspace Shift+M"
        title={`${item.label}. shift-click or shift-enter opens in a new pane`}
        onMouseDown={(event) => {
          if (!hasActiveInteractionOwner()) sortable.listeners?.onMouseDown?.(event);
        }}
        onTouchStart={(event) => {
          if (!hasActiveInteractionOwner()) sortable.listeners?.onTouchStart?.(event);
        }}
        onClick={props.onActivate}
        onFocus={() => props.onFocus("activate")}
        onKeyDown={(event) => props.onKeyDown(event, "activate")}
      >
        <TabIdentity item={item} />
        {item.isActive ? <span className="sr-only"> Active pane.</span> : null}
        {item.minimized ? <span className="sr-only"> Minimized.</span> : null}
        {props.maximized ? <span className="sr-only"> Maximized.</span> : null}
      </button>
      <div className={styles.actions}>
        {props.controls.map((control) => {
          const Icon = control.icon;
          return <Button
            key={control.slot}
            ref={(node) => props.register(control.slot, node)}
            iconOnly
            icon={<Icon aria-hidden size={16} strokeWidth={1.75} />}
            className={styles.action}
            tabIndex={props.focusable === control.slot ? 0 : -1}
            aria-label={control.label}
            aria-disabled={control.disabledReason !== null || undefined}
            tooltip={{ text: control.disabledReason ?? control.tooltip }}
            aria-describedby={props.descriptionId}
            onPointerDown={(event) => event.currentTarget.focus({ preventScroll: true })}
            onFocus={() => props.onFocus(control.slot)}
            onKeyDown={(event) => props.onKeyDown(event, control.slot)}
            onClick={(event) => {
              // Safari does not focus pointer-clicked buttons by default.
              event.currentTarget.focus({ preventScroll: true });
              props.onCommand(control.command);
            }}
          />;
        })}
      </div>
    </div>
  );
}

/** One roving toolbar over the workspace order; activation and management differ. */
export default function WorkspacePaneStrip(props: {
  readonly state: WorkspaceState;
  readonly items: readonly StripItem[];
  readonly isMaximized: boolean;
  readonly onActivate: (paneId: string, disposition: WorkspaceTargetDisposition) => WorkspaceTargetActivationResult | null;
  readonly onRestoreCanvas: (paneId: string) => WorkspaceSelection | null;
  readonly onMinimize: (paneId: string) => void;
  readonly onClose: (paneId: string) => WorkspaceSelection | null;
  readonly onMaximize: (paneId: string) => WorkspaceSelection | null;
  readonly onMove: (input: Move) => boolean;
}) {
  const { items } = props;
  const latestWorkspace = useLatestWorkspace();
  const strip = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [roving, setRoving] = useState<FocusTarget | null>(null);
  const [focusAfter, setFocusAfter] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const draggedOrder = useRef<readonly string[] | null>(null);
  const heldPointer = useRef<number | null>(null);
  const descriptionId = useId();
  const ids = items.map((item) => item.paneId);
  const tabs = items.map((item) => ({ item, controls: paneControls({
    state: props.state, paneId: item.paneId, title: item.label,
    desktopMaximized: props.isMaximized, isMobile: false,
  }) }));
  const targets: FocusTarget[] = tabs.flatMap(({ item, controls }) => [
    { paneId: item.paneId, control: "activate" },
    ...controls.map((control) => ({ paneId: item.paneId, control: control.slot })),
  ]);
  const activeId = items.find((item) => item.isActive)?.paneId ?? items[0]?.paneId;
  const focusable: FocusTarget | null = roving && targets.some((target) => target.paneId === roving.paneId && target.control === roving.control)
    ? roving
    : activeId ? { paneId: activeId, control: "activate" } : null;
  // A changed order makes an in-flight insertion preview obsolete. Do not
  // reinterpret its slot after another command adds, removes or moves a pane.
  const dragValid = draggedOrder.current !== null &&
    ids.length === draggedOrder.current.length &&
    ids.every((id, index) => id === draggedOrder.current![index]);
  const draggedItem = dragValid ? items.find((item) => item.paneId === draggedId) : null;
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );

  useEffect(() => {
    const clear = () => { heldPointer.current = null; };
    const release = (event: PointerEvent) => {
      if (event.pointerId === heldPointer.current) clear();
    };
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
    const viewport = strip.current;
    const tab = buttons.current.get(`${paneId}:activate`)?.parentElement;
    if (!viewport || !tab) return;
    const frame = viewport.getBoundingClientRect();
    const rect = tab.getBoundingClientRect();
    const left = frame.left + viewport.clientLeft;
    const right = left + viewport.clientWidth;
    if (rect.left < left) viewport.scrollLeft += rect.left - left;
    else if (rect.right > right) viewport.scrollLeft += rect.right - right;
  }, []);
  const focus = (target: FocusTarget) => {
    setRoving(target);
    buttons.current.get(`${target.paneId}:${target.control}`)?.focus({ preventScroll: true });
    reveal(target.paneId);
  };

  useLayoutEffect(() => {
    // A management command keeps its focused chip visible even when the store
    // selects a different active pane. Only this scrollport may move.
    if (activeId && !strip.current?.contains(document.activeElement)) reveal(activeId);
  }, [activeId, reveal]);

  useLayoutEffect(() => {
    if (focusAfter === null) return;
    setFocusAfter(null);
    if (hasActiveInteractionOwner()) return;
    const paneId = items.find((item) => item.paneId === focusAfter)?.paneId ?? activeId;
    if (!paneId) return;
    setRoving({ paneId, control: "activate" });
    buttons.current.get(`${paneId}:activate`)?.focus({ preventScroll: true });
    reveal(paneId);
  }, [focusAfter, items, activeId, reveal]);

  const close = (paneId: string) => {
    if (!latestWorkspace().state.panes.some((pane) => pane.id === paneId)) return;
    const index = items.findIndex((item) => item.paneId === paneId);
    if (index < 0) return;
    const next = items[index + 1]?.paneId ?? items[index - 1]?.paneId;
    const selection = props.onClose(paneId);
    if (selection === null) return;
    setFocusAfter(next ?? selection.paneId);
  };
  const move = (input: Move) => {
    if (!props.onMove(input)) return;
    const panes = latestWorkspace().state.panes;
    const label = items.find((item) => item.paneId === input.paneId)!.label;
    setAnnouncement(`Moved ${label} to position ${panes.findIndex((pane) => pane.id === input.paneId) + 1} of ${panes.length}.`);
  };
  const activate = (paneId: string, event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Consume" || hasActiveInteractionOwner()) return;
    const result = props.onActivate(paneId, { kind: activation.intent === "new_pane" ? "Fork" : "Follow" });
    if (result && result.kind !== "Cancelled" && result.kind !== "CreatedPane") reveal(result.paneId);
  };
  const onKeyDown = (
    event: ButtonKey,
    paneId: string,
    control: Control,
  ) => {
    if (event.defaultPrevented) return;
    if (control === "activate" && event.key === "Enter") {
      activate(paneId, event);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!event.repeat && !event.nativeEvent.isComposing && !event.metaKey &&
        !event.ctrlKey && !event.altKey && !hasActiveInteractionOwner()) event.currentTarget.click();
      return;
    }
    if (
      event.nativeEvent.isComposing ||
      event.metaKey || event.ctrlKey || event.altKey || hasActiveInteractionOwner() ||
      !(event.target instanceof Node) || !strip.current?.contains(event.target)
    ) return;
    if (event.shiftKey && event.key.toLowerCase() === "m") {
      event.preventDefault();
      if (!event.repeat) {
        if (props.isMaximized && paneId === activeId) props.onRestoreCanvas(paneId);
        else props.onMaximize(paneId);
      }
      return;
    }
    if (event.shiftKey) return;
    const index = targets.findIndex((target) => target.paneId === paneId && target.control === control);
    const last = targets.length - 1;
    const byKey: Partial<Record<string, number>> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const target = byKey[event.key];
    if (target !== undefined) {
      event.preventDefault();
      focus(targets[target]!);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      if (!event.repeat) close(paneId);
    }
  };
  const finishDrag = (paneId: string) => {
    draggedOrder.current = null;
    if (!strip.current) return;
    setDraggedId(null);
    if (document.activeElement === document.body && !hasActiveInteractionOwner()) {
      const state = latestWorkspace().state;
      setFocusAfter(state.panes.some((pane) => pane.id === paneId) ? paneId : state.active_primary_pane_id);
    }
  };

  return (
    <DndContext
      sensors={sensors}
      accessibility={{ announcements: SILENT_DRAG, screenReaderInstructions: { draggable: "" }, restoreFocus: false }}
      autoScroll={{ canScroll: (element) => element === strip.current, layoutShiftCompensation: false }}
      collisionDetection={(args) => {
        const rect = strip.current?.getBoundingClientRect();
        const point = args.pointerCoordinates;
        if (
          !rect || !point || point.x < rect.left || point.x > rect.right ||
          point.y < rect.top || point.y > rect.bottom
        ) return [];
        return closestCenter(args);
      }}
      modifiers={[({ transform }) => ({ ...transform, y: 0, scaleX: 1, scaleY: 1 })]}
      onDragStart={(event) => {
        const paneId = String(event.active.id);
        draggedOrder.current = ids;
        if (heldPointer.current !== null) suppressDragReleaseClick(heldPointer.current);
        setDraggedId(paneId);
        setAnnouncement(null);
        focus({ paneId, control: "activate" });
      }}
      onDragCancel={(event) => finishDrag(String(event.active.id))}
      onDragEnd={(event) => {
        const paneId = String(event.active.id);
        // Resolve against the store at dispatch, even if React has not rendered
        // an intervening removal yet. Unmounted strips cannot complete a drop.
        const liveIds = latestWorkspace().state.panes.map((pane) => pane.id);
        const original = draggedOrder.current;
        const unchanged = original !== null && liveIds.length === original.length &&
          liveIds.every((id, index) => id === original[index]);
        const from = liveIds.indexOf(paneId);
        const to = event.over ? liveIds.indexOf(String(event.over.id)) : -1;
        if (strip.current && unchanged && from >= 0 && to >= 0 && !hasActiveInteractionOwner()) {
          const order = arrayMove(liveIds, from, to);
          move({ paneId, beforePaneId: order[to + 1] ?? null });
        }
        finishDrag(paneId);
      }}
    >
      <div className={styles.root}>
        <div
          ref={strip}
          className={styles.switcher}
          role="toolbar"
          aria-label="Workspace panes"
          aria-describedby={descriptionId}
          onPointerDownCapture={(event) => {
            if (heldPointer.current === null) heldPointer.current = event.pointerId;
          }}
        >
          <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
            {tabs.map(({ item, controls }) => (
              <StripTab
                key={item.paneId}
                item={item}
                controls={controls}
                maximized={props.isMaximized && item.isActive}
                focusable={focusable?.paneId === item.paneId ? focusable.control : null}
                descriptionId={descriptionId}
                cancelled={draggedId !== null && !dragValid}
                register={(control, node) => {
                  const key = `${item.paneId}:${control}`;
                  if (node) buttons.current.set(key, node);
                  else buttons.current.delete(key);
                }}
                onFocus={(control) => {
                  setRoving({ paneId: item.paneId, control });
                  // Native pointer focus happens before release. Moving a
                  // clipped chip now could put another control under the pointer.
                  if (heldPointer.current === null) reveal(item.paneId);
                }}
                onKeyDown={(event, control) => onKeyDown(event, item.paneId, control)}
                onActivate={event => activate(item.paneId, event)}
                onCommand={(command) => {
                  switch (command) {
                    case "minimize": props.onMinimize(item.paneId); return;
                    case "maximize": props.onMaximize(item.paneId); return;
                    case "restore_canvas": props.onRestoreCanvas(item.paneId); return;
                    case "close": close(item.paneId); return;
                    default: assertNever(command);
                  }
                }}
              />
            ))}
          </SortableContext>
        </div>
        <span id={descriptionId} className="sr-only">{PANE_STRIP_DESCRIPTION}</span>
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
      </div>
      {draggedItem ? createPortal(
        <DragOverlay adjustScale={false} dropAnimation={null}>
          <div className={`${styles.tab} ${styles.dragOverlay}`} data-active={draggedItem.isActive || undefined} aria-hidden inert>
            <span className={styles.activator}><TabIdentity item={draggedItem} /></span>
            <span className={styles.actions}>
              {paneControls({ state: props.state, paneId: draggedItem.paneId, title: draggedItem.label, desktopMaximized: props.isMaximized, isMobile: false }).map((control) => {
                const Icon = control.icon;
                return <span key={control.slot} className={styles.action}><Icon size={16} strokeWidth={1.75} aria-hidden /></span>;
              })}
            </span>
          </div>
        </DragOverlay>,
        document.body,
      ) : null}
    </DndContext>
  );
}
