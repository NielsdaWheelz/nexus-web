"use client";

// The editor host (pane visit or reader document) owns unsent rich input; nothing unsaved is
// stored, and the host's loss guard covers it until it is saved or cleared. Explicit save commits
// the new note and its first link to the destination in one local transaction,
// after any caller prelude (a latent day's page). A
// failed commit keeps its input visible and frozen until its retry lands the same
// bytes. Once saved, the note keeps editing in place through its bound editor.
// A save that didn't land puts the draft's words at risk until one does, while any words
// or a frozen commit remain; a link whose commit may still land holds until it does or
// its retry settles it.
import {useEffect, useRef, useState} from "react";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import {useCopyFeedback} from "@/components/ui/useCopyFeedback";
import {ClipboardWriteUnavailableError} from "@/lib/ui/copyText";
import NoteEditor from "@/components/notes/NoteEditor";
import BoundNoteEditor from "@/components/notes/BoundNoteEditor";
import { Hold, useOutcome } from "@/components/feedback/Feedback";
import { bodyHasContent, emptyBody, type NoteBody } from "@nexus/authored/body";
import { createNoteIntent, type Intent } from "@nexus/authored/commands";
import { emptyNoteBodyHistory, recordNoteBodyEdit, type NoteBodyHistory } from "@/lib/notes/bodyHistory";
import { useWritingRuntime } from "@/lib/notes/hooks";
import type { NoteEdit } from "@/lib/notes/editorTypes";
import { LocalCommitError, isAuthoredStorageFailure } from "@/lib/notes/runtime";
import { createLink, prepareTarget, LinkInputRefusal, type LinkTarget } from "@/lib/resourceGraph/links";
import { useEditorDraft } from "@/lib/notes/editorHost";
import type { WorkRisk } from "@/lib/unsavedWork";
import type { ResourceItem } from "@/lib/resources/items";
import styles from "./ResourceComposer.module.css";

/** A failed local commit's frozen retry and the target it named, held until it lands. */
type Frozen = { attempt: () => Promise<unknown>; target: string };
type Composer = {
  body: NoteBody; revision: number; searching: boolean;
  history: NoteBodyHistory;
  focus: { selection: NoteEdit["selectionAfter"]; serial: number } | null;
  /** Minted once per draft; a retried commit keeps it. */
  noteRef: string;
  state: "editing" | "saving" | "saved";
  /** A save that didn't land: the draft's words stay at risk until one does. `retry` replays the
   * frozen commit; without one, the next save sends again. `attempt` keys speech. */
  unsaved: { retry: Frozen | null; attempt: number } | null;
  /** A link whose local commit may still land; its frozen retry replays it. */
  linking: { label: string; retry: Frozen; attempt: number } | null;
};
type Command = { kind: "save" } | { kind: "link"; label: string };
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

/** Unsent input and a held failed commit would be lost; an in-flight local commit is unconfirmed. */
function composerRisk(value: Composer): WorkRisk {
  return {
    changed: value.state === "editing" && (bodyHasContent(value.body) || value.unsaved?.retry != null || value.linking !== null),
    unconfirmed: value.state === "saving",
    stopsBrowserWork: false,
  };
}
const fresh = (revision: number): Composer => ({
  body: emptyBody(), revision, searching: false, history: emptyNoteBodyHistory(), focus: null,
  noteRef: `note_block:${crypto.randomUUID()}`, state: "editing", unsaved: null, linking: null,
});

export default function ResourceComposer({ destinationRef, occurrenceKey, label, destinationLabel, prelude = [], afterSave = "keep", onSaved, onActiveChange }: Props) {
  const writing = useWritingRuntime();
  const { say } = useOutcome();
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  /** The draft's text, shown to select by hand when the clipboard refused it. */
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const [defect, setDefect] = useState<{error: unknown} | null>(null);
  const draft = useEditorDraft<Composer>(`Resources.ItemDraft:${occurrenceKey}`, () => fresh(0), composerRisk);
  const value = draft.value;
  const copied = useCopyFeedback(value.noteRef);
  /** Local writing never waits for a server label: the host's capture, the existing stub, else the literal ref. */
  const sourceLabel = async (): Promise<string | null> => {
    if (/^(note_block|page|highlight):/u.test(destinationRef) || writing === null) return null;
    if (destinationLabel !== undefined) return destinationLabel;
    const local = await (await writing.store).query({ kind: "resource", ref: destinationRef });
    return local.rows[0]?.resource.title ?? destinationRef;
  };
  /** Finishing reads this render's props, so a retry after a pane return calls the live owner. */
  const finish = (command: Command, target: string) => {
    if (command.kind === "link") draft.set(current => ({ ...current, state: "editing", linking: null }));
    else draft.set(current => afterSave === "keep" ? { ...current, state: "saved", unsaved: null } : fresh(current.revision + 1));
    if (mounted.current) onSaved?.(target);
  };
  /** `attempt` names its target before committing, so a failed commit keeps that exact ref beside its frozen retry. */
  const commit = async (command: Command, attempt: (target: { ref: string | null }) => Promise<unknown>, frozen: Frozen | null = null) => {
    const target = { ref: frozen?.target ?? null };
    const noteRef = draft.read().noteRef;
    draft.set(current => ({ ...current, state: "saving" }));
    try {
      await attempt(target);
    } catch (error) {
      if (!(error instanceof LocalCommitError) && !isAuthoredStorageFailure(error) && !(error instanceof LinkInputRefusal)) {setDefect({error}); return;}
      const retry = error instanceof LocalCommitError && target.ref !== null ? { attempt: error.retry, target: target.ref } : frozen;
      draft.set(current => {
        const editing = { ...current, state: "editing" as const };
        if (error instanceof LinkInputRefusal) return editing;
        if (command.kind === "save") return { ...editing, unsaved: { retry, attempt: (current.unsaved?.attempt ?? -1) + 1 } };
        return retry === null ? editing : { ...editing, linking: { label: command.label, retry, attempt: (current.linking?.attempt ?? -1) + 1 } };
      });
      if (error instanceof LinkInputRefusal) say(error.line);
      else if (command.kind === "link" && retry === null) say({ fact: `couldn’t link “${command.label}”.` });
      if (error instanceof LocalCommitError) void error.completion.then(() => {
        const current = draft.read();
        const held = command.kind === "save" ? current.unsaved?.retry : current.linking?.retry;
        if (current.state === "editing" && current.noteRef === noteRef && held?.attempt === error.retry && target.ref !== null) finish(command, target.ref);
      }, () => {});
      return;
    }
    if (target.ref !== null) finish(command, target.ref);
  };
  const save = () => {
    const submitted = draft.read();
    if (writing === null || submitted.state !== "editing") return;
    const frozen = submitted.unsaved?.retry ?? null;
    if (frozen) { void commit({ kind: "save" }, () => frozen.attempt(), frozen); return; }
    if (submitted.searching || !bodyHasContent(submitted.body)) return;
    const creation = createNoteIntent(submitted.noteRef, submitted.body);
    void commit({ kind: "save" }, async target => {
      target.ref = submitted.noteRef;
      return createLink(writing, {
        source_ref: destinationRef, target_ref: submitted.noteRef, source_label: await sourceLabel(), target_label: null,
        after: null, prelude: [...prelude, creation],
      });
    });
  };
  const retryLink = () => {
    const submitted = draft.read();
    const linking = submitted.linking;
    if (writing === null || submitted.state !== "editing" || linking === null) return;
    void commit({ kind: "link", label: linking.label }, () => linking.retry.attempt(), linking.retry);
  };
  /** A picked reference links to the destination now; the draft note stays unsent. */
  const linkReference = (picked: LinkTarget, item: ResourceItem) => {
    if (writing === null) return;
    void commit({ kind: "link", label: item.label }, async target => {
      const endpoint = await prepareTarget(writing, picked);
      target.ref = endpoint.ref;
      return createLink(writing, { source_ref: destinationRef, target_ref: endpoint.ref, source_label: await sourceLabel(),
        target_label: item.label, after: null, prelude: [...prelude, ...endpoint.intents] });
    });
  };
  const copyText = () => {
    const text = draft.read().body.body_text;
    void copied.copy(text).catch(error => {
      if (!(error instanceof ClipboardWriteUnavailableError)) {setDefect({error}); return;}
      say({ fact: "couldn’t copy the note." }, [{ label: "show text", commandKey: `ResourceComposer.showText:${value.noteRef}`, run: () => setManualCopy(draft.read().body.body_text) }]);
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
  const frozen = value.state !== "editing" || value.unsaved?.retry != null || value.linking !== null;
  const saving = value.state === "saving";
  if (defect) throw defect.error;
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
      <Button className={styles.textButton} aria-busy={saving} onClick={save}
        disabled={writing === null || value.state !== "editing" || value.linking !== null || !value.unsaved?.retry && (value.searching || !bodyHasContent(value.body))}>
        {value.unsaved?.retry ? "retry" : "save note"}</Button>
    </>}
    {value.unsaved && (value.unsaved.retry !== null || bodyHasContent(value.body)) ? <Hold id={`ResourceComposer.unsaved:${value.noteRef}`} attempt={value.unsaved.attempt} risk line={{ fact: "this note isn’t saved yet." }} verbs={[
      { label: "retry", commandKey: `ResourceComposer.save:${value.noteRef}`, run: save, busy: saving,
        disabledReason: value.unsaved.retry === null && value.searching ? "finish the link first" : undefined },
      { label: "copy text", commandKey: `ResourceComposer.copy:${value.noteRef}`, run: copyText, copied: copied.occurrence ?? undefined },
    ]} /> : null}
    {value.linking ? <Hold id={`ResourceComposer.link:${value.noteRef}`} attempt={value.linking.attempt}
      line={{ fact: `not sure “${value.linking.label}” linked.`, reason: "it may have gone through." }}
      verbs={[{ label: "retry", commandKey: `ResourceComposer.link:${value.noteRef}`, run: retryLink, busy: saving }]} /> : null}
    <Dialog open={manualCopy !== null} title="copy this note" onClose={() => setManualCopy(null)}>
      <p>select the text and copy it.</p><textarea readOnly aria-label="note text" value={manualCopy ?? ""}/>
    </Dialog>
  </div>;
}
