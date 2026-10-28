import { cx } from "@/lib/ui/cx";
import { buttonClassName } from "./control";
import styles from "./Chip.module.css";

/** One native removal target, including its decorative cross. */
export default function Chip({ children, removeLabel, onRemove }: {
  readonly children: string;
  readonly removeLabel: string;
  readonly onRemove: () => void;
}) {
  return (
    <button type="button" className={cx(buttonClassName({}), styles.chip)} aria-label={removeLabel} onClick={onRemove}>
      <span className={styles.label}>{children}</span>
      <span aria-hidden="true">×</span>
    </button>
  );
}
