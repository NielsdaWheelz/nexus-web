"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { useConnectionsComposerController } from "@/components/connections/connectionsComposerController";
import ResourceSurfaceEditor from "@/components/resource-surface/ResourceSurfaceEditor";
import DawnWriteBlock from "@/components/notes/DawnWriteBlock";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { consumePendingNoteFocus } from "@/lib/notes/pendingNoteFocus";
import {
  fetchDawnWrite,
  fetchNotePage,
  type DawnWrite,
  type NotePage,
} from "@/lib/notes/api";
import { shiftLocalDate } from "@/lib/localDate";
import {
  requirePaneRuntime,
  usePaneEntryDelivery,
  usePaneParam,
  usePaneReturnReady,
  usePaneRuntime,
  useSetPaneAliases,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { matchesPaneFilterQuery } from "@/lib/panes/paneRowFilter";
import usePaneFilterRows from "@/lib/panes/usePaneFilterRows";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { ResourceSurface } from "@/lib/resources/resourceItems";
import { resourceSurfaceFilterFields } from "@/components/resource-surface/resourceSurfaceFilterFields";
import { useOptionalAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type {
  WorkspaceTarget,
  WorkspaceTargetDisposition,
} from "@/lib/workspace/targetActivation";
import type { PaneSearchPublication } from "@/lib/panes/paneSearch";

export type PagePaneSource =
  | { kind: "PageRef"; pageId: string }
  | {
      kind: "DailyDate";
      accountId: string;
      localDate: string;
    };

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

function isExpectedDawnWriteAbsence(error: unknown): boolean {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  switch (error.code) {
    case "E_NETWORK":
      return true;
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
    pageIdOverride ?? routePageId
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
  const { delivery, acknowledge } = usePaneEntryDelivery();
  const sourceKey =
    source.kind === "PageRef"
      ? `page:${source.pageId}`
      : `daily:${source.accountId}:${source.localDate}`;
  const [filterRowsState, setFilterRowsState] = useState<{
    sourceRef: string;
    ready: boolean;
    fields: readonly (readonly string[])[];
  }>({
    sourceRef: sourceKey,
    ready: false,
    fields: [],
  });
  if (filterRowsState.sourceRef !== sourceKey) {
    setFilterRowsState({ sourceRef: sourceKey, ready: false, fields: [] });
  }
  const filterRows = useMemo(
    () =>
      filterRowsState.sourceRef === sourceKey ? filterRowsState.fields : [],
    [filterRowsState, sourceKey],
  );
  const ready =
    filterRowsState.sourceRef === sourceKey && filterRowsState.ready;
  const getFilterStatus = useCallback(
    (query: string) => {
      const visibleCount = filterRows.filter((fields) =>
        matchesPaneFilterQuery(query, fields),
      ).length;
      const unit = { singular: "item", plural: "items" };
      return ready
        ? {
            kind: "Complete" as const,
            visibleCount,
            totalCount: filterRows.length,
            unit,
          }
        : {
            kind: "Partial" as const,
            visibleCount,
            loadedCount: filterRows.length,
            unit,
          };
    },
    [filterRows, ready],
  );
  const { query: filterQuery, publication: search } = usePaneFilterRows({
    sourceKey,
    inputLabel: "Filter page items",
    placeholder: "Filter items",
    getRowStatus: getFilterStatus,
    activeDomainControlCount: 0,
  });
  const [page, setPage] = useState<NotePage | null>(
    source.kind === "PageRef" && initialPage?.id === source.pageId
      ? initialPage
      : null,
  );
  const [dailyTitle, setDailyTitle] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
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

  const dailyLocalDate =
    dailySourceDate ?? page?.dailyPage?.localDate ?? null;
  const pageId =
    page?.id ?? (source.kind === "PageRef" ? source.pageId : null);
  useSetPaneAliases([
    ...(dailyLocalDate ? [`daily:${dailyLocalDate}`] : []),
    ...(pageId ? [`page:${pageId}`] : []),
  ]);
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
      setFilterRowsState({
        sourceRef: sourceKey,
        ready: true,
        fields: surface.orderedItems.map(resourceSurfaceFilterFields),
      });
      if (surface.source.content.kind !== "page_title") return;
      const { title } = surface.source.content;
      setPage((current) =>
        current
          ? { ...current, title }
          : dailySourceDate
            ? {
                id: surface.source.item.id,
                title,
                actionTarget: routeResourceActionSubject({
                  scheme: "page",
                  id: surface.source.item.id,
                  href: `/pages/${surface.source.item.id}`,
                }),
                dailyPage: { localDate: dailySourceDate },
              }
            : current,
      );
    },
    [dailySourceDate, sourceKey],
  );
  const handleDailyTitleChange = useCallback((title: string | null) => {
    setDailyTitle(title);
    if (title !== null) {
      setFilterRowsState((current) =>
        current.sourceRef === sourceKey
          ? { ...current, ready: true }
          : current,
      );
    }
  }, [sourceKey]);
  const [dawnWrite, setDawnWrite] = useState<DawnWrite | null>(null);
  useEffect(() => {
    if (!dailyLocalDate) {
      setDawnWrite(null);
      return;
    }
    void fetchDawnWrite(dailyLocalDate)
      .then(setDawnWrite)
      .catch((error: unknown) => {
        if (handleUnauthenticatedApiError(error)) return;
        try {
          // justify-ignore-error: Dawn Write is optional editorial context; a
          // modeled network miss omits it without blocking the canonical page.
          if (isExpectedDawnWriteAbsence(error)) setDawnWrite(null);
        } catch (caughtDefect) {
          setDefect({ error: caughtDefect });
        }
      });
  }, [dailyLocalDate]);

  const chrome = (
    <PageChrome
      page={page}
      search={search}
      viewActions={viewActions}
      activateTarget={activateTarget}
    />
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
      {dawnWrite ? <DawnWriteBlock write={dawnWrite} /> : null}
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
                delivery,
                onDeliveryClaimed: acknowledge,
              },
            }
          : source.kind === "PageRef"
            ? { sourceRef: `page:${source.pageId}` }
            : {
                daily: {
                  accountId: source.accountId,
                  localDate: source.localDate,
                  delivery,
                  onDeliveryClaimed: acknowledge,
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
  search,
  viewActions,
  activateTarget,
}: {
  page: NotePage | null;
  search: PaneSearchPublication;
  viewActions: ActionDescriptor[];
  activateTarget: (input: {
    target: WorkspaceTarget;
    disposition: WorkspaceTargetDisposition;
  }) => void;
}) {
  return page ? (
    <MaterializedPageChrome
      page={page}
      search={search}
      viewActions={viewActions}
      activateTarget={activateTarget}
    />
  ) : (
    <LatentPageChrome search={search} />
  );
}

function LatentPageChrome({ search }: { search: PaneSearchPublication }) {
  usePanePrimaryChrome({ search, actions: [] });
  return null;
}

function MaterializedPageChrome({
  page,
  search,
  viewActions,
  activateTarget,
}: {
  page: NotePage;
  search: PaneSearchPublication;
  viewActions: ActionDescriptor[];
  activateTarget: (input: {
    target: WorkspaceTarget;
    disposition: WorkspaceTargetDisposition;
  }) => void;
}) {
  const composer = useConnectionsComposerController({
    scheme: "page",
    id: page.id,
  });
  const connections = useMemo(
    () => (
      <ConnectionsSurface
        resourceRef={{ scheme: "page", id: page.id }}
        composerController={composer}
        activateTarget={activateTarget}
      />
    ),
    [activateTarget, composer, page.id],
  );
  const { companionAction } = useResourceInspector({
    scheme: "page",
    handle: page.id,
    bodies: { linkedItems: connections },
  });
  usePanePrimaryChrome({
    search,
    actions: companionAction ? [companionAction] : [],
    menu: {
      kind: "ResourceMenu",
      target: page.actionTarget,
      groups: {
        core: [],
        operations: [],
        relationships: [],
        view: viewActions,
      },
    },
  });
  return null;
}
