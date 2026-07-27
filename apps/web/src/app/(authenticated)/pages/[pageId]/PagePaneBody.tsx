"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { useConnectionsComposerController } from "@/components/connections/connectionsComposerController";
import ResourceSurfaceEditor from "@/components/resource-surface/ResourceSurfaceEditor";
import DawnWriteBlock from "@/components/notes/DawnWriteBlock";
import { FeedbackNotice, toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { consumePendingNoteFocus } from "@/lib/notes/pendingNoteFocus";
import { fetchDailyNotePage, fetchDawnWrite, fetchNotePage, type DawnWrite, type NotePage } from "@/lib/notes/api";
import { shiftLocalDate } from "@/lib/localDate";
import { usePaneParam, usePaneReturnReady, usePaneRouter, usePaneRuntime, useSetPaneLabel } from "@/lib/panes/paneRuntime";
import type { WorkspaceSecondaryActivation } from "@/lib/panes/paneSecondaryModel";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { resolveResourceLocators } from "@/lib/resources/resourceLocators";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";

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
  const router = usePaneRouter();
  const paneRuntime = usePaneRuntime();
  const [page, setPage] = useState<NotePage | null>(
    initialPage?.id === pageId ? initialPage : null,
  );
  const [ready, setReady] = useState(false);
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
        setFeedback(toFeedback(error, { fallback: "This page could not be loaded." }));
      });
    return () => { active = false; };
  }, [initialPage, pageId]);

  useEffect(() => {
    if (!ready) return;
    const pending = consumePendingNoteFocus(pageId);
    if (pending === "title") setFocusMastheadSerial((current) => current + 1);
    else if (pending) setFocusBodySerial((current) => current + 1);
  }, [pageId, ready]);

  const openRoute = useCallback((href: string, openInNewPane: boolean, secondary?: WorkspaceSecondaryActivation) => {
    if (openInNewPane) paneRuntime?.openInNewPane?.(href, undefined, secondary);
    else router.push(href);
  }, [paneRuntime, router]);
  const openObject = useCallback(async (type: string, id: string, openInNewPane: boolean) => {
    const ref = `${type}:${id}`;
    if (!parseResourceRef(ref)) return;
    try {
      const [resolved] = await resolveResourceLocators([{ kind: "resource_ref", ref }]);
      if (resolved?.resourceItem.route) openRoute(resolved.resourceItem.route, openInNewPane);
    } catch (error) {
      if (!handleUnauthenticatedApiError(error)) {
        setFeedback(toFeedback(error, { fallback: "That linked item could not be opened." }));
      }
    }
  }, [openRoute]);

  const dailyLocalDate = page?.dailyNote?.localDate ?? null;
  const openDatedPage = useCallback(async (localDate: string) => {
    const next = await fetchDailyNotePage(localDate);
    router.push(`/pages/${next.id}`);
  }, [router]);
  const viewActions = useMemo<ActionDescriptor[]>(() => dailyLocalDate ? [
    { kind: "command", id: "ViewAction.Page.OpenYesterday", label: "Open yesterday", onSelect: () => void openDatedPage(shiftLocalDate(dailyLocalDate, -1)) },
    { kind: "command", id: "ViewAction.Page.OpenTomorrow", label: "Open tomorrow", onSelect: () => void openDatedPage(shiftLocalDate(dailyLocalDate, 1)) },
  ] : [], [dailyLocalDate, openDatedPage]);
  const composer = useConnectionsComposerController({ scheme: "page", id: pageId });
  const connections = useMemo(() => <ConnectionsSurface resourceRef={{ scheme: "page", id: pageId }} composerController={composer} onOpenRoute={openRoute} />, [composer, openRoute, pageId]);
  const { companionAction } = useResourceInspector({ scheme: "page", handle: pageId, bodies: { linkedItems: connections } });
  usePanePrimaryChrome({
    actions: companionAction ? [companionAction] : [],
    menu: page ? { kind: "ResourceMenu", target: page.actionTarget, groups: { core: [], operations: [], relationships: [], view: viewActions } } : undefined,
  });
  const [dawnWrite, setDawnWrite] = useState<DawnWrite | null>(null);
  useEffect(() => {
    if (!dailyLocalDate) { setDawnWrite(null); return; }
    void fetchDawnWrite(dailyLocalDate).then(setDawnWrite).catch(() => setDawnWrite(null));
  }, [dailyLocalDate]);

  if (feedback && !page) return <FeedbackNotice {...feedback} />;
  if (!page) return <PaneLoadingState />;
  return <>
    {dawnWrite ? <DawnWriteBlock write={dawnWrite} /> : null}
    <ResourceSurfaceEditor
      sourceRef={`page:${pageId}`}
      focusMastheadSerial={focusMastheadSerial}
      focusBodySerial={focusBodySerial}
      onSurfaceReady={(surface) => {
        setReady(true);
        if (surface.source.content.kind !== "page_title") return;
        const { title } = surface.source.content;
        setPage((current) => current ? { ...current, title } : current);
      }}
      onOpenObject={openObject}
      onOpenRoute={openRoute}
    />
  </>;
}
