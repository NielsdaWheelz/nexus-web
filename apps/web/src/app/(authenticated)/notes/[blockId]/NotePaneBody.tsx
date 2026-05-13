"use client";

import { useEffect, useState } from "react";
import { FeedbackNotice, toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import { fetchNoteBlock } from "@/lib/notes/api";
import { usePaneParam } from "@/lib/panes/paneRuntime";
import PagePaneBody from "../../pages/[pageId]/PagePaneBody";

export default function NotePaneBody() {
  const blockId = usePaneParam("blockId");
  if (!blockId) throw new Error("note route requires a block id");

  const [pageId, setPageId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchNoteBlock(blockId)
      .then((block) => {
        if (!cancelled) setPageId(block.pageId);
      })
      .catch((error: unknown) => {
        if (!cancelled) setFeedback(toFeedback(error, { fallback: "Note could not be loaded." }));
      });
    return () => {
      cancelled = true;
    };
  }, [blockId]);

  if (feedback) return <FeedbackNotice {...feedback} />;
  if (!pageId) return <FeedbackNotice severity="info" title="Loading note..." />;
  return <PagePaneBody pageIdOverride={pageId} focusBlockId={blockId} />;
}
