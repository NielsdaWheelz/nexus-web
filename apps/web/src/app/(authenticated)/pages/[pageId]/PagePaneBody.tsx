"use client";

// A page (/pages/{id}) or a dated page (/daily/{date}, latent until its first write;
// a page bound to a date behaves the same at /pages/{id}). Serves the entries
// ComposePage (the launcher’s title), EditPageTitle (focus and select the title),
// AppendNote (a new empty row, focused) and FocusNote (the caret at its end).
import { useEffect, useMemo, useRef, useState } from "react";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { FeedbackNotice, FeedbackState, useFeedback, type FeedbackActions, type FeedbackContent } from "@/components/feedback/Feedback";
import { UnavailableTexts } from "@/components/notes/NoteNotices";
import OutlineEditor, { useOutlineFilter } from "@/components/notes/OutlineEditor";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { catalogErrorFeedback } from "@/lib/catalog/copy";
import { useCatalogState } from "@/lib/catalog/provider";
import { catalogPage } from "@/lib/catalog/selectors";
import { remoteReady } from "@/lib/native/admission";
import { isStaleBuild, STALE_BUILD_FEEDBACK } from "@/lib/api/client";
import { useResourceInspector } from "@/components/resource-inspector/useResourceInspector";
import { shiftLocalDate } from "@/lib/localDate";
import { editText, hasUnsavedText, readText, textDraft, useTextReady } from "@/lib/notes/texts";
import { readDraft, readWriting } from "@/lib/notes/journal";
import { isDeletedResource } from "@/lib/resourceGraph/links";
import { useOutline } from "@/lib/notes/useOutline";
import { outlineTextRefs, type PageCreation } from "@/lib/notes/useOutlineSession";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import {
  requirePaneRuntime,
  usePaneDailyPage,
  usePaneEntryDelivery,
  usePaneParam,
  usePaneRuntime,
  usePaneSearchParams,
} from "@/lib/panes/paneRuntime";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";

export default function PagePaneBody() {
  const pageId = usePaneParam("pageId");
  const localDate = usePaneParam("localDate");
  const params = usePaneSearchParams();
  const route = pageId ?? (localDate === null ? "new" : `daily:${localDate}`);
  const initialCreation = (): PageCreation | null => {
    if (localDate !== null) return null;
    if (pageId !== null) {
      const candidates = readWriting().drafts.filter(draft => (draft.context.kind === "body" || draft.context.kind === "title") && draft.context.publication?.kind === "page" && draft.context.publication.request.id === pageId);
      if (candidates.some(draft => draft.base !== null)) return null;
      for (const draft of candidates) {
        if (draft.context.kind !== "body" && draft.context.kind !== "title") continue;
        const publication = draft.context.publication;
        if (publication?.kind !== "page" || publication.request.initial_item.kind !== "note") continue;
        const title = candidates.find(candidate => candidate.value.kind === "title")?.value;
        return { page_id: pageId, note_id: publication.request.initial_item.note_id, link_id: publication.request.initial_item.link_id, title: title?.kind === "title" ? title.text : publication.request.title };
      }
      return null;
    }
    return { page_id: crypto.randomUUID(), note_id: crypto.randomUUID(), link_id: crypto.randomUUID(), title: params.get("title") ?? "" };
  };
  const [owner, setOwner] = useState(() => ({ route, creation: initialCreation() }));
  if (owner.route !== route) {
    setOwner({ route, creation: owner.creation?.page_id === pageId ? owner.creation : initialCreation() });
    return null;
  }
  const creation = owner.creation;
  const owned = creation !== null && (pageId === null || pageId === creation.page_id) && localDate === null ? creation : null;
  const resource = owned?.page_id ?? pageId ?? localDate;
  return <PageContent key={resource} creation={owned} />;
}

function PageContent({ creation }: { creation: PageCreation | null }) {
  const routePageId = usePaneParam("pageId");
  const pageId = creation?.page_id ?? routePageId;
  const localDate = usePaneParam("localDate");
  const catalog = useCatalogState();
  const saved = pageId === null || catalog.data === null ? null : catalogPage(catalog.data, pageId);
  const runtime = requirePaneRuntime(usePaneRuntime(), "PagePaneBody");
  const { delivery, claim } = usePaneEntryDelivery();
  const feedback = useFeedback();
  const outline = useOutline({
    root: pageId ? `page:${pageId}` : null,
    dailyDate: pageId ? null : localDate,
    creation,
  });
  const titleReady = useTextReady(creation ? `page:${creation.page_id}` : "");
  const titleSeeded = useRef(false);
  useEffect(() => {
    if (!creation || !titleReady || titleSeeded.current || readWriting().paused) return;
    titleSeeded.current = true;
    const ref = `page:${creation.page_id}`;
    const handle = textDraft(ref);
    const value = readText(ref)?.value;
    // The launcher supplied authored title text; a blank route supplies none.
    if (handle && readDraft(handle.draft_id)?.revision === 0 && typeof value === "string" && value.length > 0)
      editText(ref, value);
  }, [creation, titleReady]);
  useEffect(() => {
    if (creation && outline.creationPublished && routePageId === null)
      runtime.router.replace(`/pages/${creation.page_id}`, { activate: false });
  }, [creation, outline.creationPublished, routePageId, runtime.router]);
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
  usePaneReturnReady(outline.status !== "loading" || !remoteReady() && !catalog.loading && creation === null);
  usePaneDailyPage(dailyDate && id ? { localDate: dailyDate, pageId: id } : null);

  useEffect(() => {
    if (!creation || !titleReady || readWriting().paused || delivery?.entry.kind !== "ComposePage") return;
    if (claim(delivery)) editText(`page:${creation.page_id}`, delivery.entry.title);
  }, [claim, creation, delivery, titleReady]);

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
  const savedOnly = !gone && !remoteReady() && outline.root === null && creation === null && !catalog.loading &&
    outline.failure?.status !== 403 && outline.failure?.status !== 404 && !isStaleBuild(outline.failure);
  const materialized = id !== null && !gone && !outline.latent && outline.status === "ready" && (creation === null || outline.creationPublished);
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
  usePaneChrome(useMemo(() => ({ displayTitle: savedOnly && saved !== null ? saved.title || "untitled page" : undefined, query: queryControls, resourceRef, menuActions }), [savedOnly, saved, resourceRef, menuActions, queryControls]));

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
  if (failure !== null && (unavailable || stale)) return <FeedbackState content={failure} announcement="Polite" actions={actions} />;
  if (savedOnly) return <>
    {saved === null ? null : <h1>{saved.title || "untitled page"}</h1>}
    <FeedbackState content={saved === null ? catalogErrorFeedback(catalog.data !== null ? { code: "E_CATALOG_COVERAGE" } : catalog.error ?? { code: "E_CATALOG_UNAVAILABLE" }) ?? { tone: "Warning", title: "saved catalog couldn’t be opened" } : { tone: "Neutral", title: "this text is not available offline" }} announcement="Polite" />
  </>;
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
