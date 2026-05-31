"use client";

import { FeedbackNotice, toFeedback } from "@/components/feedback/Feedback";
import { fetchNoteBlock } from "@/lib/notes/api";
import { usePaneParam, useSetPaneTitle } from "@/lib/panes/paneRuntime";
import { useAsyncResource } from "@/lib/useAsyncResource";
import PagePaneBody from "../../pages/[pageId]/PagePaneBody";

export default function NotePaneBody() {
  const blockId = usePaneParam("blockId");
  if (!blockId) throw new Error("note route requires a block id");

  const blockResource = useAsyncResource<{ blockId: string; pageId: string }>({
    cacheKey: `note-block:${blockId}`,
    load: async () => {
      const block = await fetchNoteBlock(blockId);
      return { blockId, pageId: block.pageId };
    },
  });
  const pageId =
    blockResource.status === "ready" && blockResource.data.blockId === blockId
      ? blockResource.data.pageId
      : null;
  const feedback =
    blockResource.status === "error"
      ? toFeedback(blockResource.error, { fallback: "Note could not be loaded." })
      : null;

  useSetPaneTitle(feedback ? "Note" : null);

  if (feedback) return <FeedbackNotice {...feedback} />;
  if (!pageId) return <FeedbackNotice severity="info" title="Loading note..." />;
  return <PagePaneBody pageIdOverride={pageId} focusBlockId={blockId} />;
}
