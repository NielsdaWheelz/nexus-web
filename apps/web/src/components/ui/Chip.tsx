import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { X } from "lucide-react";
import styles from "./Chip.module.css";

type ChipSize = "sm" | "md";

interface ChipProps extends HTMLAttributes<HTMLDivElement> {
  size?: ChipSize;
  selected?: boolean;
  removable?: boolean;
  onRemove?: () => void;
  leadingIcon?: ReactNode;
  truncate?: boolean;
}

const sizeClass: Record<ChipSize, string> = {
  sm: styles.sizeSm,
  md: styles.sizeMd,
};

const Chip = forwardRef<HTMLDivElement, ChipProps>(function Chip(
  {
    size = "sm",
    selected = false,
    removable = false,
    onRemove,
    leadingIcon,
    truncate = false,
    className,
    children,
    ...rest
  },
  ref
) {
  const cls = [
    styles.chip,
    sizeClass[size],
    selected ? styles.selected : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const labelCls = [styles.label, truncate ? styles.labelTruncate : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={ref} className={cls} {...rest}>
      {leadingIcon ? (
        <span className={styles.leadingIcon} aria-hidden="true">
          {leadingIcon}
        </span>
      ) : null}
      <span className={labelCls}>{children}</span>
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
export type { ChipProps, ChipSize };
