"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import { settleDeletedResourcePanes } from "@/lib/actions/settleDeletedResource";
import { apiFetch, isApiError } from "@/lib/api/client";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { assertNever } from "@/lib/assertNever";
import { createReaderChatSend } from "@/lib/chat/drafts";
import { readCatalog } from "@/lib/chat/catalog";
import { assumeReaderSelectionKey, getReaderQuotePreview, readerHighlightChatIntent, readerHighlightChatIntentHref } from "@/lib/chat/readerIntent";
import { failureDetail, type Catalog, type Selection } from "@/lib/chat/wire";
import { createRandomId } from "@/lib/createRandomId";
import type { Mark, SelectionCapture } from "@/lib/documentReader/DocumentReader";
import type { Reader } from "@/lib/documentReader/runtime";
import type { HighlightColor } from "@/lib/documentReader/model";
import { emptyNoteBodyHistory, recordNoteBodyEdit } from "@/lib/notes/bodyHistory";
import { docFromBody, emptyBody, parseBody, sameBody } from "@/lib/notes/noteBody";
import { adoptText, setGone } from "@/lib/notes/texts";
import type { NoteEdit } from "@/lib/notes/useOutline";
import { enqueueWrite, nudgeWrites, type WriteRequest } from "@/lib/notes/writes";
import { announceResourceDeletion, isDeletedResource, subscribeLinkMutations } from "@/lib/resourceGraph/links";
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";
import { useLatestWorkspace } from "@/lib/workspace/store";
import type { AnnotationStore } from "./annotations";
import { createSelectionDrafts, initialBody, isEmptyParagraph, noteBase, samePassage, type ComposerDraft, type SelectionDrafts } from "./selectionDrafts";

const VISIT_DRAFTS = definePaneVisitDataKey<SelectionDrafts>("Reader.AnnotationDrafts");
const CATALOG_VISIT = definePaneVisitDataKey<Visit<Catalog>>("Reader.ChatCatalog");
type Highlight = Schema<"TypedHighlightOut">;
type Note = Schema<"LinkedNoteBlockRef">;
type Opening = { id: string; draftId: string; focus: boolean; ownsFocus: boolean; serial: number };
type Command =
  | { kind: "Save"; noteId: string }
  | { kind: "Chat"; selection: Selection | null }
  | { kind: "Ensure" }
  | { kind: "Highlight"; color: HighlightColor }
  | { kind: "Delete" };

/** The shared online queue serializes these frozen requests and retries exact bytes. */
function write<R>(request: WriteRequest, acknowledge?: (reply: R) => void): Promise<R> {
  return new Promise((resolve, reject) => enqueueWrite<R>({ build: () => request,
    settle(reply) { acknowledge?.(reply); resolve(reply); }, fail: reject }));
}

async function liveHighlight(id: string): Promise<Highlight | null> {
  try {
    const { data } = await apiFetch<ApiJson<"/highlights/{highlight_id}", "get">>(`/api/highlights/${id}`);
    return { ...data, linked_note_blocks: data.linked_note_blocks.filter((note) => !isDeletedResource(`note_block:${note.note_block_id}`)) };
  } catch (error) { if (isApiError(error) && error.status === 404) return null; throw error; }
}

function reconcileDeletedNote(entry: ComposerDraft): ComposerDraft {
  const baseDeleted = entry.base.kind === "Present" && isDeletedResource(`note_block:${entry.base.id}`);
  const conflictDeleted = entry.issue?.kind === "Conflict" && entry.issue.saved.kind === "Present" &&
    isDeletedResource(`note_block:${entry.issue.saved.id}`);
  if (!baseDeleted && !conflictDeleted) return entry;
  const clean = baseDeleted && sameBody(entry.body, initialBody(entry.base));
  return { ...entry, ...(baseDeleted ? { base: { kind: "Absent" } as const, load: "Ready" as const } : {}),
    ...(clean ? { body: emptyBody(), selection: { anchor: 1, head: 1 }, history: emptyNoteBodyHistory() } : {}),
    ...(conflictDeleted ? { issue: null } : {}), revision: entry.revision + 1,
    status: clean ? "note deleted. highlight kept." : "note deleted elsewhere. your draft is kept." };
}

export function useSelectionComposer(input: {
  mediaId: string;
  reader: Reader;
  annotations: AnnotationStore;
  active: boolean;
  onError: (error: unknown, title: string) => void;
}) {
  const { mediaId, reader, annotations, active, onError } = input;
  const latestWorkspace = useLatestWorkspace();
  const feedback = useFeedback();
  const catalogRead = useServerValue({ key: "/llm-catalog", stale: "", visit: CATALOG_VISIT, load: readCatalog });
  const catalog = catalogRead.status === "ready" ? catalogRead.data : null;
  const refreshCatalog = catalogRead.refetch;
  const holder = useRef<SelectionDrafts | null>(null);
  const retained = usePaneVisitData(VISIT_DRAFTS, () => holder.current);
  const [store] = useState(() => retained ?? createSelectionDrafts());
  holder.current = store;
  const retain = usePaneVisitDataWriter(VISIT_DRAFTS);
  const drafts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [opening, setOpening] = useState<Opening | null>(null);
  const current = useRef<Opening | null>(null);
  const serial = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const show = useCallback((next: Opening | null) => { current.current = next; setOpening(next); }, []);
  useEffect(() => { if (!active) show(null); }, [active, show]);
  useEffect(() => () => { current.current = null; activeRef.current = false; }, []);
  useEffect(() => {
    const moved = (event: Event) => {
      const source = current.current;
      if (!source) return;
      if (event.type === "pointerdown" && event.target instanceof Element && event.target.closest("[data-passive-tooltip]")) return;
      const inside = event.target instanceof Element && event.target.closest("[data-selection-composer]") !== null;
      if (source.focus || source.ownsFocus !== inside) show({ ...source, focus: false, ownsFocus: inside });
    };
    document.addEventListener("focusin", moved);
    document.addEventListener("pointerdown", moved, true);
    window.addEventListener("blur", moved);
    return () => { document.removeEventListener("focusin", moved); document.removeEventListener("pointerdown", moved, true); window.removeEventListener("blur", moved); };
  }, [show]);

  const draft = active && opening ? drafts.find((entry) => entry.id === opening.draftId) ?? null : null;
  const get = (id: string) => store.getSnapshot().find((entry) => entry.id === id);
  useEffect(() => subscribeLinkMutations((change) => {
    if (change.kind !== "resource_deleted") return;
    for (const entry of store.getSnapshot()) if (reconcileDeletedNote(entry) !== entry) store.update(entry.id, reconcileDeletedNote);
  }), [store]);

  const readNote = useCallback(async (draftId: string, highlightId: string, replace: boolean) => {
    if (replace) store.update(draftId, (entry) => ({ ...entry, load: "Loading", issue: null }));
    const requested = store.getSnapshot().find((entry) => entry.id === draftId);
    if (!requested) return;
    const ownsRead = () => {
      const entry = store.getSnapshot().find((entry) => entry.id === draftId);
      return entry?.highlightId === highlightId && entry.revision === requested.revision &&
        entry.operation === requested.operation && entry.issue === requested.issue;
    };
    try {
      const data = await liveHighlight(highlightId);
      if (!ownsRead()) return;
      if (!data) {
        store.update(draftId, (entry) => ({ ...entry, load: "Failed", issue: { kind: "Failed", message: "this highlight is no longer available. your draft is kept." } }));
        return;
      }
      const base = noteBase(data), body = initialBody(base), doc = docFromBody(body);
      const end = doc.firstChild?.isTextblock ? doc.content.size - 1 : 0;
      store.update(draftId, (entry) => ({ ...entry, highlight: data, highlightId: data.id, load: "Ready",
        ...(replace ? { base, body, selection: { anchor: end, head: end }, revision: entry.revision + 1, history: emptyNoteBodyHistory(), issue: null } :
          { issue: { kind: "Conflict", message: "this note changed elsewhere. your draft is kept.", saved: base } }) }));
    } catch (error) {
      if (!ownsRead()) return;
      store.update(draftId, (entry) => ({ ...entry, load: replace ? "Failed" : entry.load, issue: { kind: "Failed", message: "your note could not be loaded. your draft is kept." } }));
      onError(error, "Note couldn’t be loaded");
    }
  }, [onError, store]);

  const open = (passage: ComposerDraft["passage"], highlightId: string | null, focus: boolean) => {
    let existing = (highlightId ? store.getSnapshot().find((entry) => entry.highlightId === highlightId) : undefined) ??
      store.getSnapshot().find((entry) => samePassage(entry.passage, passage));
    if (existing) {
      const admitted = reconcileDeletedNote(existing);
      if (admitted !== existing) store.update(existing.id, () => admitted);
      existing = admitted;
    }
    const bound = highlightId !== null && existing?.highlightId !== highlightId;
    const id = existing?.id ?? createRandomId();
    if (!existing) store.put({ id, passage, highlightId, highlight: null, base: { kind: "Absent" }, body: emptyBody(), revision: 0,
      selection: null, history: emptyNoteBodyHistory(), load: highlightId ? "Loading" : "Ready", operation: null, issue: null, status: null });
    else store.update(id, (entry) => ({ ...entry, passage, highlightId: highlightId ?? entry.highlightId }));
    show({ id: createRandomId(), draftId: id, focus, ownsFocus: true, serial: ++serial.current });
    const clean = existing && sameBody(existing.body, initialBody(existing.base));
    if (highlightId && !existing?.operation && existing?.load !== "Loading") {
      if (!existing || existing.load === "Failed" || clean) void readNote(id, highlightId, !existing || Boolean(clean));
      else if (bound) void readNote(id, highlightId, false);
    }
  };

  const highlightDeleted = useCallback((id: string) => {
    if (store.getSnapshot().some((entry) => entry.id === current.current?.draftId && entry.highlightId === id)) show(null);
    for (const entry of store.getSnapshot()) if (entry.highlightId === id) {
      store.update(entry.id, (value) => ({ ...value, highlightId: null, highlight: null, base: { kind: "Absent" },
        issue: value.operation ? value.issue : null, load: "Ready", revision: value.revision + 1, status: "highlight deleted. your draft is kept." }));
    }
    retain(store);
  }, [retain, show, store]);

  const submit = (command: Command, continuation?: (id: string, isCurrent: () => boolean) => void | Promise<void>) => {
    const source = current.current, entry = source && get(source.draftId);
    if (!source || !entry || entry.load !== "Ready" || entry.operation) return;
    if (!entry.highlightId && !reader.measurePassage(entry.passage)) return;
    const submitted = { ...entry, command, openingId: source.id, commandId: createRandomId() };
    const owns = () => activeRef.current && current.current?.id === submitted.openingId && current.current.ownsFocus && get(entry.id)?.revision === submitted.revision;
    let sender: ReturnType<typeof createReaderChatSend> | null = null;
    let targetId = entry.highlightId;
    let target = entry.highlight;
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      store.update(entry.id, (value) => ({ ...value, operation: { id: submitted.commandId, kind: command.kind, pending: true }, issue: null,
        status: command.kind === "Save" ? "saving note…" : command.kind === "Chat" ? "starting chat…" : command.kind === "Delete" ? "deleting note…" : command.kind === "Ensure" ? "preparing passage…" : "saving highlight…" }));
      try {
        if (!sender && !targetId) {
          const anchor = submitted.passage.anchor;
          const result = await write<ApiJson<"/media/{media_id}/highlights", "post">["data"]>(annotations.prepareCreate(
            anchor.kind === "pdf" ? { ...anchor, exact: submitted.passage.quote } : anchor,
            command.kind === "Highlight" ? command.color : "yellow"), (reply) => annotations.acknowledge(reply.highlight));
          targetId = result.highlight.id;
          target = result.highlight;
          store.update(entry.id, (value) => ({ ...value, highlightId: result.highlight.id, highlight: result.highlight }));
        }
        if (!targetId) throw new Error("Missing ensured passage");
        let keepOpen = false;
        if (command.kind === "Chat") {
          let conversationId: string | null = null;
          if (submitted.body.body_text.trim()) {
            if (!sender) {
              if (!command.selection) throw new Error("Missing submitted model selection");
              const preview = await getReaderQuotePreview({ key: assumeReaderSelectionKey({ mediaId, highlightId: targetId }) });
              sender = createReaderChatSend({ key: submitted.commandId, request: { destination: { kind: "New" }, content: submitted.body.body_text.trim(),
                selection: command.selection, reader_selection: { key: preview.key, revision: preview.revision } } });
            }
            const result = await sender.send();
            if (result.kind !== "Accepted") {
              store.update(entry.id, (value) => ({ ...value, operation: null, issue: { kind: "Failed", message: `message not sent. ${failureDetail(result.code)} your draft is kept.` } }));
              store.setRetry(entry.id, null); refreshCatalog(); return;
            }
            conversationId = result.receipt.outcome.conversation_id;
          }
          const href = conversationId ? `/conversations/${conversationId}` : readerHighlightChatIntentHref(readerHighlightChatIntent({ kind: "New" }, assumeReaderSelectionKey({ mediaId, highlightId: targetId })));
          const status = conversationId ? "message sent. note draft kept." : "quoted chat ready. note draft kept.";
          const noticeKey = `Reader.Chat.${submitted.commandId}`;
          // A completed chat owns a destination, never another send. A retained
          // action opens from the current pane even after its source has closed.
          const openChat = () => {
            retain(store);
            const workspace = latestWorkspace();
            const result = workspace.activateWorkspaceTarget({ originPaneId: workspace.state.active_primary_pane_id,
              target: { href, labelHint: "Chat" }, disposition: { kind: "Fork" } });
            switch (result.kind) {
              case "Rejected": {
                if (result.reason !== "PaneLimitReached") assertNever(result.reason);
                const message = `${conversationId ? "message sent. " : ""}pane limit reached. close a pane, then open chat. your note draft is kept.`;
                store.update(entry.id, (value) => value.revision === submitted.revision && value.operation === null ? { ...value, status: message } : value);
                feedback.publish({ kind: "Persistent", key: noticeKey, announcement: "Polite",
                  content: { tone: "Warning", title: "chat is ready but could not open", message },
                  actions: [{ label: "open chat", onClick: openChat }] });
                return;
              }
              case "Unchanged": case "ActivatedExisting": case "NavigatedOrigin": case "NavigatedExisting": case "CreatedPane":
                if (current.current?.id === submitted.openingId) show(null);
                feedback.resolve(noticeKey);
                return;
              default: return assertNever(result);
            }
          };
          store.update(entry.id, (value) => ({ ...value, operation: null, status }));
          if (owns()) openChat();
          else feedback.publish({ kind: "Hud", key: noticeKey, content: { tone: "Success", title: status }, actions: [{ label: "open chat", onClick: openChat }] });
        } else if (command.kind === "Delete") {
          if (submitted.base.kind !== "Present") throw new Error("Deleting an absent note");
          const ref = `note_block:${submitted.base.id}`;
          await write<ApiJson<"/highlights/{highlight_id}/note/delete", "post">["data"]>({ path: `/api/highlights/${targetId}/note/delete`, method: "POST",
            body: { note_id: submitted.base.id, expected_version: submitted.base.version } }, () => {
            // Publish the committed deletion before the queue builds its next write.
            store.update(entry.id, (value) => ({ ...value, base: { kind: "Absent" },
              ...(value.revision === submitted.revision ? { body: emptyBody(), selection: null, history: emptyNoteBodyHistory() } : {}),
              revision: value.revision + 1, issue: null, status: "note and links deleted. highlight kept." }));
            setGone(ref); announceResourceDeletion(ref);
            settleDeletedResourcePanes({ workspace: latestWorkspace(), deletedRef: ref, fallbackHref: "/notes" });
          });
          annotations.refresh();
          const revision = get(entry.id)?.revision;
          try {
            const live = await liveHighlight(targetId);
            if (live) annotations.acknowledge(live);
            if (get(entry.id)?.revision === revision) store.update(entry.id, (value) => {
              const base = live ? noteBase(live) : { kind: "Absent" } as const;
              return { ...value, highlight: live,
                issue: base.kind === "Present" ? { kind: "Conflict", message: "note deleted. another note is attached. review it before saving.", saved: base } : null };
            });
          } catch (error) {
            if (get(entry.id)?.revision === revision) store.update(entry.id, (value) => ({ ...value,
              issue: { kind: "Failed", message: "note deleted. the highlight could not be refreshed. your draft is kept." } }));
            onError(error, "Highlight couldn’t be refreshed");
          }
        } else {
          let live: Highlight | null;
          if (command.kind === "Highlight") {
            if (!target) throw new Error("Missing observed highlight version");
            live = target.color === command.color ? target : await annotations.recolor(targetId, command.color, target.version);
          } else live = await liveHighlight(targetId);
          if (!live) {
            store.update(entry.id, (value) => ({ ...value, operation: null, load: "Failed",
              issue: { kind: "Failed", message: "this highlight is no longer available. your draft is kept." } }));
            store.setRetry(entry.id, null); return;
          }
          if (command.kind === "Save") {
            if (submitted.base.kind === "Present" || !isEmptyParagraph(submitted.body)) {
              const highlight = live;
              await write<Note>({ path: `/api/highlights/${targetId}/note`, method: "PUT", body: {
                note_id: command.noteId, body_pm_json: submitted.body.body_pm_json,
                expected: submitted.base.kind === "Present" ? { kind: "version", version: submitted.base.version } : { kind: "absent", version: live.links_version } } }, (saved) => {
                const base = isDeletedResource(`note_block:${saved.note_block_id}`) ? { kind: "Absent" } as const :
                  { kind: "Present", id: saved.note_block_id, version: saved.body_version, body: parseBody(saved.body_pm_json) } as const;
                const accepted = base.kind === "Present" && sameBody(base.body, submitted.body);
                store.update(entry.id, (value) => ({ ...value, base: accepted ? base : value.base,
                  issue: accepted ? null : { kind: "Conflict", message: "this note changed elsewhere. your draft is kept.", saved: base }, status: accepted ? "note saved." : null }));
                if (base.kind === "Present") adoptText(`note_block:${base.id}`, base.body, base.version);
                live = { ...highlight, linked_note_blocks: base.kind === "Present" ? [saved] : [] };
                keepOpen = !accepted;
              });
            } else {
              const base = noteBase(live);
              if (base.kind === "Present") {
                keepOpen = true;
                store.update(entry.id, (value) => ({ ...value, issue: { kind: "Conflict", message: "this passage already has a note. your draft is kept.", saved: base } }));
              } else store.update(entry.id, (value) => ({ ...value, status: "highlight saved." }));
            }
          }
          if (live) {
            if (command.kind !== "Highlight") annotations.acknowledge(live);
            store.update(entry.id, (value) => ({ ...value, highlight: live }));
          }
          if (command.kind === "Save" && !keepOpen && owns()) { show(null); reader.focusSource(); }
          if (continuation && owns()) await continuation(targetId, owns);
        }
        store.update(entry.id, (value) => ({ ...value, operation: null,
          ...(value.revision === submitted.revision && (command.kind === "Highlight" || command.kind === "Ensure")
            ? { status: command.kind === "Highlight" ? "highlight saved." : "passage ready." } : {}) }));
        store.setRetry(entry.id, null);
      } catch (error) {
        const uncertain = sender !== null;
        store.update(entry.id, (value) => ({ ...value, operation: uncertain ? { id: submitted.commandId, kind: command.kind, pending: false } : null,
          issue: { kind: uncertain ? "Unknown" : "Failed", message: uncertain ? "send status unknown. retry the same request." : "this request did not finish. your draft is kept." } }));
        store.setRetry(entry.id, uncertain ? () => void run() : null);
        if (command.kind === "Highlight" && isApiError(error) && error.code === "E_HIGHLIGHT_CONFLICT" &&
          (error.details?.reason === "version_mismatch" || error.details?.reason === "unit_mismatch") && targetId) {
          annotations.refresh();
          const issue = get(entry.id)?.issue;
          try {
            const live = await liveHighlight(targetId);
            store.update(entry.id, (value) => value.operation === null && value.highlight === target && value.issue === issue ? { ...value, highlight: live,
              load: live ? "Ready" : "Failed", issue: { kind: "Failed", message: live
                ? "this highlight changed. review its colour and try again. your draft is kept."
                : "this highlight is no longer available. your draft is kept." } } : value);
          } catch (refreshError) { onError(refreshError, "Highlight couldn’t be refreshed"); }
        } else if (isApiError(error) && (error.code === "E_NOTE_CONFLICT" || error.code === "E_RESOURCE_CONFLICT") && targetId) void readNote(entry.id, targetId, false);
        else onError(error, "Passage request didn’t finish");
      } finally { running = false; }
    };
    void run(); retain(store);
  };

  const restoreHistoryFocus = () => {
    if (current.current?.ownsFocus) show({ ...current.current, focus: true, serial: ++serial.current });
  };
  return {
    draft, opening,
    activePassage: active && draft ? draft.passage : null,
    select(capture: SelectionCapture) { open(capture, annotations.twin(capture.anchor), capture.input !== "touch"); },
    activate(mark: Mark, identity: string, focus = true) { open({ identity, anchor: mark.anchor, quote: annotations.highlight(mark.id)?.quote ?? "" }, mark.id, focus); },
    highlightDeleted,
    dismiss(reason?: "outside-click" | "escape") {
      const returnFocus = current.current?.ownsFocus;
      show(null); retain(store);
      if (reason === "escape" && activeRef.current && returnFocus) reader.focusSource();
    },
    edit(edit: NoteEdit) {
      if (draft) store.update(draft.id, (entry) => ({ ...entry, body: edit.after, revision: entry.revision + 1,
        selection: edit.selectionAfter, history: recordNoteBodyEdit(entry.history, edit), status: null }));
    },
    selection(selection: NoteEdit["selectionAfter"]) { if (draft) store.update(draft.id, (entry) => ({ ...entry, selection })); },
    historyBoundary() { if (draft) store.update(draft.id, (entry) => ({ ...entry, history: { ...entry.history, group: entry.history.group + 1 } })); },
    undo() {
      if (!draft) return;
      store.update(draft.id, (entry) => { const edit = entry.history.undo.at(-1); return edit ? { ...entry, body: edit.before, selection: edit.selectionBefore, revision: entry.revision + 1,
        history: { undo: entry.history.undo.slice(0, -1), redo: [...entry.history.redo, edit], group: entry.history.group + 1 }, status: null } : entry; });
      restoreHistoryFocus();
    },
    redo() {
      if (!draft) return;
      store.update(draft.id, (entry) => { const edit = entry.history.redo.at(-1); return edit ? { ...entry, body: edit.after, selection: edit.selectionAfter, revision: entry.revision + 1,
        history: { undo: [...entry.history.undo, edit], redo: entry.history.redo.slice(0, -1), group: entry.history.group + 1 }, status: null } : entry; });
      restoreHistoryFocus();
    },
    save() { if (draft) submit({ kind: "Save", noteId: draft.base.kind === "Present" ? draft.base.id : createRandomId() }); },
    newChat() {
      if (!draft || draft.load !== "Ready" || draft.operation) return;
      if (draft.body.body_text.trim() && !catalog) { refreshCatalog(); store.update(draft.id, (entry) => ({ ...entry, issue: { kind: "Failed", message: "model configuration unavailable. refreshing availability; your draft is kept." } })); return; }
      submit({ kind: "Chat", selection: catalog?.chat_seed.selection ?? null });
    },
    deleteNote() { if (draft?.base.kind === "Present" && isEmptyParagraph(draft.body)) submit({ kind: "Delete" }); },
    highlight(color: HighlightColor) { submit({ kind: "Highlight", color }); },
    ensure(then: (id: string, isCurrent: () => boolean) => void | Promise<void>) { submit({ kind: "Ensure" }, then); },
    retry() {
      if (!draft) return;
      if (draft.load === "Failed" && draft.highlightId) void readNote(draft.id, draft.highlightId, sameBody(draft.body, initialBody(draft.base)));
      else { nudgeWrites(); store.retry(draft.id); }
    },
    resolveConflict(useSaved: boolean) {
      if (!draft || draft.operation || draft.issue?.kind !== "Conflict") return;
      if (reconcileDeletedNote(draft) !== draft) { store.update(draft.id, reconcileDeletedNote); return; }
      const base = draft.issue.saved;
      store.update(draft.id, (entry) => ({ ...entry, base, body: useSaved ? initialBody(base) : entry.body, revision: entry.revision + 1,
        operation: null, issue: null, ...(useSaved ? { selection: null, history: emptyNoteBodyHistory() } : {}) }));
      if (!useSaved) submit({ kind: "Save", noteId: base.kind === "Present" ? base.id : createRandomId() });
    },
  };
}

export type SelectionComposer = ReturnType<typeof useSelectionComposer>;
