"use client";

import { useRef, useState } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import PickerSurface from "@/components/ui/PickerSurface";
import DestinationChooser, { DestinationTrigger, type DestinationChange } from "@/components/libraries/DestinationChooser";
import type { ChooserCreation, ChooserError } from "@/components/libraries/LibraryChooser";
import type { LibraryDestination } from "@/lib/libraries/api";
import styles from "./DestinationChooser.module.css";

export default function DestinationField({ label, emptyLabel, chosen, onSet, disabled, create, error, status }: {
  readonly label: string;
  readonly emptyLabel: string;
  readonly chosen: readonly LibraryDestination[];
  readonly onSet: (change: DestinationChange) => boolean;
  readonly disabled: boolean;
  readonly create: ChooserCreation | null;
  readonly error?: ChooserError | null;
  readonly status?: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <div style={{ minWidth: 0 }}>
    <DestinationTrigger ref={trigger} label={label} emptyLabel={emptyLabel} chosen={chosen}
      expanded={open} disabled={disabled && !open} onToggle={() => setOpen(current => !current)} controls={{ kind: "dialog" }} />
    <PickerSurface active={open} onClose={() => setOpen(false)} anchor={() => trigger.current} title={label}>
      <DestinationChooser selection={{ kind: "Item", chosen }} onSet={onSet} disabled={disabled}
        create={create} error={error} status={status} />
    </PickerSurface>
    {!open && status ? <p className={styles.status} role="status">{status}</p> : null}
    {!open && error ? <FeedbackNotice content={error.content} announcement="Assertive"
      actions={error.retry ? [{ label: "retry", onClick: error.retry }] : undefined} /> : null}
  </div>;
}
