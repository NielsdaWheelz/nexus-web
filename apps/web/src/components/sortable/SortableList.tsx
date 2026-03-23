"use client";

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import styles from "./SortableList.module.css";

type SortableHookResult = ReturnType<typeof useSortable>;

export interface SortableHandleProps {
  attributes: SortableHookResult["attributes"];
  listeners: SortableHookResult["listeners"];
}

export interface SortableListRenderItemProps<T> {
  item: T;
  isDragging: boolean;
  isOver: boolean;
  handleProps: SortableHandleProps;
}

interface SortableListProps<T> {
  items: T[];
  getItemId: (item: T) => string;
  renderItem: (props: SortableListRenderItemProps<T>) => ReactNode;
  renderDragOverlay?: (item: T) => ReactNode;
  onReorder: (nextItems: T[]) => void;
  className?: string;
  itemClassName?: string;
}

interface SortableListItemProps<T> {
  item: T;
  id: string;
  renderItem: (props: SortableListRenderItemProps<T>) => ReactNode;
  className?: string;
}

function joinClassNames(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function SortableListItem<T>({
  item,
  id,
  renderItem,
  className,
}: SortableListItemProps<T>) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({
      id,
    });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={joinClassNames(styles.item, className)}
      data-dragging={isDragging ? "true" : "false"}
      data-over={isOver ? "true" : "false"}
    >
      {renderItem({
        item,
        isDragging,
        isOver,
        handleProps: {
          attributes,
          listeners,
        },
      })}
    </li>
  );
}

export default function SortableList<T>({
  items,
  getItemId,
  renderItem,
  renderDragOverlay,
  onReorder,
  className,
  itemClassName,
}: SortableListProps<T>) {
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const itemIds = useMemo(() => items.map(getItemId), [getItemId, items]);
  const activeItem = useMemo(() => {
    if (!activeItemId) {
      return null;
    }
    return items.find((item) => getItemId(item) === activeItemId) ?? null;
  }, [activeItemId, getItemId, items]);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveItemId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveItemId(null);
    if (!over || active.id === over.id) {
      return;
    }
    const oldIndex = itemIds.indexOf(String(active.id));
    const newIndex = itemIds.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) {
      return;
    }
    onReorder(arrayMove(items, oldIndex, newIndex));
  };

  const handleDragCancel = () => {
    setActiveItemId(null);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        <ul className={joinClassNames(styles.list, className)}>
          {items.map((item) => {
            const id = getItemId(item);
            return (
              <SortableListItem
                key={id}
                id={id}
                item={item}
                renderItem={renderItem}
                className={itemClassName}
              />
            );
          })}
        </ul>
      </SortableContext>
      {renderDragOverlay && activeItem ? <DragOverlay>{renderDragOverlay(activeItem)}</DragOverlay> : null}
    </DndContext>
  );
}
