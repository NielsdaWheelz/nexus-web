"use client";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEventHandler,
  type ReactNode,
  type TouchEventHandler,
} from "react";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import ResourceList from "@/components/ui/ResourceList";
import styles from "./SortableList.module.css";

const SILENT_DND_ANNOUNCEMENTS = {
  onDragStart: () => "",
  onDragMove: () => "",
  onDragOver: () => "",
  onDragEnd: () => "",
  onDragCancel: () => "",
} as const;
const SILENT_DND_INSTRUCTIONS = { draggable: "" } as const;
const POST_MOUSE_DRAG_CLICK_SUPPRESSION_MS = 50;
const POST_TOUCH_DRAG_CLICK_SUPPRESSION_MS = 500;

export interface SortableActivatorProps {
  readonly setActivatorNodeRef: (node: HTMLButtonElement | null) => void;
  readonly listeners: {
    readonly onMouseDown?: MouseEventHandler<HTMLButtonElement>;
    readonly onTouchStart?: TouchEventHandler<HTMLButtonElement>;
  };
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly disabled: boolean;
  readonly isDragging: boolean;
  readonly moveUp: () => void;
  readonly moveDown: () => void;
  readonly consumeClickSuppression: () => boolean;
}

export interface SortableListRenderItemProps<T> {
  readonly item: T;
  readonly activatorProps: SortableActivatorProps;
}

interface SortableListProps<T> {
  readonly items: readonly T[];
  readonly getItemId: (item: T) => string;
  readonly renderItem: (props: SortableListRenderItemProps<T>) => ReactNode;
  readonly onReorder: (nextItems: T[]) => void;
  readonly ariaLabel: string;
  readonly disabled?: boolean;
}

interface SortableListItemProps<T> {
  readonly item: T;
  readonly id: string;
  readonly index: number;
  readonly total: number;
  readonly disabled: boolean;
  readonly renderItem: (props: SortableListRenderItemProps<T>) => ReactNode;
  readonly moveItem: (id: string, nextIndex: number) => void;
  readonly registerActivator: (id: string, node: HTMLButtonElement | null) => void;
  readonly consumeClickSuppression: (id: string) => boolean;
}

function SortableListItem<T>({
  item,
  id,
  index,
  total,
  disabled,
  renderItem,
  moveItem,
  registerActivator,
  consumeClickSuppression,
}: SortableListItemProps<T>) {
  const {
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const registerNode = useCallback(
    (node: HTMLButtonElement | null) => {
      setActivatorNodeRef(node);
      registerActivator(id, node);
    },
    [id, registerActivator, setActivatorNodeRef],
  );
  const mouseListener = listeners?.onMouseDown;
  const touchListener = listeners?.onTouchStart;

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={styles.item}
      data-dragging={isDragging ? "true" : "false"}
    >
      {renderItem({
        item,
        activatorProps: {
          setActivatorNodeRef: registerNode,
          listeners: {
            onMouseDown: mouseListener
              ? (event) => mouseListener(event)
              : undefined,
            onTouchStart: touchListener
              ? (event) => touchListener(event)
              : undefined,
          },
          canMoveUp: !disabled && index > 0,
          canMoveDown: !disabled && index < total - 1,
          disabled,
          isDragging,
          moveUp: () => moveItem(id, index - 1),
          moveDown: () => moveItem(id, index + 1),
          consumeClickSuppression: () => consumeClickSuppression(id),
        },
      })}
    </li>
  );
}

export default function SortableList<T>({
  items,
  getItemId,
  renderItem,
  onReorder,
  ariaLabel,
  disabled = false,
}: SortableListProps<T>) {
  const [announcement, setAnnouncement] = useState("");
  const activatorNodesRef = useRef(new Map<string, HTMLButtonElement>());
  const suppressedClickExpiryRef = useRef(new Map<string, number>());
  const activeClickSuppressionMsRef = useRef(
    POST_MOUSE_DRAG_CLICK_SUPPRESSION_MS,
  );
  const dndAccessibilityContainerRef = useRef<Element | null>(null);
  if (
    typeof document !== "undefined" &&
    dndAccessibilityContainerRef.current === null
  ) {
    dndAccessibilityContainerRef.current = document.createElement("div");
  }
  const itemIds = useMemo(() => items.map(getItemId), [getItemId, items]);
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 8 },
    }),
  );

  const registerActivator = useCallback(
    (id: string, node: HTMLButtonElement | null) => {
      if (node) activatorNodesRef.current.set(id, node);
      else activatorNodesRef.current.delete(id);
    },
    [],
  );

  const focusActivator = useCallback((id: string) => {
    requestAnimationFrame(() => activatorNodesRef.current.get(id)?.focus());
  }, []);

  const announceMove = useCallback(
    (id: string, nextIndex: number) => {
      setAnnouncement("");
      requestAnimationFrame(() => {
        setAnnouncement(`Moved to position ${nextIndex + 1} of ${items.length}`);
        activatorNodesRef.current.get(id)?.focus();
      });
    },
    [items.length],
  );

  const moveItem = useCallback(
    (id: string, nextIndex: number) => {
      if (disabled) return;
      const currentIndex = itemIds.indexOf(id);
      if (
        currentIndex < 0 ||
        nextIndex < 0 ||
        nextIndex >= items.length ||
        currentIndex === nextIndex
      ) {
        focusActivator(id);
        return;
      }
      onReorder(arrayMove([...items], currentIndex, nextIndex));
      announceMove(id, nextIndex);
    },
    [announceMove, disabled, focusActivator, itemIds, items, onReorder],
  );

  const suppressNextClick = useCallback((id: string, durationMs: number) => {
    const expiresAt = Date.now() + durationMs;
    suppressedClickExpiryRef.current.set(id, expiresAt);
    window.setTimeout(() => {
      if (suppressedClickExpiryRef.current.get(id) === expiresAt) {
        suppressedClickExpiryRef.current.delete(id);
      }
    }, durationMs);
  }, []);

  const consumeClickSuppression = useCallback((id: string) => {
    const expiresAt = suppressedClickExpiryRef.current.get(id);
    suppressedClickExpiryRef.current.delete(id);
    return expiresAt !== undefined && Date.now() <= expiresAt;
  }, []);

  const handleDragStart = (event: DragStartEvent) => {
    activeClickSuppressionMsRef.current = event.activatorEvent.type.startsWith(
      "touch",
    )
      ? POST_TOUCH_DRAG_CLICK_SUPPRESSION_MS
      : POST_MOUSE_DRAG_CLICK_SUPPRESSION_MS;
    setAnnouncement("");
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    suppressNextClick(activeId, activeClickSuppressionMsRef.current);
    if (!event.over) {
      focusActivator(activeId);
      return;
    }
    const nextIndex = itemIds.indexOf(String(event.over.id));
    moveItem(activeId, nextIndex);
  };

  const handleDragCancel = (event: DragCancelEvent) => {
    const activeId = String(event.active.id);
    suppressNextClick(activeId, activeClickSuppressionMsRef.current);
    focusActivator(activeId);
  };

  const sortableItems = items.map((item, index) => {
    const id = getItemId(item);
    return (
      <SortableListItem
        key={id}
        id={id}
        index={index}
        total={items.length}
        disabled={disabled}
        item={item}
        moveItem={moveItem}
        registerActivator={registerActivator}
        consumeClickSuppression={consumeClickSuppression}
        renderItem={renderItem}
      />
    );
  });

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      accessibility={{
        announcements: SILENT_DND_ANNOUNCEMENTS,
        screenReaderInstructions: SILENT_DND_INSTRUCTIONS,
        container: dndAccessibilityContainerRef.current ?? undefined,
      }}
      onDragStart={handleDragStart}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        <ResourceList ariaLabel={ariaLabel}>{sortableItems}</ResourceList>
      </SortableContext>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </DndContext>
  );
}
