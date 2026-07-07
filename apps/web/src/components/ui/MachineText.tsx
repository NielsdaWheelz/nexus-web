"use client";

import type { HTMLAttributes } from "react";
import styles from "./MachineText.module.css";

export interface MachineOrigin {
  /**
   * Honest origin label for the small-caps signature (e.g. "Assistant",
   * "Synapse", "Dossier"). MUST derive from the surface's own provenance
   * (message.role, edge.origin, model attribution) — never a literal invented
   * in the component. Also stamped onto `data-machine-origin` for the gate.
   */
  label: string;
}

/**
 * Signature time travels as a pair — both fields or neither (D-9). A discriminated
 * union so a call site can't construct a bare `timestamp` (which would render an
 * HTML-invalid `<time>` with no `datetime`) at the type level.
 */
export type MachineSignatureTime =
  /** Signed with a time: ALREADY-FORMATTED display string ("06:14") + the ISO instant backing `<time datetime>`. */
  | { timestamp: string; timestampIso: string }
  /** No honest time — no `<time>` is rendered. */
  | { timestamp?: null; timestampIso?: null };

export type MachineTextProps = HTMLAttributes<HTMLElement> & {
  origin: MachineOrigin;
  variant?: "block" | "inline";
  showSignature?: boolean;
  as?: "div" | "section" | "span";
} & MachineSignatureTime;

/**
 * MachineText — the sole owner of the machine-voice typographic register: the
 * machine face, a cooler ink, the hairline apparatus rail, and the small-caps
 * origin signature. Every machine-voice surface composes it; the machine tokens
 * are referenced ONLY through MachineText.module.css.
 */
export default function MachineText({
  origin,
  timestamp,
  timestampIso,
  variant = "block",
  showSignature = true,
  as,
  className,
  children,
  ...rest
}: MachineTextProps) {
  const isInline = variant === "inline";
  const Tag = as ?? (isInline ? "span" : "div");
  const classes = [styles.machine, isInline ? styles.inline : styles.block, className]
    .filter(Boolean)
    .join(" ");

  return (
    <Tag className={classes} data-machine-origin={origin.label} {...rest}>
      {!isInline && showSignature ? (
        <MachineSignature
          label={origin.label}
          timestamp={timestamp}
          timestampIso={timestampIso}
        />
      ) : null}
      {children}
    </Tag>
  );
}

function MachineSignature({
  label,
  timestamp,
  timestampIso,
}: {
  label: string;
  timestamp?: string | null;
  timestampIso?: string | null;
}) {
  return (
    <div className={styles.signature}>
      <span className={styles.origin}>{label}</span>
      {timestamp ? (
        <time className={styles.time} dateTime={timestampIso ?? undefined}>
          {`· ${timestamp}`}
        </time>
      ) : null}
    </div>
  );
}
