"use client";

import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { FeedbackBusy } from "@/components/feedback/Feedback";

/** Cold reads occupy the host's existing control slot; the unfinished body stays sparse. */
export function PaneLoadingState() {
  const pane = usePaneRuntime();
  return <FeedbackBusy pending subject={pane?.visitId} />;
}
