"use client";

// Upload callers retain a thin mutation adapter. Inline reference inputs own
// discovery; all link mutations are sent by the tab's shared write queue.
import { useFeedback } from "@/components/feedback/Feedback";
import { createRandomId } from "@/lib/createRandomId";
import { createLink, type InsertionSource, type LinkTarget } from "./links";
export function useLinkComposer() {
  const feedback = useFeedback();
  return {
    async linkTo(input: {
      source: InsertionSource;
      target: LinkTarget;
      onLinked?: () => void;
    }) {
      const result = await createLink({
        link_id: createRandomId(),
        source: input.source,
        target: input.target,
        position: null,
      });
      feedback.receipt({
        tone: result.created ? "Success" : "Info",
        title: result.created ? "linked" : "already linked",
      });
      input.onLinked?.();
    },
  };
}
