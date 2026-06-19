"use client";

import Pill from "@/components/ui/Pill";
import type { CollectionRowView } from "@/lib/collections/types";

/** Derived read/listen state as a calm badge. */
export default function ReadStateBadge({
  consumption,
}: {
  consumption: NonNullable<CollectionRowView["consumption"]>;
}) {
  switch (consumption.status) {
    case "unread":
      return <Pill tone="neutral">Unread</Pill>;
    case "in_progress":
      return (
        <Pill tone="info">
          {consumption.fraction !== undefined
            ? `${Math.round(consumption.fraction * 100)}%`
            : "Reading"}
        </Pill>
      );
    case "finished":
      return <Pill tone="subtle">Finished</Pill>;
    default: {
      const exhaustive: never = consumption.status;
      return exhaustive;
    }
  }
}
