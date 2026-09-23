"use client";

import { forwardRef } from "react";
import { ChevronDown } from "lucide-react";
import type { LibraryDestinationSelection } from "@/lib/libraries/destinationContract";
import styles from "./LibraryDestinationTrigger.module.css";

export interface LibraryDestinationTriggerProps {
  label: string;
  /** Caller-owned collapsed empty summary. Required; there is no shared default. */
  emptyLabel: string;
  selected: readonly LibraryDestinationSelection[];
  expanded: boolean;
  disabled: boolean;
  onToggle: () => void;
  /** What the trigger opens: a chooser dialog surface, or an inline region by id. */
  discloses: { kind: "dialog" } | { kind: "region"; id: string };
}

/**
 * The collapsed destination summary and the button that opens its chooser.
 * It stays in normal layout, owns no open state and no chooser: the web field
 * pairs it with the anchored picker, the extension popup with an inline chooser.
 */
const LibraryDestinationTrigger = forwardRef<
  HTMLButtonElement,
  LibraryDestinationTriggerProps
>(function LibraryDestinationTrigger(
  { label, emptyLabel, selected, expanded, disabled, onToggle, discloses },
  ref,
) {
  const names = selected
    .map((destination) => destination.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const summary =
    names.length === 0
      ? emptyLabel
      : names.length <= 2
        ? names.join(", ")
        : `${names[0]}, ${names[1]} +${names.length - 2}`;

  return (
    <button
      ref={ref}
      type="button"
      className={styles.trigger}
      aria-expanded={expanded}
      aria-haspopup={discloses.kind === "dialog" ? "dialog" : undefined}
      aria-controls={discloses.kind === "region" ? discloses.id : undefined}
      aria-label={`${label}: ${names.length === 0 ? emptyLabel : names.join(", ")}`}
      disabled={disabled}
      onClick={onToggle}
    >
      <span className={styles.label}>{label}</span>
      <span className={styles.summary}>{summary}</span>
      <ChevronDown size={15} aria-hidden="true" data-open={expanded || undefined} />
    </button>
  );
});

export default LibraryDestinationTrigger;
