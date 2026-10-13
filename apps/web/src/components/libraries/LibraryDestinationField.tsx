"use client";

import { useRef, useState } from "react";
import LibraryDestinationPicker from "@/components/libraries/LibraryDestinationPicker";
import LibraryDestinationTrigger from "@/components/libraries/LibraryDestinationTrigger";
import type { LibraryDestinationSelection } from "@/lib/libraries/destinationContract";
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
}

/**
 * The compact destination field: the shared trigger + summary, which never
 * expand in place, and
 * the anchored picker. It owns `open` and always mounts the picker adapter (so
 * query/results survive close). An in-flight create is the only dismissal lock.
 */
export default function LibraryDestinationField({
  label,
  emptyLabel,
  selected,
  onChange,
  interaction,
  onCreateDestination,
}: LibraryDestinationFieldProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const creating = interaction.kind === "Creating";

  return (
    <div className={styles.root}>
      <LibraryDestinationTrigger
        ref={triggerRef}
        label={label}
        accessibleLabel={label}
        emptyLabel={emptyLabel}
        selected={selected}
        expanded={open}
        disabled={creating || (interaction.kind === "Disabled" && !open)}
        onToggle={() => setOpen((current) => !current)}
        discloses={{ kind: "dialog" }}
      />
      <LibraryDestinationPicker
        open={open}
        presentation="Responsive"
        onClose={() => {
          if (!creating) setOpen(false);
        }}
        anchor={() => triggerRef.current}
        title={label}
        selectedGroupLabel="Selected"
        selection={{ kind: "Item", selected, onChange }}
        interaction={interaction}
        onCreateDestination={onCreateDestination}
      />
    </div>
  );
}
