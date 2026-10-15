"use client";

import { useRef, useState } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import LibraryDestinationPicker from "@/components/libraries/LibraryDestinationPicker";
import LibraryDestinationTrigger from "@/components/libraries/LibraryDestinationTrigger";
import type { LibraryChooserAdmission, LibraryChooserError } from "@/components/libraries/LibraryChooser";
import type { DestinationChange } from "@/components/libraries/LibraryDestinationPicker";
import type { LibraryDestinationSelection } from "@/lib/libraries/destinationContract";
import styles from "./LibraryDestinationField.module.css";

export interface LibraryDestinationFieldProps {
  label: string;
  /** Caller-owned collapsed empty summary. Required; there is no shared default. */
  emptyLabel: string;
  selected: readonly LibraryDestinationSelection[];
  onSet: (change: DestinationChange) => LibraryChooserAdmission;
  interaction: { kind: "Enabled" } | { kind: "Disabled" };
  onCreateDestination: (name: string) => LibraryChooserAdmission;
  pendingCreateNames: readonly string[];
  error?: LibraryChooserError | null;
  status?: string;
}

/**
 * The compact destination field: the shared trigger + summary, which never
 * expand in place, and
 * the anchored picker. The form owns edits and creation; the field owns only
 * disclosure. Closing resets query while the adapter retains its catalog.
 */
export default function LibraryDestinationField({
  label,
  emptyLabel,
  selected,
  onSet,
  interaction,
  onCreateDestination,
  pendingCreateNames,
  error,
  status,
}: LibraryDestinationFieldProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <div className={styles.root}>
      <LibraryDestinationTrigger
        ref={triggerRef}
        label={label}
        accessibleLabel={label}
        emptyLabel={emptyLabel}
        selected={selected}
        expanded={open}
        disabled={interaction.kind === "Disabled" && !open}
        onToggle={() => setOpen((current) => !current)}
        discloses={{ kind: "dialog" }}
      />
      <LibraryDestinationPicker
        open={open}
        presentation="Responsive"
        onClose={() => setOpen(false)}
        anchor={() => triggerRef.current}
        title={label}
        selection={{ kind: "Item", selected, onSet }}
        interaction={interaction}
        onCreateDestination={onCreateDestination}
        pendingCreateNames={pendingCreateNames}
        error={error}
        status={status}
      />
      {!open && status ? <p className={styles.status} role="status">{status}</p> : null}
      {!open && error ? <FeedbackNotice content={error.content} announcement="Assertive"
        actions={error.onRetry ? [{ label: "retry", onClick: error.onRetry }] : undefined} /> : null}
    </div>
  );
}
