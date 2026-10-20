import type { ComponentProps } from "react";
import { Ellipsis } from "lucide-react";
import { cx } from "@/lib/ui/cx";
import styles from "./OverflowMenuButton.module.css";

/** context tokens set inline/block minima and border width; interaction stays native. */
export default function OverflowMenuButton({
  children,
  className,
  ...props
}: Omit<ComponentProps<"button">, "type">) {
  return (
    <button {...props} type="button" className={cx(styles.button, className)}>
      {children}
      <Ellipsis size={18} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
