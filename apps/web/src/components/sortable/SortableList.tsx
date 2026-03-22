"use client";

import { useMemo, type CSSProperties, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
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
  handleProps: SortableHandleProps;
}

interface SortableListProps<T> {
  items: T[];
  getItemId: (item: T) => string;
  renderItem: (props: SortableListRenderItemProps<T>) => ReactNode;
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
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
    >
      {renderItem({
        item,
        isDragging,
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
  onReorder,
  className,
  itemClassName,
}: SortableListProps<T>) {
  const itemIds = useMemo(() => items.map(getItemId), [getItemId, items]);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
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

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
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
    </DndContext>
  );
}
