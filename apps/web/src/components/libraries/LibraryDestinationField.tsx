"use client";

import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import LibraryDestinationPicker from "@/components/libraries/LibraryDestinationPicker";
import type { LibraryDestinationSelection } from "@/lib/libraries/client";
import styles from "./LibraryDestinationField.module.css";

export interface LibraryDestinationFieldProps {
  label: string;
  /** Caller-owned collapsed empty summary. Required; there is no shared default. */
  emptyLabel: string;
  selected: readonly LibraryDestinationSelection[];
  onChange: (next: readonly LibraryDestinationSelection[]) => void;
  interaction:
    | { kind: "Enabled" }
    | { kind: "Disabled" }
    | { kind: "Creating" };
  onCreateDestination: (name: string) => Promise<LibraryDestinationSelection>;
  layer: "modal" | "palette";
}

function sortedNames(
  selected: readonly LibraryDestinationSelection[],
): string[] {
  return selected
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function collapsedSummary(names: readonly string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]}, ${names[1]}`;
  return `${names[0]}, ${names[1]} +${names.length - 2}`;
}

/**
 * The compact destination field (docs/cutovers/library-chooser-interaction-hard-
 * cutover.md §4): a trigger + summary that stay in normal layout and never expand
 * in place. It owns `open` and always mounts the picker adapter (so query/results
 * survive close). An in-flight create is the only dismissal lock.
 */
export default function LibraryDestinationField({
  label,
  emptyLabel,
  selected,
  onChange,
  interaction,
  onCreateDestination,
  layer,
}: LibraryDestinationFieldProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const creating = interaction.kind === "Creating";
  const names = sortedNames(selected);
  const summary = selected.length === 0 ? emptyLabel : collapsedSummary(names);
  const accessibleName =
    selected.length === 0
      ? `${label}: ${emptyLabel}`
      : `${label}: ${names.join(", ")}`;

  return (
    <div className={styles.root}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={accessibleName}
        disabled={interaction.kind === "Disabled" && !open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.label}>{label}</span>
        <span className={styles.summary}>{summary}</span>
        <ChevronDown size={15} aria-hidden="true" data-open={open || undefined} />
      </button>
      <LibraryDestinationPicker
        open={open}
        onClose={() => {
          if (!creating) setOpen(false);
        }}
        anchor={() => triggerRef.current}
        layer={layer}
        title={label}
        selectedGroupLabel="Selected"
        selected={selected}
        onChange={onChange}
        interaction={interaction}
        onCreateDestination={onCreateDestination}
      />
    </div>
  );
}
