"use client";

import { useCallback, useMemo, useRef } from "react";
import {
  FeedbackNotice,
  toFeedback,
} from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { usePaneChromeOverride } from "@/components/workspace/PaneShell";
import { isLocalDate, shiftLocalDate } from "@/lib/localDate";
import { fetchDailyNotePage } from "@/lib/notes/api";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import {
  usePaneParam,
  usePaneRuntime,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import { useResource } from "@/lib/api/useResource";
import PagePaneBody from "../pages/[pageId]/PagePaneBody";

export default function DailyNotePaneBody() {
  const { currentLocalDate } = useRenderEnvironment();
  const paneRuntime = usePaneRuntime();
  const paneRuntimeRef = useRef(paneRuntime);
  const routeLocalDate = usePaneParam("localDate");
  const localDate = routeLocalDate ?? currentLocalDate;
  paneRuntimeRef.current = paneRuntime;
  const validLocalDate = isLocalDate(localDate);
  const dailyResource = useResource({
    cacheKey: validLocalDate ? `daily:${localDate}` : null,
    load: async () => ({
      localDate,
      page: await fetchDailyNotePage(localDate),
    }),
  });

  const openYesterday = useCallback(() => {
    const href = `/daily/${shiftLocalDate(currentLocalDate, -1)}`;
    paneRuntimeRef.current?.openInNewPane(href, "Yesterday");
  }, [currentLocalDate]);
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
  if (!page) return <PaneLoadingState />;
  return <PagePaneBody pageIdOverride={page.id} initialPage={page} />;
}
