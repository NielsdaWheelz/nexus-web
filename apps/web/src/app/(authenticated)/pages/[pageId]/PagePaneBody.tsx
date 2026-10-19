"use client";

// A page (/pages/{id}) or a dated page (/daily/{date}, latent until its first write;
// a page bound to a date behaves the same at /pages/{id}). Serves the entries
// EditPageTitle (focus and select the title), AppendNote (a new empty row, focused)
// and FocusNote (the caret at the end of that row).
import { useEffect, useMemo, useRef } from "react";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { FeedbackNotice, FeedbackState, useFeedback, type FeedbackActions, type FeedbackContent } from "@/components/feedback/Feedback";
import OutlineEditor, { useOutlineFilter } from "@/components/notes/OutlineEditor";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { isStaleBuild, STALE_BUILD_COPY } from "@/lib/api/client";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import { shiftLocalDate } from "@/lib/localDate";
import { useOutline } from "@/lib/notes/useOutline";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import {
  requirePaneRuntime,
  usePaneDailyPage,
  usePaneEntryDelivery,
  usePaneParam,
  usePaneRuntime,
} from "@/lib/panes/paneRuntime";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";

export default function PagePaneBody() {
  const pageId = usePaneParam("pageId");
  const localDate = usePaneParam("localDate");
  const runtime = requirePaneRuntime(usePaneRuntime(), "PagePaneBody");
  const { delivery, claim } = usePaneEntryDelivery();
  const feedback = useFeedback();
  const outline = useOutline({
    root: pageId ? `page:${pageId}` : null,
    dailyDate: pageId ? null : localDate,
  });
  const source = outline.root?.source ?? null;
  const id = source ? source.item.ref.slice("page:".length) : pageId;
  const content = source?.content;
  const dailyDate = content?.kind === "page" ? content.daily_date : localDate;
  const titleRef = useRef<HTMLInputElement | null>(null);
  const { query, queryControls } = useOutlineFilter(
    outline,
    `page:${pageId ?? localDate}`,
    "Filter page items",
  );
  usePaneReturnReady(outline.status !== "loading");
  usePaneDailyPage(dailyDate && id ? { localDate: dailyDate, pageId: id } : null);

  const reloadedFor = useRef<string | null>(null);
  useEffect(() => {
    const entry = delivery?.entry;
    if (!delivery || !entry || outline.status !== "ready" || !source) return;
    const gone = (title: string) =>
      void feedback.offer({ key: "page-entry", announcement: "Polite", content: { tone: "Neutral", title } });
    if (entry.kind === "EditPageTitle") {
      if (!claim(delivery)) return;
      if (entry.pageId !== id) return gone("This page is no longer available.");
      titleRef.current?.focus();
      titleRef.current?.select();
    } else if (entry.kind === "AppendNote") {
      if (claim(delivery)) outline.insert("end");
    } else if (entry.kind === "FocusNote") {
      const ref = `note_block:${entry.noteBlockId}`;
      const row = outline.rows.find((r) => r.terminal === null && r.link.target.item.ref === ref);
      if (!row && reloadedFor.current !== delivery.activationId) {
        reloadedFor.current = delivery.activationId;
        return void outline.reload();
      }
      if (!claim(delivery)) return;
      if (row) outline.focusRow(row.key, "end");
      else gone("This note is no longer available.");
    }
  }, [claim, delivery, feedback, id, outline, source]);

  const materialized = id !== null && !outline.latent && outline.status === "ready";
  const resourceRef = materialized ? canonicalResourceRef({ scheme: "page", id }) : undefined;
  const { activateTarget } = runtime;
  const menuActions = useMemo<ActionDescriptor[]>(
    () =>
      dailyDate
        ? ([-1, 1] as const).map((days) => ({
            kind: "link",
            id: days < 0 ? "ViewAction.Page.OpenYesterday" : "ViewAction.Page.OpenTomorrow",
            label: days < 0 ? "Open yesterday" : "Open tomorrow",
            href: `/daily/${shiftLocalDate(dailyDate, days)}`,
          }))
        : [],
    [dailyDate],
  );
  usePaneChrome(useMemo(() => ({ query: queryControls, resourceRef, menuActions }), [resourceRef, menuActions, queryControls]));

  const unavailable = outline.failure?.status === 403 || outline.failure?.status === 404;
  const stale = isStaleBuild(outline.failure);
  const failure: FeedbackContent | null = outline.failure === null ? null : {
    tone: "Warning",
    title: stale ? "the app needs to reload" : unavailable ? "this page is no longer available" :
      outline.root ? "this page couldn’t refresh" : "this page couldn’t be loaded",
    message: stale ? STALE_BUILD_COPY : unavailable ? "it may have been removed or your access may have changed." :
      outline.root ? "the current outline remains in this tab." : undefined,
    requestId: outline.failure.requestId,
  };
  const actions: FeedbackActions | undefined = stale
    ? [{ label: "reload app", onClick: () => window.location.reload() }]
    : unavailable ? undefined : [{ label: "retry loading", onClick: outline.reload, busy: outline.retrying }];
  if (failure !== null && (outline.root === null || unavailable || stale))
    return <FeedbackState content={failure} announcement="Polite" actions={actions} />;
  if (!outline.root) return <PaneLoadingState label="Loading page…" announcement="Polite" />;
  return (
    <>
      {failure === null ? null : <FeedbackNotice content={failure} announcement="Polite" actions={actions} />}
      {materialized ? <Inspector pageId={id} /> : null}
      <OutlineEditor
        outline={outline}
        filter={query}
        inspection={null}
        titleRef={titleRef}
        activateTarget={activateTarget}
      />
    </>
  );
}

/** A page's inspector: its connections. */
function Inspector({ pageId }: { pageId: string }) {
  const connections = useMemo(
    () => <ConnectionsSurface resourceRef={{ scheme: "page", id: pageId }} />,
    [pageId],
  );
  useResourceInspector({ scheme: "page", handle: pageId, bodies: { linkedItems: connections } });
  return null;
}
