import type { RefObject } from "react";
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
  chips: AppliedFilterChip[];
  onRemove: (id: string) => void;
  returnFocusTo: RefObject<HTMLElement | null>;
}) {
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
        (
          buttons[index + 1] ??
          buttons[index - 1] ??
          returnFocusTo.current
        )?.focus({ preventScroll: true });
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
