"use client";

import ActionButtons from "@/components/resources/ActionButtons";
import type { PodcastActionSubject } from "@/lib/actions/inlineActions";
import { usePodcastActions } from "@/lib/actions/usePodcastActions";

export default function PodcastActions({ subject, density, returnFocus, afterRemoval }: {
  readonly subject: PodcastActionSubject;
  readonly density: "Row" | "Header";
  readonly returnFocus: () => HTMLElement | null;
  readonly afterRemoval: () => HTMLElement | null;
}) {
  const actions = usePodcastActions(subject);
  return <ActionButtons actions={actions} density={density}
    returnFocus={returnFocus} afterRemoval={afterRemoval} />;
}
