import type { HTMLAttributes } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./MachineText.module.css";

/**
 * The machine voice: the machine face, a cooler ink, the apparatus rail and a
 * small-caps signature naming the text's origin. The origin label must come from
 * the surface's own provenance (message role, edge origin, model), never a literal
 * invented here. A signature time is both fields or neither, so `<time>` always has
 * its `datetime`.
 */
export default function MachineText({
  origin,
  timestamp,
  timestampIso,
  variant = "block",
  as,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLElement> & {
  origin: { label: string };
  variant?: "block" | "inline";
  as?: "div" | "section" | "span";
} & (
    | { timestamp: string; timestampIso: string }
    | { timestamp?: null; timestampIso?: null }
  )) {
  const inline = variant === "inline";
  const Tag = as ?? (inline ? "span" : "div");
  return (
    <Tag
      className={cx(styles.machine, !inline && styles.block, className)}
      {...rest}
    >
      {inline ? null : (
        <div className={styles.signature}>
          <span className={styles.origin}>{origin.label}</span>
          {timestamp ? (
            <time className={styles.time} dateTime={timestampIso}>
              {`· ${timestamp}`}
            </time>
          ) : null}
        </div>
      )}
      {children}
    </Tag>
  );
}
