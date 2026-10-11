import type { ComponentProps } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./Field.module.css";

/** A text input; `bare` leaves the surface (background, border, padding) to the caller. */
export default function Input({
  bare = false,
  size = "md",
  className,
  type = "text",
  ...rest
}: Omit<ComponentProps<"input">, "size"> & {
  bare?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <input
      type={type}
      className={cx(
        styles.field,
        styles.input,
        styles[size],
        bare ? styles.bare : styles.boxed,
        className,
      )}
      {...rest}
    />
  );
}
