import Chip from "@/components/ui/Chip";
import styles from "./AppliedFilters.module.css";

export interface AppliedFilterChip {
  id: string;
  label: string;
}

interface AppliedFiltersProps {
  chips: AppliedFilterChip[];
  onRemove: (id: string) => void;
  onClearAll: () => void;
}

export default function AppliedFilters({
  chips,
  onRemove,
  onClearAll,
}: AppliedFiltersProps) {
  if (chips.length === 0) {
    return null;
  }
  return (
    <div className={styles.bar} role="group" aria-label="Applied filters">
      {chips.map((chip) => (
        <Chip
          key={chip.id}
          size="md"
          removable
          onRemove={() => onRemove(chip.id)}
        >
          {chip.label}
        </Chip>
      ))}
      <button type="button" className={styles.clearAll} onClick={onClearAll}>
        Clear all
      </button>
    </div>
  );
}
