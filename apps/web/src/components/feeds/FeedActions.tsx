"use client";

import ActionButtons from "@/components/resources/ActionButtons";
import type { FeedActionSubject } from "@/lib/actions/inlineActions";
import { useFeedActions } from "@/lib/actions/useFeedActions";

export default function FeedActions({ subject, density, returnFocus, afterRemoval }: {
  readonly subject: FeedActionSubject;
  readonly density: "Row" | "Header";
  readonly returnFocus: () => HTMLElement | null;
  readonly afterRemoval: () => HTMLElement | null;
}) {
  const actions = useFeedActions(subject);
  return <ActionButtons actions={actions} density={density}
    returnFocus={returnFocus} afterRemoval={afterRemoval} />;
}
