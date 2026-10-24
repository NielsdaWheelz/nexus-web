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
import { Ellipsis, X } from "lucide-react";
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
import ActionMenu from "@/components/ui/ActionMenu";
import OverflowMenuButton from "@/components/ui/OverflowMenuButton";
import { getPaneRouteIcon } from "@/lib/panes/paneRouteModel";
import { PANE_STRIP_DESCRIPTION } from "@/lib/shortcuts";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { suppressDragReleaseClick } from "@/lib/ui/dragGesture";
import { hasActiveInteractionOwner } from "@/lib/ui/overlay";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import type { WorkspaceTargetActivationResult, WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import type { WorkspaceState } from "@/lib/workspace/model";
import { paneActions } from "@/lib/workspace/paneActions";
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

type Control = "activate" | "menu";
type FocusTarget = { paneId: string; control: Control };
type Move = { paneId: string; beforePaneId: string | null };
type ButtonKey = KeyboardEvent<HTMLButtonElement>;

// Menu and drag moves share the strip's completion announcement. There is no
// keyboard pickup mode: the reachable move commands also work by click/tap.
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
  readonly options: readonly ActionDescriptor[];
  readonly focusable: Control | null;
  readonly descriptionId: string;
  readonly cancelled: boolean;
  readonly register: (control: Control, node: HTMLButtonElement | null) => void;
  readonly onFocus: (control: Control) => void;
  readonly onKeyDown: (
    event: ButtonKey,
    control: Control,
    menuDefault?: (event: ButtonKey) => void,
  ) => void;
  readonly onActivate: (event: TargetActivationEvent) => void;
  readonly onClose: () => void;
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
        aria-keyshortcuts="ArrowLeft ArrowRight Home End ArrowDown Delete Backspace Shift+M Shift+F10"
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
        {item.minimized ? <span className="sr-only"> Minimized. Restore.</span> : null}
      </button>
      <div className={styles.actions}>
        <ActionMenu
          source={{ kind: "Immediate", subjectKey: `pane-strip:${item.paneId}`, title: item.label, content: { sections: [{ id: "Pane", label: null, options: props.options }] } }}
          label={`more actions for ${item.label}`}
          triggerAttributes={{ tabIndex: props.focusable === "menu" ? 0 : -1 }}
          triggerRef={(node) => props.register("menu", node)}
          renderTrigger={(trigger) => (
            <OverflowMenuButton
              {...trigger}
              onFocus={() => props.onFocus("menu")}
              onClick={(event) => {
                // Safari does not focus a pointer-clicked button. More must be
                // the roving stop before the menu captures its return target.
                event.currentTarget.focus({ preventScroll: true });
                props.onFocus("menu");
                trigger.onClick(event);
              }}
              onKeyDown={(event) => props.onKeyDown(event, "menu", trigger.onKeyDown)}
            />
          )}
        />
        <button
          type="button"
          tabIndex={-1}
          className={styles.action}
          aria-label={`Close ${item.label}`}
          onClick={props.onClose}
        >
          <X aria-hidden size={16} strokeWidth={1.75} />
        </button>
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
  readonly onRestore: (paneId: string) => void;
  readonly onMinimize: (paneId: string) => void;
  readonly onClose: (paneId: string) => WorkspaceSelection | null;
  readonly onToggleMaximize: (paneId: string) => void;
  readonly onMove: (input: Move) => boolean;
}) {
  const { items } = props;
  const latestWorkspace = useLatestWorkspace();
  const strip = useRef<HTMLDivElement>(null);
  const activators = useRef(new Map<string, HTMLButtonElement>());
  const menus = useRef(new Map<string, HTMLButtonElement>());
  const [roving, setRoving] = useState<FocusTarget | null>(null);
  const [focusAfter, setFocusAfter] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const draggedOrder = useRef<readonly string[] | null>(null);
  const heldPointer = useRef<number | null>(null);
  const descriptionId = useId();
  const ids = items.map((item) => item.paneId);
  const activeId = items.find((item) => item.isActive)?.paneId ?? items[0]?.paneId;
  const focusable: FocusTarget | null = roving && ids.includes(roving.paneId)
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
    const tab = activators.current.get(paneId)?.parentElement;
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
    const nodes = target.control === "activate" ? activators.current : menus.current;
    nodes.get(target.paneId)?.focus({ preventScroll: true });
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
    activators.current.get(paneId)?.focus({ preventScroll: true });
    reveal(paneId);
  }, [focusAfter, items, activeId, reveal]);

  const close = (paneId: string) => {
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
  const openMenu = (paneId: string) => {
    focus({ paneId, control: "menu" });
    menus.current.get(paneId)?.click();
  };
  const activate = (paneId: string, event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Consume") return;
    const result = props.onActivate(paneId, { kind: activation.intent === "new_pane" ? "Fork" : "Follow" });
    if (result && result.kind !== "Cancelled" && result.kind !== "CreatedPane") reveal(result.paneId);
  };
  const onKeyDown = (
    event: ButtonKey,
    index: number,
    control: Control,
    menuDefault?: (event: ButtonKey) => void,
  ) => {
    if (
      event.defaultPrevented ||
      event.metaKey || event.ctrlKey || event.altKey || hasActiveInteractionOwner() ||
      !(event.target instanceof Node) || !strip.current?.contains(event.target)
    ) return;
    const paneId = items[index]!.paneId;
    if (control === "activate" && event.key === "Enter") {
      activate(paneId, event);
      return;
    }
    if (event.nativeEvent.isComposing) return;
    if (event.shiftKey && event.key.toLowerCase() === "m") {
      event.preventDefault();
      if (!event.repeat) props.onToggleMaximize(paneId);
      return;
    }
    if ((event.shiftKey && event.key === "F10") || (!event.shiftKey && event.key === "ContextMenu")) {
      event.preventDefault();
      openMenu(paneId);
      return;
    }
    if (event.shiftKey) return;
    const last = items.length - 1;
    const byKey: Partial<Record<string, number>> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const target = byKey[event.key];
    if (target !== undefined) {
      event.preventDefault();
      focus({ paneId: items[target]!.paneId, control: "activate" });
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      if (!event.repeat) close(paneId);
    } else if (control === "activate" && event.key === "ArrowDown") {
      event.preventDefault();
      openMenu(paneId);
    } else {
      menuDefault?.(event);
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
            {items.map((item, index) => {
              const actions = paneActions({
                state: props.state,
                paneId: item.paneId,
                onOpen: paneId => props.onActivate(paneId, { kind: "Fork" }),
                onMinimize: props.onMinimize,
                onRestore: props.onRestore,
                onMove: move,
                onClose: close,
              });
              const options: ActionDescriptor[] = [
                ...actions.slice(0, 1),
                {
                  id: "pane-maximize",
                  kind: "command",
                  label: props.isMaximized && item.isActive ? "Restore layout" : "Maximize pane",
                  onSelect: () => props.onToggleMaximize(item.paneId),
                },
                ...actions.slice(1),
              ];
              return (
                <StripTab
                  key={item.paneId}
                  item={item}
                  options={options}
                  focusable={focusable?.paneId === item.paneId ? focusable.control : null}
                  descriptionId={descriptionId}
                  cancelled={draggedId !== null && !dragValid}
                  register={(control, node) => {
                    const nodes = control === "activate" ? activators.current : menus.current;
                    if (node) nodes.set(item.paneId, node);
                    else nodes.delete(item.paneId);
                  }}
                  onFocus={(control) => {
                    setRoving({ paneId: item.paneId, control });
                    // Native pointer focus happens before release. Moving a
                    // clipped chip now could put More/Close under the pointer.
                    if (heldPointer.current === null) reveal(item.paneId);
                  }}
                  onKeyDown={(event, control, menuDefault) => onKeyDown(event, index, control, menuDefault)}
                  onActivate={event => activate(item.paneId, event)}
                  onClose={() => close(item.paneId)}
                />
              );
            })}
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
              <span className={styles.action}><Ellipsis size={16} strokeWidth={1.5} aria-hidden /></span>
              <span className={styles.action}><X size={16} aria-hidden /></span>
            </span>
          </div>
        </DragOverlay>,
        document.body,
      ) : null}
    </DndContext>
  );
}
