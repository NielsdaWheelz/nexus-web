"use client";

// The visit owns unsent rich input. Explicit save transfers an immutable value
// and fixed create ids to the live writer; only acknowledgement advances its base.
import { useContext, useEffect, useRef, useSyncExternalStore } from "react";
import Button from "@/components/ui/Button";
import NoteEditor from "@/components/notes/NoteEditor";
import { TextComparison, copyWriting, useWriting } from "@/components/notes/NoteNotices";
import { FeedbackNotice, FeedbackStatus, useFeedback } from "@/components/feedback/Feedback";
import { OutlineSessionContext, OutlineSessionScope, ResourceBranch } from "./ResourceOutlineList";
import { useOutlineSession, type NoteEdit, type OutlineSession } from "@/lib/notes/useOutlineSession";
import { emptyNoteBodyHistory, recordNoteBodyEdit, type NoteBodyHistory } from "@/lib/notes/bodyHistory";
import { emptyBody, bodyHasContent, parseBody, sameBody, type NoteBody } from "@/lib/notes/noteBody";
import { adoptText } from "@/lib/notes/texts";
import { admitWriting, captureLane, canRetryWriting, readWriting, WritingDecisionError, type Publication, type WriteHandle } from "@/lib/notes/writes";
import { apiTransportFeedback, isApiError } from "@/lib/api/client";
import { fetchNote } from "@/lib/notes/api";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import type { InsertionSource } from "@/lib/resourceGraph/links";
import styles from "./ResourceComposer.module.css";

type ItemPublication = Extract<Publication, { kind: "insert_note" }>;
type Composer = {
  body: NoteBody; revision: number; selection: NoteEdit["selectionAfter"] | null; history: NoteBodyHistory;
  focus: { selection: NoteEdit["selectionAfter"]; serial: number } | null; searching: boolean;
  publication: ItemPublication; base: { body: NoteBody; version: number } | null;
  write: WriteHandle | null; failure: unknown; conflict: { body: NoteBody; version: number } | null;
};
type Props = { source: InsertionSource; occurrenceKey: string; label: string; onSaved?: () => void; onActiveChange?: (active: boolean) => void };
const idle = () => null;
const noSubscription = () => () => undefined;

export default function ResourceComposer(props: Props) {
  const session = useContext(OutlineSessionContext);
  return session ? <SessionComposer {...props} session={session} /> : <StandaloneComposer {...props} />;
}
function StandaloneComposer(props: Props) {
  const branch = useContext(ResourceBranch);
  const session = useOutlineSession({ scope: `resource-composer:${props.occurrenceKey}`, inheritedBranch: branch });
  return <OutlineSessionScope session={session}><SessionComposer {...props} session={session} /></OutlineSessionScope>;
}
function SessionComposer({ source, occurrenceKey, label, onSaved, onActiveChange, session }: Props & { session: OutlineSession }) {
  const writing = useWriting();
  const feedback = useFeedback();
  const draft = useResourceDraft<Composer>(`Resources.ItemDraft:${occurrenceKey}`, () => ({
    body: emptyBody(), revision: 0, selection: null, history: emptyNoteBodyHistory(), focus: null, searching: false,
    publication: { kind: "insert_note", initial_title: null, request: { kind: "insert_note", source: structuredClone(source), position: null,
      note_id: crypto.randomUUID(), link_id: crypto.randomUUID(), body_pm_json: emptyBody().body_pm_json } },
    base: null, write: null, failure: null, conflict: null,
  }));
  const mounted = useRef(true);
  const inspectClosed = useRef<(() => void) | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; inspectClosed.current?.(); }; }, []);
  const value = draft.value;
  const state = useSyncExternalStore(value.write?.subscribe ?? noSubscription, value.write?.read ?? idle, idle);
  const pending = state?.kind === "queued" || state?.kind === "sending" || state?.kind === "unconfirmed";
  const saved = value.base !== null && sameBody(value.body, value.base.body);
  const save = async () => {
    const submitted = draft.read();
    if (writing.paused || submitted.searching || pending || submitted.conflict || !bodyHasContent(submitted.body) && submitted.base === null) return;
    const generation = readWriting().generation;
    const ref = `note_block:${submitted.publication.request.note_id}`;
    try {
      const write = admitWriting(submitted.base === null
        ? { ...submitted.publication, request: { ...submitted.publication.request, body_pm_json: submitted.body.body_pm_json } }
        : { kind: "body", policy: "explicit", note_id: submitted.publication.request.note_id,
          body_pm_json: submitted.body.body_pm_json, expected: captureLane(ref, "body", submitted.base.version) });
      draft.set(current => ({ ...current, write, failure: null }));
      let notice: ReturnType<typeof feedback.retainCondition> | null = null;
      let irreducible: boolean | null = null;
      const copy = () => { if (readWriting().generation === generation) copyWriting(feedback, submitted.body.body_text); };
      const inspect = () => {
        const state = write.read();
        if (readWriting().generation !== generation || state.kind === "accepted" || state.kind === "refused" || state.kind === "abandoned") {
          notice?.withdraw(); return;
        }
        if (state.kind === "unconfirmed") irreducible = !canRetryWriting(write);
        if (irreducible === null || mounted.current && notice === null) return;
        const condition = { priority: "Write" as const, needsAttention: true, announcement: "Polite" as const,
          content: { tone: "Warning" as const, title: "item save not confirmed", message: irreducible
            ? "copy changes you want to keep, then reload. other unsaved changes will be lost." : "the request may have succeeded." },
          actions: irreducible ? [{ label: "copy text", onClick: copy },
            { label: "reload", onClick: () => { if (readWriting().generation === generation) window.location.reload(); } }] as const
            : [{ label: "retry same save", commandKey: `item-save:${write.id}:retry`, busy: state.kind === "queued" || state.kind === "sending",
              onClick: () => { if (readWriting().generation === generation) write.retry(); } }, { label: "copy text", onClick: copy }] as const,
        };
        if (notice) notice.update(condition); else notice = feedback.retainCondition({ key: `item-save:${write.id}`, ...condition });
      };
      inspectClosed.current = inspect;
      const stop = write.subscribe(inspect);
      void write.settled.then(() => { stop(); notice?.withdraw(); }, error => {
        stop(); notice?.withdraw();
        if (!mounted.current && readWriting().generation === generation) feedback.offer({ needsAttention: true, undo: null, onDismiss: null, key: `item-save:${write.id}`, announcement: "Polite",
          content: { tone: "Warning", title: "couldn’t save this item", message: isApiError(error) ? error.message : "review its destination before saving again." },
          actions: [{ label: "copy text", onClick: () => copyWriting(feedback, submitted.body.body_text) }] });
      });
      const ack = await write.settled;
      if (readWriting().generation !== generation) return;
      const id = ack.identities.find(identity => identity.kind === "note_block" && identity.requested_id === submitted.publication.request.note_id)?.canonical_id ?? submitted.publication.request.note_id;
      const note = ack.notes.find(note => note.id === id);
      if (note) {
        const body = parseBody(note.body_pm_json);
        adoptText(`note_block:${id}`, body, note.body_version);
        draft.set(current => ({ ...current, write: null, base: { body, version: note.body_version },
          publication: { ...current.publication, request: { ...current.publication.request, note_id: id } } }));
      }
      if (mounted.current && draft.read().revision === submitted.revision) onSaved?.();
      feedback.receipt({ tone: "Success", title: "note saved" });
    } catch (error) {
      if (readWriting().generation !== generation) return;
      draft.set(current => ({ ...current, failure: error }));
      if (isApiError(error) && error.code === "E_NOTE_CONFLICT" && submitted.base !== null) {
        try {
          const note = await fetchNote(submitted.publication.request.note_id);
          if (readWriting().generation !== generation) return;
          draft.set(current => ({ ...current, conflict: { body: parseBody(note.body_pm_json), version: note.body_version } }));
        } catch (readError) { draft.set(current => ({ ...current, failure: readError })); }
      }
    }
  };
  const edit = (change: NoteEdit) => draft.set(current => ({ ...current, body: change.after, selection: change.selectionAfter,
    history: recordNoteBodyEdit(current.history, change), focus: null, revision: current.revision + 1 }));
  const step = (redo: boolean) => {
    const current = draft.read();
    const change = (redo ? current.history.redo : current.history.undo).at(-1);
    if (!change) return;
    draft.set({ ...current, body: redo ? change.after : change.before,
      selection: redo ? change.selectionAfter : change.selectionBefore, revision: current.revision + 1,
      focus: { selection: redo ? change.selectionAfter : change.selectionBefore, serial: current.revision + 1 },
      history: { undo: redo ? [...current.history.undo, change] : current.history.undo.slice(0, -1),
        redo: redo ? current.history.redo.slice(0, -1) : [...current.history.redo, change], group: current.history.group + 1 } });
  };
  return <div className={styles.composer}>
    {source.kind === "resource" && source.ref.startsWith("conversation:") ? <p className={styles.status}>linked items supply context to future turns in this conversation</p> : null}
    <NoteEditor editorKey={`resource-composer:${occurrenceKey}`} body={value.body} revision={value.revision} label={label}
      containingNoteRef={value.base === null ? null : `note_block:${value.publication.request.note_id}`} editable={!writing.paused} focus={value.focus}
      history={{ undo: () => step(false), redo: () => step(true), boundary: () => draft.set(current => ({ ...current, history: { ...current.history, group: current.history.group + 1 } })) }}
      onEdit={edit} onSelectionChange={selection => draft.set(current => ({ ...current, selection }))} onSave={() => void save()}
      reference={{ source: value.publication.request.source, label, position: null,
        onActiveChange: active => { draft.set(current => ({ ...current, searching: active })); onActiveChange?.(active); },
        onSelected(target, targetItem, authored) {
          void session.insertReference({ destination: { source: value.publication.request.source, position: null, occurrencePrefix: occurrenceKey, path: [] }, target, targetItem, authored });
        },
      }} />
    <Button className={styles.textButton} onClick={() => void save()} disabled={writing.paused || value.searching || pending || saved || !bodyHasContent(value.body) && value.base === null}>save note</Button>
    {value.conflict ? <TextComparison value={value.body} saved={value.conflict.body} before={value.base?.body ?? null}
      shown={{ revision: value.revision, saved_version: value.conflict.version }} resolve={async (choice, shown) => {
        const current = draft.read();
        if (current.revision !== shown.revision || current.conflict?.version !== shown.saved_version) throw new WritingDecisionError("the comparison changed; review both versions again.");
        draft.set(entry => ({ ...entry, base: current.conflict, conflict: null, failure: null,
          ...(choice === "saved" ? { body: current.conflict!.body, revision: entry.revision + 1, selection: null, history: emptyNoteBodyHistory() } : {}) }));
        if (choice === "mine") await save();
      }} />
      : state?.kind === "unconfirmed" ? <FeedbackNotice content={{ tone: "Warning", title: "save not confirmed", message: !canRetryWriting(value.write!) ? "copy changes you want to keep, then reload. other unsaved changes will be lost." : "the request may have succeeded." }} announcement="Polite"
        actions={!canRetryWriting(value.write!) ? [
          { label: "copy text", onClick: () => copyWriting(feedback, value.body.body_text) },
          { label: "reload", onClick: () => { window.location.reload(); } },
        ] : [{ label: "retry same save", onClick: () => value.write?.retry() }, { label: "copy text", onClick: () => copyWriting(feedback, value.body.body_text) }]} />
        : value.failure ? <FeedbackNotice content={isApiError(value.failure) && apiTransportFeedback(value.failure, "couldn’t save this note") || { tone: "Warning", title: "couldn’t save this note", message: "review your input before saving again." }} announcement="Polite"
          actions={[{ label: "copy text", onClick: () => copyWriting(feedback, value.body.body_text) }]} />
          : pending ? <FeedbackStatus content={{ tone: "Neutral", title: "saving…" }} announcement="None" /> : null}
  </div>;
}
