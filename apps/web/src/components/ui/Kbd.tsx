import { forwardRef, type HTMLAttributes } from "react";
import styles from "./Kbd.module.css";

type KbdVariant = "ghost" | "bordered";
type KbdSize = "sm" | "md";

interface KbdProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: KbdVariant;
  size?: KbdSize;
}

const variantClass: Record<KbdVariant, string> = {
  ghost: styles.ghost,
  bordered: styles.bordered,
};

const sizeClass: Record<KbdSize, string> = {
  sm: styles.sizeSm,
  md: styles.sizeMd,
};

const Kbd = forwardRef<HTMLSpanElement, KbdProps>(function Kbd(
  { variant = "ghost", size = "sm", className, children, ...rest },
  ref
) {
  const cls = [styles.kbd, variantClass[variant], sizeClass[size], className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <span ref={ref} className={cls} {...rest}>
      {children}
    </span>
  );
});

export default Kbd;
export type { KbdProps, KbdVariant, KbdSize };
