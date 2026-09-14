import { forwardRef, type HTMLAttributes, type ReactNode, type Ref } from "react";
import { X } from "lucide-react";
import styles from "./Chip.module.css";

type ChipSize = "sm" | "md";

interface ChipProps extends HTMLAttributes<HTMLElement> {
  size?: ChipSize;
  selected?: boolean;
  removable?: boolean;
  onRemove?: () => void;
  leadingIcon?: ReactNode;
  truncate?: boolean;
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
    selected = false,
    removable = false,
    onRemove,
    leadingIcon,
    truncate = false,
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
    selected || pressed ? styles.selected : "",
    isPressable ? styles.pressable : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const labelCls = [styles.label, truncate ? styles.labelTruncate : ""]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      {leadingIcon ? (
        <span className={styles.leadingIcon} aria-hidden="true">
          {leadingIcon}
        </span>
      ) : null}
      <span className={labelCls}>{children}</span>
    </>
  );

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
          aria-label="Remove"
        >
          <X size={12} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
});

export default Chip;
