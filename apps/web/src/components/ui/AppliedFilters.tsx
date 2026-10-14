import { useLayoutEffect, useRef, type RefObject } from "react";
import Chip from "./Chip";
import styles from "./AppliedFilters.module.css";

export interface AppliedFilterChip {
  id: string;
  label: string;
}

/** Removable filter chips; removing one moves focus to its neighbour, then to `returnFocusTo`. */
export default function AppliedFilters({
  chips,
  onRemove,
  returnFocusTo,
}: {
  chips: readonly AppliedFilterChip[];
  onRemove: (id: string) => void;
  returnFocusTo: RefObject<HTMLElement | null>;
}) {
  const pendingFocus = useRef<{
    removed: HTMLButtonElement;
    focused: HTMLElement | null;
    neighbours: HTMLButtonElement[];
  } | null>(null);

  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || pending.removed.isConnected) return;
    pendingFocus.current = null;
    if (
      pending.focused?.isConnected ||
      document.activeElement !== document.body
    ) {
      return;
    }
    // Removing one constraint can also remove its dependent neighbours.
    (
      pending.neighbours.find((button) => button.isConnected) ??
      returnFocusTo.current
    )?.focus({ preventScroll: true });
  }, [chips, returnFocusTo]);

  if (chips.length === 0) return null;
  return (
    <div
      className={styles.bar}
      role="group"
      aria-label="Applied filters"
      onClickCapture={(event) => {
        const button =
          event.target instanceof Element
            ? event.target.closest("button")
            : null;
        if (!button) return;
        const buttons = [...event.currentTarget.querySelectorAll("button")];
        const index = buttons.indexOf(button);
        const neighbours = [
          ...buttons.slice(index + 1),
          ...buttons.slice(0, index).reverse(),
        ];
        const focused = neighbours[0] ?? returnFocusTo.current;
        pendingFocus.current = { removed: button, focused, neighbours };
        focused?.focus({ preventScroll: true });
      }}
    >
      {chips.map((chip) => (
        <Chip
          key={chip.id}
          className={styles.chip}
          removable
          removeLabel={`Remove filter: ${chip.label}`}
          onRemove={() => onRemove(chip.id)}
        >
          {chip.label}
        </Chip>
      ))}
    </div>
  );
}
