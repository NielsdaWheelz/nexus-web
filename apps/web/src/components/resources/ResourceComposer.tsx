"use client";

// an explicit item draft keeps its fixed destination and identities in the journal.
// the editor owns immediate paint; settlement advances only its confirmed base.
import { useContext, useEffect, useLayoutEffect, useRef } from "react";
import NoteEditor from "@/components/notes/NoteEditor";
import { DraftDecision, useOnline, useWriting } from "@/components/notes/NoteNotices";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import { OutlineSessionContext, OutlineSessionScope, ResourceBranch } from "./ResourceOutlineList";
import { useOutlineSession, type NoteEdit, type OutlineSession } from "@/lib/notes/useOutlineSession";
import { emptyNoteBodyHistory, recordNoteBodyEdit, type NoteBodyHistory } from "@/lib/notes/bodyHistory";
import { emptyBody, bodyHasContent, parseBody, sameBody, type NoteBody } from "@/lib/notes/noteBody";
import { adoptText } from "@/lib/notes/texts";
import {
  admitWriting, checkpoint, claimDraft, confirmedDraftBase, discardDraft, draftDependency, draftIsDurable,
  openDraft, readDraft, readWriting, releaseDraft, resolveDraftConflict, snapshotDraft, stageDraft,
  assertWritingRuntimeToken, writingRuntimeToken,
  type DraftBase, type DraftContext, type DraftHandle, type DraftSelection, type Publication, type WritingIntent,
} from "@/lib/notes/journal";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import type { InsertionSource } from "@/lib/resourceGraph/links";
import styles from "./ResourceOutline.module.css";

type ItemPublication = Extract<Publication, { kind: "insert_note" }>;
type ComposerDraft = {
  body: NoteBody;
  revision: number;
  selection: DraftSelection;
  history: NoteBodyHistory;
  focus: { selection: NonNullable<DraftSelection>; serial: number } | null;
  searching: boolean;
  publication: ItemPublication;
  base: DraftBase;
  discardBase: DraftBase;
  recoverId: string | null;
  journal: Promise<DraftHandle> | null;
  handle: DraftHandle | null;
  localCommits: number;
  failure: string | null;
};
type Props = {
  source: InsertionSource;
  occurrenceKey: string;
  label: string;
  onSaved?: () => void;
  onActiveChange?: (active: boolean) => void;
};

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
  const online = useOnline();
  const draft = useResourceDraft<ComposerDraft>(`Resources.ItemDraft:${occurrenceKey}`, () => {
    const matches = readWriting().drafts.filter(saved => saved.context.kind === "composer" &&
      JSON.stringify(saved.context.publication.request.source) === JSON.stringify(source));
    const saved = matches.length === 1 ? matches[0] : null;
    const publication: ItemPublication = saved?.context.kind === "composer" ? saved.context.publication : {
      kind: "insert_note", initial_title: null, request: { kind: "insert_note", source: structuredClone(source), position: null,
        note_id: crypto.randomUUID(), link_id: crypto.randomUUID(), body_pm_json: emptyBody().body_pm_json },
    };
    return { body: saved?.value.kind === "body" ? parseBody(saved.value.body_pm_json) : emptyBody(),
      revision: 0, selection: saved?.selection ?? null, history: emptyNoteBodyHistory(), focus: null, searching: false,
      publication, base: saved?.base ?? null, discardBase: saved ? confirmedDraftBase(saved) : null, recoverId: saved?.draft_id ?? null, journal: null, handle: null, localCommits: 0, failure: null };
  });
  const { body, revision, searching, publication, handle, localCommits, failure } = draft.value;
  const { read: readComposer, set: setComposer } = draft;
  const canonical = handle === null ? null : readDraft(handle.draft_id);
  const rows = canonical ? writing.outbox.filter(row => row.authored.some(item => item.draft_id === canonical.draft_id)) : [];
  const base = canonical ? canonical.base : draft.value.base;
  const published = base !== null && base !== undefined;
  const currentSaved = base?.value.kind === "body" && sameBody(parseBody(base.value.body_pm_json), body);
  const currentRequest = rows.some(row => row.authored.some(item => item.draft_id === canonical?.draft_id &&
    item.value.kind === "body" && sameBody(parseBody(item.value.body_pm_json), body)));
  const kept = canonical !== null && canonical !== undefined && draftIsDurable(canonical.draft_id);
  const context = (value: ComposerDraft): DraftContext => ({ kind: "composer",
    resource_ref: `note_block:${value.publication.request.note_id}`, publication: value.publication });
  const journalFor = (value: ComposerDraft): Promise<DraftHandle> => {
    if (value.journal) return value.journal;
    const token = writingRuntimeToken();
    const journal = (async () => {
      const recovered = value.recoverId ? await claimDraft(value.recoverId) : null;
      assertWritingRuntimeToken(token);
      return recovered ?? openDraft(context(value), { kind: "body", body_pm_json: value.body.body_pm_json }, value.base, value.recoverId);
    })();
    draft.set(current => ({ ...current, journal }));
    void journal.then(opened => {
      assertWritingRuntimeToken(token);
      draft.set(current => current.journal === journal ? { ...current, handle: opened, recoverId: opened.draft_id } : current);
    }).catch(() => undefined);
    return journal;
  };
  useEffect(() => {
    if (writing.paused) return;
    void journalFor(draft.read()).catch(() => draft.set(value => ({ ...value,
      failure: "recent changes are only in this tab. keep it open or download your writing." })));
    return () => {
      const opened = draft.read().journal;
      if (opened) void opened.then(releaseDraft).catch(() => undefined);
      draft.set(value => ({ ...value, journal: null, handle: null,
        base: value.handle ? readDraft(value.handle.draft_id)?.base ?? value.base : value.base,
        recoverId: value.handle?.draft_id ?? value.recoverId }));
    };
    // the retained visit cell owns this branch; ordinary edits do not reopen it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.owner, writing.paused]);
  useLayoutEffect(() => {
    if (handle !== null && canonical === undefined) {
      const current = readComposer();
      if (current.handle !== handle) return;
      const base = current.discardBase;
      const body = base?.value.kind === "body" ? parseBody(base.value.body_pm_json) : emptyBody();
      const publication: ItemPublication = base === null ? { ...current.publication,
        request: { ...current.publication.request, note_id: crypto.randomUUID(), link_id: crypto.randomUUID(), body_pm_json: body.body_pm_json },
      } : current.publication;
      const journal = writing.paused ? null : openDraft({ kind: "composer",
        resource_ref: `note_block:${publication.request.note_id}`, publication },
        { kind: "body", body_pm_json: body.body_pm_json }, base);
      setComposer({ ...current, body, publication, base, discardBase: base, revision: current.revision + 1, selection: null,
        history: emptyNoteBodyHistory(), focus: null, searching: false, recoverId: null,
        handle: null, journal, localCommits: 0, failure: null });
      void releaseDraft(handle);
      if (journal !== null) {
        const token = writingRuntimeToken();
        void journal.then(opened => {
          assertWritingRuntimeToken(token);
          setComposer(value => value.journal === journal ? { ...value, handle: opened, recoverId: opened.draft_id } : value);
        }).catch(() => undefined);
      }
      return;
    }
    if (canonical?.context.kind !== "composer") return;
    const current = readComposer();
    const confirmed = confirmedDraftBase(canonical);
    const previous = canonical.resource_ref === `note_block:${current.publication.request.note_id}` ? current.discardBase : null;
    const discardBase = confirmed?.value.kind === "body" && (previous === null ||
      typeof confirmed.version === "number" && (typeof previous.version !== "number" || confirmed.version > previous.version))
      ? confirmed : previous;
    if (canonical.context.publication === publication && canonical.base === current.base && discardBase === current.discardBase) return;
    setComposer(value => ({ ...value, base: canonical.base, discardBase, recoverId: canonical.draft_id,
      publication: canonical.context.kind === "composer" ? canonical.context.publication : value.publication }));
  }, [canonical, handle, publication, readComposer, setComposer, writing.paused]);
  const composing = useRef(false);
  const reported = useRef<{ draftId: string | null; version: number | string | null }>({ draftId: null, version: null });
  useEffect(() => {
    if (!canonical) return;
    const version = base?.version ?? null;
    if (reported.current.draftId !== canonical.draft_id) {
      reported.current = { draftId: canonical.draft_id, version };
      return;
    }
    if (version === null || reported.current.version === version) return;
    reported.current.version = version;
    if (currentSaved && !composing.current) onSaved?.();
  }, [base, canonical, currentSaved, onSaved]);

  const checkpointBody = (value: ComposerDraft, editBase?: NoteEdit["editBase"]) => {
    draft.set(current => ({ ...current, localCommits: current.localCommits + 1, failure: null }));
    void journalFor(value).then(async opened => {
      const saved = readDraft(opened.draft_id);
      if (!saved) throw new Error("the item draft is no longer open");
      await checkpoint(opened, saved.revision, { kind: "body", body_pm_json: value.body.body_pm_json }, value.selection, null, null, editBase?.consumed_reference ?? null);
    }).catch(() => draft.set(current => ({ ...current,
      failure: "recent changes are only in this tab. keep it open or download your writing." })))
      .finally(() => draft.set(current => ({ ...current, localCommits: Math.max(0, current.localCommits - 1) })));
  };
  const edit = (change: NoteEdit) => {
    draft.set(value => ({ ...value, body: change.after, selection: change.selectionAfter,
      history: recordNoteBodyEdit(value.history, change), focus: null, revision: value.revision + 1 }));
    checkpointBody(draft.read(), change.editBase);
  };
  const save = async () => {
    const submitted = draft.read();
    if (writing.paused || submitted.handle === null || submitted.searching || !bodyHasContent(submitted.body) && !published) return;
    const token = writingRuntimeToken();
    draft.set(value => ({ ...value, localCommits: value.localCommits + 1, failure: null }));
    try {
      const opened = await journalFor(submitted);
      assertWritingRuntimeToken(token);
      const expected = draftDependency(opened, "body");
      const authored = stageDraft(opened, { kind: "body", body_pm_json: submitted.body.body_pm_json }, submitted.selection);
      const intent: WritingIntent = expected === null
        ? { ...submitted.publication, request: { ...submitted.publication.request, body_pm_json: submitted.body.body_pm_json } }
        : { kind: "body", policy: "explicit", note_id: expected.ref.slice("note_block:".length),
          body_pm_json: submitted.body.body_pm_json, expected };
      const admitted = admitWriting(intent, [authored]);
      await admitted.durable;
      void admitted.settled.then(ack => {
        assertWritingRuntimeToken(token);
        for (const note of ack.notes) adoptText(`note_block:${note.id}`, parseBody(note.body_pm_json), note.body_version);
      }).catch(() => undefined);
    } catch {
      const saved = draft.read().handle;
      draft.set(value => ({ ...value, failure: saved && draftIsDurable(saved.draft_id)
        ? "couldn’t submit this item. your draft is kept; review its destination before trying again."
        : "recent changes are only in this tab. keep it open or download your writing." }));
    } finally { draft.set(value => ({ ...value, localCommits: Math.max(0, value.localCommits - 1) })); }
  };
  const step = (redo: boolean) => {
    const value = draft.read();
    const change = (redo ? value.history.redo : value.history.undo).at(-1);
    if (!change) return;
    draft.set({ ...value, body: redo ? change.after : change.before,
      selection: redo ? change.selectionAfter : change.selectionBefore, revision: value.revision + 1,
      focus: { selection: redo ? change.selectionAfter : change.selectionBefore, serial: value.revision + 1 },
      history: { undo: redo ? [...value.history.undo, change] : value.history.undo.slice(0, -1),
        redo: redo ? value.history.redo.slice(0, -1) : [...value.history.redo, change], group: value.history.group + 1 } });
    checkpointBody(draft.read());
  };
  const status = localCommits > 0 ? "saving…" : !kept && revision > 0 ? "recent changes are only in this tab. keep it open or download your writing."
    : rows.some(row => row.uncertain) ? "couldn’t confirm this change."
    : currentRequest ? online ? "saved on this device · syncing" : "saved on this device · offline"
    : currentSaved ? "synced" : kept && (revision > 0 || draft.value.recoverId !== null) ? "draft saved on this device" : null;
  return <div className={styles.composer} onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => { composing.current = false; }}>
    {source.kind === "resource" && source.ref.startsWith("conversation:") ? <p className={styles.status}>
      linked items supply context to future turns in this conversation
    </p> : null}
    <NoteEditor editorKey={`resource-composer:${occurrenceKey}`} body={body} revision={revision} label={label}
      containingNoteRef={published ? canonical?.resource_ref ?? null : null} editable={handle !== null && canonical !== undefined && !writing.paused} focus={draft.value.focus}
      history={{ undo: () => step(false), redo: () => step(true), boundary: () => draft.set(value => ({ ...value, history: { ...value.history, group: value.history.group + 1 } })) }}
      onEdit={edit} onSelectionChange={selection => draft.set(value => ({ ...value, selection }))} onSave={() => void save()}
      reference={{ source: publication.request.source, recoverySource: publication.request.source, label, position: null,
        onActiveChange: active => { draft.set(value => ({ ...value, searching: active })); onActiveChange?.(active); },
        onSelected(target, targetItem, authored) {
          const value = draft.read();
          const carried = journalFor(value).then(opened => {
            const snapshot = readDraft(opened.draft_id);
            if (!snapshot) throw new Error("the item draft is no longer open");
            if (JSON.stringify(snapshot.value) !== JSON.stringify({ kind: "body", body_pm_json: value.body.body_pm_json }))
              stageDraft(opened, { kind: "body", body_pm_json: value.body.body_pm_json }, value.selection);
            return snapshotDraft(opened);
          });
          void session.insertReference({ destination: { source: publication.request.source, position: null,
            occurrencePrefix: occurrenceKey, path: [] }, target, targetItem,
            authored: Promise.all([authored, carried]).then(([references, body]) => [...references, body]),
          });
        },
      }} />
    <button className={styles.textButton} type="button" onClick={() => void save()}
      disabled={handle === null || writing.paused || searching || currentSaved || currentRequest || !bodyHasContent(body) && !published}>save note</button>
    {canonical?.conflict ? <DraftDecision draft={canonical}
      resolve={async (choice, shown) => {
        const localRevision = draft.read().revision;
        await resolveDraftConflict(handle!, choice, shown);
        if (choice !== "saved" || draft.read().revision !== localRevision) return;
        const saved = readDraft(handle!.draft_id);
        if (saved?.value.kind === "body") {
          const body = parseBody(saved.value.body_pm_json);
          draft.set(value => ({ ...value, body, base: saved.base,
            revision: value.revision + 1, selection: null, focus: null, history: emptyNoteBodyHistory() }));
        }
      }} retire={shown => discardDraft(handle!, shown)} />
      : failure ? <FeedbackNotice content={{ tone: "Warning", title: failure }} announcement="Polite" />
        : status ? <FeedbackStatus content={{ tone: "Neutral", title: status }} announcement="None" /> : null}
  </div>;
}

/** a mounted root exposes its explicit item composer to pane chrome. */
export function useResourceComposer(source: InsertionSource | null, occurrenceKey: string, label: string) {
  const opened = useResourceDraft<boolean>(`Resources.RootComposer:${occurrenceKey}`, () => false);
  return {
    action: source === null ? null : { kind: "command" as const, id: "Resource.AddItem", label: "add item", onSelect: () => opened.set(true) },
    content: opened.value && source ? <ResourceComposer source={source} occurrenceKey={occurrenceKey} label={label} /> : null,
  };
}
