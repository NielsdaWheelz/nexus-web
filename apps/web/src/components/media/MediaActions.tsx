"use client";

import ActionButtons from "@/components/resources/ActionButtons";
import { useMediaActions } from "@/lib/actions/useMediaActions";
import type { MediaSubject } from "@/lib/media/mediaSummary";
import type { PlayerDescriptor } from "@/lib/player/playerRuntime";

/** Media execution belongs to the account runtime. */
export default function MediaActions({ subject, knownDescriptor, density, returnFocus, afterRemoval = returnFocus }: {
  readonly subject: MediaSubject;
  readonly knownDescriptor: PlayerDescriptor | null;
  readonly density: "Row" | "Header";
  readonly returnFocus: () => HTMLElement | null;
  readonly afterRemoval?: () => HTMLElement | null;
}) {
  const actions = useMediaActions(subject, knownDescriptor);
  return <ActionButtons actions={actions} density={density} returnFocus={returnFocus} afterRemoval={afterRemoval} />;
}
