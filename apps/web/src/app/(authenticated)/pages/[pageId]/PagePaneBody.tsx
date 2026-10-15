"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import ResourceSurfaceEditor from "@/components/resource-surface/ResourceSurfaceEditor";
import {
  FeedbackNotice,
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { usePaneChrome, type PaneQuery } from "@/lib/panes/paneChrome";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { consumePendingNoteFocus } from "@/lib/notes/pendingNoteFocus";
import { fetchNotePage } from "@/lib/notes/api";
import type {
  DailyPageSummary,
  NotePage,
} from "@/lib/notes/pageContract";
import { shiftLocalDate } from "@/lib/localDate";
import {
  requirePaneRuntime,
  usePaneDailyPage,
  usePaneEntryDelivery,
  usePaneParam,
  usePaneRuntime,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { ResourceSurface } from "@/lib/resources/resourceItems";
import { useResourceSurfaceFilterRows } from "@/components/resource-surface/useResourceSurfaceFilterRows";
import { useOptionalAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { canonicalResourceRef } from "@/lib/sharing/targets";

export type PagePaneSource =
  | { kind: "PageRef"; pageId: string }
  | {
      kind: "DailyDate";
      accountId: string;
      localDate: string;
    };

interface PageView {
  readonly id: string;
  readonly title: string;
  readonly actionSubject: NotePage["actionSubject"];
  readonly daily_page: DailyPageSummary | null;
}

function pageLoadErrorMessage(error: unknown): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  switch (error.code) {
    case "E_NOT_FOUND":
      return {
        tone: "Danger",
        title: "This page is no longer available",
        requestId: error.requestId,
      };
    case "E_NETWORK":
      return {
        tone: "Danger",
        title: "This page couldn’t be loaded",
        message: "Check your connection and retry.",
        requestId: error.requestId,
      };
    default:
      throw error;
  }
}

export default function PagePaneBody({
  pageIdOverride,
  initialPage,
}: {
  pageIdOverride?: string;
  initialPage?: NotePage;
}) {
  const routePageId = usePaneParam("pageId");
  const routeLocalDate = usePaneParam("localDate");
  const account = useOptionalAuthenticatedAccount();
  const source: PagePaneSource =
    (pageIdOverride ?? routePageId)
      ? { kind: "PageRef", pageId: (pageIdOverride ?? routePageId)! }
      : routeLocalDate && account
        ? {
            kind: "DailyDate",
            accountId: account.accountId,
            localDate: routeLocalDate,
          }
        : (() => {
            throw new Error(
              "page route requires a page id or authenticated daily date",
            );
          })();
  const activateTarget = requirePaneRuntime(
    usePaneRuntime(),
    "PagePaneBody",
  ).activateTarget;
  const { delivery, claim } = usePaneEntryDelivery();
  const sourceKey =
    source.kind === "PageRef"
      ? `page:${source.pageId}`
      : `daily:${source.accountId}:${source.localDate}`;
  const {
    ready,
    query: filterQuery,
    queryControls,
    acceptSurface,
    markReady,
  } = useResourceSurfaceFilterRows(sourceKey, "Filter page items");
  const [page, setPage] = useState<PageView | null>(
    source.kind === "PageRef" && initialPage?.id === source.pageId
      ? initialPage
      : null,
  );
  const [dailyTitle, setDailyTitle] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const feedbackController = useFeedback();
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [focusMastheadSerial, setFocusMastheadSerial] = useState(0);
  const [focusBodySerial, setFocusBodySerial] = useState(0);
  const pageRefId = source.kind === "PageRef" ? source.pageId : null;
  const dailySourceDate = source.kind === "DailyDate" ? source.localDate : null;
  usePaneReturnReady(ready || feedback !== null);
  useSetPaneLabel(page?.title ?? dailyTitle ?? (feedback ? "Page" : null));

  useEffect(() => {
    if (!pageRefId) return;
    let active = true;
    if (initialPage?.id === pageRefId) return;
    setPage(null);
    void fetchNotePage(pageRefId)
      .then((next) => active && setPage(next))
      .catch((error: unknown) => {
        if (!active || handleUnauthenticatedApiError(error)) return;
        try {
          setFeedback(pageLoadErrorMessage(error));
        } catch (caughtDefect) {
          setDefect({ error: caughtDefect });
        }
      });
    return () => {
      active = false;
    };
  }, [initialPage, pageRefId]);

  useEffect(() => {
    if (!ready || !page) return;
    const pending = consumePendingNoteFocus(page.id);
    if (pending === "title") setFocusMastheadSerial((current) => current + 1);
    else if (pending) setFocusBodySerial((current) => current + 1);
  }, [page, ready]);

  const pageDailyLocalDate =
    page?.daily_page != null
      ? page.daily_page.local_date
      : null;
  const dailyLocalDate = dailySourceDate ?? pageDailyLocalDate;
  const pageId = page?.id ?? (source.kind === "PageRef" ? source.pageId : null);
  // Edit title… from a resource menu: focus the title once the page is loaded.
  useEffect(() => {
    if (delivery?.entry.kind !== "EditPageTitle" || !ready || !page) return;
    if (!claim(delivery)) return;
    if (delivery.entry.pageId !== page.id) {
      feedbackController.publish({
        kind: "Hud",
        content: { tone: "Neutral", title: "This page is no longer available." },
      });
      return;
    }
    setFocusMastheadSerial((current) => current + 1);
  }, [claim, delivery, feedbackController, page, ready]);
  const dailyDelivery = delivery?.entry.kind === "AppendNote" ? delivery : null;
  usePaneDailyPage(dailyLocalDate ? { localDate: dailyLocalDate, pageId } : null);
  const openDatedPage = useCallback(
    (localDate: string) => {
      activateTarget({
        target: { href: `/daily/${localDate}` },
        disposition: { kind: "Follow" },
      });
    },
    [activateTarget],
  );
  const viewActions = useMemo<ActionDescriptor[]>(
    () =>
      dailyLocalDate
        ? [
            {
              kind: "command",
              id: "ViewAction.Page.OpenYesterday",
              label: "Open yesterday",
              onSelect: () =>
                void openDatedPage(shiftLocalDate(dailyLocalDate, -1)),
            },
            {
              kind: "command",
              id: "ViewAction.Page.OpenTomorrow",
              label: "Open tomorrow",
              onSelect: () =>
                void openDatedPage(shiftLocalDate(dailyLocalDate, 1)),
            },
          ]
        : [],
    [dailyLocalDate, openDatedPage],
  );
  const handleSurfaceChange = useCallback(
    (surface: ResourceSurface) => {
      acceptSurface(surface);
      if (surface.source.content.kind !== "page_title") return;
      const { title } = surface.source.content;
      setPage((current) =>
        current
          ? { ...current, title }
          : dailySourceDate
            ? {
                id: surface.source.item.id,
                title,
                actionSubject: {
                  ref: canonicalResourceRef({
                    scheme: "page",
                    id: surface.source.item.id,
                  }),
                },
                daily_page: { local_date: dailySourceDate },
              }
            : current,
      );
    },
    [acceptSurface, dailySourceDate],
  );
  const handleDailyTitleChange = useCallback(
    (title: string | null) => {
      setDailyTitle(title);
      if (title !== null) markReady();
    },
    [markReady],
  );
  const chrome = (
    <PageChrome page={page} queryControls={queryControls} viewActions={viewActions} />
  );
  if (defect) throw defect.error;
  if (feedback && !page) {
    return (
      <>
        {chrome}
        <FeedbackNotice content={feedback} announcement="Assertive" />
      </>
    );
  }
  if (!page && source.kind === "PageRef") {
    return (
      <>
        {chrome}
        <PaneLoadingState label="Loading page…" announcement="Polite" />
        {filterQuery.trim() ? (
          <p role="status">No matching item found so far.</p>
        ) : null}
      </>
    );
  }
  return (
    <>
      {chrome}
      {!ready && filterQuery.trim() ? (
        <p role="status">No matching item found so far.</p>
      ) : null}
      <ResourceSurfaceEditor
        {...(dailyLocalDate && account
          ? {
              daily: {
                accountId: account.accountId,
                localDate: dailyLocalDate,
                ...(source.kind === "PageRef"
                  ? { materializedSourceRef: `page:${source.pageId}` }
                  : {}),
                delivery: dailyDelivery,
                onDeliveryClaimed: claim,
              },
            }
          : source.kind === "PageRef"
            ? { sourceRef: `page:${source.pageId}` }
            : {
                daily: {
                  accountId: source.accountId,
                  localDate: source.localDate,
                  delivery: dailyDelivery,
                  onDeliveryClaimed: claim,
                },
              })}
        rowFilterQuery={filterQuery}
        focusMastheadSerial={focusMastheadSerial}
        focusBodySerial={focusBodySerial}
        onSurfaceChange={handleSurfaceChange}
        onDailyTitleChange={
          source.kind === "DailyDate" ? handleDailyTitleChange : undefined
        }
        activateTarget={activateTarget}
      />
    </>
  );
}

function PageChrome({
  page,
  queryControls,
  viewActions,
}: {
  page: PageView | null;
  queryControls: PaneQuery;
  viewActions: ActionDescriptor[];
}) {
  return page ? (
    <MaterializedPageChrome
      page={page}
      queryControls={queryControls}
      viewActions={viewActions}
    />
  ) : (
    <LatentPageChrome queryControls={queryControls} />
  );
}

function LatentPageChrome({ queryControls }: { queryControls: PaneQuery }) {
  usePaneChrome({ query: queryControls });
  return null;
}

function MaterializedPageChrome({
  page,
  queryControls,
  viewActions,
}: {
  page: PageView;
  queryControls: PaneQuery;
  viewActions: ActionDescriptor[];
}) {
  const connections = useMemo(
    () => (
      <ConnectionsSurface
        resourceRef={{ scheme: "page", id: page.id }}
      />
    ),
    [page.id],
  );
  useResourceInspector({
    scheme: "page",
    handle: page.id,
    bodies: { linkedItems: connections },
  });
  usePaneChrome({
    query: queryControls,
    actionSubject: page.actionSubject,
    menuActions: viewActions,
  });
  return null;
}
