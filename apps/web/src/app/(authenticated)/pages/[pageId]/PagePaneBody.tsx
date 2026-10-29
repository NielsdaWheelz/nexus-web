"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";

// Opening a daily page resolves its permanent identity but writes nothing. Its
// first title edit or item commits the latent page and that edit/item together.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Intent } from "@nexus/authored/commands";
import type { ResourceProjection } from "@nexus/authored/types";
import { pageTitle } from "@nexus/authored/queries";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { FeedbackNotice, FeedbackState } from "@/components/feedback/Feedback";
import { useLocalOutlineRoot, type LocalOutlineHandle } from "@/components/notes/LocalOutline";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { useResourceInspector } from "@/components/resource-inspector/useResourceInspector";
import { shiftLocalDate } from "@/lib/localDate";
import { useAuthoredAccountId } from "@/lib/authored/provider";
import { dailyPage } from "@/lib/notes/api";
import { useAuthoredQuery, useWritingRuntime } from "@/lib/notes/hooks";
import { type WritingRuntime } from "@/lib/notes/runtime";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { requirePaneRuntime, usePaneDailyPage, usePaneEntryDelivery, usePaneParam, usePaneRuntime, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { usePaneReturnReady, usePaneVisitData } from "@/lib/workspace/paneReturnMemento";
import { NEW_PAGE_IDENTITY, type NewPageIdentity } from "@/lib/panes/pageAuthoring";

type ResolvedPage = { ref: string; prelude: Intent[] };

export default function PagePaneBody() {
  const writing = useWritingRuntime();
  const accountId = useAuthoredAccountId();
  const page = usePaneParam("pageId");
  const date = usePaneParam("localDate");
  if (writing === null) return <PaneLoadingState label="preparing your notes" announcement="None" />;
  return <PageAccount key={accountId} writing={writing} pageId={page} localDate={date} />;
}

function PageAccount({ writing, pageId, localDate }: { writing: WritingRuntime; pageId: string | null; localDate: string | null }) {
  const accountId = useAuthoredAccountId();
  const retained: NewPageIdentity | null = usePaneVisitData(NEW_PAGE_IDENTITY, (): NewPageIdentity => ({ accountId, id: createdId }));
  const [createdId] = useState<string>(() => retained?.accountId === accountId ? retained.id : crypto.randomUUID());
  const identity = localDate === null ? pageId === "new" || pageId === null ? createdId : pageId : `daily:${localDate}`;
  return <PageContent key={identity} writing={writing} createdId={createdId} pageId={pageId === "new" ? null : pageId} localDate={localDate} />;
}

function PageContent({ writing, createdId, pageId, localDate }: { writing: WritingRuntime; createdId: string; pageId: string | null; localDate: string | null }) {
  const {delivery, claim} = usePaneEntryDelivery();
  const newPage = pageId === null && localDate === null;
  const direct = useMemo<ResolvedPage>(() => ({
    ref: `page:${pageId ?? createdId}`,
    prelude: newPage ? [{ kind: "create_page", ref: `page:${createdId}`, title: "", local_date: null }] : [],
  }), [createdId, newPage, pageId]);
  const [dailyAttempt, setDailyAttempt] = useState(0);
  const [daily, setDaily] = useState<{ writing: WritingRuntime; date: string; value: ResolvedPage | null; error: unknown | null } | null>(null);
  useEffect(() => {
    if (localDate === null) return;
    let retired = false;
    void dailyPage(writing, localDate).then(value => {
      if (!retired) setDaily({ writing, date: localDate, value, error: null });
    }).catch(error => { if (!retired) setDaily({ writing, date: localDate, value: null, error }); });
    return () => { retired = true; };
  }, [dailyAttempt, localDate, writing]);
  const currentDaily = daily?.writing === writing && daily.date === localDate ? daily : null;
  const resolved = localDate === null ? direct : currentDaily?.value ?? null;
  const ref = resolved?.ref ?? null;
  const read = useAuthoredQuery(ref === null ? null : { kind: "resource", ref });
  const page = read.data?.rows.find(row => row.resource.kind === "page")?.resource ?? null;
  const prelude = page === null ? resolved?.prelude ?? [] : [];
  const latent = prelude.length > 0;
  const ready = resolved !== null && read.data !== null;
  const gone = ready && page === null && !latent;
  useEffect(() => {
    if (!gone || !delivery) return;
    const kind = delivery.entry.kind;
    if (kind === "EditPageTitle" || kind === "AppendNote" || kind === "FocusNote" || kind === "ComposePage") claim(delivery);
  }, [claim, delivery, gone]);
  const date = page?.local_date ?? localDate;
  const id = ref?.slice("page:".length) ?? null;
  usePaneReturnReady(ready || read.error !== null || (currentDaily !== null && currentDaily.error !== null));
  usePaneDailyPage(date !== null && id !== null ? { localDate: date, pageId: id } : null);
  const error = currentDaily?.error ?? read.error;
  if (error !== null && error !== undefined) return <FeedbackState content={{ tone: "Danger", title: "couldn’t open this page on this device" }} announcement="Assertive"
    actions={[{ label: "retry", onClick: localDate === null ? read.retry : () => setDailyAttempt(attempt => attempt + 1) }]} />;
  if (!ready || ref === null || id === null) return <PaneLoadingState label="loading page…" announcement="None" />;
  if (gone) return <FeedbackState content={{ tone: "Neutral", title: "this page is no longer available" }} announcement="Polite" />;
  return <PageEditing rootRef={ref} id={id} page={page} date={date} newPage={newPage} prelude={prelude} />;
}

function PageEditing({rootRef, id, page, date, newPage, prelude}: {
  rootRef: string; id: string; page: ResourceProjection | null;
  date: string | null; newPage: boolean; prelude: readonly Intent[];
}) {
  const pane = requirePaneRuntime(usePaneRuntime(), "PagePaneBody");
  const params = usePaneSearchParams();
  const { delivery, claim } = usePaneEntryDelivery();
  const [initialTitle, setInitialTitle] = useState(() => newPage ? params.get("title") ?? "" : "");
  const [entryMessage, setEntryMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [entryError, setEntryError] = useState<unknown | null>(null);
  const outline = useRef<LocalOutlineHandle | null>(null);
  const rootField = useMemo(() => ({label: "page title", initialTitle, placeholder: pageTitle("", date)}), [date, initialTitle]);
  const root = useLocalOutlineRoot({rootRef, prelude, apiRef: outline, filter, rootField});
  const { inputRef, focusInput } = usePaneQueryInput();
  const displayTitle = root.rootTitle ?? pageTitle(page?.title ?? initialTitle, date);
  const menuActions = useMemo<ActionDescriptor[]>(() => date === null ? [] : ([-1, 1] as const).map(days => ({
    kind: "link", id: days < 0 ? "ViewAction.Page.OpenYesterday" : "ViewAction.Page.OpenTomorrow",
    label: days < 0 ? "Open yesterday" : "Open tomorrow", icon: days < 0 ? <ArrowLeft size={16} aria-hidden="true" /> : <ArrowRight size={16} aria-hidden="true" />, href: `/daily/${shiftLocalDate(date, days)}`,
  })), [date]);
  usePaneChrome({
    displayTitle, menuActions, editor: root.rootEditor ?? undefined,
    header: {kind: "Resource", resource: {status: "Ready", creditGroups: []}},
    resourceRef: page !== null && id !== null ? canonicalResourceRef({ scheme: "page", id }) : undefined,
    query: { kind: "Controls", focusInput, content: <PaneQueryToolbar inputRef={inputRef}
      input={{ label: "Filter page items", placeholder: "Filter page items", value: filter, appliedValue: filter, onChange: setFilter, onClear: () => setFilter("") }}
      onReset={filter ? () => setFilter("") : undefined} /> },
  });
  useEffect(() => {
    if (newPage && page !== null && id !== null) pane.router.replace(`/pages/${id}`, { activate: false });
  }, [id, newPage, page, pane.router]);
  useEffect(() => {
    if (!delivery || !root.rootReady) return;
    const entry = delivery.entry;
    if (entry.kind === "ComposePage") {
      if (claim(delivery) && newPage) setInitialTitle(entry.title);
      return;
    }
    if (entry.kind === "EditPageTitle") {
      const handle = outline.current;
      if (!handle) return;
      if (!claim(delivery)) return;
      if (entry.pageId !== id) { setEntryMessage("this page is no longer available."); return; }
      void handle.focusRoot(document => ({anchor: 1, head: document.doc.getText("title").length + 1})).catch(setEntryError);
    } else if (entry.kind === "AppendNote") {
      setFilter("");
      if (outline.current && claim(delivery)) void outline.current.append().catch(setEntryError);
    } else if (entry.kind === "FocusNote") {
      setFilter("");
      const controller = new AbortController();
      const handle = outline.current;
      if (handle === null) return;
      void handle.focusNote(`note_block:${entry.noteBlockId}`, controller.signal).then(found => {
        if (controller.signal.aborted || !claim(delivery)) return;
        if (!found) { setEntryMessage("this note is no longer on this page."); return; }
      }).catch(error => { if (!controller.signal.aborted) setEntryError(error); });
      return () => controller.abort();
    }
  }, [claim, delivery, id, newPage, root.rootReady]);
  return <div>
    {page !== null && id !== null ? <Inspector pageId={id} /> : null}
    {entryError !== null ? <FeedbackNotice content={{ tone: "Warning", title: "couldn’t complete this page action" }} announcement="Polite" /> : null}
    {entryMessage !== null ? <FeedbackNotice content={{ tone: "Neutral", title: entryMessage }} announcement="Polite" /> : null}
    {filter.trim() ? <p>filter applies to loaded items.</p> : null}
    {root.view}

  </div>;
}

function Inspector({ pageId }: { pageId: string }) {
  const connections = useMemo(() => <ConnectionsSurface resourceRef={{ scheme: "page", id: pageId }} />, [pageId]);
  useResourceInspector({ scheme: "page", handle: pageId, bodies: { linkedItems: connections } });
  return null;
}
