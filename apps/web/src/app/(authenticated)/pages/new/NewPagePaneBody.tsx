"use client";

// A visit owns unpublished input. Admission freezes one atomic first-item request;
// acknowledged bodies and any successor edits then belong to the shared text owner.
import { useCallback, useEffect, useRef, useState } from "react";
import { FeedbackNotice, FeedbackStatus, type FeedbackContent } from "@/components/feedback/Feedback";
import { UnavailableTexts } from "@/components/notes/NoteNotices";
import NoteEditor from "@/components/notes/NoteEditor";
import { isApiError } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { modeledApiError, useThrowLater } from "@/lib/api/serverState";
import type { Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { bodyHasContent, emptyBody, parseBody, type NoteBody } from "@/lib/notes/noteBody";
import * as texts from "@/lib/notes/texts";
import { enqueueWrite } from "@/lib/notes/writes";
import { requirePaneRuntime, usePaneRuntime, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import { isDeletedResource, type LinkTarget } from "@/lib/resourceGraph/links";
import { definePaneVisitDataKey, usePaneReturnReady, usePaneVisitData } from "@/lib/workspace/paneReturnMemento";
import styles from "@/components/notes/OutlineEditor.module.css";

interface Draft {
  page: string;
  note: string;
  link: string;
  title: string;
  body: NoteBody;
}
const VISIT = definePaneVisitDataKey<Draft>("Notes.NewPage");
type Request = Schema<"CreatePageRequest">;

export default function NewPagePaneBody() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "NewPagePaneBody");
  const params = usePaneSearchParams();
  const current = useRef<Draft | null>(null);
  const saved = usePaneVisitData(VISIT, useCallback(() => current.current, []));
  const [draft, setDraft] = useState<Draft>(() => saved ?? {
    page: crypto.randomUUID(), note: crypto.randomUUID(), link: crypto.randomUUID(),
    title: params.get("title") ?? "", body: emptyBody(),
  });
  current.current = draft;
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  const request = useRef<Request | null>(null);
  const admitted = useRef(false);
  const retry = useRef<() => void>(() => undefined);
  const mounted = useRef(true);
  const fail = useThrowLater();
  const noteText = texts.useText(`note_block:${draft.note}`);
  usePaneReturnReady(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  function update(patch: Partial<Draft>) {
    const next = { ...current.current!, ...patch };
    current.current = next;
    setDraft(next);
    if (admitted.current && patch.body) texts.editText(`note_block:${next.note}`, patch.body);
    if (patch.title !== undefined && texts.readText(`page:${next.page}`)?.acked) texts.editText(`page:${next.page}`, patch.title);
  }

  function publish(target: LinkTarget | null) {
    if (admitted.current) return;
    admitted.current = true;
    const snapshot = current.current!;
    const title = snapshot.title.trim() || "untitled";
    current.current = { ...snapshot, title };
    setDraft(current.current);
    request.current = {
      id: snapshot.page,
      title,
      initial_item: target
        ? { kind: "resource", link_id: snapshot.link, target }
        : { kind: "note", note_id: snapshot.note, link_id: snapshot.link, body_pm_json: snapshot.body.body_pm_json },
    };
    texts.createText(`note_block:${snapshot.note}`, snapshot.body, null);
    retry.current = submit;
    submit();
  }

  function submit() {
    const sent = request.current!;
    const sentBody = sent.initial_item.kind === "note" ? parseBody(sent.initial_item.body_pm_json) : emptyBody();
    setSubmitting(true);
    setFailure(null);
    enqueueWrite<Schema<"NotePageSummaryOut">>({
      cancelled: () => isDeletedResource(`page:${sent.id}`) || (sent.initial_item.kind === "note" && isDeletedResource(`note_block:${sent.initial_item.note_id}`)),
      cancel: () => { if (mounted.current) setSubmitting(false); },
      build: () => ({ path: "/api/notes/pages", method: "POST", body: sent }),
      settle(page) {
        const latest = current.current!;
        const pageRef = `page:${page.id}`;
        texts.adoptText(pageRef, sent.title, 1);
        if (latest.title !== sent.title && latest.title.trim()) texts.editText(pageRef, latest.title);
        if (sent.initial_item.kind === "note") {
          texts.acknowledgeText(`note_block:${latest.note}`, sentBody, 1);
          texts.editText(`note_block:${latest.note}`, latest.body);
        } else if (bodyHasContent(latest.body)) {
          const noteRef = `note_block:${latest.note}`;
          const body = latest.body;
          const linkId = crypto.randomUUID();
          const append = () => {
            setSubmitting(true);
            setFailure(null);
            enqueueWrite<Schema<"OutlineCommandsOut">>({
              cancelled: () => isDeletedResource(pageRef) || isDeletedResource(noteRef),
              cancel: () => { if (mounted.current) setSubmitting(false); },
              build: () => ({ path: "/api/resource-graph/commands", method: "POST", body: { commands: [{ kind: "insert_note", source: { kind: "resource", ref: pageRef }, note_id: latest.note, link_id: linkId, position: null, body_pm_json: body.body_pm_json }] } }),
              settle() {
                texts.acknowledgeText(noteRef, body, 1);
                texts.editText(noteRef, current.current!.body);
                publishChange("Notes");
                if (mounted.current) runtime.router.replace(`/pages/${page.id}`);
              },
              fail: refuse,
            });
          };
          retry.current = append;
          append();
          return;
        }
        publishChange("Notes");
        if (mounted.current) runtime.router.replace(`/pages/${page.id}`);
      },
      fail: refuse,
    });
  }

  function refuse(error: unknown) {
    if (handleUnauthenticatedApiError(error)) return;
    if (!modeledApiError(error, fail)) return;
    if (mounted.current) {
      setSubmitting(false);
      setFailure({ tone: "Danger", title: "this page couldn’t finish saving", message: "your input remains in this tab. retry the same request.", requestId: isApiError(error) ? error.requestId : undefined });
    }
  }

  useEffect(() => {
    if (admitted.current || !bodyHasContent(draft.body)) return;
    const timer = window.setTimeout(() => publish(null), 1500);
    return () => window.clearTimeout(timer);
  });

  if (isDeletedResource(`page:${draft.page}`) || noteText?.gone) return <section className={styles.outline}><input className={styles.title} aria-label="Page title" value={draft.title} readOnly /><UnavailableTexts kind="page" refs={[`note_block:${draft.note}`]} /></section>;

  return <section className={styles.outline}>
    <div className={styles.masthead}>
      <input className={styles.title} aria-label="Page title" maxLength={200} placeholder="untitled" value={draft.title} onChange={event => update({ title: event.currentTarget.value })} />
      <FeedbackStatus content={{ tone: "Neutral", title: submitting ? "saving…" : "add an item to save this page" }} announcement="Polite" />
    </div>
    {failure ? <FeedbackNotice content={failure} announcement="Polite" actions={[{ label: "retry", onClick: () => retry.current(), busy: submitting }]} /> : null}
    <NoteEditor editorKey={draft.note} containingNoteRef={null} body={draft.body} revision={0} editable label="First item" placeholder="write a note, or @ link something" reference={admitted.current ? null : { source: null, label: "first page item", position: null, onSelected: target => publish(target) }} history={null} onEdit={edit => update({ body: edit.after })} />

  </section>;
}
