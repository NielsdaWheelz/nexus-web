"use client";

// Opening a daily page resolves its permanent identity but writes nothing. Its
// first title edit or item commits the latent page and that edit/item together.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Intent } from "@nexus/authored/commands";
import { pageTitle } from "@nexus/authored/queries";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { FeedbackNotice, FeedbackState } from "@/components/feedback/Feedback";
import BoundPageTitleEditor from "@/components/notes/BoundPageTitleEditor";
import LocalOutline, { type LocalOutlineHandle } from "@/components/notes/LocalOutline";
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
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";

type ResolvedPage = { ref: string; prelude: Intent[] };

export default function PagePaneBody() {
  const writing = useWritingRuntime();
  const accountId = useAuthoredAccountId();
  const page = usePaneParam("pageId");
  const date = usePaneParam("localDate");
  const key = date === null ? page ?? "new" : `daily:${date}`;
  if (writing === null) return <PaneLoadingState label="preparing your notes" announcement="None" />;
  return <PageContent key={`${accountId}:${key}`} writing={writing} pageId={page === "new" ? null : page} localDate={date} />;
}

function PageContent({ writing, pageId, localDate }: { writing: WritingRuntime; pageId: string | null; localDate: string | null }) {
  const pane = requirePaneRuntime(usePaneRuntime(), "PagePaneBody");
  const params = usePaneSearchParams();
  const { delivery, claim } = usePaneEntryDelivery();
  const [createdId] = useState(() => crypto.randomUUID());
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
  const date = page?.local_date ?? localDate;
  const id = ref?.slice("page:".length) ?? null;
  const [initialTitle, setInitialTitle] = useState(() => newPage ? params.get("title") ?? "" : "");
  const [entryMessage, setEntryMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [entryError, setEntryError] = useState<unknown | null>(null);
  const titleInput = useRef<HTMLTextAreaElement>(null);
  const outline = useRef<LocalOutlineHandle | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const saved = useSyncExternalStore(writing.subscribe, writing.snapshot, writing.snapshot);
  const localError = ref !== null && saved.error_refs.includes(ref) ? saved.error : null;
  const { inputRef, focusInput } = usePaneQueryInput();
  const displayTitle = pageTitle(page?.title ?? initialTitle, date);
  usePaneReturnReady(ready || read.error !== null || (currentDaily !== null && currentDaily.error !== null));
  usePaneDailyPage(date !== null && id !== null ? { localDate: date, pageId: id } : null);
  const menuActions = useMemo<ActionDescriptor[]>(() => date === null ? [] : ([-1, 1] as const).map(days => ({
    kind: "link", id: days < 0 ? "ViewAction.Page.OpenYesterday" : "ViewAction.Page.OpenTomorrow",
    label: days < 0 ? "Open yesterday" : "Open tomorrow", href: `/daily/${shiftLocalDate(date, days)}`,
  })), [date]);
  usePaneChrome({
    displayTitle, menuActions,
    resourceRef: page !== null && id !== null ? canonicalResourceRef({ scheme: "page", id }) : undefined,
    query: { kind: "Controls", label: "Filter page items", focusInput, content: <PaneQueryToolbar inputRef={inputRef}
      input={{ label: "Filter page items", placeholder: "Filter page items", value: filter, appliedValue: filter, onChange: setFilter, onClear: () => setFilter("") }}
      onReset={filter ? () => setFilter("") : undefined} /> },
  });
  useEffect(() => {
    if (newPage && page !== null && id !== null) pane.router.replace(`/pages/${id}`, { activate: false });
  }, [id, newPage, page, pane.router]);
  useEffect(() => {
    if (!delivery || !ready) return;
    const entry = delivery.entry;
    if (entry.kind === "ComposePage" && newPage) {
      if (claim(delivery)) setInitialTitle(entry.title);
      return;
    }
    if (gone) { if (claim(delivery)) setEntryMessage("this page is no longer available."); return; }
    if (entry.kind === "EditPageTitle") {
      if (!claim(delivery)) return;
      if (entry.pageId !== id) { setEntryMessage("this page is no longer available."); return; }
      titleInput.current?.focus(); titleInput.current?.select();
    } else if (entry.kind === "AppendNote") {
      if (outline.current && claim(delivery)) void outline.current.append().catch(setEntryError);
    } else if (entry.kind === "FocusNote") {
      setFilter("");
      const focus = () => {
        if (!outline.current?.focusNote(`note_block:${entry.noteBlockId}`)) return false;
        const editor = [...surface.current?.querySelectorAll<HTMLElement>("[data-resource-ref]") ?? []]
          .find(row => row.dataset.resourceRef === `note_block:${entry.noteBlockId}`)?.querySelector<HTMLElement>('[role="textbox"]');
        if (editor?.isContentEditable) {
          const range = editor.ownerDocument.createRange(); range.selectNodeContents(editor); range.collapse(false);
          const selection = editor.ownerDocument.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
        }
        claim(delivery);
        return true;
      };
      if (focus()) return;
      const observer = new MutationObserver(focus);
      if (surface.current) observer.observe(surface.current, { childList: true, subtree: true });
      return () => observer.disconnect();
    }
  }, [claim, delivery, gone, id, newPage, ready]);
  const enterTitle = () => {
    if (ref === null) return;
    void (async () => {
      const first = await (await writing.store).query({ kind: "adjacency", ref, cursor: null, limit: 1 });
      if (first.rows.length) outline.current?.focusFirst();
      else await outline.current?.append();
    })().catch(setEntryError);
  };
  const error = currentDaily?.error ?? read.error;
  if (error !== null && error !== undefined) return <FeedbackState content={{ tone: "Danger", title: "couldn’t open this page on this device" }} announcement="Assertive"
    actions={[{ label: "retry", onClick: localDate === null ? read.retry : () => setDailyAttempt(attempt => attempt + 1) }]} />;
  if (!ready || ref === null) return <PaneLoadingState label="loading page…" announcement="None" />;
  if (gone) return <FeedbackState content={{ tone: "Neutral", title: "this page is no longer available" }} announcement="Polite" />;
  return <div ref={surface}>
    {page !== null && id !== null ? <Inspector pageId={id} /> : null}
    {localError !== null ? <FeedbackNotice content={{ tone: "Warning", title: "couldn’t save on this device", message: "keep this page open. retry saving." }} announcement="Assertive"
      actions={[{ label: "retry saving", onClick: () => { void writing.retry(); } }, { label: "copy text", onClick: () => { void navigator.clipboard.writeText(titleInput.current?.value ?? ""); } }]} /> : null}
    {entryError !== null ? <FeedbackNotice content={{ tone: "Warning", title: "couldn’t complete this page action" }} announcement="Polite" /> : null}
    {entryMessage !== null ? <FeedbackNotice content={{ tone: "Neutral", title: entryMessage }} announcement="Polite" /> : null}
    <BoundPageTitleEditor pageRef={ref} prelude={prelude} initialTitle={initialTitle} placeholder={pageTitle("", date)} inputRef={titleInput} onEnter={enterTitle} />
    {filter.trim() ? <p>filter applies to loaded items.</p> : null}
    <LocalOutline rootRef={ref} prelude={prelude} apiRef={outline} filter={filter} />
  </div>;
}

function Inspector({ pageId }: { pageId: string }) {
  const connections = useMemo(() => <ConnectionsSurface resourceRef={{ scheme: "page", id: pageId }} />, [pageId]);
  useResourceInspector({ scheme: "page", handle: pageId, bodies: { linkedItems: connections } });
  return null;
}
