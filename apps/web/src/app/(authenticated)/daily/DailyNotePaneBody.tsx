"use client";

import { useEffect, useState } from "react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { usePaneChromeOverride } from "@/components/workspace/PaneShell";
import { formatLocalDate, isLocalDate, todayLocalDate } from "@/lib/localDate";
import { fetchDailyNotePage, type NotePage } from "@/lib/notes/api";
import {
  usePaneParam,
  usePaneRuntime,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import PagePaneBody from "../pages/[pageId]/PagePaneBody";

export default function DailyNotePaneBody() {
  const paneRuntime = usePaneRuntime();
  const routeLocalDate = usePaneParam("localDate");
  const localDate = routeLocalDate ?? todayLocalDate();
  const [page, setPage] = useState<NotePage | null>(null);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const paneOptions = [
    {
      id: "daily-open-yesterday",
      label: "Open yesterday",
      onSelect: () => {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const href = `/daily/${formatLocalDate(yesterday)}`;
        paneRuntime?.openInNewPane(href, "Yesterday");
      },
    },
  ];

  useSetPaneTitle(routeLocalDate ? (feedback ? "Daily note" : null) : "Today");
  usePaneChromeOverride({ options: paneOptions });

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
  return <PagePaneBody pageIdOverride={page.id} initialPage={page} />;
}
