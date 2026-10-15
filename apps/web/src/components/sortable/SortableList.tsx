"use client";

// A list whose rows move by drag (mouse, or touch after a press) or by their
// Move up / Move down controls. Each move calls onReorder with the whole next
// order and announces the new position; focus stays on the moved row's handle.
// The click that ends a drag is swallowed so the row's link does not open.

import {
  useRef,
  useState,
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

// The list announces moves itself; dnd-kit's own live regions stay silent and
// detached from the document.
const SILENT = {
  onDragStart: () => "",
  onDragMove: () => "",
  onDragOver: () => "",
  onDragEnd: () => "",
  onDragCancel: () => "",
};

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

interface Moves {
  readonly move: (id: string, to: number) => void;
  readonly handles: Map<string, HTMLButtonElement>;
  readonly consumeClick: (id: string) => boolean;
}

function Row<T>(props: {
  readonly id: string;
  readonly index: number;
  readonly count: number;
  readonly disabled: boolean;
  readonly item: T;
  readonly renderItem: (props: SortableListRenderItemProps<T>) => ReactNode;
  readonly moves: Moves;
}) {
  const { id, index, count, disabled, moves } = props;
  const sortable = useSortable({ id, disabled });
  const listeners = sortable.listeners;
  return (
    <li
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={styles.item}
      data-dragging={sortable.isDragging ? "true" : "false"}
    >
      {props.renderItem({
        item: props.item,
        activatorProps: {
          setActivatorNodeRef: (node) => {
            sortable.setActivatorNodeRef(node);
            if (node) moves.handles.set(id, node);
            else moves.handles.delete(id);
          },
          listeners: {
            onMouseDown: listeners && ((event) => listeners.onMouseDown?.(event)),
            onTouchStart: listeners && ((event) => listeners.onTouchStart?.(event)),
          },
          canMoveUp: !disabled && index > 0,
          canMoveDown: !disabled && index < count - 1,
          disabled,
          isDragging: sortable.isDragging,
          moveUp: () => moves.move(id, index - 1),
          moveDown: () => moves.move(id, index + 1),
          consumeClickSuppression: () => moves.consumeClick(id),
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
  busy,
  disabled = false,
}: {
  readonly items: readonly T[];
  readonly getItemId: (item: T) => string;
  readonly renderItem: (props: SortableListRenderItemProps<T>) => ReactNode;
  readonly onReorder: (nextItems: T[]) => void;
  readonly ariaLabel: string;
  readonly busy?: boolean;
  readonly disabled?: boolean;
}) {
  const [announcement, setAnnouncement] = useState("");
  const handles = useRef(new Map<string, HTMLButtonElement>()).current;
  // The row whose drag just ended, and until when its click is swallowed.
  const swallow = useRef<{ id: string; until: number } | null>(null);
  const touch = useRef(false);
  const [liveRegions] = useState(() =>
    typeof document === "undefined" ? undefined : document.createElement("div"),
  );
  const ids = items.map(getItemId);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );
  const focus = (id: string) =>
    requestAnimationFrame(() => handles.get(id)?.focus());

  const move = (id: string, to: number) => {
    const from = ids.indexOf(id);
    if (disabled) return;
    if (from < 0 || to < 0 || to >= items.length || from === to) {
      focus(id);
      return;
    }
    onReorder(arrayMove([...items], from, to));
    setAnnouncement("");
    requestAnimationFrame(() => {
      setAnnouncement(`Moved to position ${to + 1} of ${items.length}`);
      handles.get(id)?.focus();
    });
  };
  const ended = (id: string) => {
    swallow.current = { id, until: Date.now() + (touch.current ? 500 : 50) };
  };
  const consumeClick = (id: string) => {
    const held = swallow.current;
    swallow.current = null;
    return held?.id === id && Date.now() <= held.until;
  };
  const moves = { move, handles, consumeClick };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      accessibility={{
        announcements: SILENT,
        screenReaderInstructions: { draggable: "" },
        container: liveRegions,
      }}
      onDragStart={(event) => {
        touch.current = event.activatorEvent.type.startsWith("touch");
        setAnnouncement("");
      }}
      onDragCancel={(event) => {
        ended(String(event.active.id));
        focus(String(event.active.id));
      }}
      onDragEnd={(event) => {
        const id = String(event.active.id);
        ended(id);
        if (event.over) move(id, ids.indexOf(String(event.over.id)));
        else focus(id);
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ResourceList ariaLabel={ariaLabel} busy={busy}>
          {items.map((item, index) => (
            <Row
              key={ids[index]}
              id={ids[index]!}
              index={index}
              count={items.length}
              disabled={disabled}
              item={item}
              renderItem={renderItem}
              moves={moves}
            />
          ))}
        </ResourceList>
      </SortableContext>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </DndContext>
  );
}
