"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { useConnectionsComposerController } from "@/components/connections/connectionsComposerController";
import ResourceSurfaceEditor from "@/components/resource-surface/ResourceSurfaceEditor";
import DawnWriteBlock from "@/components/notes/DawnWriteBlock";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { consumePendingNoteFocus } from "@/lib/notes/pendingNoteFocus";
import {
  fetchDailyNotePage,
  fetchDawnWrite,
  fetchNotePage,
  type DawnWrite,
  type NotePage,
} from "@/lib/notes/api";
import { shiftLocalDate } from "@/lib/localDate";
import {
  requirePaneRuntime,
  usePaneParam,
  usePaneReturnReady,
  usePaneRuntime,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { matchesPaneFilterQuery } from "@/lib/panes/paneRowFilter";
import usePaneFilterRows from "@/lib/panes/usePaneFilterRows";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { ResourceSurface } from "@/lib/resources/resourceItems";
import { resourceSurfaceFilterFields } from "@/components/resource-surface/resourceSurfaceFilterFields";

export default function PagePaneBody({
  pageIdOverride,
  initialPage,
}: {
  pageIdOverride?: string;
  initialPage?: NotePage;
}) {
  const routePageId = usePaneParam("pageId");
  const pageId = pageIdOverride ?? routePageId;
  if (!pageId) throw new Error("page route requires a page id");
  const activateTarget = requirePaneRuntime(
    usePaneRuntime(),
    "PagePaneBody",
  ).activateTarget;
  const sourceRef = `page:${pageId}`;
  const [filterRowsState, setFilterRowsState] = useState<{
    sourceRef: string;
    ready: boolean;
    fields: readonly (readonly string[])[];
  }>({
    sourceRef,
    ready: false,
    fields: [],
  });
  if (filterRowsState.sourceRef !== sourceRef) {
    setFilterRowsState({ sourceRef, ready: false, fields: [] });
  }
  const filterRows = useMemo(
    () =>
      filterRowsState.sourceRef === sourceRef ? filterRowsState.fields : [],
    [filterRowsState, sourceRef],
  );
  const ready =
    filterRowsState.sourceRef === sourceRef && filterRowsState.ready;
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
    sourceKey: sourceRef,
      inputLabel: "Filter page items",
      placeholder: "Filter items",
    getRowStatus: getFilterStatus,
    activeDomainControlCount: 0,
  });
  const [page, setPage] = useState<NotePage | null>(
    initialPage?.id === pageId ? initialPage : null,
  );
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [focusMastheadSerial, setFocusMastheadSerial] = useState(0);
  const [focusBodySerial, setFocusBodySerial] = useState(0);
  usePaneReturnReady(ready || feedback !== null);
  useSetPaneLabel(page?.title ?? (feedback ? "Page" : null));

  useEffect(() => {
    let active = true;
    if (initialPage?.id === pageId) return;
    setPage(null);
    void fetchNotePage(pageId)
      .then((next) => active && setPage(next))
      .catch((error: unknown) => {
        if (!active || handleUnauthenticatedApiError(error)) return;
        setFeedback(
          toFeedback(error, { fallback: "This page could not be loaded." }),
        );
      });
    return () => {
      active = false;
    };
  }, [initialPage, pageId]);

  useEffect(() => {
    if (!ready) return;
    const pending = consumePendingNoteFocus(pageId);
    if (pending === "title") setFocusMastheadSerial((current) => current + 1);
    else if (pending) setFocusBodySerial((current) => current + 1);
  }, [pageId, ready]);

  const dailyLocalDate = page?.dailyNote?.localDate ?? null;
  const openDatedPage = useCallback(
    async (localDate: string) => {
    const next = await fetchDailyNotePage(localDate);
    activateTarget({
      target: { href: `/pages/${next.id}`, labelHint: next.title },
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
  const composer = useConnectionsComposerController({
    scheme: "page",
    id: pageId,
  });
  const connections = useMemo(
    () => (
      <ConnectionsSurface
        resourceRef={{ scheme: "page", id: pageId }}
        composerController={composer}
        activateTarget={activateTarget}
      />
    ),
    [activateTarget, composer, pageId],
  );
  const { companionAction } = useResourceInspector({
    scheme: "page",
    handle: pageId,
    bodies: { linkedItems: connections },
  });
  const handleSurfaceChange = useCallback(
    (surface: ResourceSurface) => {
      setFilterRowsState({
        sourceRef,
        ready: true,
        fields: surface.orderedItems.map(resourceSurfaceFilterFields),
      });
      if (surface.source.content.kind !== "page_title") return;
      const { title } = surface.source.content;
      setPage((current) => (current ? { ...current, title } : current));
    },
    [sourceRef],
  );
  usePanePrimaryChrome({
    search,
    actions: companionAction ? [companionAction] : [],
    menu: page
      ? {
          kind: "ResourceMenu",
          target: page.actionTarget,
          groups: {
            core: [],
            operations: [],
            relationships: [],
            view: viewActions,
          },
        }
      : undefined,
  });
  const [dawnWrite, setDawnWrite] = useState<DawnWrite | null>(null);
  useEffect(() => {
    if (!dailyLocalDate) {
      setDawnWrite(null);
      return;
    }
    void fetchDawnWrite(dailyLocalDate)
      .then(setDawnWrite)
      .catch(() => setDawnWrite(null));
  }, [dailyLocalDate]);

  if (feedback && !page) return <FeedbackNotice {...feedback} />;
  if (!page) {
    return (
      <>
        <PaneLoadingState />
        {filterQuery.trim() ? (
          <p role="status">No matching item found so far.</p>
        ) : null}
      </>
    );
  }
  return (
    <>
    {dawnWrite ? <DawnWriteBlock write={dawnWrite} /> : null}
      {!ready && filterQuery.trim() ? (
        <p role="status">No matching item found so far.</p>
      ) : null}
    <ResourceSurfaceEditor
      sourceRef={sourceRef}
      rowFilterQuery={filterQuery}
      focusMastheadSerial={focusMastheadSerial}
      focusBodySerial={focusBodySerial}
        onSurfaceChange={handleSurfaceChange}
      activateTarget={activateTarget}
    />
    </>
  );
}
