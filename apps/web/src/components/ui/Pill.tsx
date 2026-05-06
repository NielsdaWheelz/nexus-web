import { forwardRef, type HTMLAttributes } from "react";
import styles from "./Pill.module.css";

type PillTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "accent"
  | "subtle";
type PillShape = "pill" | "square";
type PillSize = "sm" | "md";

interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone;
  shape?: PillShape;
  size?: PillSize;
  uppercase?: boolean;
}

const toneClass: Record<PillTone, string> = {
  neutral: styles.toneNeutral,
  info: styles.toneInfo,
  success: styles.toneSuccess,
  warning: styles.toneWarning,
  danger: styles.toneDanger,
  accent: styles.toneAccent,
  subtle: styles.toneSubtle,
};

const shapeClass: Record<PillShape, string> = {
  pill: styles.shapePill,
  square: styles.shapeSquare,
};

const sizeClass: Record<PillSize, string> = {
  sm: styles.sizeSm,
  md: styles.sizeMd,
};

const Pill = forwardRef<HTMLSpanElement, PillProps>(function Pill(
  {
    tone = "neutral",
    shape = "pill",
    size = "sm",
    uppercase = true,
    className,
    children,
    ...rest
  },
  ref
) {
  const cls = [
    styles.pill,
    toneClass[tone],
    shapeClass[shape],
    sizeClass[size],
    uppercase ? styles.uppercase : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span ref={ref} className={cls} {...rest}>
      {children}
    </span>
  );
});

export default Pill;
export type { PillProps, PillTone, PillShape, PillSize };
