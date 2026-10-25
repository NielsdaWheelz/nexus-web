"use client";

// One ephemeral rich composer for a passage. A new selection freezes its exact local
// capture when the composer opens; saving commits the highlight, its new note and their
// link in one local transaction. An existing highlight's notes are their own resources,
// edited in place; this input only ever adds another independent note. Unsubmitted
// input stays ephemeral and is never written anywhere.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { noteEditorAttachmentOwnerId } from "@/components/notes/NoteEditor";
import { useWorkGuard } from "@/lib/unsavedWork";
import { useFeedback } from "@/components/feedback/Feedback";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { openAsyncResult, type OpenResult } from "@/lib/panes/openResult";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { conversationViewHref } from "@/lib/chat/view";
import { isApiError } from "@/lib/api/client";
import { useServerValue, type Visit } from "@/lib/api/serverState";
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
import { useReaderState, type DraftAnchor, type Mark, type SelectionCapture } from "@/lib/documentReader/DocumentReader";
import type { Reader } from "@/lib/documentReader/runtime";
import type { HighlightColor } from "@/lib/documentReader/model";
import { attachNote, captureSelection, createHighlight, recolorHighlight, type SourceLabel } from "@/lib/documentReader/annotations";
import { LocalCommitError } from "@/lib/notes/runtime";
import { createLink, prepareTarget } from "@/lib/resourceGraph/links";
import type { ReferenceInputHost } from "@/lib/resourceGraph/useReferenceInput";
import { bodyHasContent, emptyBody } from "@nexus/authored/body";
import { useWritingRuntime } from "@/lib/notes/hooks";
import { definePaneVisitDataKey, usePaneVisitIdentity } from "@/lib/workspace/paneReturnMemento";
import type { MediaAnnotations } from "./annotations";
import { createSelectionDrafts, emptyDraftHistory, recordDraftEdit, samePassage, type ComposerDraft, type NoteEdit, type ReaderChatIssue } from "./selectionDrafts";

const DEFAULT_VISIT = definePaneVisitDataKey<Visit<ListPage<ConversationListItem>>>("Reader.ChatDefault");
const TREE_VISIT = definePaneVisitDataKey<Visit<{ tree: ConversationTree | null }>>("Reader.ChatTree");
const CATALOG_VISIT = definePaneVisitDataKey<Visit<Catalog>>("Reader.ChatCatalog");
type Opening = { id: string; draftId: string; focus: boolean; ownsFocus: boolean; serial: number; mode: "Note" | "Ask" };
type Reselection = { id: string; draftId: string; identity: string; mode: Opening["mode"] };
type Command =
  | { kind: "Save" }
  | { kind: "Ensure" }
  | { kind: "Highlight"; color: HighlightColor };

const SOURCE_CHANGED = "the source changed. select it again before saving or sending.";
const LOCAL_FAILURE = "couldn’t save on this device. keep this page open. retry saving.";

/** A settled draft cannot claim a later command that happens to use the same chat. */
function readerRecovery(attempt: ComposerDraft["chatAttempt"]) {
  return attempt?.kind === "Dispatched" ? recoveryOf(attempt.owner.getSnapshot(),
    command => command.kind === "Send" && command.runId === attempt.runId) : null;
}

export function useSelectionComposer(input: {
  reader: Reader;
  mediaId: string;
  annotations: MediaAnnotations;
  /** The literal label this host knows for a capture's source, if any. */
  sourceLabel: (sourceRef: string) => SourceLabel | null;
  active: boolean;
  isMobile: boolean;
  onError: (error: unknown, title: string) => void;
}) {
  const { reader, mediaId, annotations, sourceLabel, active, isMobile, onError } = input;
  const feedback = useFeedback();
  const guard = useWorkGuard();
  const visitId = usePaneVisitIdentity();
  const { ctx } = useActionRuntime();
  const pane = requirePaneRuntime(usePaneRuntime(), "useSelectionComposer");
  const writing = useWritingRuntime();
  const catalogRead = useServerValue({ key: "/llm-catalog", stale: "", visit: CATALOG_VISIT, load: readCatalog });
  const catalog = catalogRead.status === "ready" && catalogRead.error === null ? catalogRead.data : null;
  const refreshCatalog = catalogRead.refetch;
  const [store] = useState(createSelectionDrafts);
  const drafts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const publication = useReaderState(reader, state => state.document.status === "ready" ? state.document.doc.identity : null);
  const [reselection, setReselection] = useState<Reselection | null>(null);
  const reselecting = useRef<Reselection | null>(null);
  const cancelReselection = useCallback(() => { reselecting.current = null; setReselection(null); }, []);
  const [pickerDraftId, setPickerDraftId] = useState<string | null>(null);
  const [opening, setOpening] = useState<Opening | null>(null);
  const current = useRef<Opening | null>(null);
  const interaction = useRef<string | null>(null);
  const serial = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const show = useCallback((next: Opening | null) => {
    current.current = next; interaction.current = next?.id ?? null; setOpening(next);
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
  useEffect(() => () => { current.current = null; interaction.current = null; reselecting.current = null; activeRef.current = false; }, []);
  useEffect(() => {
    const moved = (event: Event) => {
      const opened = current.current;
      if (!opened) return;
      if (event.type === "pointerdown" && event.target instanceof Element && event.target.closest("[data-passive-tooltip]")) return;
      // the sheet may focus its panel before this interaction's editor is ready.
      if (event.type === "focusin" && opened.focus && event.target instanceof Element &&
        event.target.matches('[role="dialog"]') &&
        event.target.querySelector("[data-selection-composer]")?.getAttribute("data-selection-composer") === opened.id) return;
      const inside = event.target instanceof Element && event.target.closest("[data-selection-composer]") !== null;
      if (opened.focus || opened.ownsFocus !== inside) show({ ...opened, focus: false, ownsFocus: inside });
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
  const defaultId = destination?.kind === "Resolving" ? draft!.id : null;
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
  // A highlight deleted on this or another device closes its composer; typed input is the guard's.
  const annotationState = useSyncExternalStore(annotations.subscribe, annotations.getState, annotations.getState);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (annotationState.local.status !== "ready") return;
    for (const annotation of annotationState.local.annotations) seen.current.add(annotation.id);
    for (const entry of store.getSnapshot()) {
      const id = entry.highlightId;
      if (!id || !seen.current.has(id) || annotations.annotation(id) || entry.operation) continue;
      seen.current.delete(id);
      if (current.current?.draftId === entry.id) show(null);
      store.remove(entry.id);
    }
  }, [annotationState, annotations, show, store]);

  // Opening fixes the exact capture before any command; commands reuse that frozen target.
  const prepare = (selected: ComposerDraft["passage"], highlightId: string | null, carried: ComposerDraft | null): ComposerDraft => {
    // pdf captures carry the command-only `exact`; the passage keeps the visual anchor.
    const passage: ComposerDraft["passage"] = { identity: selected.identity, quote: selected.quote,
      anchor: selected.anchor.kind === "text"
        ? { kind: "text", unit: selected.anchor.unit, start: selected.anchor.start, end: selected.anchor.end }
        : { kind: "pdf", page: selected.anchor.page, quads: selected.anchor.quads },
    };
    const existing = carried ? undefined : store.getSnapshot().find(entry => entry.id === current.current?.draftId &&
      (highlightId ? entry.highlightId === highlightId : entry.highlightId === null && samePassage(entry.passage, passage)));
    if (existing) return existing;
    const shown = reader.getState().document;
    const annotation = highlightId ? annotations.annotation(highlightId) : null;
    const anchor: DraftAnchor = passage.anchor.kind === "pdf" ? { ...passage.anchor, exact: selected.quote } : passage.anchor;
    const capture = highlightId || shown.status !== "ready" || shown.doc.identity !== passage.identity ? null
      : captureSelection(shown.doc, mediaId, anchor);
    const sourceRef = annotation?.sourceRef ?? capture?.sourceRef ?? `media:${mediaId}`;
    const entry: ComposerDraft = {
      id: createRandomId(), passage: annotation ? { ...passage, quote: annotation.selection.quote_exact } : passage,
      capture, highlightId,
      body: carried?.body ?? emptyBody(), revision: 0, selection: carried?.selection ?? null, history: carried?.history ?? emptyDraftHistory(),
      operation: null, issue: highlightId || capture ? null : { kind: "Source", message: "this passage can’t be annotated here." },
      referenceActive: false, attachmentActive: false,
      sourceMediaId: sourceRef.slice("media:".length), sourceHasChats: null, destination: { kind: "Resolving" }, chatAttempt: null, chatIssue: null,
    };
    store.put(entry);
    return entry;
  };
  const open = (passage: ComposerDraft["passage"], highlightId: string | null, focus: boolean, carried: ComposerDraft | null, mode: Opening["mode"]) => {
    const previous = current.current && get(current.current.draftId);
    const replacing = previous && (carried !== null || !(highlightId ? previous.highlightId === highlightId : samePassage(previous.passage, passage)));
    if (replacing && !canAbandon()) return;
    const prepared = prepare(passage, highlightId, carried);
    setPickerDraftId(null);
    show({ id: createRandomId(), draftId: prepared.id, focus, ownsFocus: true, serial: ++serial.current, mode });
  };

  const highlightDeleted = useCallback((id: string) => {
    if (store.getSnapshot().some((entry) => entry.id === current.current?.draftId && entry.highlightId === id)) show(null);
    for (const entry of store.getSnapshot()) if (entry.highlightId === id) store.remove(entry.id);
  }, [show, store]);

  /** One local command for the opened draft; the input stays until its commit is durable. */
  const submit = async ({ command, opened }: { command: Command; opened: Opening | null }): Promise<{ id: string } | null> => {
    const entry = opened && get(opened.draftId);
    // a failed frame is retried, never resubmitted under a new identity.
    if (!opened || !entry || !writing || entry.operation || entry.referenceActive || entry.attachmentActive ||
      entry.issue !== null || entry.chatIssue?.kind === "Passage" || entry.chatIssue?.kind === "Source") return null;
    const annotation = entry.highlightId ? annotations.annotation(entry.highlightId) : null;
    // a just-committed highlight joins the local reads a moment after its commit.
    if (entry.highlightId && !annotation) return null;
    const shown = reader.getState().document;
    if (!annotation && (!entry.capture || shown.status !== "ready" || shown.refreshing || shown.doc.identity !== entry.passage.identity)) {
      store.update(entry.id, value => ({ ...value, issue: { kind: "Source", message: SOURCE_CHANGED } }));
      return null;
    }
    const submitted = entry;
    const operationId = createRandomId();
    store.update(entry.id, value => ({ ...value, operation: { id: operationId, kind: command.kind }, issue: null }));
    const note = command.kind === "Save" && bodyHasContent(submitted.body) ? submitted.body : null;
    const id = submitted.highlightId ?? crypto.randomUUID();
    // the committed note is now an attached note of its own; this input starts empty.
    const finish = () => {
      store.update(entry.id, value => ({ ...value, operation: null, issue: null, highlightId: id, capture: null,
        ...(note && value.revision === submitted.revision ? { body: emptyBody(), revision: value.revision + 1, selection: null, history: emptyDraftHistory() } : {}) }));
      return { id };
    };
    try {
      if (annotation) {
        if (command.kind === "Highlight") await recolorHighlight(writing, annotation, command.color);
        else if (note) await attachNote(writing, annotation, note);
      } else await createHighlight(writing, { id, capture: submitted.capture!,
          color: command.kind === "Highlight" ? command.color : "yellow", note, source: sourceLabel(submitted.capture!.sourceRef) });
      return finish();
    } catch (error) {
      if (ctx.sessionSignal().aborted) return null;
      if (error instanceof LocalCommitError) {
        store.update(entry.id, value => ({ ...value, operation: null, issue: { kind: "Failed", message: LOCAL_FAILURE,
          retry: () => { void error.retry().then(finish, () => {}); } } }));
        return null;
      }
      // nothing committed: the input stays and the same gesture may run again.
      store.update(entry.id, value => ({ ...value, operation: null }));
      onError(error, "couldn’t save this passage");
      return null;
    }
  };

  const captureCommand = async (capture: SelectionCapture, command: Extract<Command, { kind: "Ensure" | "Highlight" }>): Promise<{ id: string; isCurrent: () => boolean } | null> => {
    const activeOpening = current.current;
    const activeEntry = activeOpening && get(activeOpening.draftId);
    const sameOwner = activeEntry && activeEntry.highlightId === null && samePassage(activeEntry.passage, capture);
    if (!sameOwner && !canAbandon()) return null;
    const prepared = prepare(capture, null, null);
    const opened: Opening = sameOwner && activeOpening ? activeOpening
      : { id: createRandomId(), draftId: prepared.id, focus: false, ownsFocus: true, serial: ++serial.current, mode: "Note" };
    if (!sameOwner) show(null);
    interaction.current = opened.id;
    const owns = () => activeRef.current && interaction.current === opened.id;
    const result = await submit({ command, opened });
    if (!result) return null;
    if (!sameOwner) store.remove(prepared.id);
    return { ...result, isCurrent: owns };
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
    // a closed composer cannot show this refusal; one receipt names it and its way back.
    if (submitted && outcome.kind === "Failed" && current.current?.draftId !== entry.id)
      feedback.receipt({ tone: "Warning", title: "highlight saved; question not sent", message: outcome.feedback.title },
        { label: "open chat", href: entry.destination.kind === "Selected" ? `/conversations/${entry.destination.id}` : "/conversations/new" });
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
    const opened = current.current;
    const entry = opened && get(opened.draftId);
    if (!opened || !entry || entry.operation || entry.referenceActive || entry.attachmentActive || entry.chatIssue?.kind === "Passage" || entry.chatIssue?.kind === "Source" || pickerDraftId !== null || hasHeldChat()) return;
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
      return activeRef.current && current.current?.id === opened.id && current.current.ownsFocus &&
        latest !== undefined && !latest.referenceActive && !latest.attachmentActive &&
        (latest.revision === submittedInput.revision || latest.revision === submittedInput.consumedRevision);
    };
    const account = ctx.sessionSignal();
    let reported: "Unconfirmed" | "RefreshRequired" | null = null;
    let stopSend: (() => void) | null = null;
    // The open composer shows an uncertain send beside its input; once closed, its
    // onset is reported once with the recovery the chat owner still holds.
    const inspectSend = () => {
      const state = owner.getSnapshot();
      if (account.aborted || !owner.isActive() || state.kind === "Idle" || state.command.kind !== "Send" || state.command.runId !== runId) {
        stopSend?.(); stopSend = null; return;
      }
      if (state.kind === "Busy" || reported === state.kind || current.current?.draftId === entry.id) return;
      reported = state.kind;
      feedback.receipt(state.kind === "Unconfirmed" ? { ...state.feedback, title: "highlight saved; send not confirmed" } : state.feedback,
        { label: state.kind === "RefreshRequired" ? "refresh chat" : "retry same send", onClick: (intent: OpenIntent) => {
          const latest = owner.getSnapshot();
          if (account.aborted || !owner.isActive() || latest.kind === "Idle" || latest.command.kind !== "Send" || latest.command.runId !== runId) return;
          void openAsyncResult({ ctx, intent, disposition: "Fork",
            create: async () => {
              const outcome = await owner.retry(intent);
              return account.aborted ? null : chatOutcome(entry, outcome, target, true);
            },
          }).catch(error => { if (!account.aborted) onError(error, "chat retry didn’t finish"); });
        } });
    };
    const execute = async (): Promise<OpenResult | null> => {
      const ensured = entry.highlightId ? { id: entry.highlightId } : await submit({ command: { kind: "Ensure" }, opened });
      if (!ensured || ctx.sessionSignal().aborted) return null;
      store.update(entry.id, value => ({ ...value, operation: { id: runId, kind: "Chat" }, chatIssue: null }));
      // The server derives the quote from its own copy of this highlight. Its creation, resize
      // or recolour may be any committed local command, so wait for the local prefix committed
      // now (uploads are prefix-ordered); later commits and downloads do not hold the question.
      if (!navigator.onLine) {
        store.update(entry.id, value => ({ ...value, operation: null, chatIssue: { kind: "Failed", message: "connect to ask about this passage. the highlight is saved on this device." } }));
        return null;
      }
      const committed = (await (await writing!.store).readReplica()).command_seq;
      await writing!.whenUploaded(committed, account);
      const key = assumeReaderSelectionKey({ mediaId: entry.sourceMediaId, highlightId: ensured.id });
      let preview;
      try { preview = await getReaderQuotePreview({ key, signal: account }); }
      catch (error) {
        if (isApiError(error) && error.status === 404) {
          store.update(entry.id, value => ({ ...value, operation: null, chatIssue: { kind: "Failed", message: "couldn’t sync this highlight yet. connect and try again." } }));
          return null;
        }
        throw error;
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
      stopSend = owner.subscribe(inspectSend);
      const result = await owner.execute({ kind: "Send", request, runId, viewId: pane.paneId, openIntent }, () => {
        store.update(entry.id, value => {
          if (value.chatAttempt?.runId !== runId) return value;
          const consume = value.revision === submittedInput.revision && !value.referenceActive && !value.attachmentActive;
          if (consume) submittedInput.consumedRevision = value.revision + 1;
          return { ...value, chatIssue: null,
            ...(consume ? { body: emptyBody(), revision: value.revision + 1, selection: null, history: emptyDraftHistory() } : {}),
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
      store.update(entry.id, value => ({ ...value, operation: null, chatIssue: { kind: "Failed", message: "chat couldn’t be prepared. your question is kept" } }));
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
    const opened = current.current;
    const entry = opened && get(opened.draftId);
    const attempt = entry?.chatAttempt;
    if (!opened || !entry || attempt?.kind !== "Dispatched") return;
    const state = attempt.owner.getSnapshot();
    if (state.kind === "Idle" || state.command.kind !== "Send" || state.command.runId !== attempt.runId || state.kind !== "Unconfirmed") return;
    const owns = () => {
      const latest = get(entry.id);
      return activeRef.current && current.current?.id === opened.id && current.current.ownsFocus &&
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
  return {
    draft, opening, chat, branchCue, chatState, chatLocked, readerChatLocked, ownChatCommand,
    annotation: draft?.highlightId ? annotations.annotation(draft.highlightId) : null,
    reselection, cancelReselection,
    reselect() {
      const shown = reader.getState().document;
      if (!draft || draft.operation || shown.status !== "ready" || shown.refreshing) return;
      const next: Reselection = { id: createRandomId(), draftId: draft.id, identity: shown.doc.identity, mode: opening?.mode ?? "Note" };
      reselecting.current = next; setReselection(next); show(null); reader.focusSource();
    },
    applyReselection(capture: SelectionCapture) {
      const selected = reselecting.current, previous = selected && get(selected.draftId);
      const shown = reader.getState().document;
      if (!selected || !previous || !activeRef.current || shown.status !== "ready" || shown.refreshing ||
        capture.identity !== selected.identity || shown.doc.identity !== selected.identity) return;
      cancelReselection();
      open(capture, null, true, previous, selected.mode);
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
    /** A reference typed in the composer links the passage's highlight to its target. */
    reference(): ReferenceInputHost | null {
      if (!draft || !writing) return null;
      const id = draft.id;
      return { source_ref: draft.highlightId ? `highlight:${draft.highlightId}` : null, label: "selected passage",
        onActiveChange(referencing) { store.update(id, entry => entry.referenceActive === referencing ? entry : { ...entry, referenceActive: referencing }); },
        onSelected(target, item) {
          store.update(id, entry => ({ ...entry, referenceActive: false }));
          // a captured passage target materializes its own binding in the same command as the link.
          void submit({ command: { kind: "Ensure" }, opened: current.current }).then(async result => {
            if (!result) return;
            const prepared = await prepareTarget(writing, target);
            await createLink(writing, { source_ref: `highlight:${result.id}`, target_ref: prepared.ref, source_label: null,
              target_label: target.kind === "resource" ? item.label : null, after: null, prelude: prepared.intents });
          })
            .catch((error: unknown) => {
              if (error instanceof LocalCommitError) feedback.receipt({ tone: "Danger", title: "couldn’t link on this device", message: "keep this page open. retry saving." },
                { label: "retry", onClick: () => { void error.retry().catch(() => {}); } });
              else onError(error, "couldn’t link this passage");
            });
        } };
    },
    activePassage: active && draft ? draft.passage : null,
    select(capture: SelectionCapture) {
      const selected = reselecting.current;
      const previous = selected?.identity === capture.identity ? get(selected.draftId) ?? null : null;
      cancelReselection();
      open(capture, null, capture.input !== "touch", previous, selected?.mode ?? "Note");
    },
    compose(capture: SelectionCapture, mode: "Note" | "Ask") {
      cancelReselection();
      open(capture, null, true, null, mode);
    },
    highlightCapture(capture: SelectionCapture, color: HighlightColor) {
      return captureCommand(capture, { kind: "Highlight", color });
    },
    ensureCapture(capture: SelectionCapture) {
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
    attachmentActive(attached: boolean) {
      if (draft) store.update(draft.id, entry => entry.attachmentActive === attached ? entry : { ...entry, attachmentActive: attached });
    },
    compositionStart() { if (draft) store.update(draft.id, entry => ({ ...entry, revision: entry.revision + 1 })); },
    edit(edit: NoteEdit) {
      if (draft) store.update(draft.id, (entry) => ({ ...entry, body: edit.after, revision: entry.revision + 1,
        selection: edit.selectionAfter, history: recordDraftEdit(entry.history, edit) }));
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
    save() { if (draft) void submit({ command: { kind: "Save" }, opened: current.current }); },
    newChat(openIntent: OpenIntent) { void sendChat("New", openIntent); },
    continueChat(openIntent: OpenIntent = "default") { void sendChat("Existing", openIntent); },
    highlight(color: HighlightColor) { void submit({ command: { kind: "Highlight", color }, opened: current.current }); },
    async ensure(): Promise<{ id: string; isCurrent: () => boolean } | null> {
      const opened = current.current;
      const result = await submit({ command: { kind: "Ensure" }, opened });
      return result && opened ? { id: result.id, isCurrent: () => activeRef.current && interaction.current === opened.id } : null;
    },
  };
}

export type SelectionComposer = ReturnType<typeof useSelectionComposer>;
