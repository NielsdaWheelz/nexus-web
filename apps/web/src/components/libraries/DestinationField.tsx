"use client";

import { useRef, useState } from "react";
import { Hold, useResendFeedback } from "@/components/feedback/Feedback";
import PickerSurface from "@/components/ui/PickerSurface";
import DestinationChooser, { DestinationTrigger, type DestinationChange } from "@/components/libraries/DestinationChooser";
import type { ChooserCreation, ChooserError } from "@/components/libraries/LibraryChooser";

import type { LibraryDestination } from "@/lib/libraries/api";

/** A destination picker behind its trigger. `error` is a form's unknown creation, restated by
 * `useDestinationCreation` for a form that does not render its `holds` yet; it holds here, picker
 * open or closed, and leaves with that form's `holds`. */
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
  const slipContent = useRef<HTMLDivElement>(null);
  const resendFeedback = useResendFeedback();
  const holdId = error?.commandKey ?? "library-creation";
  return <div style={{ minWidth: 0 }}>
    <DestinationTrigger ref={trigger} label={label} emptyLabel={emptyLabel} chosen={chosen}
      expanded={open} disabled={disabled && !open} onToggle={() => setOpen(current => !current)} controls={{ kind: "dialog" }} />
    <PickerSurface slipContent={slipContent} active={open} onClose={() => setOpen(false)} anchor={() => trigger.current} title={label}>
      <DestinationChooser scrollRef={slipContent} context={context} selection={{ kind: "Item", chosen }} onSet={onSet} disabled={disabled} create={create} />
    </PickerSurface>
    {error ? <Hold id={holdId} attempt={error.attempt} {...resendFeedback({ line: { fact: error.content.title, reason: error.content.message },
      resend: error.retry ? { label: "retry", commandKey: holdId, run: error.retry, busy: error.busy } : null })} /> : null}
  </div>;
}
