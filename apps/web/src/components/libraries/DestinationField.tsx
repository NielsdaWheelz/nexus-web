"use client";

// A destination field on the web: the trigger with its summary, and the
// destination chooser in its surface, reading the api.

import { useRef, useState } from "react";
import ChooserSurface from "@/components/libraries/ChooserSurface";
import DestinationChooser, {
  DestinationTrigger,
  type DestinationSource,
} from "@/components/libraries/DestinationChooser";
import { useThrowLater } from "@/lib/api/serverState";
import { destinationsPage, type LibraryDestination } from "@/lib/libraries/api";
import { libraryErrorFeedback } from "@/lib/libraries/errors";

/** The api as a destination source, its defects thrown at the pane. */
export function useApiDestinations(): DestinationSource {
  const fail = useThrowLater();
  return {
    search: destinationsPage,
    describe: (error, title) => libraryErrorFeedback(error, title, fail),
  };
}

export default function DestinationField({
  label,
  emptyLabel,
  chosen,
  onChange,
  disabled,
  onCreate,
}: {
  readonly label: string;
  readonly emptyLabel: string;
  readonly chosen: readonly LibraryDestination[];
  readonly onChange: (next: readonly LibraryDestination[]) => void;
  readonly disabled: boolean;
  readonly onCreate: ((name: string) => Promise<LibraryDestination>) | null;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const source = useApiDestinations();
  // A creation in flight keeps the chooser open until its library is chosen.
  const create =
    onCreate &&
    (async (name: string) => {
      setCreating(true);
      try {
        return await onCreate(name);
      } finally {
        setCreating(false);
      }
    });
  return (
    <div style={{ minWidth: 0 }}>
      <DestinationTrigger
        ref={trigger}
        label={label}
        emptyLabel={emptyLabel}
        chosen={chosen}
        expanded={open}
        disabled={creating || (disabled && !open)}
        onToggle={() => setOpen((current) => !current)}
        controls={{ kind: "dialog" }}
      />
      <ChooserSurface
        active={open}
        onClose={creating ? null : () => setOpen(false)}
        anchor={() => trigger.current}
        title={label}
      >
        <DestinationChooser
          chosen={chosen}
          onChange={onChange}
          source={source}
          onCreate={create}
          disabled={disabled}
          emptyLabel="No libraries yet. Type a name to create one."
        />
      </ChooserSurface>
    </div>
  );
}
