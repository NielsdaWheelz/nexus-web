import { X } from "lucide-react";
import type { HTMLAttributes } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./Chip.module.css";

/**
 * A chip: a label, optionally removable (its remove control is named
 * `removeLabel`), or, given `onPressedChange`, a real `<button aria-pressed>`.
 */
export default function Chip({
  removable = false,
  removeLabel = "Remove",
  onRemove,
  pressed = false,
  onPressedChange,
  disabled = false,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLElement> & {
  removable?: boolean;
  removeLabel?: string;
  onRemove?: () => void;
  pressed?: boolean;
  onPressedChange?: (pressed: boolean) => void;
  disabled?: boolean;
}) {
  const classes = cx(styles.chip, pressed && styles.selected, className);
  if (onPressedChange) {
    return (
      <button
        {...rest}
        type="button"
        className={cx(classes, styles.pressable)}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={() => onPressedChange(!pressed)}
      >
        {children}
      </button>
    );
  }
  return (
    <div className={classes} {...rest}>
      <span>{children}</span>
      {removable ? (
        <button
          type="button"
          className={styles.remove}
          onClick={onRemove}
          aria-label={removeLabel}
        >
          <X size={12} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
