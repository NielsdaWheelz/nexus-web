import type { ComponentProps } from "react";
import { Ellipsis } from "lucide-react";
import { cx } from "@/lib/ui/cx";
import Button from "./Button";
import styles from "./OverflowMenuButton.module.css";

/** The named ellipsis adapter; shared controls own paint, help and busy state. */
export default function OverflowMenuButton({
  className,
  ...props
}: Omit<ComponentProps<"button">, "type" | "children" | "aria-label"> & { "aria-label": string }) {
  return (
    <Button {...props} iconOnly icon={<Ellipsis strokeWidth={1.5} />} className={cx(styles.button, className)} />
  );
}
