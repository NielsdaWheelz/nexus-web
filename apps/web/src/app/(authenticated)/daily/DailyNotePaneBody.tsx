"use client";

import { useEffect, useState } from "react";
import { FeedbackNotice, toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import { fetchDailyNotePage, isLocalDate, todayLocalDate, type NotePage } from "@/lib/notes/api";
import { usePaneParam, useSetPaneTitle } from "@/lib/panes/paneRuntime";
import PagePaneBody from "../pages/[pageId]/PagePaneBody";

export default function DailyNotePaneBody() {
  const routeLocalDate = usePaneParam("localDate");
  const localDate = routeLocalDate ?? todayLocalDate();
  const [page, setPage] = useState<NotePage | null>(null);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);

  useSetPaneTitle(routeLocalDate ? "Daily note" : "Today");

  useEffect(() => {
    let cancelled = false;
    setPage(null);
    setFeedback(null);
    if (!isLocalDate(localDate)) {
      setFeedback({
        severity: "error",
        title: "Daily note date must use YYYY-MM-DD.",
      });
      return () => {
        cancelled = true;
      };
    }
    fetchDailyNotePage(localDate)
      .then((dailyPage) => {
        if (!cancelled) setPage(dailyPage);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setFeedback(toFeedback(error, { fallback: "Daily note could not be loaded." }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [localDate]);

  if (feedback) return <FeedbackNotice {...feedback} />;
  if (!page) return <FeedbackNotice severity="info" title="Loading daily note..." />;
  return <PagePaneBody pageIdOverride={page.id} />;
}
