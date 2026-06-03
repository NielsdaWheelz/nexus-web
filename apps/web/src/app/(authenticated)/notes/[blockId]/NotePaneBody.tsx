"use client";

import { FeedbackNotice, toFeedback } from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { noteBlockResource } from "@/lib/api/resource";
import { fetchNoteBlock } from "@/lib/notes/api";
import { usePaneParam, useSetPaneTitle } from "@/lib/panes/paneRuntime";
import { useResource } from "@/lib/api/useResource";
import PagePaneBody from "../../pages/[pageId]/PagePaneBody";

export default function NotePaneBody() {
  const blockId = usePaneParam("blockId");
  if (!blockId) throw new Error("note route requires a block id");

  const blockResource = useResource<
    { blockId: string; pageId: string },
    { blockId: string }
  >({
    descriptor: noteBlockResource,
    params: { blockId },
    load: async (params) => {
      const block = await fetchNoteBlock(params.blockId);
      return { blockId: params.blockId, pageId: block.pageId };
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
  if (!pageId) return <PaneLoadingState />;
  return <PagePaneBody pageIdOverride={pageId} focusBlockId={blockId} />;
}
