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
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import {
  usePaneParam,
  usePaneRuntime,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import { useResource } from "@/lib/api/useResource";
import PagePaneBody from "../pages/[pageId]/PagePaneBody";

function dailyNotePageCacheKey(localDate: string, timeZone: string): string {
  return `daily-note-page:${localDate}:${timeZone}`;
}

function pageIdFromResourceRef(resourceRef: string | null | undefined): string | null {
  if (!resourceRef) return null;
  const parsed = parseResourceRef(resourceRef);
  return parsed?.scheme === "page" ? parsed.id : null;
}

export default function DailyNotePaneBody() {
  const { currentLocalDate, displayTimeZone } = useRenderEnvironment();
  const paneRuntime = usePaneRuntime();
  const paneRuntimeRef = useRef(paneRuntime);
  const routeLocalDate = usePaneParam("localDate");
  const localDate = routeLocalDate ?? currentLocalDate;
  paneRuntimeRef.current = paneRuntime;
  const validLocalDate = isLocalDate(localDate);
  const resourceStatus = paneRuntime?.resourceStatus ?? "none";
  const shellPageId = pageIdFromResourceRef(paneRuntime?.resourceRef);
  const unsupportedResourceRef =
    paneRuntime?.resourceRef !== null &&
    paneRuntime?.resourceRef !== undefined &&
    shellPageId === null;
  const waitingForShellResource = resourceStatus === "pending";
  const failedShellResource =
    resourceStatus === "missing" ||
    resourceStatus === "unauthorized" ||
    resourceStatus === "invalid" ||
    resourceStatus === "error";
  const cacheKey =
    validLocalDate &&
    !shellPageId &&
    !unsupportedResourceRef &&
    !waitingForShellResource &&
    !failedShellResource
      ? dailyNotePageCacheKey(localDate, displayTimeZone)
      : null;
  const dailyResource = useResource({
    cacheKey,
    load: async () => ({
      localDate,
      timeZone: displayTimeZone,
      page: await fetchDailyNotePage(localDate, { timeZone: displayTimeZone }),
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
    dailyResource.status === "ready" &&
    dailyResource.data.localDate === localDate &&
    dailyResource.data.timeZone === displayTimeZone
      ? dailyResource.data.page
      : null;
  const hasLoadError =
    !validLocalDate ||
    unsupportedResourceRef ||
    failedShellResource ||
    dailyResource.status === "error";

  useSetPaneTitle(routeLocalDate ? (hasLoadError ? "Daily note" : null) : "Today");
  usePaneChromeOverride({ options: paneOptions });

  if (!validLocalDate) {
    return <FeedbackNotice severity="error" title="Daily note date must use YYYY-MM-DD." />;
  }
  if (unsupportedResourceRef) {
    return <FeedbackNotice severity="error" title="Daily note resource must resolve to a page." />;
  }
  if (failedShellResource) {
    return <FeedbackNotice severity="error" title="Daily note resource could not be resolved." />;
  }
  if (waitingForShellResource) {
    return <PaneLoadingState />;
  }
  if (shellPageId) {
    return <PagePaneBody pageIdOverride={shellPageId} />;
  }
  if (dailyResource.status === "error") {
    return <FeedbackNotice {...toFeedback(dailyResource.error, { fallback: "Daily note could not be loaded." })} />;
  }
  if (!page) return <PaneLoadingState />;
  return <PagePaneBody pageIdOverride={page.id} initialPage={page} />;
}
