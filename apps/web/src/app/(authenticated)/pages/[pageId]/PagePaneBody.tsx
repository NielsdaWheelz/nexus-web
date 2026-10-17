"use client";

// A page (/pages/{id}) or a dated page (/daily/{date}, latent until its first write;
// a page bound to a date behaves the same at /pages/{id}). Serves the entries
// EditPageTitle (focus and select the title), AppendNote (a new empty row, focused)
// and FocusNote (the caret at the end of that row).
import { useEffect, useMemo, useRef } from "react";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { FeedbackNotice, useFeedback } from "@/components/feedback/Feedback";
import OutlineEditor, { useOutlineFilter } from "@/components/notes/OutlineEditor";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import { shiftLocalDate } from "@/lib/localDate";
import { useText } from "@/lib/notes/texts";
import { useOutline } from "@/lib/notes/useOutline";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import {
  requirePaneRuntime,
  usePaneDailyPage,
  usePaneEntryDelivery,
  usePaneParam,
  usePaneRuntime,
  useSetPaneLabel,
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
  const title = useText(source?.item.ref ?? "");
  const content = source?.content;
  const dailyDate = content?.kind === "page" ? content.daily_date : localDate;
  const titleRef = useRef<HTMLInputElement | null>(null);
  const { query, queryControls } = useOutlineFilter(
    outline,
    `page:${pageId ?? localDate}`,
    "Filter page items",
  );
  usePaneReturnReady(outline.status !== "loading");
  useSetPaneLabel(
    typeof title?.value === "string" ? title.value : outline.status === "failed" ? "Page" : null,
  );
  usePaneDailyPage(dailyDate && id ? { localDate: dailyDate, pageId: id } : null);

  const reloadedFor = useRef<string | null>(null);
  useEffect(() => {
    const entry = delivery?.entry;
    if (!delivery || !entry || outline.status !== "ready" || !source) return;
    const gone = (title: string) =>
      feedback.publish({ kind: "Hud", content: { tone: "Neutral", title } });
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
            kind: "command",
            id: days < 0 ? "ViewAction.Page.OpenYesterday" : "ViewAction.Page.OpenTomorrow",
            label: days < 0 ? "Open yesterday" : "Open tomorrow",
            onSelect: () =>
              activateTarget({
                target: { href: `/daily/${shiftLocalDate(dailyDate, days)}` },
                disposition: { kind: "Follow" },
              }),
          }))
        : [],
    [activateTarget, dailyDate],
  );
  usePaneChrome(useMemo(() => ({ query: queryControls, resourceRef, menuActions }), [resourceRef, menuActions, queryControls]));

  if (outline.status === "failed")
    return (
      <FeedbackNotice
        content={{ tone: "Danger", title: "This page couldn’t be loaded" }}
        announcement="Assertive"
        actions={[{ label: "Retry", onClick: () => void outline.reload() }]}
      />
    );
  if (!outline.root) return <PaneLoadingState label="Loading page…" announcement="Polite" />;
  return (
    <>
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
