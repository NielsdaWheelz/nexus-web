import { forwardRef, type HTMLAttributes } from "react";
import styles from "./Pill.module.css";

export type PillTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "accent";
type PillSize = "xs" | "sm";

interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone;
  size?: PillSize;
}

const toneClass: Record<PillTone, string> = {
  neutral: styles.toneNeutral,
  info: styles.toneInfo,
  success: styles.toneSuccess,
  warning: styles.toneWarning,
  danger: styles.toneDanger,
  accent: styles.toneAccent,
};

const sizeClass: Record<PillSize, string> = {
  xs: styles.sizeXs,
  sm: styles.sizeSm,
};

const Pill = forwardRef<HTMLSpanElement, PillProps>(function Pill(
  {
    tone = "neutral",
    size = "sm",
    className,
    children,
    ...rest
  },
  ref
) {
  const cls = [
    styles.pill,
    toneClass[tone],
    sizeClass[size],
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span ref={ref} className={cls} {...rest}>
      <span className={styles.label}>{children}</span>
    </span>
  );
});

export default Pill;
