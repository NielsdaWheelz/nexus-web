"use client";

import { useCallback, useMemo, useRef } from "react";
import {
  FeedbackNotice,
  toFeedback,
} from "@/components/feedback/Feedback";
import { usePaneChromeOverride } from "@/components/workspace/PaneShell";
import { formatLocalDate, isLocalDate, todayLocalDate } from "@/lib/localDate";
import { fetchDailyNotePage } from "@/lib/notes/api";
import {
  usePaneParam,
  usePaneRuntime,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import { useAsyncResource } from "@/lib/useAsyncResource";
import PagePaneBody from "../pages/[pageId]/PagePaneBody";

export default function DailyNotePaneBody() {
  const paneRuntime = usePaneRuntime();
  const paneRuntimeRef = useRef(paneRuntime);
  const routeLocalDate = usePaneParam("localDate");
  const localDate = routeLocalDate ?? todayLocalDate();
  paneRuntimeRef.current = paneRuntime;
  const validLocalDate = isLocalDate(localDate);
  const dailyResource = useAsyncResource({
    cacheKey: validLocalDate ? `daily:${localDate}` : null,
    load: async () => ({
      localDate,
      page: await fetchDailyNotePage(localDate),
    }),
  });

  const openYesterday = useCallback(() => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const href = `/daily/${formatLocalDate(yesterday)}`;
    paneRuntimeRef.current?.openInNewPane(href, "Yesterday");
  }, []);
  const paneOptions = useMemo(
    () => [
      {
        id: "daily-open-yesterday",
        label: "Open yesterday",
        onSelect: openYesterday,
      },
    ],
    [openYesterday]
  );

  const page =
    dailyResource.status === "ready" && dailyResource.data.localDate === localDate
      ? dailyResource.data.page
      : null;
  const hasLoadError = !validLocalDate || dailyResource.status === "error";

  useSetPaneTitle(routeLocalDate ? (hasLoadError ? "Daily note" : null) : "Today");
  usePaneChromeOverride({ options: paneOptions });

  if (!validLocalDate) {
    return <FeedbackNotice severity="error" title="Daily note date must use YYYY-MM-DD." />;
  }
  if (dailyResource.status === "error") {
    return <FeedbackNotice {...toFeedback(dailyResource.error, { fallback: "Daily note could not be loaded." })} />;
  }
  if (!page) return <FeedbackNotice severity="info" title="Loading daily note..." />;
  return <PagePaneBody pageIdOverride={page.id} initialPage={page} />;
}
