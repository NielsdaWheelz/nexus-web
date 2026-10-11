import {
  cloneElement,
  isValidElement,
  type ComponentProps,
  type ReactNode,
} from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./Button.module.css";

/**
 * The app's button. `loading` keeps the width, shows a spinner, disables it and
 * sets `aria-busy`. `asChild` styles its one element child (an anchor) instead.
 */
export default function Button({
  variant = "primary",
  size = "md",
  iconOnly = false,
  loading = false,
  leadingIcon,
  asChild = false,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "pill";
  size?: "sm" | "md" | "lg";
  iconOnly?: boolean;
  loading?: boolean;
  leadingIcon?: ReactNode;
  asChild?: boolean;
}) {
  const classes = cx(
    styles.button,
    styles[variant],
    styles[size],
    iconOnly && styles.iconOnly,
    className,
  );
  if (asChild) {
    if (!isValidElement<{ className?: string }>(children))
      throw new Error("Button asChild expects one element child");
    return cloneElement(children, {
      className: cx(classes, children.props.className),
    });
  }
  return (
    <button
      type={type}
      className={cx(classes, loading && styles.loading)}
      disabled={disabled || loading}
      {...rest}
      aria-busy={loading || rest["aria-busy"]}
    >
      {loading ? (
        <span className={styles.spinner} aria-hidden="true" />
      ) : leadingIcon ? (
        <span className={styles.icon}>{leadingIcon}</span>
      ) : null}
      <span className={loading ? styles.hiddenLabel : styles.label}>
        {children}
      </span>
    </button>
  );
}
