"use client";

import {
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
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
import ResourceList from "@/components/ui/ResourceList";
import { cx } from "@/lib/ui/cx";
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
  resourceList?: {
    ariaLabel: string;
    view?: "list" | "gallery";
    density?: "comfortable" | "compact";
  };
}

interface SortableListItemProps<T> {
  item: T;
  id: string;
  index: number;
  items: T[];
  renderItem: (props: SortableListRenderItemProps<T>) => ReactNode;
  onReorder: (nextItems: T[]) => void;
  className?: string;
}

function SortableListItem<T>({
  item,
  id,
  index,
  items,
  renderItem,
  onReorder,
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
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    listeners?.onKeyDown?.(event);
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return;
    }

    const direction =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (direction === 0) {
      return;
    }

    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= items.length) {
      return;
    }

    event.preventDefault();
    onReorder(arrayMove(items, index, nextIndex));
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cx(styles.item, className)}
      data-dragging={isDragging ? "true" : "false"}
      data-over={isOver ? "true" : "false"}
    >
      {renderItem({
        item,
        isDragging,
        isOver,
        handleProps: {
          attributes,
          listeners: { ...listeners, onKeyDown: handleKeyDown },
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
  resourceList,
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

  const sortableItems = items.map((item, index) => {
    const id = getItemId(item);
    return (
      <SortableListItem
        key={id}
        id={id}
        index={index}
        item={item}
        items={items}
        onReorder={onReorder}
        renderItem={renderItem}
        className={itemClassName}
      />
    );
  });

  const list = resourceList ? (
    <ResourceList
      className={className}
      ariaLabel={resourceList.ariaLabel}
      view={resourceList.view ?? "list"}
      density={resourceList.density ?? "comfortable"}
    >
      {sortableItems}
    </ResourceList>
  ) : (
    <ul className={cx(styles.list, className)}>{sortableItems}</ul>
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        {list}
      </SortableContext>
      {renderDragOverlay && activeItem ? <DragOverlay>{renderDragOverlay(activeItem)}</DragOverlay> : null}
    </DndContext>
  );
}
