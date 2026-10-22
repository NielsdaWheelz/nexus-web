"use client";

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import { WritingDecisionError, admitWriting, assertWritingRuntimeToken, writingRuntimeToken, checkpoint, claimDraft, confirmedDraftBase, discardDraft, draftIsDurable, openDraft, readDraft, readWriting, releaseDraft, retireWriting, snapshotDraft, stageDraft, subscribeWriting, updateDraftContext, type ConflictShown, type DraftContext, type DraftHandle, type DraftShown, type DraftSnapshot, type WritingIntent } from "@/lib/notes/journal";
import { useOutlineSession, type NoteEdit } from "@/lib/notes/useOutlineSession";
import { OutlineSessionContext, ResourceBranch } from "@/components/resources/ResourceOutlineList";
import { nudgeWrites } from "@/lib/notes/writes";
import type { ReferenceInputHost } from "@/lib/resourceGraph/useReferenceInput";
import { isDeletedResource, subscribeLinkMutations } from "@/lib/resourceGraph/links";
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";
import { useLatestWorkspace } from "@/lib/workspace/store";
import type { AnnotationStore } from "./annotations";
import { createSelectionDrafts, initialBody, isEmptyParagraph, noteBase, samePassage, type ComposerDraft, type SelectionDrafts } from "./selectionDrafts";

const VISIT_DRAFTS = definePaneVisitDataKey<SelectionDrafts>("Reader.AnnotationDrafts");
const DEFAULT_VISIT = definePaneVisitDataKey<Visit<ListPage<ConversationListItem>>>("Reader.ChatDefault");
const TREE_VISIT = definePaneVisitDataKey<Visit<{ tree: ConversationTree | null }>>("Reader.ChatTree");
const CATALOG_VISIT = definePaneVisitDataKey<Visit<Catalog>>("Reader.ChatCatalog");
type Highlight = Schema<"TypedHighlightOut">;
type Opening = { id: string; draftId: string; focus: boolean; ownsFocus: boolean; serial: number };
type Command =
  | { kind: "Save" }
  | { kind: "Ensure" }
  | { kind: "Highlight"; color: HighlightColor }
  | { kind: "Delete" };

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
  return { ...entry, ...(baseDeleted ? { base: { kind: "Absent" } as const, discardBase: null, load: "Ready" as const, publication: null } : {}),
    issue: { kind: "Deleted", message: "this note was deleted. your words are kept. save them as a new note or select another passage." },
    status: null };

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
  const inheritedSession = useContext(OutlineSessionContext);
  const branch = useContext(ResourceBranch);
  const standaloneSession = useOutlineSession({ scope: `reader-annotations:${pane.paneId}`, inheritedBranch: branch });
  const session = inheritedSession ?? standaloneSession;
  const catalogRead = useServerValue({ key: "/llm-catalog", stale: "", visit: CATALOG_VISIT, load: readCatalog });
  const catalog = catalogRead.status === "ready" && catalogRead.error === null ? catalogRead.data : null;
  const refreshCatalog = catalogRead.refetch;
  const holder = useRef<SelectionDrafts | null>(null);
  const retained = usePaneVisitData(VISIT_DRAFTS, () => holder.current);
  const [store] = useState(() => retained ?? createSelectionDrafts());
  holder.current = store;
  const retain = usePaneVisitDataWriter(VISIT_DRAFTS);
  const drafts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const writing = useSyncExternalStore(subscribeWriting, readWriting, readWriting);
  const reselecting = useRef<string | null>(null);
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
  const contextFor = (entry: ComposerDraft): DraftContext => {
    if (!entry.publication) throw new Error("load the exact annotation slot before editing");
    return { kind: "passage", media_id: entry.sourceMediaId, resource_ref: `note_block:${entry.noteId}`,
      passage: { identity: entry.passage.identity, anchor: entry.passage.anchor, quote: entry.passage.quote },
      source: entry.referenceSource, publication: entry.publication };
  };
  const journalFor = (entry: ComposerDraft): Promise<DraftHandle> => {
    if (entry.journal) return entry.journal;
    const candidates = readWriting().drafts.filter(saved => saved.context.kind === "passage" &&
      saved.context.resource_ref === `note_block:${entry.noteId}` &&
      saved.context.media_id === entry.sourceMediaId && samePassage(saved.context.passage, entry.passage));
    const recovered = candidates.length === 1 ? candidates[0] : undefined;
    const token = writingRuntimeToken();
    const journal = (async () => {
      const handle = recovered ? await claimDraft(recovered.draft_id) : null;
      assertWritingRuntimeToken(token);
      return handle ?? openDraft(contextFor(entry), { kind: "body", body_pm_json: entry.body.body_pm_json },
        entry.base.kind === "Present" ? { value: { kind: "body", body_pm_json: entry.base.body.body_pm_json }, version: entry.base.version } : null,
        recovered?.draft_id ?? null);
    })();
    void journal.then(handle => {
      assertWritingRuntimeToken(token);
      store.update(entry.id, value => value.journal === journal ? { ...value, handle } : value);
    }).catch(() => undefined);
    store.update(entry.id, value => ({ ...value, journal }));
    return journal;
  };
  useEffect(() => {
    if (writing.paused) return;
    for (const entry of drafts) if (entry.load === "Ready" && entry.publication && !entry.journal)
      void journalFor(entry).catch(() => undefined);
    // opening acquires local ownership; it never checkpoints or submits clean prose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, store, writing.paused]);
  useEffect(() => () => {
    for (const entry of store.getSnapshot()) if (entry.journal) {
      void entry.journal.then(releaseDraft).catch(() => undefined);
      store.update(entry.id, value => ({ ...value, journal: null, handle: null }));
    }
  }, [store]);
  useLayoutEffect(() => {
    for (const entry of drafts) {
      const saved = entry.handle && readDraft(entry.handle.draft_id);
      if (entry.handle !== null && saved === undefined) {
        const confirmed = entry.discardBase;
        const base: ComposerDraft["base"] = confirmed?.value.kind === "body" && typeof confirmed.version === "number"
          ? { kind: "Present", id: entry.noteId, linkId: entry.linkId, version: confirmed.version,
            body: parseBody(confirmed.value.body_pm_json), embeddedItem: entry.base.kind === "Present" ? entry.base.embeddedItem : null }
          : { kind: "Absent" };
        const body = initialBody(base);
        const noteId = base.kind === "Present" ? base.id : createRandomId();
        const linkId = base.kind === "Present" ? base.linkId : createRandomId();
        const highlightId = entry.highlightId ?? createRandomId();
        const referenceSource = { ...entry.referenceSource, highlight_id: highlightId };
        const publication: ComposerDraft["publication"] = entry.publication?.kind === "passage"
          ? { ...entry.publication, request: { ...entry.publication.request, id: highlightId,
            initial_note: { note_id: noteId, link_id: linkId, body_pm_json: body.body_pm_json } } }
          : entry.publication?.kind === "attach_highlight"
            ? { ...entry.publication, request: { ...entry.publication.request, note_id: noteId, link_id: linkId,
              body_pm_json: body.body_pm_json, expected: base.kind === "Present"
                ? { kind: "version", version: base.version } : entry.publication.request.expected } } : null;
        store.update(entry.id, value => ({ ...value, body, base, noteId, linkId, referenceSource, publication,
          revision: value.revision + 1, selection: null, history: emptyNoteBodyHistory(),
          journal: null, handle: null, operation: null, resuming: null, issue: null, status: null, referenceActive: false }));
        void releaseDraft(entry.handle);
        continue;
      }
      if (!saved || saved.context.kind !== "passage") continue;
      const pending = writing.outbox.find(row => row.authored.some(authored => authored.draft_id === saved.draft_id));
      const base = saved.base;
      const deleted = isDeletedResource(saved.context.resource_ref) || isDeletedResource(`highlight:${saved.context.source.highlight_id}`);
      const confirmed = confirmedDraftBase(saved);
      const previous = saved.context.resource_ref === `note_block:${entry.noteId}` ? entry.discardBase : null;
      const discardBase = deleted ? null : confirmed?.value.kind === "body" && (previous === null ||
        typeof confirmed.version === "number" && (typeof previous.version !== "number" || confirmed.version > previous.version))
        ? confirmed : previous;
      const bound = !deleted && base?.value.kind === "body" && typeof base.version === "number"
        ? { value: base.value, version: base.version } : null;
      const changedBase = bound !== null && (entry.base.kind === "Absent" || entry.base.version !== bound.version || entry.publication?.kind === "passage");
      const currentRequest = pending?.authored.some(authored => authored.draft_id === saved.draft_id && authored.revision === saved.revision);
      const currentSaved = bound !== null && sameBody(parseBody(bound.value.body_pm_json), entry.body);
      const status = !draftIsDurable(saved.draft_id) ? writing.storage_error === null ? "saving…" : null
        : pending && currentRequest ? pending.uncertain ? "couldn’t confirm this change." : navigator.onLine ? "saved on this device · syncing" : "saved on this device · offline"
        : currentSaved ? "synced" : "draft saved on this device";
      const finished = entry.resuming !== null && !pending;
      const deletedIssue = deleted && entry.issue?.kind !== "Deleted";
      if (!changedBase && !finished && !deletedIssue && discardBase === entry.discardBase && status === entry.status) continue;
      const context = saved.context;
      const noteId = context.resource_ref.slice("note_block:".length);
      const linkId = saved.results.flatMap(result => result.ack.identities).find(identity => identity.kind === "link" && identity.requested_id === entry.linkId)?.canonical_id ?? entry.linkId;
      const highlightId = context.source.highlight_id;
      store.update(entry.id, current => ({ ...current, status, discardBase,
        ...(finished ? { operation: null, resuming: null } : {}),
        ...(deletedIssue ? { publication: null, issue: { kind: "Deleted", message: "this annotation was deleted. your words are kept; choose a new passage or note." } } : {}),
        ...(changedBase && bound !== null ? {
          noteId, linkId, highlightId,
          referenceSource: context.source,
          base: { kind: "Present", id: noteId, linkId, version: bound.version, body: parseBody(bound.value.body_pm_json), embeddedItem: null },
          publication: { kind: "attach_highlight", highlight_id: highlightId, request: { note_id: noteId, link_id: linkId,
            body_pm_json: bound.value.body_pm_json, expected: { kind: "version", version: bound.version } } },
        } : {}),
      }));
    }
  }, [drafts, store, writing]);
  const keep = (entry: ComposerDraft, editBase?: NoteEdit["editBase"]) => {
    const revision = entry.revision;
    store.update(entry.id, value => ({ ...value, status: "saving…" }));
    void journalFor(entry).then(async handle => {
      const saved = readDraft(handle.draft_id);
      if (!saved) throw new Error("the passage draft is no longer open");
      await checkpoint(handle, saved.revision, { kind: "body", body_pm_json: entry.body.body_pm_json }, entry.selection, null, null, editBase?.consumed_reference ?? null);
      store.update(entry.id, value => value.revision === revision ? { ...value, status: "draft saved on this device" } : value);
    }).catch(() => store.update(entry.id, value => ({ ...value, status: null,
      issue: { kind: "Failed", message: "recent changes are only in this tab. keep it open or download your writing." } })));
  };
  const retireBranch = async (entry: ComposerDraft, shown: DraftShown | null) => {
    if (!entry.handle) return;
    if (shown === null) throw new WritingDecisionError("review the current draft before replacing it");
    const rows = readWriting().outbox.filter(row => row.authored.some(authored => authored.draft_id === entry.handle!.draft_id));
    if (rows.some(row => row.uncertain || row.blocked === null)) throw new Error("resolve the pending change in recover writing before replacing this draft");
    for (const row of rows) await retireWriting(row.intent_id);
    await discardDraft(entry.handle, shown);
    await releaseDraft(entry.handle);
  };
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

  const readNote = async (draftId: string, highlightId: string, replace: boolean) => {
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
        store.update(draftId, (entry) => ({ ...entry, load: "Failed", issue: { kind: "Source", message: "the source changed. your words are kept; select the passage again." } }));
        return;
      }
      const base = noteBase(data), body = initialBody(base), doc = docFromBody(body);
      const end = doc.firstChild?.isTextblock ? doc.content.size - 1 : 0;
      const sameBase = base.kind === "Absent" ? requested.base.kind === "Absent" &&
        (requested.linksVersion === null || requested.linksVersion === data.links_version) :
        requested.base.kind === "Present" && base.id === requested.base.id && base.version === requested.base.version;
      const captureSlot = replace || requested.publication === null || requested.publication.kind === "passage";
      store.update(draftId, entry => ({ ...entry, highlight: data, highlightId: data.id, load: "Ready",
        discardBase: base.kind === "Present" && base.id === entry.noteId && (entry.discardBase === null ||
          typeof entry.discardBase.version !== "number" || base.version > entry.discardBase.version)
          ? { value: { kind: "body", body_pm_json: base.body.body_pm_json }, version: base.version } : entry.discardBase,
        ...(captureSlot && (replace || sameBase) ? {
          linksVersion: data.links_version,
          noteId: base.kind === "Present" ? base.id : entry.noteId, linkId: base.kind === "Present" ? base.linkId : entry.linkId,
          publication: { kind: "attach_highlight", highlight_id: data.id, request: {
            note_id: base.kind === "Present" ? base.id : entry.noteId, link_id: base.kind === "Present" ? base.linkId : entry.linkId,
            body_pm_json: entry.body.body_pm_json,
            expected: base.kind === "Present" ? { kind: "version", version: base.version } : { kind: "absent", version: data.links_version },
          } },
        } : {}),
        passage: { ...entry.passage, quote: data.exact }, sourceMediaId: data.anchor.media_id,
        chatIssue: entry.chatIssue?.kind === "Passage" || entry.chatIssue?.kind === "Source" ? null : entry.chatIssue,
        ...(replace ? { base, body, selection: { anchor: end, head: end }, revision: entry.revision + 1, history: emptyNoteBodyHistory(), issue: null }
          : { issue: sameBase ? null : { kind: "Conflict", message: "this note changed elsewhere. your draft is kept.", saved: base, linksVersion: data.links_version } }),
      }));
      const loaded = get(draftId);
      if (!replace && requested.load === "Loading" && !requested.journal && loaded?.publication) keep(loaded);
      if (captureSlot && (replace || sameBase) && loaded?.publication && loaded.journal) {
        const handle = await loaded.journal;
        if (get(draftId)?.handle === handle && readDraft(handle.draft_id)?.resource_ref === `note_block:${loaded.noteId}`)
          await updateDraftContext(handle, contextFor(loaded));
      }
    } catch (error) {
      if (!ownsRead()) return;
      store.update(draftId, (entry) => ({ ...entry, load: replace ? "Failed" : entry.load, issue: { kind: "Failed", message: "your note could not be loaded. your draft is kept." } }));
      onError(error, "Note couldn’t be loaded");
    }
  };

  useEffect(() => {
    for (const entry of drafts) {
      const saved = entry.handle && readDraft(entry.handle.draft_id);
      if (entry.highlightId !== null || saved?.context.kind !== "passage" || saved.base !== null) continue;
      const highlightId = saved.context.source.highlight_id;
      const ensured = saved.results.some(result => result.ack.identities.some(identity =>
        identity.kind === "highlight" && identity.canonical_id === highlightId && identity.state === "live"));
      if (!ensured) continue;
      store.update(entry.id, value => ({ ...value, highlightId, referenceSource: saved.context.kind === "passage" ? saved.context.source : value.referenceSource }));
      void readNote(entry.id, highlightId, false);
    }
    // settlement facts, rather than a link sender callback, establish this identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, store, writing]);

  const restore = (saved: DraftSnapshot, focus: boolean, retainedId: string | null = null) => {
    if (saved.context.kind !== "passage" || saved.value.kind !== "body") return;
    const context = saved.context, publication = context.publication;
    const id = retainedId ?? saved.draft_id;
    const noteId = context.resource_ref.slice("note_block:".length);
    const linkId = publication.kind === "attach_highlight" ? publication.request.link_id : publication.request.initial_note?.link_id;
    if (linkId === undefined) throw new Error("passage draft is missing its fixed attachment identity");
    const journal = (async () => await claimDraft(saved.draft_id) ?? openDraft(context, saved.value, saved.base, saved.draft_id))();
    const pending = readWriting().outbox.find(row => row.authored.some(authored => authored.draft_id === saved.draft_id));
    const highlightId = publication.kind === "attach_highlight" ? publication.highlight_id
      : saved.base !== null ? context.source.highlight_id : null;
    store.put({ id, passage: context.passage, referenceSource: context.source, publication, journal, handle: null, resuming: pending?.intent_id ?? null,
      noteId, linkId, linksVersion: publication.kind === "attach_highlight" && publication.request.expected.kind === "absent" ? publication.request.expected.version : null,
      highlightId, highlight: null, body: parseBody(saved.value.body_pm_json), selection: saved.selection,
      revision: 0, history: emptyNoteBodyHistory(), referenceActive: false, load: "Ready", discardBase: confirmedDraftBase(saved),
      base: saved.base?.value.kind === "body" && typeof saved.base.version === "number"
        ? { kind: "Present", id: noteId, linkId, body: parseBody(saved.base.value.body_pm_json), version: saved.base.version, embeddedItem: null } : { kind: "Absent" },
      operation: pending ? { id: pending.intent_id, kind: "Save" } : null,
      issue: saved.conflict ? { kind: "Failed", message: saved.conflict.reason } : null,
      status: draftIsDurable(saved.draft_id) ? "draft saved on this device" : null,
      sourceMediaId: context.media_id, sourceHasChats: null, destination: { kind: "Resolving" }, chatAttempt: null, chatIssue: null,
    });
    void journal.then(handle => store.update(id, entry => ({ ...entry, handle }))).catch(() => undefined);
    show({ id: createRandomId(), draftId: id, focus, ownsFocus: focus, serial: ++serial.current });
  };

  const open = (passage: ComposerDraft["passage"], highlightId: string | null, focus: boolean, carried: ComposerDraft | null) => {
    setPickerDraftId(null);
    let existing = carried ? undefined : (highlightId ? store.getSnapshot().find((entry) => entry.highlightId === highlightId) : undefined) ??
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
      const noteId = createRandomId(), linkId = createRandomId();
      store.put({
        id, passage, referenceSource, highlightId, highlight: null,
        noteId, linkId, linksVersion: null, journal: null, handle: null, resuming: null,
        publication: highlightId ? null : annotations.prepareCreate({
          anchor: passage.anchor.kind === "pdf" ? { ...passage.anchor, exact: passage.quote } : passage.anchor,
          id: selectionId, color: "yellow", initialNote: { note_id: noteId, link_id: linkId, body_pm_json: emptyBody().body_pm_json },
        }),
        base: { kind: "Absent" }, discardBase: null, body: carried?.body ?? emptyBody(), revision: 0,
        selection: carried?.selection ?? null, history: carried?.history ?? emptyNoteBodyHistory(),
        load: highlightId ? "Loading" : "Ready", operation: null,
        issue: null, status: null, referenceActive: false,
        sourceMediaId: boundSource.mediaId, sourceHasChats: null, destination: { kind: "Resolving" }, chatAttempt: null, chatIssue: null,
      });
    }
    else if (sameBody(existing.body, initialBody(existing.base))) store.update(id, entry => ({ ...entry,
      passage: passage.quote ? passage : { ...passage, quote: entry.passage.quote },
      referenceSource, sourceMediaId: boundSource.mediaId, highlightId: highlightId ?? entry.highlightId,
    }));
    const candidates = readWriting().drafts.filter(value => value.context.kind === "passage" &&
      value.context.media_id === boundSource.mediaId && samePassage(value.context.passage, passage));
    const saved = candidates.length === 1 ? candidates[0] : undefined;
    if (!existing && !carried && saved) { restore(saved, focus, id); return; }
    show({ id: createRandomId(), draftId: id, focus, ownsFocus: true, serial: ++serial.current });
    const opened = get(id);
    if (opened?.load === "Ready" && opened.publication && !opened.journal) void journalFor(opened).catch(() => undefined);
    const clean = existing && sameBody(existing.body, initialBody(existing.base));
    if (highlightId && !saved && !existing?.operation && existing?.load !== "Loading") {
      void readNote(id, highlightId, !carried && (!existing || Boolean(clean)));
    } else if (carried && opened?.publication) keep(opened);
  };

  const highlightDeleted = useCallback((id: string) => {
    if (store.getSnapshot().some((entry) => entry.id === current.current?.draftId && entry.highlightId === id)) show(null);
    for (const entry of store.getSnapshot()) if (entry.highlightId === id) {
      store.update(entry.id, (value) => ({ ...value, highlightId: null, highlight: null, base: { kind: "Absent" }, discardBase: null,
        issue: { kind: "Deleted", message: "this highlight was deleted. your words are kept; select a passage to save them again." },
        publication: null, load: "Ready", status: null }));
    }
    retain(store);
  }, [retain, show, store]);

  const submit = (command: Command, continuation?: (id: string, isCurrent: () => boolean) => void | Promise<void>) => {
    const source = current.current, entry = source && get(source.draftId);
    if (!source || !entry || entry.load !== "Ready" || entry.operation || entry.referenceActive || entry.issue?.kind === "Conflict" || entry.issue?.kind === "Deleted") return;
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
      store.update(entry.id, value => ({ ...value, issue: { kind: "Source", message: "the source changed. your words are kept; select the passage again." } }));
      return;
    }
    if (!entry.highlightId && !reader.measurePassage(entry.passage)) return;
    const submitted = { ...entry, commandId: createRandomId() };
    const openingId = source.id;
    const owns = () => activeRef.current && current.current?.id === openingId && current.current.ownsFocus && get(entry.id)?.revision === submitted.revision;
    const run = async () => {
      store.update(entry.id, value => ({ ...value, operation: { id: submitted.commandId, kind: command.kind }, issue: null, status: "saving…" }));
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
          const version = annotations.highlight(submitted.highlightId!)?.version ?? submitted.highlight?.version;
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
        const handle = await journalFor(submitted);
        const snapshot = readDraft(handle.draft_id);
        if (!snapshot) throw new Error("the passage draft is no longer open");
        const localCommit = checkpoint(handle, snapshot.revision, { kind: "body", body_pm_json: submitted.body.body_pm_json }, submitted.selection, null);
        const authored = snapshotDraft(handle);
        await localCommit;
        const admitted = admitWriting(intent, [authored]);
        await admitted.durable;
        store.update(entry.id, value => ({ ...value, operation: { id: admitted.intent_id, kind: command.kind },
          status: navigator.onLine ? "saved on this device · syncing" : "saved on this device · offline" }));
        const ack = await admitted.settled;
        if (ctx.sessionSignal().aborted) return;
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
          ...(command.kind === "Delete" ? { journal: null, handle: null, discardBase: null } : {}),
          issue: accepted ? null : { kind: "Conflict", message: "this note changed elsewhere. your draft is kept.", saved: base, linksVersion },
          status: value.revision === submitted.revision
            ? savedNote && accepted ? "synced" : isEmptyParagraph(value.body) ? "highlight saved" : "draft saved on this device"
            : value.status,
        }));
        const next = get(entry.id);
        if (next?.publication && next.handle === handle && command.kind !== "Delete") await updateDraftContext(handle, contextFor(next));
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
        if (ctx.sessionSignal().aborted) return;
        store.update(entry.id, value => ({ ...value, operation: null, status: null,
          issue: { kind: isApiError(error) && error.code === "E_READER_CONTENT_CHANGED" ? "Source" : "Failed", message: isApiError(error) && error.code === "E_READER_CONTENT_CHANGED"
            ? "the source changed. your words are kept; select the passage again."
            : "couldn’t confirm this change. your draft is kept." } }));
        if (isApiError(error) && (error.code === "E_NOTE_CONFLICT" || error.code === "E_RESOURCE_CONFLICT") && submitted.highlightId)
          void readNote(entry.id, submitted.highlightId, false);
        else if (isApiError(error) && error.code === "E_READER_CONTENT_CHANGED") reader.reload();
        else onError(error, "passage request didn’t finish");
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
  let conflictDraft: DraftSnapshot | null = null;
  const issue = draft?.issue;
  const savedBranch = draft?.handle && readDraft(draft.handle.draft_id);
  if (draft && savedBranch && issue?.kind === "Conflict" && issue.saved.kind === "Present") {
    conflictDraft = { ...savedBranch, value: { kind: "body", body_pm_json: draft.body.body_pm_json }, conflict: {
      reason: issue.message, saved_value: { kind: "body", body_pm_json: issue.saved.body.body_pm_json },
      saved_version: issue.saved.version, other_draft_id: null,
    } };
  }
  return {
    draft, opening, chat, branchCue, chatState, chatLocked, readerChatLocked, ownChatCommand,
    paused: writing.paused,
    conflictShown: { revision: savedBranch?.revision ?? draft?.revision ?? 0,
      saved_version: issue?.kind === "Conflict" ? issue.saved.kind === "Present" ? issue.saved.version : issue.linksVersion : null },
    conflictDraft,
    async retireDraft(shown: ConflictShown) {
      if (!draft) return;
      if (!draft.handle || readDraft(draft.handle.draft_id)?.revision !== shown.revision || get(draft.id)?.revision !== draft.revision)
        throw new WritingDecisionError("the draft changed; review the current comparison");
      await retireBranch(draft, shown);
      if (get(draft.id)?.revision !== draft.revision) return;
      if (current.current?.draftId === draft.id) show(null);
      store.remove(draft.id);
    },
    recoveries: writing.drafts.filter(saved => saved.context.kind === "passage" &&
      saved.context.media_id === annotations.getState().map.data?.media_id &&
      (saved.base === null || saved.conflict !== null || saved.base.value.kind !== "body" || saved.value.kind !== "body" ||
        !sameBody(parseBody(saved.base.value.body_pm_json), parseBody(saved.value.body_pm_json)))),
    restore(id: string) { const saved = readDraft(id); if (saved) restore(saved, true); },
    reselect() { if (draft && !draft.operation) { reselecting.current = draft.id; show(null); retain(store); reader.focusSource(); } },
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
        onSelected(target, targetItem, authored) {
          const value = get(id);
          if (!value) return;
          const carried = journalFor(value).then(handle => {
            const saved = readDraft(handle.draft_id);
            if (!saved) throw new Error("the passage draft is no longer open");
            if (saved.value.kind !== "body" || !sameBody(parseBody(saved.value.body_pm_json), value.body))
              stageDraft(handle, { kind: "body", body_pm_json: value.body.body_pm_json }, value.selection);
            return snapshotDraft(handle);
          });
          void session.insertReference({ destination: { source, position: null, occurrencePrefix: `reader-draft:${id}`, path: [] },
            target, targetItem, authored: Promise.all([authored, carried]).then(([references, body]) => [...references, body]),
          });
        },
      };
    },
    activePassage: active && draft ? draft.passage : null,
    select(capture: SelectionCapture) {
      const previous = reselecting.current ? get(reselecting.current) ?? null : null;
      reselecting.current = null;
      open(capture, annotations.twin(capture.anchor), capture.input !== "touch", previous);
    },
    activate(mark: Mark, identity: string, focus = true) { open({ identity, anchor: mark.anchor, quote: "" }, mark.id, focus, null); },
    highlightDeleted,
    dismiss(reason?: "outside-click" | "escape") {
      const returnFocus = current.current?.ownsFocus;
      show(null); setPickerDraftId(null); retain(store);
      if (reason === "escape" && activeRef.current && returnFocus) reader.focusSource();
    },
    edit(edit: NoteEdit) {
      if (draft) store.update(draft.id, (entry) => ({ ...entry, body: edit.after, revision: entry.revision + 1,
        selection: edit.selectionAfter, history: recordNoteBodyEdit(entry.history, edit), status: null }));
      const changed = draft && get(draft.id);
      if (changed) keep(changed, edit.editBase);
    },
    selection(selection: NoteEdit["selectionAfter"]) { if (draft) store.update(draft.id, (entry) => ({ ...entry, selection })); },
    historyBoundary() { if (draft) store.update(draft.id, (entry) => ({ ...entry, history: { ...entry.history, group: entry.history.group + 1 } })); },
    undo() {
      if (!draft) return;
      store.update(draft.id, (entry) => { const edit = entry.history.undo.at(-1); return edit ? { ...entry, body: edit.before, selection: edit.selectionBefore, revision: entry.revision + 1,
        history: { undo: entry.history.undo.slice(0, -1), redo: [...entry.history.redo, edit], group: entry.history.group + 1 }, status: null } : entry; });
      const changed = get(draft.id);
      if (changed) keep(changed);
      restoreHistoryFocus();
    },
    redo() {
      if (!draft) return;
      store.update(draft.id, (entry) => { const edit = entry.history.redo.at(-1); return edit ? { ...entry, body: edit.after, selection: edit.selectionAfter, revision: entry.revision + 1,
        history: { undo: [...entry.history.undo, edit], redo: entry.history.redo.slice(0, -1), group: entry.history.group + 1 }, status: null } : entry; });
      const changed = get(draft.id);
      if (changed) keep(changed);
      restoreHistoryFocus();
    },
    async saveAsNewNote(shown: DraftShown) {
      const entry = current.current && get(current.current.draftId);
      if (!entry || !entry.highlightId || entry.operation || entry.issue?.kind !== "Deleted") return;
      store.update(entry.id, value => ({ ...value, noteId: createRandomId(), linkId: createRandomId(),
        publication: null, linksVersion: null, base: { kind: "Absent" }, discardBase: null, issue: null }));
      await readNote(entry.id, entry.highlightId, false);
      const next = get(entry.id);
      if (!next?.publication || next.issue !== null) return;
      const journal = openDraft(contextFor(next), { kind: "body", body_pm_json: next.body.body_pm_json }, null);
      store.update(entry.id, value => ({ ...value, journal, handle: null }));
      const handle = await journal;
      store.update(entry.id, value => ({ ...value, handle }));
      await submit({ kind: "Save" });
      if (draftIsDurable(handle.draft_id)) await retireBranch(entry, shown);
    },

    save() { if (draft) submit({ kind: "Save" }); },
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
    async resolveConflict(useSaved: boolean, shown: ConflictShown) {
      const entry = current.current && get(current.current.draftId);
      if (!entry || entry.operation || entry.issue?.kind !== "Conflict" || !entry.highlightId) return;
      if (reconcileDeletedNote(entry) !== entry) { store.update(entry.id, reconcileDeletedNote); return; }
      const checkShown = () => {
        const current = get(entry.id);
        const issue = current?.issue;
        const version = issue?.kind === "Conflict" ? issue.saved.kind === "Present" ? issue.saved.version : issue.linksVersion : null;
        if (current?.revision !== entry.revision || !entry.handle || readDraft(entry.handle.draft_id)?.revision !== shown.revision || version !== shown.saved_version)
          throw new WritingDecisionError("the conflict changed; review the current comparison");
      };
      checkShown();
      const token = writingRuntimeToken();
      const base = entry.issue.saved;
      const linksVersion = entry.issue.linksVersion;
      if (base.kind === "Absent" && linksVersion === null) throw new Error("review the current annotation slot before saving");
      const rows = entry.handle ? readWriting().outbox.filter(row => row.authored.some(authored => authored.draft_id === entry.handle!.draft_id)) : [];
      if (rows.some(row => row.uncertain || row.blocked === null)) throw new Error("resolve the pending change in recover writing first");
      for (const row of rows) await retireWriting(row.intent_id);
      assertWritingRuntimeToken(token);
      checkShown();
      const noteId = base.kind === "Present" ? base.id : createRandomId();
      const linkId = base.kind === "Present" ? base.linkId : createRandomId();
      const body = useSaved ? initialBody(base) : entry.body;
      const publication = { kind: "attach_highlight" as const, highlight_id: entry.highlightId, request: { note_id: noteId, link_id: linkId,
        body_pm_json: body.body_pm_json, expected: base.kind === "Present" ? { kind: "version" as const, version: base.version }
          : { kind: "absent" as const, version: linksVersion! } } };
      const next = { ...entry, noteId, linkId, linksVersion, base, body, publication,
        journal: null, handle: null, operation: null, resuming: null, issue: null, revision: entry.revision + 1,
        ...(useSaved ? { selection: null, history: emptyNoteBodyHistory() } : {}),
      };
      const journal = openDraft(contextFor(next), { kind: "body", body_pm_json: body.body_pm_json },
        base.kind === "Present" ? { value: { kind: "body", body_pm_json: base.body.body_pm_json }, version: base.version } : null);
      store.update(entry.id, () => ({ ...next, journal }));
      const handle = await journal;
      store.update(entry.id, value => ({ ...value, handle }));
      if (useSaved) await retireBranch(entry, shown);
      else {
        await submit({ kind: "Save" });
        if (draftIsDurable(handle.draft_id)) await retireBranch(entry, shown);
      }
    },
  };
}

export type SelectionComposer = ReturnType<typeof useSelectionComposer>;
