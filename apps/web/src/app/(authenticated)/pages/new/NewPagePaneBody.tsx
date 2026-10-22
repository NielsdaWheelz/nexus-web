"use client";

// A visit owns unpublished input. Admission freezes one atomic first-item request;
// acknowledged bodies and any successor edits then belong to the shared text owner.
import { useEffect, useLayoutEffect } from "react";
import { FeedbackNotice, FeedbackStatus, type FeedbackContent } from "@/components/feedback/Feedback";
import { UnavailableTexts } from "@/components/notes/NoteNotices";
import NoteEditor from "@/components/notes/NoteEditor";
import { isApiError } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import type { Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { bodyHasContent, emptyBody, parseBody, type NoteBody } from "@/lib/notes/noteBody";
import * as texts from "@/lib/notes/texts";
import { enqueueWrite } from "@/lib/notes/writes";
import { requirePaneRuntime, usePaneRuntime, usePaneEntryDelivery } from "@/lib/panes/paneRuntime";
import { isDeletedResource, type LinkTarget } from "@/lib/resourceGraph/links";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { usePaneReturnReady, usePaneVisitWorkOwner, usePaneVisitWorkScope } from "@/lib/workspace/paneReturnMemento";
import styles from "@/components/notes/OutlineEditor.module.css";

interface Draft {
  page: string;
  note: string;
  link: string;
  title: string;
  body: NoteBody;
  request: Request | null;
  admitted: boolean;
  published: boolean;
  pending: boolean;
  failure: FeedbackContent | null;
  retry: () => void;
}
type Request = Schema<"CreatePageRequest">;
function newDraft(title: string): Draft {
  return { page: crypto.randomUUID(), note: crypto.randomUUID(), link: crypto.randomUUID(),
    title, body: emptyBody(), request: null, admitted: false, published: false,
    pending: false, failure: null, retry: () => undefined };
}

export default function NewPagePaneBody() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "NewPagePaneBody");
  const state = useResourceDraft<Draft>("Notes.NewPage", () => newDraft(""), value => ({
    changed: !value.published && value.title !== "",
    unconfirmed: false, stopsBrowserWork: false,
  }));
  usePaneVisitWorkOwner({ id: `${state.owner}:body`, scope: usePaneVisitWorkScope(), subscribe: state.subscribe,
    read: () => ({ changed: !state.read().published && bodyHasContent(state.read().body), unconfirmed: state.read().pending, stopsBrowserWork: false }),
  });
  const draft = state.value;
  const submitting = draft.pending;
  const failure = draft.failure;
  const setSubmitting = (pending: boolean) => state.set(value => ({ ...value, pending }));
  const setFailure = (failure: FeedbackContent | null) => state.set(value => ({ ...value, failure }));
  const { delivery, claim } = usePaneEntryDelivery();
  const { read: readDraft, set: setDraft } = state;
  useLayoutEffect(() => {
    if (delivery?.entry.kind !== "ComposePage") return;
    const title = delivery.entry.title;
    const current = readDraft();
    setDraft({ ...current, title });
    if (texts.readText(`page:${current.page}`)?.acked) texts.editText(`page:${current.page}`, title);
    claim(delivery);
  }, [delivery, claim, readDraft, setDraft]);
  const noteText = texts.useText(`note_block:${draft.note}`);
  usePaneReturnReady(true);

  function update(patch: Partial<Draft>) {
    const next = { ...state.read(), ...patch };
    state.set(next);
    if (state.read().admitted && patch.body) texts.editText(`note_block:${next.note}`, patch.body);
    if (patch.title !== undefined && texts.readText(`page:${next.page}`)?.acked) texts.editText(`page:${next.page}`, patch.title);
  }

  function publish(target: LinkTarget | null) {
    if (state.read().admitted) return;
    const snapshot = state.read();
    const title = snapshot.title.trim() || "untitled";
    const request: Request = {
      id: snapshot.page,
      title,
      initial_item: target
        ? { kind: "resource", link_id: snapshot.link, target }
        : { kind: "note", note_id: snapshot.note, link_id: snapshot.link, body_pm_json: snapshot.body.body_pm_json },
    };
    state.set({ ...snapshot, title, admitted: true, request, retry: submit });
    texts.createText(`note_block:${snapshot.note}`, snapshot.body, null);
    submit();
  }

  function submit() {
    const sent = state.read().request!;
    const sentBody = sent.initial_item.kind === "note" ? parseBody(sent.initial_item.body_pm_json) : emptyBody();
    setSubmitting(true);
    setFailure(null);
    enqueueWrite<Schema<"NotePageSummaryOut">>({
      cancelled: () => isDeletedResource(`page:${sent.id}`) || (sent.initial_item.kind === "note" && isDeletedResource(`note_block:${sent.initial_item.note_id}`)),
      cancel: () => { if (state.read().page === sent.id) setSubmitting(false); },
      build: () => ({ path: "/api/notes/pages", method: "POST", body: sent }),
      settle(page) {
        const latest = state.read();
        if (latest.page !== sent.id) {
          texts.adoptText(`page:${sent.id}`, sent.title, 1);
          if (sent.initial_item.kind === "note") texts.acknowledgeText(`note_block:${sent.initial_item.note_id}`, sentBody, 1);
          publishChange("Notes");
          return;
        }
        const pageRef = `page:${page.id}`;
        texts.adoptText(pageRef, sent.title, 1);
        if (latest.title !== sent.title) texts.editText(pageRef, latest.title);
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
              cancel: () => { if (state.read().page === sent.id) setSubmitting(false); },
              build: () => ({ path: "/api/resource-graph/commands", method: "POST", body: { commands: [{ kind: "insert_note", source: { kind: "resource", ref: pageRef }, note_id: latest.note, link_id: linkId, position: null, body_pm_json: body.body_pm_json }] } }),
              settle() {
                texts.acknowledgeText(noteRef, body, 1);
                if (state.read().page === sent.id && state.read().note === latest.note) texts.editText(noteRef, state.read().body);
                publishChange("Notes");
                if (state.read().page === sent.id) state.set(value => ({ ...value, pending: false, published: true }));
              },
              fail: error => { if (state.read().page === sent.id) refuse(error); },
            });
          };
          state.set(value => ({ ...value, retry: append }));
          append();
          return;
        }
        publishChange("Notes");
        state.set(value => ({ ...value, pending: false, published: true }));
      },
      fail: error => { if (state.read().page === sent.id) refuse(error); },
    });
  }

  // A refusal or a reported defect (it may have landed): retry resends this same request.
  function refuse(error: unknown) {
    if (handleUnauthenticatedApiError(error)) return;
    setSubmitting(false);
    setFailure({ tone: "Danger", title: "this page couldn’t finish saving", message: "your input remains in this tab. retry the same request.", requestId: isApiError(error) ? error.requestId : undefined });
  }

  useEffect(() => {
    if (state.read().admitted || !bodyHasContent(draft.body)) return;
    const timer = window.setTimeout(() => publish(null), 1500);
    return () => window.clearTimeout(timer);
  });

  useEffect(() => {
    if (draft.published) runtime.router.replace(`/pages/${draft.page}`);
  }, [draft.published, draft.page, runtime.router]);

  if (isDeletedResource(`page:${draft.page}`) || noteText?.gone) return <section className={styles.outline}><input className={styles.title} aria-label="Page title" value={draft.title} readOnly /><UnavailableTexts kind="page" refs={[`note_block:${draft.note}`]} /></section>;

  return <section className={styles.outline}>
    <div className={styles.masthead}>
      <input className={styles.title} aria-label="Page title" maxLength={200} placeholder="untitled" value={draft.title} onChange={event => update({ title: event.currentTarget.value })} />
      <FeedbackStatus content={{ tone: "Neutral", title: submitting ? "saving…" : "add an item to save this page" }} announcement="Polite" />
    </div>
    {failure ? <FeedbackNotice content={failure} announcement="Polite" actions={[{ label: "retry", onClick: () => state.read().retry(), busy: submitting }]} /> : null}
    <NoteEditor editorKey={draft.note} containingNoteRef={null} body={draft.body} revision={0} editable label="First item" placeholder="write a note, or @ link something" reference={state.read().admitted ? null : { source: null, label: "first page item", position: null, onSelected: target => publish(target) }} history={null} onEdit={edit => update({ body: edit.after })} />

  </section>;
}
