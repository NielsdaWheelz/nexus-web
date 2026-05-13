import { forwardRef, type HTMLAttributes } from "react";
import styles from "./Spinner.module.css";

type SpinnerSize = "sm" | "md" | "lg";

interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  size?: SpinnerSize;
}

const sizeClass: Record<SpinnerSize, string> = {
  sm: styles.sizeSm,
  md: styles.sizeMd,
  lg: styles.sizeLg,
};

const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(
  { size = "md", className, role = "status", ...rest },
  ref
) {
  const cls = [styles.spinner, sizeClass[size], className ?? ""]
    .filter(Boolean)
    .join(" ");

  return <span ref={ref} className={cls} role={role} aria-label="Loading" {...rest} />;
});

export default Spinner;
export type { SpinnerProps, SpinnerSize };
