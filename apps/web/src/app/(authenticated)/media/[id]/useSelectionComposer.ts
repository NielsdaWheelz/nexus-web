"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { openAsyncResult, type OpenResult } from "@/lib/panes/openResult";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { conversationViewHref } from "@/lib/chat/view";
import { settleDeletedResourcePanes } from "@/lib/actions/settleDeletedResource";
import { apiFetch, isApiError } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { getConversationCommands, getNewChatCommands, readConversationTree, recoveryOf, IDLE_COMMAND, type CommandOutcome, type ConversationTree } from "@/lib/chat/commands";
import { fetchConversationIndex, type ConversationListItem } from "@/lib/chat/conversationIndex";
import type { ListPage } from "@/lib/api/useServerList";
import { convertReaderQuestion } from "@/lib/chat/readerQuestion";
import { isSelectable } from "@/lib/chat/selection";
import { chatView } from "@/lib/chat/tree";
import { assertNever } from "@/lib/assertNever";
import { readCatalog } from "@/lib/chat/catalog";
import { assumeReaderSelectionKey, getReaderQuotePreview, readerHighlightChatIntentHref } from "@/lib/chat/readerIntent";
import { chatFailure, type Catalog, type Selection } from "@/lib/chat/wire";
import { createRandomId } from "@/lib/createRandomId";
import type { Mark, SelectionCapture } from "@/lib/documentReader/DocumentReader";
import type { Reader } from "@/lib/documentReader/runtime";
import type { HighlightColor } from "@/lib/documentReader/model";
import { emptyNoteBodyHistory, recordNoteBodyEdit } from "@/lib/notes/bodyHistory";
import { docFromBody, emptyBody, parseBody, sameBody } from "@/lib/notes/noteBody";
import { adoptText, setGone } from "@/lib/notes/texts";
import type { NoteEdit } from "@/lib/notes/useOutlineSession";
import { enqueueWrite, nudgeWrites, type WriteRequest } from "@/lib/notes/writes";
import type { ReferenceInputHost } from "@/lib/resourceGraph/useReferenceInput";
import { announceResourceDeletion, isDeletedResource, subscribeLinkMutations } from "@/lib/resourceGraph/links";
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";
import { useLatestWorkspace } from "@/lib/workspace/store";
import type { AnnotationStore } from "./annotations";
import { createSelectionDrafts, initialBody, isEmptyParagraph, noteBase, samePassage, type ComposerDraft, type SelectionDrafts } from "./selectionDrafts";

const VISIT_DRAFTS = definePaneVisitDataKey<SelectionDrafts>("Reader.AnnotationDrafts");
const DEFAULT_VISIT = definePaneVisitDataKey<Visit<ListPage<ConversationListItem>>>("Reader.ChatDefault");
const TREE_VISIT = definePaneVisitDataKey<Visit<{ tree: ConversationTree | null }>>("Reader.ChatTree");
const CATALOG_VISIT = definePaneVisitDataKey<Visit<Catalog>>("Reader.ChatCatalog");
type Highlight = Schema<"TypedHighlightOut">;
type Note = Schema<"LinkedNoteBlockRef">;
type Opening = { id: string; draftId: string; focus: boolean; ownsFocus: boolean; serial: number };
type Command =
  | { kind: "Save"; noteId: string }
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

/** A settled draft cannot claim a later command that happens to use the same chat. */
function readerRecovery(attempt: ComposerDraft["chatAttempt"]) {
  return attempt?.kind === "Dispatched" ? recoveryOf(attempt.owner.getSnapshot(),
    command => command.kind === "Send" && command.runId === attempt.runId) : null;
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
  reader: Reader;
  annotations: AnnotationStore;
  active: boolean;
  onError: (error: unknown, title: string) => void;
}) {
  const { reader, annotations, active, onError } = input;
  const latestWorkspace = useLatestWorkspace();
  const { ctx } = useActionRuntime();
  const pane = requirePaneRuntime(usePaneRuntime(), "useSelectionComposer");
  const catalogRead = useServerValue({ key: "/llm-catalog", stale: "", visit: CATALOG_VISIT, load: readCatalog });
  const catalog = catalogRead.status === "ready" && catalogRead.error === null ? catalogRead.data : null;
  const refreshCatalog = catalogRead.refetch;
  const holder = useRef<SelectionDrafts | null>(null);
  const retained = usePaneVisitData(VISIT_DRAFTS, () => holder.current);
  const [store] = useState(() => retained ?? createSelectionDrafts());
  holder.current = store;
  const retain = usePaneVisitDataWriter(VISIT_DRAFTS);
  const drafts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [pickerDraftId, setPickerDraftId] = useState<string | null>(null);
  const [opening, setOpening] = useState<Opening | null>(null);
  const current = useRef<Opening | null>(null);
  const serial = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const show = useCallback((next: Opening | null) => { current.current = next; setOpening(next); }, []);
  useEffect(() => { if (!active) { show(null); setPickerDraftId(null); } }, [active, show]);
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
  const destination = draft?.destination ?? null;
  const defaultId = draft?.load === "Ready" && destination?.kind === "Resolving" ? draft.id : null;
  const defaultSource = draft?.sourceMediaId ?? null;
  const defaultRead = useServerValue({ key: defaultId ? `reader-chat-default:${defaultId}:${defaultSource}` : null,
    stale: "", visit: DEFAULT_VISIT,
    load: signal => fetchConversationIndex(new URLSearchParams({ media_id: defaultSource!, limit: "1" }), signal),
  });
  useEffect(() => {
    if (!defaultId || !defaultSource || defaultRead.status === "loading") return;
    store.update(defaultId, entry => {
      if (entry.destination.kind !== "Resolving" || entry.sourceMediaId !== defaultSource) return entry;
      if (defaultRead.status === "failed") return { ...entry, destination: { kind: "LookupFailed" } };
      const candidate = defaultRead.data.items[0];
      return { ...entry, sourceHasChats: candidate !== undefined, destination: candidate
        ? { kind: "Selected", id: candidate.id, title: candidate.title, read: 0, snapshot: { kind: "Loading" } }
        : { kind: "Absent" } };
    });
  }, [defaultId, defaultRead, defaultSource, store]);
  const selectedId = destination?.kind === "Selected" ? destination.id : null;
  const treeReadId = destination?.kind === "Selected" && destination.snapshot.kind === "Loading" ? destination.read : null;
  const treeRead = useServerValue({ key: draft && selectedId && treeReadId !== null ? `reader-chat-tree:${draft.id}:${selectedId}:${treeReadId}` : null,
    stale: "", visit: TREE_VISIT, load: async () => ({ tree: await readConversationTree(selectedId!) }),
  });
  useEffect(() => {
    if (!draft || !selectedId || treeReadId === null || treeRead.status === "loading") return;
    store.update(draft.id, entry => {
      const selected = entry.destination;
      if (selected.kind !== "Selected" || selected.id !== selectedId || selected.read !== treeReadId || selected.snapshot.kind !== "Loading") return entry;
      if (treeRead.status === "failed") return { ...entry, destination: { ...selected, snapshot: { kind: "Failed" } } };
      return treeRead.data.tree ? { ...entry, destination: { ...selected, title: treeRead.data.tree.conversation.title,
        snapshot: { kind: "Ready", tree: treeRead.data.tree } } }
        : { ...entry, destination: { ...selected, snapshot: { kind: "Failed" } }, chatIssue: { kind: "Missing", message: "this chat is no longer available" } };
    });
  }, [draft, selectedId, treeRead, treeReadId, store]);
  const newOwner = useMemo(() => getNewChatCommands(ctx.accountId, pane.paneId), [ctx.accountId, pane.paneId]);
  const selectedOwner = selectedId ? getConversationCommands(ctx.accountId, selectedId) : null;
  const commandOwner = (draft?.chatAttempt?.kind === "Dispatched" && readerRecovery(draft.chatAttempt) ? draft.chatAttempt.owner : null) ?? selectedOwner ?? newOwner;
  const subscribeHeld = useCallback((changed: () => void) => {
    const owners = new Set(drafts.flatMap(entry => entry.chatAttempt?.kind === "Dispatched" ? [entry.chatAttempt.owner] : []));
    const subscriptions = [...owners].map(owner => owner.subscribe(changed));
    return () => subscriptions.forEach(unsubscribe => unsubscribe());
  }, [drafts]);
  const readHeld = useCallback(() => {
    for (const entry of drafts) if (entry.chatAttempt?.kind === "Dispatched") {
      const state = readerRecovery(entry.chatAttempt);
      if (state) return state;
    }
    return IDLE_COMMAND;
  }, [drafts]);
  const heldState = useSyncExternalStore(subscribeHeld, readHeld, readHeld);
  const hasHeldChat = () => store.getSnapshot().some(entry => entry.chatAttempt?.kind === "Preparing" ||
    readerRecovery(entry.chatAttempt) !== null);
  const readerChatLocked = heldState.kind !== "Idle" || drafts.some(entry => entry.chatAttempt?.kind === "Preparing");
  const chatState = useSyncExternalStore(commandOwner.subscribe, commandOwner.getSnapshot, commandOwner.getSnapshot);
  const newState = useSyncExternalStore(newOwner.subscribe, newOwner.getSnapshot, newOwner.getSnapshot);
  const ownChatCommand = draft !== null && draft.chatAttempt?.kind === "Dispatched" && chatState.kind !== "Idle" &&
    chatState.command.kind === "Send" && chatState.command.runId === draft.chatAttempt.runId;
  const chatLocked = readerChatLocked || chatState.kind !== "Idle" || newState.kind !== "Idle";
  useEffect(() => {
    if (draft?.chatAttempt?.kind === "Dispatched" && chatState.kind === "Idle") store.update(draft.id, entry => ({ ...entry, chatAttempt: null }));
  }, [chatState.kind, draft, store]);
  useEffect(() => {
    if (draft?.chatIssue?.kind === "Catalog" && catalogRead.status === "ready" && !catalogRead.error)
      store.update(draft.id, entry => ({ ...entry, chatIssue: null }));
  }, [catalogRead, draft, store]);
  const observedTree = destination?.kind === "Selected" && destination.snapshot.kind === "Ready" ? destination.snapshot.tree : null;
  const chat = observedTree ? chatView({ messages: new Map(observedTree.messages.map(message => [message.id, message])),
    leafId: observedTree.active_leaf_message_id, history: "Ready" }, observedTree.conversation.id, null) : null;
  // Target and model come from the canonical stored leaf, never another pane's endpoint.
  const branchCue = chat && [...chat.children.values()].some(children => children.filter(message => message.role === "user").length > 1)
    ? `branch · response ${chat.path.at(-1)?.seq ?? "empty"}` : null;
  useEffect(() => subscribeLinkMutations((change) => {
    if (change.kind !== "resource_deleted") return;
    for (const entry of store.getSnapshot()) if (reconcileDeletedNote(entry) !== entry) store.update(entry.id, reconcileDeletedNote);
  }), [store]);

  const readNote = useCallback(async (draftId: string, highlightId: string, replace: boolean) => {
    if (replace) store.update(draftId, (entry) => ({ ...entry, load: "Loading", issue: entry.load === "Failed" ? entry.issue : null }));
    const requested = store.getSnapshot().find((entry) => entry.id === draftId);
    if (!requested) return;
    const ownsRead = () => {
      const entry = store.getSnapshot().find((entry) => entry.id === draftId);
      return entry?.highlightId === highlightId && entry.passage === requested.passage && (!replace || entry.revision === requested.revision) &&
        entry.operation === requested.operation && entry.issue === requested.issue;
    };
    try {
      const data = await liveHighlight(highlightId);
      if (!ownsRead()) return;
      if (!data) {
        store.update(draftId, (entry) => ({ ...entry, load: "Failed", issue: { kind: "Failed", message: "this highlight is no longer available. your draft is kept." } }));
        return;
      }
      const saved = data.anchor;
      const anchor = saved.type === "fragment_offsets"
        ? { kind: "text" as const, unit: saved.fragment_id, start: saved.start_offset, end: saved.end_offset }
        : { kind: "pdf" as const, page: saved.page_number, quads: saved.quads };
      const shown = reader.getState().document;
      if (shown.status !== "ready" || shown.doc.identity !== requested.passage.identity ||
        JSON.stringify(anchor) !== JSON.stringify({ ...annotations.source(requested.passage.anchor).anchor, exact: undefined })) {
        store.update(draftId, (entry) => ({ ...entry, load: "Failed", issue: { kind: "Failed", message: "this highlight moved. close this draft and reopen its current passage." } }));
        return;
      }
      const base = noteBase(data), body = initialBody(base), doc = docFromBody(body);
      const end = doc.firstChild?.isTextblock ? doc.content.size - 1 : 0;
      const sameBase = base.kind === "Absent" ? requested.base.kind === "Absent" :
        requested.base.kind === "Present" && base.id === requested.base.id && base.version === requested.base.version;
      store.update(draftId, (entry) => ({ ...entry, highlight: data, highlightId: data.id, passage: { ...entry.passage, quote: data.exact }, sourceMediaId: data.anchor.media_id, load: "Ready",
        chatIssue: entry.chatIssue?.kind === "Passage" || entry.chatIssue?.kind === "Source" ? null : entry.chatIssue,
        ...(replace ? { base, body, selection: { anchor: end, head: end }, revision: entry.revision + 1, history: emptyNoteBodyHistory(), issue: null } :
          { issue: sameBase ? null : { kind: "Conflict", message: "this note changed elsewhere. your draft is kept.", saved: base } }) }));
    } catch (error) {
      if (!ownsRead()) return;
      store.update(draftId, (entry) => ({ ...entry, load: replace ? "Failed" : entry.load, issue: { kind: "Failed", message: "your note could not be loaded. your draft is kept." } }));
      onError(error, "Note couldn’t be loaded");
    }
  }, [annotations, onError, reader, store]);

  const open = (passage: ComposerDraft["passage"], highlightId: string | null, focus: boolean) => {
    setPickerDraftId(null);
    let existing = (highlightId ? store.getSnapshot().find((entry) => entry.highlightId === highlightId) : undefined) ??
      store.getSnapshot().find((entry) => samePassage(entry.passage, passage));
    if (existing) {
      const admitted = reconcileDeletedNote(existing);
      if (admitted !== existing) store.update(existing.id, () => admitted);
      existing = admitted;
    }
    const id = existing?.id ?? createRandomId();
    const boundSource = annotations.source(passage.anchor);
    const anchor = boundSource.anchor;
    const generation = boundSource.generation ?? (
      passage.identity.startsWith("g") ? Number(passage.identity.slice(1)) : null
    );
    const selectionId = highlightId ?? existing?.highlightId ?? existing?.referenceSource.highlight_id ?? createRandomId();
    const referenceSource: ComposerDraft["referenceSource"] = anchor.kind === "text"
      ? {
        kind: "fragment_selection",
        fragment_id: anchor.unit,
        start_offset: anchor.start,
        end_offset: anchor.end,
        expected_reader_generation: generation,
        highlight_id: selectionId,
        color: "yellow",
      }
      : {
        kind: "pdf_selection",
        media_id: boundSource.mediaId,
        page_number: anchor.page,
        quads: structuredClone([...anchor.quads]),
        exact: passage.quote,
        expected_reader_generation: generation,
        highlight_id: selectionId,
        color: "yellow",
      };
    if (!existing) {
      store.put({
        id, passage, referenceSource, highlightId, highlight: null,
        base: { kind: "Absent" }, body: emptyBody(), revision: 0,
        selection: null, history: emptyNoteBodyHistory(),
        load: highlightId ? "Loading" : "Ready", operation: null,
        issue: null, status: null, referenceActive: false,
        sourceMediaId: boundSource.mediaId, sourceHasChats: null, destination: { kind: "Resolving" }, chatAttempt: null, chatIssue: null,
      });
    }
    else store.update(id, (entry) => ({ ...entry, passage: passage.quote ? passage : { ...passage, quote: entry.passage.quote },
      referenceSource, sourceMediaId: boundSource.mediaId, highlightId: highlightId ?? entry.highlightId }));
    show({ id: createRandomId(), draftId: id, focus, ownsFocus: true, serial: ++serial.current });
    const clean = existing && sameBody(existing.body, initialBody(existing.base));
    if (highlightId && !existing?.operation && existing?.load !== "Loading") {
      void readNote(id, highlightId, !existing || Boolean(clean));
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
    if (!source || !entry || entry.load !== "Ready" || entry.operation || entry.referenceActive) return;
    const shown = reader.getState().document;
    if (shown.status !== "ready" || shown.refreshing || shown.doc.identity !== entry.passage.identity) {
      store.update(entry.id, (value) => ({ ...value, issue: { kind: "Failed", message: "this post changed. select the passage again." } }));
      return;
    }
    if (!entry.highlightId && !reader.measurePassage(entry.passage)) return;
    const submitted = { ...entry, commandId: createRandomId() };
    const openingId = source.id;
    const owns = () => activeRef.current && current.current?.id === openingId && current.current.ownsFocus && get(entry.id)?.revision === submitted.revision;
    let targetId = entry.highlightId;
    let target = entry.highlight;
    const run = async () => {
      store.update(entry.id, (value) => ({ ...value, operation: { id: submitted.commandId, kind: command.kind }, issue: null,
        status: command.kind === "Save" ? "saving note…" : command.kind === "Delete" ? "deleting note…" : command.kind === "Ensure" ? "preparing passage…" : "saving highlight…" }));
      const execute = async (): Promise<OpenResult | null> => {
        if (!targetId) {
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
        if (command.kind === "Delete") {
          if (submitted.base.kind !== "Present") throw new Error("Deleting an absent note");
          const ref = `note_block:${submitted.base.id}`;
          await write<ApiJson<"/highlights/{highlight_id}/note/delete", "post">["data"]>({ path: `/api/highlights/${targetId}/note/delete`, method: "POST", link_refs: [`highlight:${targetId}`],
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
            return null;
          }
          if (command.kind === "Save") {
            if (submitted.base.kind === "Present" || !isEmptyParagraph(submitted.body)) {
              const highlight = live;
              await write<Note>({ path: `/api/highlights/${targetId}/note`, method: "PUT", link_refs: [`highlight:${targetId}`], body: {
                note_id: command.noteId, body_pm_json: submitted.body.body_pm_json,
                expected: submitted.base.kind === "Present" ? { kind: "version", version: submitted.base.version } : { kind: "absent", version: live.links_version } } }, (saved) => {
                const base = isDeletedResource(`note_block:${saved.note_block_id}`) ? { kind: "Absent" } as const :
                  { kind: "Present", id: saved.note_block_id, version: saved.body_version, body: parseBody(saved.body_pm_json), embeddedItem: saved.embedded_item ?? null } as const;
                const accepted = base.kind === "Present" && sameBody(base.body, submitted.body);
                store.update(entry.id, (value) => ({ ...value, base: accepted ? base : value.base,
                  issue: accepted ? null : { kind: "Conflict", message: "this note changed elsewhere. your draft is kept.", saved: base }, status: accepted ? "note saved." : null }));
                if (base.kind === "Present") adoptText(`note_block:${base.id}`, base.body, base.version);
                publishChange("Notes");
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
          if (continuation) await continuation(targetId, owns);
        }
        store.update(entry.id, (value) => ({ ...value, operation: null,
          ...(value.revision === submitted.revision && (command.kind === "Highlight" || command.kind === "Ensure")
            ? { status: command.kind === "Highlight" ? "highlight saved." : "passage ready." } : {}) }));
        return null;
      };
      try {
        await execute();
      } catch (error) {
        if (ctx.sessionSignal().aborted) return;
        store.update(entry.id, (value) => ({ ...value, operation: null,
          issue: { kind: "Failed", message: "this request did not finish. your draft is kept." } }));
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
        } else if (isApiError(error) && error.code === "E_READER_CONTENT_CHANGED") {
          store.update(entry.id, (value) => ({ ...value, issue: { kind: "Failed", message: "this post changed. select the passage again." } }));
          reader.reload();
        } else if (isApiError(error) && (error.code === "E_NOTE_CONFLICT" || error.code === "E_RESOURCE_CONFLICT") && targetId) void readNote(entry.id, targetId, false);
        else onError(error, "Passage request didn’t finish");
      }
    };
    const completion = run();
    retain(store);
    return completion;
  };

  const restoreEditor = () => {
    setPickerDraftId(null);
    if (current.current) show({ ...current.current, focus: true, ownsFocus: true, serial: ++serial.current });
  };
  const chooseChat = () => {
    const entry = current.current && get(current.current.draftId);
    if (!entry || entry.operation || entry.referenceActive || chatLocked || hasHeldChat()) return;
    setPickerDraftId(entry.id);
  };
  const chatOutcome = (entry: ComposerDraft, outcome: CommandOutcome, target: "New" | "Existing"): OpenResult | null => {
    const currentAttempt = get(entry.id)?.chatAttempt;
    const attempt = currentAttempt?.kind === "Dispatched" ? currentAttempt : null;
    const held = readerRecovery(attempt ?? null) ? attempt : null;
    switch (outcome.kind) {
      case "Accepted": {
        const title = entry.destination.kind === "Selected" && target === "Existing" ? `sent to “${entry.destination.title}”` : "message sent";
        store.update(entry.id, value => ({ ...value, operation: null, chatAttempt: held, chatIssue: null, status: `${title}. note draft kept.` }));
        return { target: { href: conversationViewHref(outcome.receipt.outcome.conversation_id, outcome.receipt.outcome.assistant_message_id), labelHint: "chat" },
          title: "message sent", openLabel: "open response" };
      }
      case "Pending":
        store.update(entry.id, value => ({ ...value, operation: null }));
        return null;
      case "Gone":
        store.update(entry.id, value => ({ ...value, operation: null, chatAttempt: null,
          destination: target === "Existing" && value.destination.kind === "Selected" ? { ...value.destination, snapshot: { kind: "Failed" } } : value.destination,
          chatIssue: { kind: "Missing", message: "this chat is no longer available" } }));
        return null;
      case "Failed": {
        store.update(entry.id, value => ({ ...value, operation: null, chatAttempt: held,
          destination: target === "Existing" && outcome.rejection === "E_CONVERSATION_NOT_FOUND" && value.destination.kind === "Selected"
            ? { ...value.destination, snapshot: { kind: "Failed" } } : value.destination,
          chatIssue: outcome.rejection === "E_READER_SELECTION_STALE" ? { kind: "Passage", message: "this passage changed. reopen the highlight before sending" }
            : outcome.rejection === "E_CONVERSATION_NOT_FOUND" ? { kind: "Missing", message: "this chat is no longer available" }
            : outcome.rejection === "E_GENERATION_SELECTION_UNAVAILABLE" || outcome.rejection === "E_INVALID_GENERATION_SELECTION"
              ? { kind: "Model", message: "this chat’s model is unavailable", destination: attempt?.destination ?? "Existing", selection: attempt?.selection ?? null }
              : { kind: "Failed", message: `${outcome.feedback.title}${outcome.feedback.message ? ` ${outcome.feedback.message}` : ""}` } }));
        return null;
      }
      case "Settled":
      case "Handled":
        store.update(entry.id, value => ({ ...value, operation: null, chatAttempt: held }));
        return null;
      default: return assertNever(outcome);
    }
  };
  const sendChat = async (target: "New" | "Existing", openIntent: OpenIntent, recovery: { selection: Selection | null } | null = null) => {
    const source = current.current;
    const entry = source && get(source.draftId);
    if (!source || !entry || entry.load !== "Ready" || entry.operation || entry.referenceActive || pickerDraftId !== null || hasHeldChat()) return;
    const selected = entry.destination;
    const owner = target === "New" ? newOwner : selected.kind === "Selected" ? getConversationCommands(ctx.accountId, selected.id) : null;
    if (!owner) { chooseChat(); return; }
    const question = convertReaderQuestion(entry.body);
    switch (question.kind) {
      case "Unsupported":
        store.update(entry.id, value => ({ ...value, chatIssue: { kind: "Failed", message: "images and embedded items can’t be sent from here" } })); return;
      case "Text":
        if ([...question.content].length > 20_000) {
          store.update(entry.id, value => ({ ...value, chatIssue: { kind: "Failed", message: "this question is too long. shorten it before sending" } })); return;
        }
        break;
      case "Blank": break;
      default: return assertNever(question);
    }
    if (question.kind === "Text" && recovery === null && (newOwner.getSnapshot().kind !== "Idle" || (selected.kind === "Selected" && getConversationCommands(ctx.accountId, selected.id).getSnapshot().kind !== "Idle"))) {
      store.update(entry.id, value => ({ ...value, chatIssue: { kind: "Failed", message: "another chat change is still in progress. open that chat to resolve it." } })); return;
    }
    const shown = reader.getState().document;
    const canonical = annotations.source(entry.passage.anchor);
    if (shown.status !== "ready" || shown.refreshing || shown.doc.identity !== entry.passage.identity || canonical.mediaId !== entry.sourceMediaId ||
      canonical.generation !== entry.referenceSource.expected_reader_generation) {
      store.update(entry.id, value => ({ ...value, chatIssue: { kind: "Source", message: "this source changed. select the passage again. your draft is kept" } })); return;
    }
    let observed: ConversationTree | null = null;
    let view: ReturnType<typeof chatView> | null = null;
    if (target === "Existing") {
      if (selected.kind !== "Selected") { chooseChat(); return; }
      if (selected.snapshot.kind !== "Ready") return;
      observed = selected.snapshot.tree;
      view = chatView({ messages: new Map(observed.messages.map(message => [message.id, message])), leafId: observed.active_leaf_message_id, history: "Ready" }, selected.id, null);
      if (question.kind === "Text" && recovery === null && view.target.kind === "Blocked") {
        store.update(entry.id, value => ({ ...value, chatIssue: { kind: "Changed", message: view?.target.kind === "Blocked" && view.target.reason === "AssistantRunning"
          ? "this chat is still responding" : "this chat can’t accept a reply here" } })); return;
      }
    }
    const selection = recovery ? recovery.selection : target === "Existing" && view?.target.kind !== "Empty" ? view?.inherited ?? null
      : catalogRead.status === "ready" ? catalogRead.data.chat_seed.selection : null;
    if (question.kind === "Text" && recovery === null) {
      if (!catalog) {
        store.update(entry.id, value => ({ ...value, chatIssue: { kind: "Catalog", message: "couldn’t load model availability", destination: target, selection } })); return;
      }
      if (selection === null || !isSelectable(catalog, selection)) {
        store.update(entry.id, value => ({ ...value, chatIssue: { kind: "Model", message: "this chat’s model is unavailable", destination: target, selection } })); return;
      }
    }
    const runId = createRandomId();
    store.update(entry.id, value => ({ ...value, chatAttempt: { kind: "Preparing", runId } }));
    const owns = () => activeRef.current && current.current?.id === source.id && current.current.ownsFocus && get(entry.id)?.revision === entry.revision;
    const execute = async (): Promise<OpenResult | null> => {
      let ensured: string | null = null;
      await submit({ kind: "Ensure" }, id => { ensured = id; });
      if (!ensured || ctx.sessionSignal().aborted) return null;
      store.update(entry.id, value => ({ ...value, operation: { id: runId, kind: "Chat" }, chatIssue: null }));
      const sourceNow = annotations.source(entry.passage.anchor);
      if (sourceNow.mediaId !== entry.sourceMediaId || sourceNow.generation !== entry.referenceSource.expected_reader_generation) {
        store.update(entry.id, value => ({ ...value, operation: null, chatIssue: { kind: "Source", message: "this source changed. select the passage again. your draft is kept" } })); return null;
      }
      const live = get(entry.id)?.highlight;
      if (!live || live.anchor.media_id !== entry.sourceMediaId || live.exact !== entry.passage.quote || (entry.highlight &&
        live.version !== entry.highlight.version)) {
        store.update(entry.id, value => ({ ...value, operation: null, highlight: entry.highlight ?? value.highlight,
          chatIssue: { kind: "Passage", message: "this passage changed. reopen the highlight before sending" } })); return null;
      }
      const key = assumeReaderSelectionKey({ mediaId: live.anchor.media_id, highlightId: ensured });
      const preview = await getReaderQuotePreview({ key });
      // Preview has a revision, but its displayed excerpt may be truncated. Verify
      // its surrounding full highlight observation instead of rebasing the quote.
      const verified = await liveHighlight(ensured);
      if (!verified || verified.version !== live.version) {
        annotations.refresh();
        store.update(entry.id, value => ({ ...value, operation: null, chatIssue: { kind: "Passage", message: "this passage changed. reopen the highlight before sending" } })); return null;
      }
      const finalSource = annotations.source(entry.passage.anchor);
      if (finalSource.mediaId !== entry.sourceMediaId || finalSource.generation !== entry.referenceSource.expected_reader_generation) {
        store.update(entry.id, value => ({ ...value, operation: null, chatIssue: { kind: "Source", message: "this source changed. select the passage again. your draft is kept" } })); return null;
      }
      const quoteHref = readerHighlightChatIntentHref({ destination: observed ? { kind: "Existing", conversationId: observed.conversation.id } : { kind: "New" }, key });
      const href = observed ? `${conversationViewHref(observed.conversation.id, observed.active_leaf_message_id)}${quoteHref.slice(quoteHref.indexOf("#"))}` : quoteHref;
      if (question.kind === "Blank" || recovery !== null) {
        store.update(entry.id, value => ({ ...value, operation: null, status: "quoted chat ready. note draft kept." }));
        return { target: { href, labelHint: "chat" }, title: "quoted chat ready", openLabel: "open chat",
          ...(recovery !== null ? { entry: { kind: "ComposeReaderQuestion" as const, text: question.kind === "Text" ? question.content : "", selection } } : {}) };
      }
      if (!selection) throw new Error("Reader send without an observed selection");
      if (owner.getSnapshot().kind !== "Idle") {
        store.update(entry.id, value => ({ ...value, operation: null, chatIssue: { kind: "Failed", message: "another chat change is still in progress" } })); return null;
      }
      const insertion = view?.target;
      if (target === "Existing" && insertion?.kind !== "Empty" && insertion?.kind !== "Reply") throw new Error("Reader send without a replyable snapshot");
      store.update(entry.id, value => ({ ...value, operation: null, chatAttempt: { kind: "Dispatched", runId, owner, selection, destination: target } }));
      const request = { destination: observed && insertion && (insertion.kind === "Empty" || insertion.kind === "Reply")
        ? { kind: "Existing" as const, conversation_id: observed.conversation.id, expected_revision: observed.conversation.branch_revision,
          insertion: insertion.kind === "Empty" ? { kind: "Empty" as const } : { kind: "Reply" as const, parent_message_id: insertion.parentId, branch_anchor: insertion.anchor } }
        : { kind: "New" as const }, content: question.content, selection, reader_selection: { key: preview.key, revision: preview.revision } };
      const result = await owner.execute({ kind: "Send", request, runId, viewId: pane.paneId, openIntent }, () => {
        store.update(entry.id, value => value.chatAttempt?.runId !== runId ? value : { ...value,
          chatIssue: null,
          destination: value.destination.kind === "Selected" ? { ...value.destination, snapshot: { kind: "RefreshRequired" } } : value.destination,
          status: target === "Existing" && selected.kind === "Selected" ? `sent to “${selected.title}”. note draft kept.` : "message sent. note draft kept." });
      });
      if (result.kind === "Failed" && (result.rejection === "E_GENERATION_SELECTION_UNAVAILABLE" || result.rejection === "E_INVALID_GENERATION_SELECTION")) {
        store.update(entry.id, value => ({ ...value, operation: null, chatAttempt: null,
          chatIssue: { kind: "Model", message: "this chat’s model is unavailable", destination: target, selection } })); return null;
      }
      return chatOutcome(entry, result, target);
    };
    try {
      await openAsyncResult({ ctx, originPaneId: pane.paneId, intent: openIntent, disposition: "Fork", mayOpen: owns,
        beforeOpen: () => { retain(store); if (current.current?.id === source.id) show(null); }, create: execute });
    } catch (error) {
      if (ctx.sessionSignal().aborted) return;
      store.update(entry.id, value => ({ ...value, operation: null, chatIssue: { kind: "Failed", message: isApiError(error) && error.code === "E_READER_CONTENT_CHANGED"
        ? "this source changed. select the passage again. your draft is kept" : "chat couldn’t be prepared. your question is kept" } }));
      const failure = chatFailure(error, "chat couldn’t be prepared");
      if (failure.kind === "Defect") onError(failure.error, "Chat couldn’t be prepared");
    }
    finally {
      store.update(entry.id, value => value.chatAttempt?.kind === "Preparing" && value.chatAttempt.runId === runId ? { ...value, chatAttempt: null } : value);
    }
    retain(store);
  };
  const refreshChat = async () => {
    const entry = current.current && get(current.current.draftId);
    if (!entry || entry.destination.kind !== "Selected" || entry.operation) return;
    if (entry.chatAttempt?.kind === "Preparing") return;
    const attempt = entry.chatAttempt;
    const owner = getConversationCommands(ctx.accountId, entry.destination.id);
    if (!attempt && owner.getSnapshot().kind !== "Idle") return;
    if (attempt) {
      const state = attempt.owner.getSnapshot();
      if (state.kind === "Unconfirmed" || state.kind === "Busy" || (state.kind !== "Idle" && (state.command.kind !== "Send" || state.command.runId !== attempt.runId))) return;
      try {
        const outcome = await attempt.owner.refresh();
        chatOutcome(entry, outcome, attempt.destination);
      } catch (error) {
        if (!ctx.sessionSignal().aborted) onError(error, "chat couldn’t be refreshed");
        return;
      }
      if (attempt.owner.getSnapshot().kind !== "Idle") return;
    }
    store.update(entry.id, value => value.destination.kind !== "Selected" ? value : { ...value, chatIssue: null, chatAttempt: null,
      destination: { ...value.destination, read: value.destination.read + 1, snapshot: { kind: "Loading" } } });
  };
  const retryChat = async () => {
    const source = current.current;
    const entry = source && get(source.draftId);
    const attempt = entry?.chatAttempt;
    if (!source || !entry || attempt?.kind !== "Dispatched") return;
    const state = attempt.owner.getSnapshot();
    if (state.kind === "Idle" || state.command.kind !== "Send" || state.command.runId !== attempt.runId || state.kind !== "Unconfirmed") return;
    try {
      await openAsyncResult({ ctx, originPaneId: pane.paneId, intent: state.command.openIntent, disposition: "Fork",
        mayOpen: () => activeRef.current && current.current?.id === source.id && current.current.ownsFocus && get(entry.id)?.revision === entry.revision,
        beforeOpen: () => { retain(store); if (current.current?.id === source.id) show(null); },
        create: async () => chatOutcome(entry, await attempt.owner.retry(), attempt.destination) });
    } catch (error) { onError(error, "Chat retry didn’t finish"); }
  };
  const restoreHistoryFocus = () => {
    if (current.current?.ownsFocus) show({ ...current.current, focus: true, serial: ++serial.current });
  };
  return {
    draft, opening, chat, branchCue, chatState, chatLocked, readerChatLocked, ownChatCommand,
    pickerOpen: draft !== null && pickerDraftId === draft.id,
    chooseChat, closePicker: restoreEditor,
    chooseDestination(conversation: Pick<ConversationListItem, "id" | "title">) {
      if (!draft || chatLocked || hasHeldChat() || draft.operation) return;
      store.update(draft.id, entry => ({ ...entry, chatIssue: null, destination: { kind: "Selected", id: conversation.id,
        title: conversation.title, read: 0, snapshot: { kind: "Loading" } } }));
      restoreEditor();
    },
    retryDefault() { if (draft && draft.destination.kind === "LookupFailed") store.update(draft.id, entry => ({ ...entry, destination: { kind: "Resolving" } })); },
    refreshChat, retryChat,
    retryCatalog: refreshCatalog,
    recoverModel() {
      const issue = draft?.chatIssue;
      if (issue?.kind === "Model" || issue?.kind === "Catalog") void sendChat(issue.destination, "default", { selection: issue.selection });
    },
    openChat() {
      if (!draft || draft.destination.kind !== "Selected") return;
      const tree = draft.destination.snapshot.kind === "Ready" ? draft.destination.snapshot.tree : null;
      pane.activateTarget({ target: { href: tree ? conversationViewHref(draft.destination.id, tree.active_leaf_message_id) : `/conversations/${draft.destination.id}`, labelHint: draft.destination.title }, disposition: { kind: "Fork" } });
    },
    reference(): ReferenceInputHost | null {
      if (!draft || draft.load !== "Ready") return null;
      const id = draft.id, highlightId = draft.highlightId ?? draft.referenceSource.highlight_id;
      const source = draft.highlightId ? { kind: "resource" as const, ref: `highlight:${highlightId}` }
        : draft.referenceSource;
      return { source, label: "selected passage", position: null,
        onActiveChange(active) { store.update(id, (entry) => entry.referenceActive === active ? entry : { ...entry, referenceActive: active }); },
        onInserted() { store.update(id, (entry) => ({ ...entry, highlightId, referenceActive: false, status: "linked" })); annotations.refresh(); },
      };
    },
    activePassage: active && draft ? draft.passage : null,
    select(capture: SelectionCapture) { open(capture, annotations.twin(capture.anchor), capture.input !== "touch"); },
    activate(mark: Mark, identity: string, focus = true) { open({ identity, anchor: mark.anchor, quote: "" }, mark.id, focus); },
    highlightDeleted,
    dismiss(reason?: "outside-click" | "escape") {
      const returnFocus = current.current?.ownsFocus;
      show(null); setPickerDraftId(null); retain(store);
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
    newChat(openIntent: OpenIntent) { void sendChat("New", openIntent); },
    continueChat(openIntent: OpenIntent = "default") { void sendChat("Existing", openIntent); },
    deleteNote() { if (draft?.base.kind === "Present" && isEmptyParagraph(draft.body)) submit({ kind: "Delete" }); },
    highlight(color: HighlightColor) { submit({ kind: "Highlight", color }); },
    async ensure(): Promise<{ id: string; isCurrent: () => boolean } | null> {
      let result: { id: string; isCurrent: () => boolean } | null = null;
      await submit({ kind: "Ensure" }, (id, isCurrent) => { result = { id, isCurrent }; });
      return result;
    },
    retry() {
      if (!draft) return;
      if (draft.load === "Failed" && draft.highlightId) void readNote(draft.id, draft.highlightId, sameBody(draft.body, initialBody(draft.base)));
      else nudgeWrites();
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
