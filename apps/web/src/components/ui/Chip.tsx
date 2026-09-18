import { forwardRef, type HTMLAttributes, type Ref } from "react";
import { X } from "lucide-react";
import styles from "./Chip.module.css";

type ChipSize = "sm" | "md";

interface ChipProps extends HTMLAttributes<HTMLElement> {
  size?: ChipSize;
  removable?: boolean;
  /** What the remove control is called, so it reads outside its chip. */
  removeLabel?: string;
  onRemove?: () => void;
  // Pressable toggle mode: when onPressedChange is given the chip renders a real
  // <button aria-pressed> (multi-select toggle semantics) instead of a <div>.
  pressed?: boolean;
  onPressedChange?: (pressed: boolean) => void;
  disabled?: boolean;
}

const sizeClass: Record<ChipSize, string> = {
  sm: styles.sizeSm,
  md: styles.sizeMd,
};

const Chip = forwardRef<HTMLButtonElement | HTMLDivElement, ChipProps>(function Chip(
  {
    size = "sm",
    removable = false,
    removeLabel = "Remove",
    onRemove,
    pressed,
    onPressedChange,
    disabled = false,
    className,
    children,
    ...rest
  },
  ref
) {
  const isPressable = typeof onPressedChange === "function";
  const cls = [
    styles.chip,
    sizeClass[size],
    pressed ? styles.selected : "",
    isPressable ? styles.pressable : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const body = <span className={styles.label}>{children}</span>;

  if (isPressable) {
    return (
      <button
        {...rest}
        ref={ref as Ref<HTMLButtonElement>}
        type="button"
        className={cls}
        aria-pressed={pressed ?? false}
        disabled={disabled}
        onClick={() => onPressedChange?.(!(pressed ?? false))}
      >
        {body}
      </button>
    );
  }

  return (
    <div ref={ref as Ref<HTMLDivElement>} className={cls} {...rest}>
      {body}
      {removable ? (
        <button
          type="button"
          className={styles.removeButton}
          onClick={onRemove}
          aria-label={removeLabel}
        >
          <X size={12} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
});

export default Chip;
