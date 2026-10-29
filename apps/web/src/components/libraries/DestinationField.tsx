"use client";

import { useRef, useState } from "react";
import { FeedbackFailure } from "@/components/feedback/Feedback";
import PickerSurface from "@/components/ui/PickerSurface";
import DestinationChooser, { DestinationTrigger, type DestinationChange } from "@/components/libraries/DestinationChooser";
import type { ChooserCreation, ChooserError } from "@/components/libraries/LibraryChooser";
import type { LibraryDestination } from "@/lib/libraries/api";

export default function DestinationField({ context, label, emptyLabel, chosen, onSet, disabled, create, error }: {
  readonly context: string;
  readonly label: string;
  readonly emptyLabel: string;
  readonly chosen: readonly LibraryDestination[];
  readonly onSet: (change: DestinationChange) => boolean;
  readonly disabled: boolean;
  readonly create: ChooserCreation | null;
  readonly error?: ChooserError | null;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <div style={{ minWidth: 0 }}>
    <DestinationTrigger ref={trigger} label={label} emptyLabel={emptyLabel} chosen={chosen}
      expanded={open} disabled={disabled && !open} onToggle={() => setOpen(current => !current)} controls={{ kind: "dialog" }} />
    <PickerSurface active={open} onClose={() => setOpen(false)} anchor={() => trigger.current} title={label}>
      <DestinationChooser context={context} selection={{ kind: "Item", chosen }} onSet={onSet} disabled={disabled}
        create={create} error={error} />
    </PickerSurface>
    {!open && error ? <FeedbackFailure scope="Local" occurrence={error.occurrence} content={error.content} announcement="Assertive"
      actions={error.retry ? [{ label: error.retryLabel ?? "retry", onClick: error.retry, busy: error.busy, commandKey: error.commandKey }] : undefined} /> : null}
  </div>;
}
