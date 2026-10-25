"use client";

// One ephemeral rich composer. Explicit submissions freeze their input; their
// owners settle independently of dismissal and never replace newer input.
// The reading owner stays fixed; canonical fragment anchors may belong to its source.

import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { noteEditorAttachmentOwnerId } from "@/components/notes/NoteEditor";
import { useWorkGuard } from "@/lib/unsavedWork";
import { copyWriting } from "@/components/notes/NoteNotices";
import { useFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { openAsyncResult, type OpenResult } from "@/lib/panes/openResult";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { conversationViewHref } from "@/lib/chat/view";
import { settleDeletedResourcePanes } from "@/lib/actions/settleDeletedResource";
import { apiFetch, isApiError } from "@/lib/api/client";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { getConversationCommands, getNewChatCommands, readConversationTree, recoveryOf, IDLE_COMMAND, type CommandOutcome, type ConversationTree } from "@/lib/chat/commands";
import { fetchLatestSourceConversation, type ConversationListItem } from "@/lib/chat/conversationIndex";
import { convertReaderQuestion } from "@/lib/chat/readerQuestion";
import { isSelectable } from "@/lib/chat/selection";
import { chatView } from "@/lib/chat/tree";
import { assertNever } from "@/lib/assertNever";
import { readCatalog } from "@/lib/chat/catalog";
import { assumeReaderSelectionKey, getReaderQuotePreview, readerHighlightChatIntentHref } from "@/lib/chat/readerIntent";
import { chatFailure, type Catalog, type Selection } from "@/lib/chat/wire";
import { createRandomId } from "@/lib/createRandomId";
import { useReaderState, type Mark, type SelectionCapture } from "@/lib/documentReader/DocumentReader";
import { sameAnchor } from "@/lib/documentReader/anchors";
import type { Reader } from "@/lib/documentReader/runtime";
import type { HighlightColor } from "@/lib/documentReader/model";
import { emptyNoteBodyHistory, recordNoteBodyEdit } from "@/lib/notes/bodyHistory";
import { docFromBody, emptyBody, parseBody, sameBody } from "@/lib/notes/noteBody";
import { adoptText, setGone } from "@/lib/notes/texts";
import { WritingDecisionError, admitWriting, canRetryWriting, readWriting, subscribeWriting, type ConflictShown, type WritingIntent } from "@/lib/notes/writes";
import { useOutlineSession, type NoteEdit } from "@/lib/notes/useOutlineSession";
import { OutlineSessionContext, ResourceBranch } from "@/components/resources/ResourceOutlineList";
import type { ReferenceInputHost } from "@/lib/resourceGraph/useReferenceInput";
import { isDeletedResource, subscribeLinkMutations } from "@/lib/resourceGraph/links";
import { definePaneVisitDataKey, usePaneVisitIdentity } from "@/lib/workspace/paneReturnMemento";
import { useLatestWorkspace } from "@/lib/workspace/store";
import type { AnnotationStore } from "./annotations";
import { createSelectionDrafts, initialBody, isEmptyParagraph, noteBase, samePassage, type ComposerDraft, type ReaderChatIssue } from "./selectionDrafts";

const DEFAULT_VISIT = definePaneVisitDataKey<Visit<{ conversation: ConversationListItem | null }>>("Reader.ChatDefault");
const TREE_VISIT = definePaneVisitDataKey<Visit<{ tree: ConversationTree | null }>>("Reader.ChatTree");
const CATALOG_VISIT = definePaneVisitDataKey<Visit<Catalog>>("Reader.ChatCatalog");
type Highlight = Schema<"TypedHighlightOut">;
type Opening = { id: string; draftId: string; focus: boolean; ownsFocus: boolean; serial: number; mode: "Note" | "Ask" };
type Reselection = { id: string; draftId: string; identity: string; mode: Opening["mode"] };
type Command =
  | { kind: "Save" }
  | { kind: "Ensure" }
  | { kind: "Highlight"; color: HighlightColor; version: string | null }
  | { kind: "Delete" };

async function liveHighlight(id: string): Promise<Highlight | null> {
  try {
    const { data } = await apiFetch<ApiJson<"/highlights/{highlight_id}", "get">>(`/api/highlights/${id}`);
    return { ...data, linked_note_blocks: data.linked_note_blocks.filter((note) => !isDeletedResource(`note_block:${note.note_block_id}`)) };
  } catch (error) { if (isApiError(error) && error.status === 404) return null; throw error; }
}

/** Text fragment identity proves the source; PDF anchors belong to their whole media. */
function matchesSourceAnchor(highlight: Highlight, source: ReturnType<AnnotationStore["source"]>): boolean {
  const saved = highlight.anchor;
  const anchor = source.anchor;
  return anchor.kind === "text"
    ? saved.type === "fragment_offsets" && saved.fragment_id === anchor.unit &&
      saved.start_offset === anchor.start && saved.end_offset === anchor.end
    : saved.type === "pdf_page_geometry" && saved.media_id === source.mediaId &&
      sameAnchor({ kind: "pdf", page: saved.page_number, quads: saved.quads }, anchor);
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
  return { ...entry, ...(baseDeleted ? { base: { kind: "Absent" } as const, load: "Ready" as const, publication: null } : {}),
    issue: { kind: "Deleted", message: "this note was deleted. copy any changes you want to keep." } };

}

export function useSelectionComposer(input: {
  reader: Reader;
  annotations: AnnotationStore;
  active: boolean;
  isMobile: boolean;
  onError: (error: unknown, title: string) => void;
}) {
  const { reader, annotations, active, isMobile, onError } = input;
  const latestWorkspace = useLatestWorkspace();
  const feedback = useFeedback();
  const guard = useWorkGuard();
  const visitId = usePaneVisitIdentity();
  const { ctx } = useActionRuntime();
  const pane = requirePaneRuntime(usePaneRuntime(), "useSelectionComposer");
  const inheritedSession = useContext(OutlineSessionContext);
  const branch = useContext(ResourceBranch);
  const standaloneSession = useOutlineSession({ scope: `reader-annotations:${pane.paneId}`, inheritedBranch: branch });
  const session = inheritedSession ?? standaloneSession;
  const catalogRead = useServerValue({ key: "/llm-catalog", stale: "", visit: CATALOG_VISIT, load: readCatalog });
  const catalog = catalogRead.status === "ready" && catalogRead.error === null ? catalogRead.data : null;
  const refreshCatalog = catalogRead.refetch;
  const [store] = useState(createSelectionDrafts);
  const drafts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const writing = useSyncExternalStore(subscribeWriting, readWriting, readWriting);
  const publication = useReaderState(reader, state => state.document.status === "ready" ? state.document.doc.identity : null);
  const [reselection, setReselection] = useState<Reselection | null>(null);
  const reselecting = useRef<Reselection | null>(null);
  const cancelReselection = useCallback(() => { reselecting.current = null; setReselection(null); }, []);
  const [pickerDraftId, setPickerDraftId] = useState<string | null>(null);
  const [opening, setOpening] = useState<Opening | null>(null);
  const current = useRef<Opening | null>(null);
  const interaction = useRef<string | null>(null);
  const preparing = useRef(new Set<string>());
  const serial = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const inspectClosed = useRef(new Set<() => void>());
  const show = useCallback((next: Opening | null) => {
    const previous = current.current?.draftId;
    current.current = next; interaction.current = next?.id ?? null; setOpening(next);
    if (previous !== next?.draftId) for (const inspect of inspectClosed.current) inspect();
  }, []);
  useEffect(() => { if (!active) { show(null); setPickerDraftId(null); for (const entry of store.getSnapshot()) store.remove(entry.id); } }, [active, show, store]);
  useEffect(() => { cancelReselection(); }, [active, publication, isMobile, cancelReselection]);
  const previousPublication = useRef(publication);
  useEffect(() => {
    if (previousPublication.current === publication) return;
    previousPublication.current = publication;
    show(null); setPickerDraftId(null);
    for (const entry of store.getSnapshot()) store.remove(entry.id);
  }, [publication, show, store]);
  useEffect(() => {
    const retire = () => { if (document.visibilityState === "hidden") cancelReselection(); };
    document.addEventListener("visibilitychange", retire);
    window.addEventListener("blur", cancelReselection);
    return () => { document.removeEventListener("visibilitychange", retire); window.removeEventListener("blur", cancelReselection); };
  }, [cancelReselection]);
  useEffect(() => () => {
    current.current = null; interaction.current = null; reselecting.current = null; activeRef.current = false;
    for (const inspect of inspectClosed.current) inspect();
  }, []);
  useEffect(() => {
    const moved = (event: Event) => {
      const source = current.current;
      if (!source) return;
      if (event.type === "pointerdown" && event.target instanceof Element && event.target.closest("[data-passive-tooltip]")) return;
      // the sheet may focus its panel before this interaction's editor is ready.
      if (event.type === "focusin" && source.focus && event.target instanceof Element &&
        event.target.matches('[role="dialog"]') &&
        event.target.querySelector("[data-selection-composer]")?.getAttribute("data-selection-composer") === source.id) return;
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
  const canAbandon = () => {
    const id = current.current?.draftId;
    return id === undefined || guard.confirmLoss({ scopes: [], ownerIds: [noteEditorAttachmentOwnerId(visitId, `reader-draft:${id}`)] });
  };
  const destination = draft?.destination ?? null;
  const defaultId = draft?.load === "Ready" && destination?.kind === "Resolving" ? draft.id : null;
  const defaultSource = draft?.sourceMediaId ?? null;
  const defaultRead = useServerValue({ key: defaultId ? `reader-chat-default:${defaultId}:${defaultSource}` : null,
    stale: "", visit: DEFAULT_VISIT,
    load: async signal => ({ conversation: await fetchLatestSourceConversation(defaultSource!, signal) }),
  });
  useEffect(() => {
    if (!defaultId || !defaultSource || defaultRead.status === "loading") return;
    store.update(defaultId, entry => {
      if (entry.destination.kind !== "Resolving" || entry.sourceMediaId !== defaultSource) return entry;
      if (defaultRead.status === "failed") return { ...entry, destination: { kind: "LookupFailed" } };
      const candidate = defaultRead.data.conversation;
      return { ...entry, sourceHasChats: candidate !== null, destination: candidate
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

  const readNote = async (draftId: string, highlightId: string, replace: boolean) => {
    const previous = get(draftId);
    if (!previous) return;
    const replaceInput = replace && previous.load !== "Ready";
    if (replaceInput) store.update(draftId, (entry) => ({ ...entry, load: "Loading", issue: entry.load === "Failed" ? entry.issue : null }));
    const requested = store.getSnapshot().find((entry) => entry.id === draftId);
    if (!requested) return;
    const ownsRead = () => {
      const entry = store.getSnapshot().find((entry) => entry.id === draftId);
      return entry?.highlightId === highlightId && entry.passage === requested.passage && (!replaceInput || entry.revision === requested.revision) &&
        entry.operation === requested.operation && entry.issue === requested.issue;
    };
    try {
      const data = await liveHighlight(highlightId);
      if (!ownsRead()) return;
      if (!data) {
        store.update(draftId, (entry) => ({ ...entry, load: previous.load === "Ready" ? "Ready" : "Failed", issue: { kind: "Failed", message: "this highlight is no longer available. your input remains in this tab." } }));
        return;
      }
      const shown = reader.getState().document;
      if (shown.status !== "ready" || shown.doc.identity !== requested.passage.identity ||
        !matchesSourceAnchor(data, annotations.source(requested.passage.anchor))) {
        store.update(draftId, (entry) => ({ ...entry, load: previous.load === "Ready" ? "Ready" : "Failed", issue: { kind: "Source", message: "the source changed. select it again before saving or sending." } }));
        return;
      }
      const base = noteBase(data), body = initialBody(base), doc = docFromBody(body);
      const end = doc.firstChild?.isTextblock ? doc.content.size - 1 : 0;
      const sameBase = base.kind === "Absent" ? requested.base.kind === "Absent" &&
        (requested.linksVersion === null || requested.linksVersion === data.links_version) :
        requested.base.kind === "Present" && base.id === requested.base.id && base.version === requested.base.version;
      const captureSlot = replaceInput || requested.publication === null || requested.publication.kind === "passage";
      store.update(draftId, entry => ({ ...entry, highlight: data, highlightId: data.id, load: "Ready",
        ...(captureSlot && (replaceInput || sameBase) ? {
          linksVersion: data.links_version,
          noteId: base.kind === "Present" ? base.id : entry.noteId, linkId: base.kind === "Present" ? base.linkId : entry.linkId,
          publication: { kind: "attach_highlight", highlight_id: data.id, request: {
            note_id: base.kind === "Present" ? base.id : entry.noteId, link_id: base.kind === "Present" ? base.linkId : entry.linkId,
            body_pm_json: entry.body.body_pm_json,
            expected: base.kind === "Present" ? { kind: "version", version: base.version } : { kind: "absent", version: data.links_version },
          } },
        } : {}),
        passage: { ...entry.passage, quote: data.exact },
        chatIssue: entry.chatIssue?.kind === "Passage" || entry.chatIssue?.kind === "Source" ? null : entry.chatIssue,
        ...(replaceInput ? { base, body, selection: { anchor: end, head: end }, revision: entry.revision + 1, history: emptyNoteBodyHistory(), issue: null }
          : { issue: sameBase ? null : { kind: "Conflict", message: "this note changed elsewhere. your input remains in this tab.", saved: base, linksVersion: data.links_version } }),
      }));

    } catch (error) {
      if (!ownsRead()) return;
      store.update(draftId, (entry) => ({ ...entry, load: previous.load === "Ready" ? "Ready" : replaceInput ? "Failed" : entry.load, issue: { kind: "Failed", message: "your note could not be loaded. your input remains in this tab." } }));
      onError(error, "Note couldn’t be loaded");
    }
  };

  // Preparation fixes the source and all request identities before loading the
  // saved slot. It never presents an editor; commands await this same target.
  const prepare = (selected: ComposerDraft["passage"], highlightId: string | null, carried: ComposerDraft | null) => {
    // captures may carry command-only fields such as pdf `exact`. retained
    // passages own the visual anchor contract, with their quote kept separately.
    const passage: ComposerDraft["passage"] = { identity: selected.identity, quote: selected.quote,
      anchor: selected.anchor.kind === "text"
        ? { kind: "text", unit: selected.anchor.unit, start: selected.anchor.start, end: selected.anchor.end }
        : { kind: "pdf", page: selected.anchor.page, quads: selected.anchor.quads },
    };
    let existing = carried ? undefined : store.getSnapshot().find(entry => entry.id === current.current?.draftId &&
      (highlightId ? entry.highlightId === highlightId : samePassage(entry.passage, passage)));
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
        reading_media_id: boundSource.mediaId,
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
      const noteId = createRandomId(), linkId = createRandomId();
      store.put({
        id, passage, referenceSource, highlightId, highlight: null,
        noteId, linkId, linksVersion: null, write: null,
        publication: highlightId ? null : annotations.prepareCreate({
          anchor: passage.anchor.kind === "pdf" ? { ...passage.anchor, exact: passage.quote } : passage.anchor,
          id: selectionId, color: "yellow", initialNote: { note_id: noteId, link_id: linkId, body_pm_json: emptyBody().body_pm_json },
        }),
        base: { kind: "Absent" }, body: carried?.body ?? emptyBody(), revision: 0,
        selection: carried?.selection ?? null, history: carried?.history ?? emptyNoteBodyHistory(),
        load: highlightId ? "Loading" : "Ready", operation: null,
        issue: null, referenceActive: false, attachmentActive: false,
        sourceMediaId: boundSource.mediaId, sourceHasChats: null, destination: { kind: "Resolving" }, chatAttempt: null, chatIssue: null,
      });
    }
    else if (!existing.operation && !preparing.current.has(id) && sameBody(existing.body, initialBody(existing.base))) store.update(id, entry => ({ ...entry,
      passage: passage.quote ? passage : { ...passage, quote: entry.passage.quote },
      referenceSource, sourceMediaId: boundSource.mediaId, highlightId: highlightId ?? entry.highlightId,
    }));
    const clean = existing && sameBody(existing.body, initialBody(existing.base));
    const held = preparing.current.has(id);
    const ready = async () => {
      if (highlightId && !existing?.operation && !held)
        await readNote(id, highlightId, !carried && (!existing || Boolean(clean)));
      const opened = get(id);
      return opened ?? null;
    };
    return { id, ready, mediaId: boundSource.mediaId, generation, restored: false };
  };
  const open = (passage: ComposerDraft["passage"], highlightId: string | null, focus: boolean, carried: ComposerDraft | null, mode: Opening["mode"]) => {
    const previous = current.current && get(current.current.draftId);
    const replacing = previous && (carried !== null || !(highlightId ? previous.highlightId === highlightId : samePassage(previous.passage, passage)));
    if (replacing && !canAbandon()) return;
    const prepared = prepare(passage, highlightId, carried);
    setPickerDraftId(null);
    show({ id: createRandomId(), draftId: prepared.id, focus, ownsFocus: prepared.restored ? focus : true, serial: ++serial.current, mode });
    void prepared.ready().catch(error => {
      if (ctx.sessionSignal().aborted) return;
      store.update(prepared.id, entry => ({ ...entry, issue: { kind: "Failed", message: "passage input couldn’t be prepared." } }));
      onError(error, "passage input couldn’t be prepared");
    });
  };

  const highlightDeleted = useCallback((id: string) => {
    if (store.getSnapshot().some((entry) => entry.id === current.current?.draftId && entry.highlightId === id)) show(null);
    for (const entry of store.getSnapshot()) if (entry.highlightId === id) store.remove(entry.id);
  }, [show, store]);

  const submit = ({ command, source, commandId, continuation }: {
    command: Command;
    source: Opening | null;
    commandId?: string;
    continuation?: (id: string, isCurrent: () => boolean) => void | Promise<void>;
  }) => {
    const entry = source && get(source.draftId);
    if (!source || !entry || entry.load !== "Ready" || entry.operation || entry.referenceActive || entry.attachmentActive || entry.issue?.kind === "Conflict" || entry.issue?.kind === "Deleted" || entry.chatIssue?.kind === "Passage" || entry.chatIssue?.kind === "Source") return;
    const shown = reader.getState().document;
    let sourceMatches = false;
    if (shown.status === "ready" && !shown.refreshing && shown.doc.identity === entry.passage.identity) {
      try {
        const sourceNow = annotations.source(entry.passage.anchor);
        sourceMatches = sourceNow.mediaId === entry.sourceMediaId && sourceNow.generation === entry.referenceSource.expected_reader_generation;
      } catch {
        sourceMatches = false;
      }
    }
    if (!sourceMatches) {
      store.update(entry.id, value => ({ ...value, issue: { kind: "Source", message: "the source changed. select it again before saving or sending." } }));
      return;
    }
    if (!entry.highlightId && !reader.measurePassage(entry.passage)) return;
    const submitted = { ...entry, commandId: commandId ?? createRandomId() };
    const generation = readWriting().generation;
    const openingId = source.id;
    const owns = () => activeRef.current && interaction.current === openingId &&
      (current.current === null || current.current.id === openingId && current.current.ownsFocus) && get(entry.id)?.revision === submitted.revision;
    const run = async () => {
      store.update(entry.id, value => ({ ...value, operation: { id: submitted.commandId, kind: command.kind }, issue: null }));
      try {
        let intent: WritingIntent;
        const creating = submitted.highlightId === null;
        if (creating) {
          if (submitted.publication?.kind !== "passage") throw new Error("the passage source is unavailable");
          intent = { ...submitted.publication, request: { ...submitted.publication.request,
            color: command.kind === "Highlight" ? command.color : submitted.publication.request.color,
            initial_note: command.kind === "Save" && !isEmptyParagraph(submitted.body)
              ? { note_id: submitted.noteId, link_id: submitted.linkId, body_pm_json: submitted.body.body_pm_json } : null,
          } };
        } else if (command.kind === "Delete") {
          if (submitted.base.kind !== "Present") throw new Error("deleting an absent note");
          intent = { kind: "highlight_note_delete", highlight_id: submitted.highlightId!, request: { note_id: submitted.base.id, expected_version: submitted.base.version } };
        } else if (command.kind === "Highlight") {
          const version = command.version ?? submitted.highlight?.version;
          if (version === undefined) throw new Error("load the highlight before changing its colour");
          intent = { kind: "highlight_update", highlight_id: submitted.highlightId!, request: { color: command.color, expected_version: version } };
        } else if (command.kind === "Ensure" || (submitted.base.kind === "Absent" && isEmptyParagraph(submitted.body))) {
          store.update(entry.id, value => ({ ...value, operation: null }));
          if (continuation) await continuation(submitted.highlightId!, owns);
          return;
        } else {
          if (submitted.publication?.kind !== "attach_highlight") throw new Error("load the exact annotation slot before saving");
          intent = { ...submitted.publication, request: { ...submitted.publication.request,
            note_id: submitted.noteId, link_id: submitted.linkId, body_pm_json: submitted.body.body_pm_json,
            expected: submitted.base.kind === "Present" ? { kind: "version", version: submitted.base.version } : submitted.publication.request.expected,
          } };
        }
        const admitted = admitWriting(intent);
        store.update(entry.id, value => ({ ...value, write: admitted, operation: { id: admitted.id, kind: command.kind } }));
        let notice: ReturnType<typeof feedback.retainCondition> | null = null;
        let irreducible: boolean | null = null;
        const inspect = () => {
          const state = admitted.read();
          if (readWriting().generation !== generation || state.kind === "accepted" || state.kind === "refused" || state.kind === "abandoned") {
            notice?.withdraw(); return;
          }
          if (state.kind === "unconfirmed") irreducible = !canRetryWriting(admitted);
          if (irreducible === null) return;
          const message = irreducible ? "copy changes you want to keep, then reload. other unsaved changes will be lost." : "the request may have succeeded.";
          store.update(entry.id, value => ({ ...value,
            issue: { kind: "Failed", message: `save not confirmed. ${message}` } }));
          if (current.current?.draftId === entry.id && notice === null) return;
          const condition = { priority: "Write" as const, needsAttention: true, announcement: "Polite" as const,
            content: { tone: "Warning" as const, title: "passage save not confirmed", message },
            actions: irreducible ? [{ label: "copy text", onClick: () => { if (readWriting().generation === generation) copyWriting(feedback, submitted.body.body_text); } },
              { label: "reload", onClick: () => { if (readWriting().generation === generation) window.location.reload(); } }] as const
              : [{ label: "retry same save", commandKey: `passage-save:${admitted.id}:retry`, busy: state.kind === "queued" || state.kind === "sending",
                onClick: () => { if (readWriting().generation === generation) admitted.retry(); } }] as const };
          if (notice) notice.update(condition); else notice = feedback.retainCondition({ key: `passage-save:${admitted.id}`, ...condition });
        };
        inspectClosed.current.add(inspect);
        const stop = admitted.subscribe(inspect);
        const retire = () => { stop(); inspectClosed.current.delete(inspect); notice?.withdraw(); };
        void admitted.settled.then(retire, retire);
        const ack = await admitted.settled;
        if (ctx.sessionSignal().aborted || readWriting().generation !== generation) return;
        annotations.acknowledge(ack);
        const highlightId = ack.identities.find(identity => identity.kind === "highlight" && identity.requested_id === submitted.referenceSource.highlight_id)?.canonical_id ?? submitted.highlightId ?? submitted.referenceSource.highlight_id;
        const canonicalNoteId = ack.identities.find(identity => identity.kind === "note_block" && identity.requested_id === submitted.noteId)?.canonical_id ?? submitted.noteId;
        const savedNote = ack.notes.find(note => note.id === canonicalNoteId);
        const linkId = ack.identities.find(identity => identity.kind === "link" && identity.requested_id === submitted.linkId)?.canonical_id ?? submitted.linkId;
        const linksVersion = ack.lanes.find(lane => lane.ref === `highlight:${highlightId}` && lane.lane === "links")?.version ?? submitted.linksVersion;
        const base = savedNote ? { kind: "Present" as const, id: savedNote.id, linkId, version: savedNote.body_version, body: parseBody(savedNote.body_pm_json), embeddedItem: null } : submitted.base;
        const accepted = !savedNote || sameBody(base.kind === "Present" ? base.body : emptyBody(), submitted.body);
        const nextNoteId = command.kind === "Delete" ? createRandomId() : savedNote?.id ?? submitted.noteId;
        const nextLinkId = command.kind === "Delete" ? createRandomId() : linkId;
        const expected = base.kind === "Present" && command.kind !== "Delete" ? { kind: "version" as const, version: base.version }
          : linksVersion === null ? null : { kind: "absent" as const, version: linksVersion };
        store.update(entry.id, value => ({ ...value, highlightId, linksVersion, operation: null,
          referenceSource: { ...value.referenceSource, highlight_id: highlightId },
          noteId: nextNoteId, linkId: nextLinkId, base: command.kind === "Delete" ? { kind: "Absent" } : accepted ? base : value.base,
          publication: expected === null ? null : { kind: "attach_highlight", highlight_id: highlightId, request: {
            note_id: nextNoteId, link_id: nextLinkId, body_pm_json: submitted.body.body_pm_json, expected,
          } },
          write: null,
          issue: accepted ? null : { kind: "Conflict", message: "this note changed elsewhere. your input remains in this tab.", saved: base, linksVersion },
        }));
        const next = get(entry.id);
        if (next && next.publication === null && command.kind !== "Delete") void readNote(entry.id, highlightId, false);
        for (const note of ack.notes) adoptText(`note_block:${note.id}`, parseBody(note.body_pm_json), note.body_version);
        if (command.kind === "Delete" && submitted.base.kind === "Present") {
          const ref = `note_block:${submitted.base.id}`;
          setGone(ref);
          settleDeletedResourcePanes({ workspace: latestWorkspace(), deletedRef: ref, fallbackHref: "/notes" });
        }
        // acknowledgement adopts identity/base only: no editor replacement, focus or dismissal.
        if (continuation) await continuation(highlightId, owns);
      } catch (error) {
        if (ctx.sessionSignal().aborted || readWriting().generation !== generation) return;
        store.update(entry.id, value => ({ ...value, operation: null,
          issue: { kind: isApiError(error) && error.code === "E_READER_CONTENT_CHANGED" ? "Source" : "Failed", message: isApiError(error) && error.code === "E_READER_CONTENT_CHANGED"
            ? "the source changed. select it again before saving or sending."
            : "couldn’t confirm this change. your input remains in this tab." } }));
        if (isApiError(error) && (error.code === "E_NOTE_CONFLICT" || error.code === "E_RESOURCE_CONFLICT") && submitted.highlightId)
          void readNote(entry.id, submitted.highlightId, false);
        else if (!(isApiError(error) && error.code === "E_READER_CONTENT_CHANGED")) onError(error, "couldn’t save this passage");
        if (current.current?.draftId !== entry.id) feedback.offer({ needsAttention: true, undo: null, onDismiss: null, key: `passage-save:${submitted.commandId}`, announcement: "Polite",
          content: { tone: "Warning", title: "couldn’t save this passage", message: isApiError(error) ? error.message : "review the passage before saving again." } });
      }
    };
    const completion = run();
    return completion;
  };

  const captureCommand = async (capture: SelectionCapture, command: Extract<Command, { kind: "Ensure" | "Highlight" }>): Promise<{ id: string; isCurrent: () => boolean } | null> => {
    const highlightId = annotations.twin(capture.anchor);
    const activeOpening = current.current;
    const activeEntry = activeOpening && get(activeOpening.draftId);
    const sameOwner = activeEntry && (highlightId ? activeEntry.highlightId === highlightId : samePassage(activeEntry.passage, capture));
    if (!sameOwner && !canAbandon()) return null;
    const prepared = prepare(capture, highlightId, null);
    const source: Opening = sameOwner && activeOpening ? activeOpening
      : { id: createRandomId(), draftId: prepared.id, focus: false, ownsFocus: true, serial: ++serial.current, mode: "Note" };
    const entry = get(prepared.id);
    if (!entry || entry.operation || preparing.current.has(entry.id)) return null;
    preparing.current.add(entry.id);
    if (!sameOwner) show(null);
    interaction.current = source.id;
    let result: { id: string; isCurrent: () => boolean } | null = null;
    try {
      const loaded = await prepared.ready();
      const target = get(prepared.id);
      if (!loaded || !target || !samePassage(target.passage, capture) || target.sourceMediaId !== prepared.mediaId ||
        target.referenceSource.expected_reader_generation !== prepared.generation) return null;
      const frozen = command.kind === "Highlight" && command.version === null
        ? { ...command, version: loaded.highlight?.version ?? null } : command;
      await submit({ command: frozen, source, commandId: source.id, continuation: (id, isCurrent) => { result = { id, isCurrent }; } });
    } catch (error) {
      if (ctx.sessionSignal().aborted) return null;
      store.update(prepared.id, value => samePassage(value.passage, capture) ? { ...value,
        issue: { kind: "Failed", message: "your request could not be prepared. your input remains in this tab." } } : value);
      onError(error, "passage request didn’t finish");
    } finally {
      preparing.current.delete(entry.id);
    }
    return result;
  };

  const restoreEditor = () => {
    // Expose the parent modal before the editor consumes its focus request.
    flushSync(() => setPickerDraftId(null));
    if (current.current) show({ ...current.current, focus: true, ownsFocus: true, serial: ++serial.current });
  };
  const chooseChat = () => {
    const entry = current.current && get(current.current.draftId);
    if (!entry || entry.operation || entry.referenceActive || chatLocked || hasHeldChat()) return;
    setPickerDraftId(entry.id);
  };
  const chatOutcome = (entry: ComposerDraft, outcome: CommandOutcome, target: "New" | "Existing", submitted = false): OpenResult | null => {
    const currentAttempt = get(entry.id)?.chatAttempt;
    const attempt = currentAttempt?.kind === "Dispatched" ? currentAttempt : null;
    const held = readerRecovery(attempt ?? null) ? attempt : null;
    if (submitted && outcome.kind === "Failed" && current.current?.draftId !== entry.id)
      feedback.offer({ needsAttention: true, undo: null, onDismiss: null, key: `passage-send:${entry.id}`, announcement: "Polite",
        content: { tone: "Warning", title: "highlight saved; question not sent", message: outcome.feedback.title },
        actions: [{ label: "open chat", href: entry.destination.kind === "Selected" ? `/conversations/${entry.destination.id}` : "/conversations/new" }] });
    switch (outcome.kind) {
      case "Accepted": {
        store.update(entry.id, value => ({ ...value, operation: null, chatAttempt: held, chatIssue: null }));
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
        const issue: ReaderChatIssue = outcome.rejection === "E_READER_SELECTION_STALE"
          ? { kind: "Passage", message: "the passage changed. select it again before saving or sending." }
          : outcome.rejection === "E_CONVERSATION_NOT_FOUND"
            ? { kind: "Missing", message: "this chat is no longer available" }
            : outcome.rejection === "E_GENERATION_SELECTION_UNAVAILABLE" || outcome.rejection === "E_INVALID_GENERATION_SELECTION"
              ? { kind: "Model", message: "this chat’s model is unavailable", destination: attempt?.destination ?? target, selection: attempt?.selection ?? null }
              : { kind: "Failed", message: `${outcome.feedback.title}${outcome.feedback.message ? ` ${outcome.feedback.message}` : ""}` };
        store.update(entry.id, value => ({ ...value, operation: null, chatAttempt: held,
          destination: target === "Existing" && outcome.rejection === "E_CONVERSATION_NOT_FOUND" && value.destination.kind === "Selected"
            ? { ...value.destination, snapshot: { kind: "Failed" } } : value.destination,
          chatIssue: { ...issue, ...(submitted ? { highlightSaved: true as const } : {}) } }));
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
    if (!source || !entry || entry.load !== "Ready" || entry.operation || entry.referenceActive || entry.attachmentActive || entry.chatIssue?.kind === "Passage" || entry.chatIssue?.kind === "Source" || pickerDraftId !== null || hasHeldChat()) return;
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
      store.update(entry.id, value => ({ ...value, chatIssue: { kind: "Source", message: "the passage changed. select it again before saving or sending." } })); return;
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
    // The exact acceptance reset still belongs to this submitted input. Later
    // edits and reference queries revoke its authority to move attention.
    const submittedInput: { revision: number; consumedRevision: number | null } = { revision: entry.revision, consumedRevision: null };
    const owns = () => {
      const latest = get(entry.id);
      return activeRef.current && current.current?.id === source.id && current.current.ownsFocus &&
        latest !== undefined && !latest.referenceActive && !latest.attachmentActive &&
        (latest.revision === submittedInput.revision || latest.revision === submittedInput.consumedRevision);
    };
    const account = ctx.sessionSignal();
    let sendNotice: ReturnType<typeof feedback.retainCondition> | null = null;
    let sendFeedback: FeedbackContent | null = null;
    let sendRecovery: "Unconfirmed" | "RefreshRequired" | null = null;
    let stopSend: (() => void) | null = null;
    const inspectSend = () => {
      const state = owner.getSnapshot();
      if (account.aborted || !owner.isActive() || state.kind === "Idle" || state.command.kind !== "Send" || state.command.runId !== runId) {
        sendNotice?.withdraw(); stopSend?.(); stopSend = null; inspectClosed.current.delete(inspectSend); return;
      }
      if (state.kind !== "Busy") { sendFeedback = state.feedback; sendRecovery = state.kind; }
      if (sendFeedback === null || current.current?.draftId === entry.id && sendNotice === null) return;
      const condition = { priority: "Write" as const, needsAttention: true, announcement: "Polite" as const,
        content: sendRecovery === "Unconfirmed" ? { ...sendFeedback, title: "highlight saved; send not confirmed" } : sendFeedback,
        actions: [{ label: sendRecovery === "RefreshRequired" ? "refresh chat" : "retry same send",
          commandKey: `passage-send:${runId}:${sendRecovery}`, busy: state.kind === "Busy",
          onClick: (intent: OpenIntent) => {
            const current = owner.getSnapshot();
            if (account.aborted || !owner.isActive() || current.kind === "Idle" || current.command.kind !== "Send" || current.command.runId !== runId) return;
            void openAsyncResult({ ctx, intent, disposition: "Fork",
              create: async () => {
                const outcome = await owner.retry(intent);
                return account.aborted ? null : chatOutcome(entry, outcome, target, true);
              },
            }).catch(error => { if (!account.aborted) onError(error, "chat retry didn’t finish"); });
          } }] as const };
      if (sendNotice) sendNotice.update(condition); else sendNotice = feedback.retainCondition({ key: `passage-send:${runId}`, ...condition });
    };
    const execute = async (): Promise<OpenResult | null> => {
      let ensured: string | null = null;
      await submit({ command: { kind: "Ensure" }, source, continuation: id => { ensured = id; } });
      if (!ensured || ctx.sessionSignal().aborted) return null;
      store.update(entry.id, value => ({ ...value, operation: { id: runId, kind: "Chat" }, chatIssue: null }));
      const sourceNow = annotations.source(entry.passage.anchor);
      if (sourceNow.mediaId !== entry.sourceMediaId || sourceNow.generation !== entry.referenceSource.expected_reader_generation) {
        store.update(entry.id, value => ({ ...value, operation: null, chatIssue: { kind: "Source", message: "the passage changed. select it again before saving or sending." } })); return null;
      }
      const live = await liveHighlight(ensured);
      if (!live || !matchesSourceAnchor(live, sourceNow) || live.exact !== entry.passage.quote || (entry.highlight &&
        live.version !== entry.highlight.version)) {
        store.update(entry.id, value => ({ ...value, operation: null, highlight: entry.highlight ?? value.highlight,
          chatIssue: { kind: "Passage", message: "the passage changed. select it again before saving or sending." } })); return null;
      }
      const key = assumeReaderSelectionKey({ mediaId: entry.sourceMediaId, highlightId: ensured });
      const preview = await getReaderQuotePreview({ key });
      // Preview has a revision, but its displayed excerpt may be truncated. Verify
      // its surrounding full highlight observation instead of rebasing the quote.
      const verified = await liveHighlight(ensured);
      if (!verified || verified.version !== live.version) {
        annotations.refresh();
        store.update(entry.id, value => ({ ...value, operation: null, chatIssue: { kind: "Passage", message: "the passage changed. select it again before saving or sending." } })); return null;
      }
      const finalSource = annotations.source(entry.passage.anchor);
      if (finalSource.mediaId !== entry.sourceMediaId || finalSource.generation !== entry.referenceSource.expected_reader_generation) {
        store.update(entry.id, value => ({ ...value, operation: null, chatIssue: { kind: "Source", message: "the passage changed. select it again before saving or sending." } })); return null;
      }
      const quoteHref = readerHighlightChatIntentHref({ destination: observed ? { kind: "Existing", conversationId: observed.conversation.id } : { kind: "New" }, key });
      const href = observed ? `${conversationViewHref(observed.conversation.id, observed.active_leaf_message_id)}${quoteHref.slice(quoteHref.indexOf("#"))}` : quoteHref;
      if (question.kind === "Blank" || recovery !== null) {
        store.update(entry.id, value => ({ ...value, operation: null }));
        return { target: { href, labelHint: "chat" }, title: "quoted chat ready", openLabel: "open chat",
          ...(recovery !== null ? { entry: { kind: "ComposeReaderQuestion" as const, text: question.kind === "Text" ? question.content : "", selection } } : {}) };
      }
      if (!selection) throw new Error("Reader send without an observed selection");
      if (owner.getSnapshot().kind !== "Idle") {
        store.update(entry.id, value => ({ ...value, operation: null, chatIssue: { kind: "Failed", message: "another chat change is still in progress" } })); return null;
      }
      const insertion = view?.target;
      if (target === "Existing" && insertion?.kind !== "Empty" && insertion?.kind !== "Reply") throw new Error("Reader send without a replyable snapshot");
      store.update(entry.id, value => ({ ...value, operation: null, chatAttempt: { kind: "Dispatched", runId, owner, selection, destination: target, input: submittedInput } }));
      const request = { destination: observed && insertion && (insertion.kind === "Empty" || insertion.kind === "Reply")
        ? { kind: "Existing" as const, conversation_id: observed.conversation.id, expected_revision: observed.conversation.branch_revision,
          insertion: insertion.kind === "Empty" ? { kind: "Empty" as const } : { kind: "Reply" as const, parent_message_id: insertion.parentId, branch_anchor: insertion.anchor } }
        : { kind: "New" as const }, content: question.content, selection, reader_selection: { key: preview.key, revision: preview.revision } };
      inspectClosed.current.add(inspectSend);
      stopSend = owner.subscribe(inspectSend);
      const result = await owner.execute({ kind: "Send", request, runId, viewId: pane.paneId, openIntent }, () => {
        store.update(entry.id, value => {
          if (value.chatAttempt?.runId !== runId) return value;
          const consume = value.revision === submittedInput.revision && !value.referenceActive && !value.attachmentActive;
          if (consume) submittedInput.consumedRevision = value.revision + 1;
          return { ...value, chatIssue: null,
            ...(consume ? { body: initialBody(value.base), revision: value.revision + 1,
              selection: null, history: emptyNoteBodyHistory() } : {}),
            destination: value.destination.kind === "Selected" ? { ...value.destination, snapshot: { kind: "RefreshRequired" } } : value.destination };
        });
      });
      inspectSend();
      return chatOutcome(entry, result, target, true);
    };
    try {
      await openAsyncResult({ ctx, originPaneId: pane.paneId, intent: openIntent, disposition: "Fork", mayOpen: owns,
        onOpened: () => { if (owns()) { store.remove(entry.id); show(null); } }, create: execute });
    } catch (error) {
      if (ctx.sessionSignal().aborted) return;
      store.update(entry.id, value => ({ ...value, operation: null, chatIssue: isApiError(error) && error.code === "E_READER_CONTENT_CHANGED"
        ? { kind: "Source", message: "the passage changed. select it again before saving or sending." }
        : { kind: "Failed", message: "chat couldn’t be prepared. your question is kept" } }));
      const failure = chatFailure(error, "chat couldn’t be prepared");
      if (failure.kind === "Defect") onError(failure.error, "Chat couldn’t be prepared");
    }
    finally {
      if (!owner.isActive() || owner.getSnapshot().kind === "Idle") inspectSend();
      store.update(entry.id, value => value.chatAttempt?.kind === "Preparing" && value.chatAttempt.runId === runId ? { ...value, chatAttempt: null } : value);
    }
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
    const owns = () => {
      const latest = get(entry.id);
      return activeRef.current && current.current?.id === source.id && current.current.ownsFocus &&
        latest !== undefined && !latest.referenceActive && !latest.attachmentActive &&
        (latest.revision === attempt.input.revision || latest.revision === attempt.input.consumedRevision);
    };
    try {
      await openAsyncResult({ ctx, originPaneId: pane.paneId, intent: state.command.openIntent, disposition: "Fork", mayOpen: owns,
        onOpened: () => { if (owns()) { store.remove(entry.id); show(null); } },
        create: async () => chatOutcome(entry, await attempt.owner.retry(), attempt.destination, true) });
    } catch (error) { onError(error, "Chat retry didn’t finish"); }
  };
  const restoreHistoryFocus = () => {
    if (current.current?.ownsFocus) show({ ...current.current, focus: true, serial: ++serial.current });
  };
  const issue = draft?.issue;
  return {
    draft, opening, chat, branchCue, chatState, chatLocked, readerChatLocked, ownChatCommand,
    paused: writing.paused,
    conflictShown: { revision: draft?.revision ?? 0,
      saved_version: issue?.kind === "Conflict" ? issue.saved.kind === "Present" ? issue.saved.version : issue.linksVersion : null },
    reselection, cancelReselection,
    reselect() {
      const shown = reader.getState().document;
      if (!draft || draft.operation || shown.status !== "ready" || shown.refreshing) return;
      if (!canAbandon()) return;
      const next: Reselection = { id: createRandomId(), draftId: draft.id, identity: shown.doc.identity, mode: opening?.mode ?? "Note" };
      reselecting.current = next; setReselection(next); show(null); reader.focusSource();
    },
    applyReselection(capture: SelectionCapture) {
      const selected = reselecting.current, previous = selected && get(selected.draftId);
      const shown = reader.getState().document;
      if (!selected || !previous || !activeRef.current || shown.status !== "ready" || shown.refreshing ||
        capture.identity !== selected.identity || shown.doc.identity !== selected.identity) return;
      cancelReselection();
      open(capture, annotations.twin(capture.anchor), true, previous, selected.mode);
    },
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
    openChat(intent: OpenIntent) {
      if (!draft || draft.destination.kind !== "Selected") return;
      const tree = draft.destination.snapshot.kind === "Ready" ? draft.destination.snapshot.tree : null;
      pane.activateTarget({ target: { href: tree ? conversationViewHref(draft.destination.id, tree.active_leaf_message_id) : `/conversations/${draft.destination.id}`, labelHint: draft.destination.title }, disposition: { kind: intent === "new_pane" ? "Fork" : "Follow" } });
    },
    reference(): ReferenceInputHost | null {
      if (!draft || draft.load !== "Ready") return null;
      const id = draft.id, highlightId = draft.highlightId ?? draft.referenceSource.highlight_id;
      const source = draft.highlightId ? { kind: "resource" as const, ref: `highlight:${highlightId}` }
        : draft.referenceSource;
      return { source, label: "selected passage", position: null,
        onActiveChange(active) { store.update(id, (entry) => entry.referenceActive === active ? entry : { ...entry, referenceActive: active }); },
        onSelected(target, targetItem, authored) {
          const value = get(id);
          if (!value) return;
          void session.insertReference({ destination: { source, position: null, occurrencePrefix: `reader-composer:${id}`, path: [] },
            target, targetItem, authored });
        },
      };
    },
    activePassage: active && draft ? draft.passage : null,
    select(capture: SelectionCapture) {
      const selected = reselecting.current;
      const previous = selected?.identity === capture.identity ? get(selected.draftId) ?? null : null;
      cancelReselection();
      open(capture, annotations.twin(capture.anchor), capture.input !== "touch", previous, selected?.mode ?? "Note");
    },
    compose(capture: SelectionCapture, mode: "Note" | "Ask") {
      cancelReselection();
      open(capture, annotations.twin(capture.anchor), true, null, mode);
    },
    async highlightCapture(capture: SelectionCapture, color: HighlightColor) {
      const id = annotations.twin(capture.anchor);
      return captureCommand(capture, { kind: "Highlight", color, version: id ? annotations.highlight(id)?.version ?? null : null });
    },
    async ensureCapture(capture: SelectionCapture) {
      return captureCommand(capture, { kind: "Ensure" });
    },
    activate(mark: Mark, identity: string, focus = true) {
      cancelReselection();
      open({ identity, anchor: mark.anchor, quote: "" }, mark.id, focus, null, "Note");
    },
    highlightDeleted,
    dismiss(reason?: "outside-click" | "escape") {
      if (!canAbandon()) return;
      const returnFocus = current.current?.ownsFocus;
      const id = current.current?.draftId;
      if (id) store.remove(id);
      show(null); setPickerDraftId(null); cancelReselection();
      if (reason === "escape" && activeRef.current && returnFocus) reader.focusSource();
    },
    attachmentActive(active: boolean) {
      if (draft) store.update(draft.id, entry => entry.attachmentActive === active ? entry : { ...entry, attachmentActive: active });
    },
    compositionStart() { if (draft) store.update(draft.id, entry => ({ ...entry, revision: entry.revision + 1 })); },
    edit(edit: NoteEdit) {
      if (draft) store.update(draft.id, (entry) => ({ ...entry, body: edit.after, revision: entry.revision + 1,
        selection: edit.selectionAfter, history: recordNoteBodyEdit(entry.history, edit) }));
    },
    selection(selection: NoteEdit["selectionAfter"]) { if (draft) store.update(draft.id, (entry) => ({ ...entry, selection })); },
    historyBoundary() { if (draft) store.update(draft.id, (entry) => ({ ...entry, history: { ...entry.history, group: entry.history.group + 1 } })); },
    undo() {
      if (!draft) return;
      store.update(draft.id, (entry) => { const edit = entry.history.undo.at(-1); return edit ? { ...entry, body: edit.before, selection: edit.selectionBefore, revision: entry.revision + 1,
        history: { undo: entry.history.undo.slice(0, -1), redo: [...entry.history.redo, edit], group: entry.history.group + 1 } } : entry; });
      restoreHistoryFocus();
    },
    redo() {
      if (!draft) return;
      store.update(draft.id, (entry) => { const edit = entry.history.redo.at(-1); return edit ? { ...entry, body: edit.after, selection: edit.selectionAfter, revision: entry.revision + 1,
        history: { undo: [...entry.history.undo, edit], redo: entry.history.redo.slice(0, -1), group: entry.history.group + 1 } } : entry; });
      restoreHistoryFocus();
    },
    save() { if (draft) void submit({ command: { kind: "Save" }, source: current.current }); },
    newChat(openIntent: OpenIntent) { void sendChat("New", openIntent); },
    continueChat(openIntent: OpenIntent = "default") { void sendChat("Existing", openIntent); },
    deleteNote() { if (draft?.base.kind === "Present" && isEmptyParagraph(draft.body)) void submit({ command: { kind: "Delete" }, source: current.current }); },
    highlight(color: HighlightColor) {
      void submit({ command: { kind: "Highlight", color,
        version: draft?.highlightId ? annotations.highlight(draft.highlightId)?.version ?? draft.highlight?.version ?? null : null }, source: current.current });
    },
    async ensure(): Promise<{ id: string; isCurrent: () => boolean } | null> {
      let result: { id: string; isCurrent: () => boolean } | null = null;
      await submit({ command: { kind: "Ensure" }, source: current.current, continuation: (id, isCurrent) => { result = { id, isCurrent }; } });
      return result;
    },
    retry() {
      if (!draft) return;
      if (draft.load === "Failed" && draft.highlightId) void readNote(draft.id, draft.highlightId, sameBody(draft.body, initialBody(draft.base)));
      else draft.write?.retry();
    },
    async resolveConflict(useSaved: boolean, shown: ConflictShown) {
      const entry = current.current && get(current.current.draftId);
      if (!entry || entry.operation || entry.issue?.kind !== "Conflict" || !entry.highlightId) return;
      if (reconcileDeletedNote(entry) !== entry) { store.update(entry.id, reconcileDeletedNote); return; }
      const version = entry.issue.saved.kind === "Present" ? entry.issue.saved.version : entry.issue.linksVersion;
      if (entry.revision !== shown.revision || version !== shown.saved_version)
        throw new WritingDecisionError("the conflict changed; review the current comparison");
      const base = entry.issue.saved;
      const linksVersion = entry.issue.linksVersion;
      if (base.kind === "Absent" && linksVersion === null) throw new Error("review the current annotation slot before saving");
      const noteId = base.kind === "Present" ? base.id : createRandomId();
      const linkId = base.kind === "Present" ? base.linkId : createRandomId();
      const body = useSaved ? initialBody(base) : entry.body;
      const publication = { kind: "attach_highlight" as const, highlight_id: entry.highlightId, request: { note_id: noteId, link_id: linkId,
        body_pm_json: body.body_pm_json, expected: base.kind === "Present" ? { kind: "version" as const, version: base.version }
          : { kind: "absent" as const, version: linksVersion! } } };
      store.update(entry.id, value => ({ ...value, noteId, linkId, linksVersion, base, body, publication,
        write: null, operation: null, issue: null, revision: value.revision + 1,
        ...(useSaved ? { selection: null, history: emptyNoteBodyHistory() } : {}) }));
      if (!useSaved) await submit({ command: { kind: "Save" }, source: current.current });
    },
  };
}

export type SelectionComposer = ReturnType<typeof useSelectionComposer>;
