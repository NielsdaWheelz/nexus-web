"use client";

// The editor host (pane visit or reader document) owns unsent rich input; nothing unsaved is
// stored, and the host's loss guard covers it until it is saved or cleared. Explicit save commits
// the new note and its first link to the destination in one local transaction,
// after any caller prelude (a latent day's page). A
// failed commit keeps its input visible and frozen until its retry lands the same
// bytes. Once saved, the note keeps editing in place through its bound editor.
import Button from "@/components/ui/Button";
import NoteEditor from "@/components/notes/NoteEditor";
import BoundNoteEditor from "@/components/notes/BoundNoteEditor";
import { FeedbackNotice, FeedbackStatus, type FeedbackContent } from "@/components/feedback/Feedback";
import { bodyHasContent, emptyBody, type NoteBody } from "@nexus/authored/body";
import { createNoteIntent, type Intent } from "@nexus/authored/commands";
import { emptyNoteBodyHistory, recordNoteBodyEdit, type NoteBodyHistory } from "@/lib/notes/bodyHistory";
import { useWritingRuntime } from "@/lib/notes/hooks";
import type { NoteEdit } from "@/lib/notes/editorTypes";
import { LocalCommitError } from "@/lib/notes/runtime";
import { createLink, prepareTarget, type LinkTarget } from "@/lib/resourceGraph/links";
import { useEditorDraft } from "@/lib/notes/editorHost";
import type { WorkRisk } from "@/lib/unsavedWork";
import type { ResourceItem } from "@/lib/resources/items";
import styles from "./ResourceComposer.module.css";

type Composer = {
  body: NoteBody; revision: number; searching: boolean;
  history: NoteBodyHistory;
  focus: { selection: NoteEdit["selectionAfter"]; serial: number } | null;
  /** Minted once per draft; a retried commit keeps it. */
  noteRef: string;
  state: "editing" | "saving" | "saved";
  /** A failed local commit's frozen retry and its captured target, held until it lands; `kind` picks how the current render finishes it. */
  failure: { content: FeedbackContent; retry: { kind: "save" | "link"; attempt: () => Promise<unknown>; target: string } | null } | null;
};
type Props = {
  destinationRef: string; occurrenceKey: string; label: string;
  /** The host's literal label for a non-authored destination, captured in its source stub. */
  destinationLabel?: string;
  /** Intents committed first in the same transaction, e.g. a latent day's page creation. */
  prelude?: readonly Intent[];
  /** `keep`: the saved note keeps editing in place. `clear`: a surface that lists the new
   * note itself starts a fresh draft instead of showing it twice. */
  afterSave?: "keep" | "clear";
  /** After each durable local insertion, the new note or a linked reference, with its committed target ref. */
  onSaved?: (targetRef: string) => void;
  onActiveChange?: (active: boolean) => void;
};
const LOCAL_FAILURE: FeedbackContent = { tone: "Warning", title: "couldn’t save on this device", message: "keep this page open. retry saving." };

/** Unsent input and a held failed commit would be lost; an in-flight local commit is unconfirmed. */
function composerRisk(value: Composer): WorkRisk {
  return {
    changed: value.state === "editing" && (bodyHasContent(value.body) || value.failure?.retry != null),
    unconfirmed: value.state === "saving",
    stopsBrowserWork: false,
  };
}
const fresh = (revision: number): Composer => ({
  body: emptyBody(), revision, searching: false, history: emptyNoteBodyHistory(), focus: null,
  noteRef: `note_block:${crypto.randomUUID()}`, state: "editing", failure: null,
});

export default function ResourceComposer({ destinationRef, occurrenceKey, label, destinationLabel, prelude = [], afterSave = "keep", onSaved, onActiveChange }: Props) {
  const writing = useWritingRuntime();
  const draft = useEditorDraft<Composer>(`Resources.ItemDraft:${occurrenceKey}`, () => fresh(0), composerRisk);
  const value = draft.value;
  /** Local writing never waits for a server label: the host's capture, the existing stub, else the literal ref. */
  const sourceLabel = async (): Promise<string | null> => {
    if (/^(note_block|page|highlight):/u.test(destinationRef) || writing === null) return null;
    if (destinationLabel !== undefined) return destinationLabel;
    const local = await (await writing.store).query({ kind: "resource", ref: destinationRef });
    return local.rows[0]?.resource.title ?? destinationRef;
  };
  /** Finishing reads this render's props, so a retry after a pane return calls the live owner. */
  const finish = (kind: "save" | "link", target: string) => {
    if (kind === "link") draft.set(current => ({ ...current, state: "editing" }));
    else draft.set(current => afterSave === "keep" ? { ...current, state: "saved" } : fresh(current.revision + 1));
    onSaved?.(target);
  };
  /** `attempt` names its target before committing, so a failed commit keeps that exact ref beside its frozen retry. */
  const commit = async (kind: "save" | "link", attempt: (target: { ref: string | null }) => Promise<unknown>,
    frozen: { attempt: () => Promise<unknown>; target: string } | null = null) => {
    const target = { ref: frozen?.target ?? null };
    draft.set(current => ({ ...current, state: "saving", failure: null }));
    try {
      await attempt(target);
    } catch (error) {
      const retry = error instanceof LocalCommitError ? error.retry : frozen?.attempt ?? null;
      draft.set(current => ({ ...current, state: "editing", failure: retry && target.ref !== null
        ? { content: LOCAL_FAILURE, retry: { kind, attempt: retry, target: target.ref } }
        : { content: { tone: "Warning", title: "couldn’t save this note", message: error instanceof Error ? error.message : undefined }, retry: null } }));
      return;
    }
    if (target.ref !== null) finish(kind, target.ref);
  };
  const save = () => {
    const submitted = draft.read();
    if (writing === null || submitted.state !== "editing") return;
    const retry = submitted.failure?.retry;
    if (retry) { void commit(retry.kind, () => retry.attempt(), retry); return; }
    if (submitted.searching || !bodyHasContent(submitted.body)) return;
    const creation = createNoteIntent(submitted.noteRef, submitted.body);
    void commit("save", async target => {
      target.ref = submitted.noteRef;
      return createLink(writing, {
        source_ref: destinationRef, target_ref: submitted.noteRef, source_label: await sourceLabel(), target_label: null,
        after: null, prelude: [...prelude, creation],
      });
    });
  };
  /** A picked reference links to the destination now; the draft note stays unsent. */
  const linkReference = (picked: LinkTarget, item: ResourceItem) => {
    if (writing === null) return;
    void commit("link", async target => {
      const endpoint = await prepareTarget(writing, picked);
      target.ref = endpoint.ref;
      return createLink(writing, { source_ref: destinationRef, target_ref: endpoint.ref, source_label: await sourceLabel(),
        target_label: item.label, after: null, prelude: [...prelude, ...endpoint.intents] });
    });
  };
  const edit = (change: NoteEdit) => draft.set(current => ({ ...current, body: change.after,
    history: recordNoteBodyEdit(current.history, change), focus: null, revision: current.revision + 1 }));
  const step = (redo: boolean) => {
    const current = draft.read();
    const change = (redo ? current.history.redo : current.history.undo).at(-1);
    if (!change) return;
    const selection = redo ? change.selectionAfter : change.selectionBefore;
    draft.set({ ...current, body: redo ? change.after : change.before, revision: current.revision + 1,
      focus: { selection, serial: current.revision + 1 },
      history: { undo: redo ? [...current.history.undo, change] : current.history.undo.slice(0, -1),
        redo: redo ? current.history.redo.slice(0, -1) : [...current.history.redo, change], group: current.history.group + 1 } });
  };
  // A pending or failed commit freezes the displayed input: retry lands exactly what is shown.
  const frozen = value.state !== "editing" || value.failure?.retry != null;
  return <div className={styles.composer} data-composer-destination={destinationRef}>
    {destinationRef.startsWith("conversation:") ? <p className={styles.status}>linked items supply context to future turns in this conversation</p> : null}
    {value.state === "saved" ? <BoundNoteEditor noteRef={value.noteRef} label="edit saved note" /> : <>
      <NoteEditor editorKey={`resource-composer:${occurrenceKey}`} body={value.body} revision={value.revision} label={label}
        containingNoteRef={null} editable={writing !== null && !frozen} focus={value.focus}
        history={{ undo: () => step(false), redo: () => step(true), boundary: () => draft.set(current => ({ ...current, history: { ...current.history, group: current.history.group + 1 } })) }}
        onEdit={edit} onSave={save}
        reference={{ source_ref: destinationRef, label,
          onActiveChange: active => { draft.set(current => ({ ...current, searching: active })); onActiveChange?.(active); },
          onSelected: linkReference }} />
      <Button className={styles.textButton} onClick={save}
        disabled={writing === null || value.state !== "editing" || !value.failure?.retry && (value.searching || !bodyHasContent(value.body))}>
        {value.failure?.retry ? "retry saving" : "save note"}</Button>
    </>}
    {value.state === "saving" ? <FeedbackStatus content={{ tone: "Neutral", title: "saving on this device…" }} announcement="None" /> : null}
    {value.failure ? <FeedbackNotice content={value.failure.content} announcement="Polite" actions={value.failure.retry
      ? [{ label: "retry saving", onClick: save }, { label: "copy text", onClick: () => void navigator.clipboard.writeText(value.body.body_text) }]
      : [{ label: "copy text", onClick: () => void navigator.clipboard.writeText(value.body.body_text) }]} /> : null}
  </div>;
}
