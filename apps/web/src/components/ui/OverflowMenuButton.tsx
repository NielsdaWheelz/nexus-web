import type { ComponentProps } from "react";
import { Ellipsis, LoaderCircle } from "lucide-react";
import { cx } from "@/lib/ui/cx";
import styles from "./OverflowMenuButton.module.css";

/** A quiet overflow glyph; busy paint occupies the same slot and keeps its name. */
export default function OverflowMenuButton({
  children,
  className,
  ...props
}: Omit<ComponentProps<"button">, "type">) {
  return (
    <button {...props} type="button" className={cx(styles.button, className)}>
      {children}
      {props["aria-busy"] === true || props["aria-busy"] === "true"
        ? <LoaderCircle size={16} strokeWidth={1.5} aria-hidden="true" className={styles.busy} />
        : <Ellipsis size={16} strokeWidth={1.5} aria-hidden="true" />}
    </button>
  );
}
