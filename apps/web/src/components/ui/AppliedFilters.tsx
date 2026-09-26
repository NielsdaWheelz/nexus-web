import { useRef, type RefObject } from "react";
import Chip from "@/components/ui/Chip";
import styles from "./AppliedFilters.module.css";

export interface AppliedFilterChip {
  id: string;
  label: string;
}

interface AppliedFiltersProps {
  chips: AppliedFilterChip[];
  onRemove: (id: string) => void;
  returnFocusTo: RefObject<HTMLElement | null>;
}

export default function AppliedFilters({
  chips,
  onRemove,
  returnFocusTo,
}: AppliedFiltersProps) {
  const barRef = useRef<HTMLDivElement>(null);
  if (chips.length === 0) {
    return null;
  }
  return (
    <div
      ref={barRef}
      className={styles.bar}
      role="group"
      aria-label="Applied filters"
      onClickCapture={(event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest("button");
        const bar = barRef.current;
        if (!button || !bar?.contains(button)) return;
        const buttons = Array.from(bar.querySelectorAll<HTMLButtonElement>("button"));
        const index = buttons.indexOf(button);
        (buttons[index + 1] ?? buttons[index - 1] ?? returnFocusTo.current)
          ?.focus({ preventScroll: true });
      }}
    >
      {chips.map((chip) => (
        <Chip
          key={chip.id}
          size="md"
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
