"use client";

// A page (/pages/{id}) or a dated page (/daily/{date}, latent until its first write;
// a page bound to a date behaves the same at /pages/{id}). Serves the entries
// EditPageTitle (focus and select the title), AppendNote (a new empty row, focused)
// and FocusNote (the caret at the end of that row).
import { useEffect, useMemo, useRef } from "react";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { FeedbackNotice, FeedbackState, useFeedback, type FeedbackActions, type FeedbackContent } from "@/components/feedback/Feedback";
import { UnavailableTexts } from "@/components/notes/NoteNotices";
import OutlineEditor, { useOutlineFilter } from "@/components/notes/OutlineEditor";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { isStaleBuild, STALE_BUILD_FEEDBACK } from "@/lib/api/client";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import { shiftLocalDate } from "@/lib/localDate";
import { hasUnsavedText } from "@/lib/notes/texts";
import { isDeletedResource } from "@/lib/resourceGraph/links";
import { useOutline } from "@/lib/notes/useOutline";
import { outlineTextRefs } from "@/lib/notes/useOutlineSession";
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
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
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

  const gone = id !== null && isDeletedResource(`page:${id}`);
  const retainedRefs = id ? outlineTextRefs(`page:${id}`) : [];
  const materialized = id !== null && !gone && !outline.latent && outline.status === "ready";
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
  const failure: FeedbackContent | null = outline.failure === null ? null : stale ? STALE_BUILD_FEEDBACK : {
    tone: "Warning",
    title: unavailable ? "this page is no longer available" :
      outline.root ? "couldn’t refresh connections" : "this page couldn’t be loaded",
    message: unavailable ? "it may have been removed or your access may have changed." :
      outline.root ? "the current outline remains in this tab." : undefined,
    requestId: outline.failure.requestId,
  };
  const actions: FeedbackActions | undefined = stale || unavailable
    ? undefined
    : [{ label: outline.root ? "retry refresh" : "retry loading", onClick: outline.reload, busy: outline.retrying }];
  if (gone && retainedRefs.some(hasUnsavedText)) return <UnavailableTexts kind="page" refs={retainedRefs} />;
  if (gone) return <FeedbackState content={{ tone: "Neutral", title: "this page is no longer available" }} announcement="Polite" />;
  if (failure !== null && (outline.root === null || unavailable || stale))
    return <FeedbackState content={failure} announcement="Polite" actions={actions} />;
  if (!outline.root) return <PaneLoadingState label="Loading page…" announcement="Polite" />;
  return (
    <>
      {failure === null ? null : <FeedbackNotice content={failure} announcement="Polite" actions={actions} />}
      {outline.dailyConflict ? <FeedbackNotice content={{ tone: "Warning", title: "this day was saved in another tab", message: "your input remains here. save it to the current page when ready." }} announcement="Polite" actions={[{ label: "save to this day", onClick: outline.retryDaily }]} /> : null}
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
