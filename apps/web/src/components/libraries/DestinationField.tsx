"use client";

import { useRef, useState } from "react";
import PickerSurface from "@/components/ui/PickerSurface";
import DestinationChooser, { DestinationTrigger, type DestinationChange } from "@/components/libraries/DestinationChooser";
import type { ChooserCreation } from "@/components/libraries/LibraryChooser";

import type { LibraryDestination } from "@/lib/libraries/api";

/** The form owns creation and its mounted holds; this field owns only the picker. */
export default function DestinationField({ context, label, emptyLabel, chosen, onSet, disabled, create }: {
  readonly context: string;
  readonly label: string;
  readonly emptyLabel: string;
  readonly chosen: readonly LibraryDestination[];
  readonly onSet: (change: DestinationChange) => boolean;
  readonly disabled: boolean;
  readonly create: ChooserCreation | null;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const slipContent = useRef<HTMLDivElement>(null);
  return <div style={{ minWidth: 0 }}>
    <DestinationTrigger ref={trigger} label={label} emptyLabel={emptyLabel} chosen={chosen}
      expanded={open} disabled={disabled && !open} onToggle={() => setOpen(current => !current)} controls={{ kind: "dialog" }} />
    <PickerSurface slipContent={slipContent} active={open} onClose={() => setOpen(false)} anchor={() => trigger.current} title={label}>
      <DestinationChooser scrollRef={slipContent} context={context} chosen={chosen} onSet={onSet} disabled={disabled} create={create} />
    </PickerSurface>
  </div>;
}
