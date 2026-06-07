import Chip from "@/components/ui/Chip";
import {
  SEARCH_KINDS,
  SEARCH_KIND_LABELS,
  type SearchKind,
} from "@/lib/search/kinds";
import styles from "./KindChips.module.css";

interface KindChipsProps {
  // null ⇒ all kinds active (default); otherwise the explicit active set.
  selected: ReadonlySet<SearchKind> | null;
  disabled: ReadonlySet<SearchKind>;
  disabledReason: string | null;
  onToggle: (kind: SearchKind) => void;
}

export default function KindChips({
  selected,
  disabled,
  disabledReason,
  onToggle,
}: KindChipsProps) {
  const isActive = (kind: SearchKind) => selected === null || selected.has(kind);
  return (
    <div className={styles.row} role="group" aria-label="Result kinds">
      {SEARCH_KINDS.map((kind) => {
        const kindDisabled = disabled.has(kind);
        return (
          <Chip
            key={kind}
            size="md"
            pressed={isActive(kind) && !kindDisabled}
            disabled={kindDisabled}
            onPressedChange={() => onToggle(kind)}
            title={kindDisabled ? (disabledReason ?? undefined) : undefined}
          >
            {SEARCH_KIND_LABELS[kind]}
          </Chip>
        );
      })}
    </div>
  );
}
