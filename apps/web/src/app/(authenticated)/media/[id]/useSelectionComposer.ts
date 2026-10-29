"use client";
import { CommandTooLargeError } from "@nexus/authored/types";
import { ExcerptCaptureError, excerptTextParts } from "@nexus/authored/excerpt";

// A frozen selection owns one explicit annotation-or-question input. Existing
// highlight bodies have their own bound editor; this draft then owns questions.
// Unsubmitted writing survives source publication changes and remote deletion.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";
import {hydrateNote, readBody} from "@nexus/authored/documents";
import {applyDraftBody} from "@/lib/notes/editorBinding";
import { flushSync } from "react-dom";
import { noteEditorAttachmentOwnerId } from "@/components/notes/NoteEditor";
import { usePaneVisitWorkOwner, usePaneVisitWorkScope } from "@/lib/workspace/paneReturnMemento";
import { useWorkGuard } from "@/lib/unsavedWork";
import { type FeedbackContent, type FeedbackActions } from "@/components/feedback/Feedback";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { openAsyncResult, type OpenResult } from "@/lib/panes/openResult";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { isNavigationAttention, NAVIGATION_ATTENTION_EVENTS } from "@/lib/ui/eventTarget";
import { getInteractionGeneration, getInteractionOwner, type Layer } from "@/lib/ui/overlay";
import { conversationViewHref } from "@/lib/chat/view";
import { isApiError } from "@/lib/api/client";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import { getConversationCommands, getNewChatCommands, readConversationTree, recoveryOf, IDLE_COMMAND, type CommandOutcome, type ConversationTree } from "@/lib/chat/commands";
import { fetchLatestSourceConversation, type ConversationListItem } from "@/lib/chat/conversationIndex";
import { convertReaderQuestion } from "@nexus/authored/markdown";
import { isSelectable, type SelectionEditor } from "@/lib/chat/selection";
import { useChatSelection } from "@/lib/chat/selectionMemory";
import { chatView } from "@/lib/chat/tree";
import { assertNever } from "@/lib/assertNever";
import { readCatalog } from "@/lib/chat/catalog";
import { assumeReaderSelectionKey, getReaderQuotePreview, readerHighlightChatIntentHref } from "@/lib/chat/readerIntent";
import { chatFailure, type Catalog } from "@/lib/chat/wire";
import { createRandomId } from "@/lib/createRandomId";
import { useReaderState, type DraftAnchor, type Mark, type SelectionCapture } from "@/lib/documentReader/DocumentReader";
import type { Reader } from "@/lib/documentReader/runtime";
import type { HighlightColor } from "@/lib/documentReader/model";
import { captureSelection, createHighlight, recolorHighlight, type SourceLabel, type Capture } from "@/lib/documentReader/annotations";
import { LocalCommitError, isAuthoredStorageFailure, type LocalCommit } from "@/lib/notes/runtime";
import { createLink, prepareTarget } from "@/lib/resourceGraph/links";
import type { ReferenceInputHost } from "@/lib/resourceGraph/useReferenceInput";
import { bodyHasContent, emptyBody } from "@nexus/authored/body";
import { useAuthoredQuery, useWritingRuntime } from "@/lib/notes/hooks";
import { definePaneVisitDataKey, usePaneVisitIdentity } from "@/lib/workspace/paneReturnMemento";
import type { MediaAnnotations } from "./annotations";
import { createSelectionDrafts, emptyDraftHistory, recordDraftEdit, samePassage, type ComposerDraft, type NoteEdit, type ReaderChatIssue } from "./selectionDrafts";

const DEFAULT_VISIT = definePaneVisitDataKey<Visit<{ conversation: ConversationListItem | null }>>("Reader.ChatDefault");
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
  onError: (error: unknown, title: string, retry?: () => Promise<unknown>) => void;
  onFailure: (content: FeedbackContent, actions: FeedbackActions) => void;
}) {
  const { reader, mediaId, annotations, sourceLabel, active, isMobile, onError, onFailure } = input;
  const memory = useChatSelection();
  const { fresh: freshMemory, read: memoryRead } = memory;
  const guard = useWorkGuard();
  const visitId = usePaneVisitIdentity();
  const { ctx } = useActionRuntime();
  const pane = requirePaneRuntime(usePaneRuntime(), "useSelectionComposer");
  const writing = useWritingRuntime();
  const catalogRead = useServerValue({ key: "/llm-catalog", stale: "", visit: CATALOG_VISIT, load: readCatalog });
  const catalog = catalogRead.status === "ready" ? catalogRead.data : null;
  const refreshCatalog = catalogRead.status === "ready" && !catalogRead.error ? catalogRead.revalidate : catalogRead.refetch;
  const [store] = useState(createSelectionDrafts);
  const workScope = usePaneVisitWorkScope();
  const draftOwner = `selection-composer:${visitId}`;
  usePaneVisitWorkOwner({id: draftOwner, scope: workScope, subscribe: store.subscribe, read: () => ({changed: store.getSnapshot().some(entry => bodyHasContent(entry.body) || entry.referenceActive || entry.linkInputActive), unconfirmed: false, stopsBrowserWork: store.getSnapshot().some(entry => entry.attachmentActive)}), readCopyText: () => store.getSnapshot().map(entry => entry.body.body_text).join("\n\n")});
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
  const attention = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const show = useCallback((next: Opening | null) => {
    current.current = next; interaction.current = next?.id ?? null; setOpening(next);
  }, []);
  useEffect(() => { if (!active) setPickerDraftId(null); }, [active]);
  useEffect(() => { cancelReselection(); }, [active, publication, isMobile, cancelReselection]);
  const previousPublication = useRef(publication);
  useEffect(() => {
    if (previousPublication.current === publication) return;
    previousPublication.current = publication;
    setPickerDraftId(null);
    for (const entry of store.getSnapshot()) if (entry.highlightId === null) store.update(entry.id, value => ({...value, issue: {kind: "Source", message: SOURCE_CHANGED}}));
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
      if (event.type === "focusin" || event.type === "blur") attention.current++;
      const inside = event.target instanceof Element && event.target.closest("[data-selection-composer]") !== null;
      if (opened.focus || opened.ownsFocus !== inside) show({ ...opened, focus: false, ownsFocus: inside });
    };
    const attended = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("[data-passive-tooltip]")) return;
      if (isNavigationAttention(event)) attention.current++;
    };
    for (const event of NAVIGATION_ATTENTION_EVENTS) window.addEventListener(event, attended, { capture: true, passive: true });
    document.addEventListener("focusin", moved);
    const blurred = () => { if (current.current) attention.current++; };
    document.addEventListener("focusout", blurred);
    document.addEventListener("pointerdown", moved, true);
    window.addEventListener("blur", moved);
    return () => { for (const event of NAVIGATION_ATTENTION_EVENTS) window.removeEventListener(event, attended, true); document.removeEventListener("focusin", moved); document.removeEventListener("focusout", blurred); document.removeEventListener("pointerdown", moved, true); window.removeEventListener("blur", moved); };
  }, [show]);

  const draft = active && opening ? drafts.find((entry) => entry.id === opening.draftId) ?? null : null;
  const copyAnnotation = draft?.highlightId ? annotations.annotation(draft.highlightId) : null;
  const copyRead = useAuthoredQuery(copyAnnotation ? { kind: "excerpt", ref: copyAnnotation.ref, reading_ref: copyAnnotation.readingRef } : null);
  const copyResource = copyRead.data?.rows[0]?.resource;
  const fullCopyText = useMemo(() => copyResource?.excerpt?.kind === "content" ? excerptTextParts(copyResource.excerpt.body).exact : null, [copyResource]);
  const copyQuote = draft?.highlightId ? copyResource?.capture_revision === copyAnnotation?.projection.capture_revision && copyResource?.excerpt?.kind === "content" ? fullCopyText : null : draft?.passage.quote ?? null;
  const copyUnavailable = draft?.highlightId && copyQuote === null ? copyRead.error ? "couldn’t load this passage" : copyRead.data ? "passage unavailable in this reading" : "loading passage…" : copyQuote?.trim() ? null : "this highlight has no text to copy";
  const get = (id: string) => store.getSnapshot().find((entry) => entry.id === id);
  const annotationOwners = useRef<readonly string[]>([]);
  const canAbandon = () => {
    const id = current.current?.draftId;
    return id === undefined || guard.confirmLoss({ scopes: [], ownerIds: [...annotationOwners.current, draftOwner, noteEditorAttachmentOwnerId(visitId, `reader-draft:${id}`)] });
  };
  const destination = draft?.destination ?? null;
  const defaultId = destination?.kind === "Resolving" ? draft!.id : null;
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
  useEffect(() => {
    if (draft?.chatIssue?.kind !== "Recall") return;
    if (freshMemory(catalog)) store.update(draft.id, entry => ({ ...entry, chatIssue: null }));
    else if (memoryRead.status === "failed" || (memoryRead.status === "ready" && memoryRead.error))
      store.update(draft.id, entry => entry.chatIssue?.kind === "Recall" && entry.chatIssue.state !== "Failed"
        ? { ...entry, chatIssue: { ...entry.chatIssue, state: "Failed" } } : entry);
  }, [draft, freshMemory, catalog, memoryRead, store]);
  const observedTree = destination?.kind === "Selected" && destination.snapshot.kind === "Ready" ? destination.snapshot.tree : null;
  const chat = observedTree ? chatView({ messages: new Map(observedTree.messages.map(message => [message.id, message])),
    leafId: observedTree.active_leaf_message_id, history: "Ready" }, observedTree.conversation.id, null) : null;
  // Target and branch come from the canonical stored leaf, never another pane's endpoint.
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
      store.update(entry.id, value => ({...value, issue: {kind: "Source", message: "this highlight was deleted. your writing is kept."}}));
    }
  }, [annotationState, annotations, show, store]);

  // Opening fixes the exact capture before any command; commands reuse that frozen target.
  const prepare = (selected: ComposerDraft["passage"], highlightId: string | null, carried: ComposerDraft | null): ComposerDraft => {
    // pdf captures carry the command-only `exact`; the passage keeps the visual anchor.
    const passage: ComposerDraft["passage"] = { identity: selected.identity, quote: selected.quote, excerpt: selected.excerpt, excerpt_start: selected.excerpt_start, excerpt_end: selected.excerpt_end,
      anchor: selected.anchor.kind === "text"
        ? { kind: "text", unit: selected.anchor.unit, start: selected.anchor.start, end: selected.anchor.end }
        : { kind: "pdf", page: selected.anchor.page, quads: selected.anchor.quads },
    };
    const existing = carried ? undefined : store.getSnapshot().find(entry =>
      (highlightId ? entry.highlightId === highlightId : entry.highlightId === null && samePassage(entry.passage, passage)));
    if (existing) {
      if (highlightId && !samePassage(existing.passage, passage)) {
        const updated = { ...existing, passage: { ...passage, quote: existing.passage.quote } };
        store.put(updated);
        return updated;
      }
      return existing;
    }
    const shown = reader.getState().document;
    const annotation = highlightId ? annotations.annotation(highlightId) : null;
    const anchor: DraftAnchor = passage.anchor.kind === "pdf" ? { ...passage.anchor, exact: selected.quote } : passage.anchor;
    let capture: Capture | null = null;
    let refused = false;
    if (!highlightId && shown.status === "ready" && shown.doc.identity === passage.identity) {
      try { capture = captureSelection(shown.doc, mediaId, anchor, selected.excerpt, selected.excerpt_start, selected.excerpt_end); }
      catch (error) { if (error instanceof ExcerptCaptureError) refused = true; else throw error; }
    }
    const sourceRef = annotation?.sourceRef ?? capture?.sourceRef ?? `media:${mediaId}`;
    const entry: ComposerDraft = {
      id: createRandomId(), passage: annotation ? { ...passage, quote: "" } : passage,
      capture, highlightId, bodyRole: carried?.bodyRole ?? (highlightId ? "question" : "annotation_or_question"), annotationBase: carried?.annotationBase ?? null,
      body: carried?.body ?? emptyBody(), revision: 0, selection: carried?.selection ?? null, history: carried?.history ?? emptyDraftHistory(),
      operation: null, issue: highlightId || capture ? null : { kind: "Capture", message: refused ? "this passage contains text that can’t be captured faithfully yet." : "this passage can’t be annotated here." },
      referenceActive: false, linkInputActive: false, attachmentActive: false,
      sourceMediaId: sourceRef.startsWith("media:") ? sourceRef.slice("media:".length) : mediaId, sourceHasChats: null, destination: { kind: "Resolving" }, chatSelection: carried?.chatSelection ?? { kind: "Uninitialized" }, chatAttempt: null, chatIssue: null,
    };
    store.put(entry);
    return entry;
  };
  const open = (passage: ComposerDraft["passage"], highlightId: string | null, focus: boolean, carried: ComposerDraft | null, mode: Opening["mode"]) => {
    const previous = current.current && get(current.current.draftId);
    const replacing = previous && (carried !== null || !(highlightId ? previous.highlightId === highlightId : samePassage(previous.passage, passage)));
    if (replacing && !canAbandon()) return;
    memory.enter();
    refreshCatalog();
    const prepared = prepare(passage, highlightId, carried);
    setPickerDraftId(null);
    show({ id: createRandomId(), draftId: prepared.id, focus, ownsFocus: true, serial: ++serial.current, mode });
  };

  const highlightDeleted = useCallback((id: string) => {
    for (const entry of store.getSnapshot()) if (entry.highlightId === id) store.update(entry.id, value => ({...value, issue: {kind: "Source", message: "this highlight was deleted. your writing is kept."}}));
  }, [store]);

  const close = (id: string | null) => {
    if (id !== null) store.remove(id);
    show(null); setPickerDraftId(null); cancelReselection();
  };

  /** One local command for the opened draft; the input stays until its commit is durable. */
  const submit = async ({ command, opened, recovery = null }: { command: Command; opened: Opening | null; recovery?: Extract<ComposerDraft["issue"], {kind: "Failed"}> | null }): Promise<{ id: string } | null> => {
    const entry = opened && get(opened.draftId);
    // a failed frame is retried, never resubmitted under a new identity.
    if (!opened || !entry || !writing || entry.operation || entry.referenceActive || entry.linkInputActive || entry.attachmentActive ||
      (command.kind === "Save" && entry.bodyRole === "question") || (entry.issue !== null && entry.issue !== recovery) || entry.chatIssue?.kind === "Passage" || entry.chatIssue?.kind === "Source") return null;
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
    store.update(entry.id, value => ({ ...value, operation: { id: operationId, kind: command.kind }, issue: recovery }));
    const note = command.kind === "Save" && bodyHasContent(submitted.body) ? submitted.body : null;
    const id = submitted.highlightId ?? crypto.randomUUID();
    let intent: { openingId: string; attention: number; layer: Layer | null; generation: number } | null = command.kind === "Save"
      ? { openingId: opened.id, attention: attention.current, layer: getInteractionOwner(), generation: getInteractionGeneration() } : null;
    let createdBody: string | null = null;
    let failed: Extract<ComposerDraft["issue"], { kind: "Failed" }> | null = recovery;
    const finish = (receipt?: LocalCommit) => {
      const created = receipt?.change.resources.find(resource => resource.ref === `highlight:${id}`);
      if (submitted.highlightId === null && created?.kind === "highlight" && created.body_update !== null) createdBody = created.body_update;
      if (ctx.sessionSignal().aborted) return { id };
      const value = get(entry.id);
      if (!value) return { id };
      const unchanged = value.revision === submitted.revision && !value.referenceActive && !value.linkInputActive && !value.attachmentActive;
      const complete = command.kind === "Save" && unchanged && intent !== null && activeRef.current &&
        current.current?.id === intent.openingId && current.current.draftId === entry.id &&
        attention.current === intent.attention && getInteractionOwner() === intent.layer && getInteractionGeneration() === intent.generation;
      store.update(entry.id, value => ({ ...value, highlightId: id, capture: null, annotationBase: value.annotationBase ?? createdBody,
        operation: value.operation?.id === operationId ? null : value.operation,
        issue: failed !== null && value.issue === failed ? null : value.issue,
        ...(note && unchanged ? { body: emptyBody(), revision: value.revision + 1, selection: null, history: emptyDraftHistory() } : {}) }));
      if (complete) {
        close(entry.id);
        if (!isMobile) reader.focusSource();
      }
      return { id };
    };
    try {
      if (annotation) {
        if (command.kind === "Highlight") await recolorHighlight(writing, annotation, command.color);
        else if (command.kind === "Save" && submitted.annotationBase !== null && note) {
          const clone = hydrateNote(submitted.annotationBase);
          const vector = Y.encodeStateVector(clone);
          let delta: Uint8Array;
          try {applyDraftBody(clone, readBody(clone), note); delta = Y.encodeStateAsUpdate(clone, vector);} finally {clone.destroy();}
          const document = await writing.openDocument(annotation.ref), origin = Symbol("selection annotation save");
          await writing.admitWriting({existing: [{document, origin}], notes: [], mutate: () => {Y.applyUpdate(document.doc, delta, origin);}, prepare: async () => []}).result;
        }

      } else {
        const receipt = await createHighlight(writing, { id, capture: submitted.capture!,
          color: command.kind === "Highlight" ? command.color : "yellow", annotation: note, source: sourceLabel(submitted.capture!.sourceRef) });
        const created = receipt.change.resources.find(resource => resource.ref === `highlight:${id}`);
        if (created?.kind !== "highlight" || created.body_update === null) throw new Error("highlight creation receipt has no permanent body");
        createdBody = created.body_update;
      }
      return finish();
    } catch (error) {
      if (ctx.sessionSignal().aborted) return null;
      if (error instanceof CommandTooLargeError) {
        store.update(entry.id, value => value.operation?.id === operationId ? { ...value, operation: null, issue: { kind: "Capacity", message: "this selection is too large to save. select a shorter passage." } } : value);
        return null;
      }
      if (error instanceof LocalCommitError) {
        intent = null;
        failed = { kind: "Failed", phase: "Commit", message: LOCAL_FAILURE, retry: () => {
          const value = get(entry.id);
          if (!value || value.issue !== failed || value.operation) return;
          if (command.kind === "Save" && current.current?.id === opened.id && activeRef.current &&
            value.revision === submitted.revision && !value.referenceActive && !value.linkInputActive && !value.attachmentActive) {
            intent = { openingId: opened.id, attention: attention.current, layer: getInteractionOwner(), generation: getInteractionGeneration() };
          }
          store.update(entry.id, value => ({ ...value, operation: { id: operationId, kind: command.kind } }));
          void error.retry().catch(() => {
            intent = null;
            store.update(entry.id, value => value.issue === failed && value.operation?.id === operationId ? { ...value, operation: null } : value);
          });
        } };
        store.update(entry.id, value => value.operation?.id === operationId ? { ...value, operation: null, issue: failed } : value);
        void error.completion.then(finish, () => undefined);
        return null;
      }
      if (isAuthoredStorageFailure(error)) {
        failed = recovery?.phase === "Preparation" ? recovery : {kind: "Failed", phase: "Preparation", message: "couldn’t prepare this passage", retry: () => {
          const value = get(entry.id);
          if (!value || value.issue !== failed || value.operation) return;
          void submit({command, opened, recovery: failed});
        }};
        store.update(entry.id, value => value.operation?.id === operationId ? {...value, operation: null, issue: failed} : value);
        return null;
      }
      // Nothing committed; unexpected failures retain their defect boundary.
      store.update(entry.id, value => value.operation?.id === operationId ? { ...value, operation: null } : value);
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
      onFailure({ tone: "Warning", title: "highlight saved; question not sent", message: outcome.feedback.title },
        [{ label: "open chat", href: entry.destination.kind === "Selected" ? `/conversations/${entry.destination.id}` : "/conversations/new" }]);
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
              ? { kind: "Model", message: "this chat’s model is unavailable", destination: attempt?.destination ?? target, selection: attempt?.selection ?? { kind: "Uninitialized" } }
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
  const sendChat = async (target: "New" | "Existing", openIntent: OpenIntent, recovery: { selection: SelectionEditor } | null = null) => {
    const opened = current.current;
    const entry = opened && get(opened.draftId);
    if (!opened || !entry || entry.operation || entry.referenceActive || entry.linkInputActive || entry.attachmentActive || entry.issue || entry.chatIssue?.kind === "Passage" || entry.chatIssue?.kind === "Source" || pickerDraftId !== null || hasHeldChat()) return;
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
    const selection = recovery?.selection ?? (entry.chatSelection.kind === "Uninitialized" ? memory.fresh(catalog) : entry.chatSelection);
    if (question.kind === "Text" && recovery === null) {
      if (!selection) {
        store.update(entry.id, value => ({ ...value, chatIssue: { kind: "Recall", state: memoryRead.status === "loading" || (memoryRead.status === "ready" && !memoryRead.error) ? "Pending" : "Failed", destination: target, selection: { kind: "Uninitialized" } } })); return;
      }
      store.update(entry.id, value => ({ ...value, chatSelection: selection }));
      if (!catalog) {
        store.update(entry.id, value => ({ ...value, chatIssue: { kind: "Catalog", message: "couldn’t load model availability", destination: target, selection } })); return;
      }
      if (selection.kind !== "Selected" || !isSelectable(catalog, selection.selection, selection.route)) {
        store.update(entry.id, value => ({ ...value, chatIssue: { kind: "Model", message: "model unavailable", destination: target, selection } })); return;
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
        latest !== undefined && !latest.referenceActive && !latest.linkInputActive && !latest.attachmentActive &&
        (latest.revision === submittedInput.revision || latest.revision === submittedInput.consumedRevision);
    };
    const account = ctx.sessionSignal();
    const execute = async (): Promise<OpenResult | null> => {
      const ensured = entry.highlightId ? { id: entry.highlightId } : await submit({ command: { kind: "Ensure" }, opened });
      if (!ensured || ctx.sessionSignal().aborted) return null;
      store.update(entry.id, value => ({ ...value, operation: { id: runId, kind: "Chat" }, chatIssue: null }));
      // The server derives the quote from its own copy of this highlight. Its creation, resize
      // or recolour may be any committed local command, so wait for the local prefix committed
      // now (uploads are prefix-ordered); later commits and downloads do not hold the question.
      // an upload that cannot proceed (offline, sign-in, update, sync or local failure) names its
      // cause; the highlight stays saved here and the question may be asked again later.
      try {
        const committed = (await (await writing!.store).readReplica()).command_seq;
        await writing!.whenUploaded(committed, account);
      } catch (error) {
        if (account.aborted) return null;
        store.update(entry.id, value => ({ ...value, operation: null, chatIssue: { kind: "Failed",
          message: error instanceof Error ? error.message : "couldn’t send this highlight to nexus yet. try again later." } }));
        return null;
      }
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
          ...(recovery !== null ? { entry: { kind: "ComposeReaderQuestion" as const, text: question.kind === "Text" ? question.content : "", selection: recovery.selection } } : {}) };
      }
      if (!selection || selection.kind !== "Selected") throw new Error("Reader send without an observed selection");
      if (owner.getSnapshot().kind !== "Idle") {
        store.update(entry.id, value => ({ ...value, operation: null, chatIssue: { kind: "Failed", message: "another chat change is still in progress" } })); return null;
      }
      const insertion = view?.target;
      if (target === "Existing" && insertion?.kind !== "Empty" && insertion?.kind !== "Reply") throw new Error("Reader send without a replyable snapshot");
      store.update(entry.id, value => ({ ...value, operation: null, chatAttempt: { kind: "Dispatched", runId, owner, selection, destination: target, input: submittedInput } }));
      const request = { destination: observed && insertion && (insertion.kind === "Empty" || insertion.kind === "Reply")
        ? { kind: "Existing" as const, conversation_id: observed.conversation.id, expected_revision: observed.conversation.branch_revision,
          insertion: insertion.kind === "Empty" ? { kind: "Empty" as const } : { kind: "Reply" as const, parent_message_id: insertion.parentId, branch_anchor: insertion.anchor } }
        : { kind: "New" as const }, content: question.content, selection: selection.selection, reader_selection: { key: preview.key, revision: preview.revision } };
      const sendingResult = owner.execute({ kind: "Send", request, selectionRoute: selection.route, runId, viewId: pane.paneId, openIntent }, () => {
        store.update(entry.id, value => {
          if (value.chatAttempt?.runId !== runId) return value;
          const consume = value.revision === submittedInput.revision && !value.referenceActive && !value.linkInputActive && !value.attachmentActive;
          if (consume) submittedInput.consumedRevision = value.revision + 1;
          return { ...value, chatIssue: null,
            ...(consume ? { chatSelection: { kind: "Uninitialized" as const }, body: emptyBody(), revision: value.revision + 1, selection: null, history: emptyDraftHistory() } : {}),
            destination: value.destination.kind === "Selected" ? { ...value.destination, snapshot: { kind: "RefreshRequired" } } : value.destination };
        });
      });
      ctx.observeChatCommand({id: `reader-send:${runId}`, title: "highlight question", owner,
        present: outcome => {chatOutcome(entry, outcome, target, true);},
        retry: async intent => {await openAsyncResult({ctx, intent, disposition: "Fork", create: async () => {
          const outcome = await owner.retry(intent);
          return account.aborted ? null : chatOutcome(entry, outcome, target, true);
        }});},
      });
      const result = await sendingResult;
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
        latest !== undefined && !latest.referenceActive && !latest.linkInputActive && !latest.attachmentActive &&
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
    protectOwners(owners: readonly string[]) {annotationOwners.current = owners;},
    draft, opening, copyQuote, copyUnavailable, chat, branchCue, chatState, chatLocked, readerChatLocked, ownChatCommand,
    hiddenPreparationFailures: drafts.flatMap(entry => entry.id !== draft?.id && entry.issue?.kind === "Failed" && entry.issue.phase === "Preparation"
      ? [{id: entry.id, issue: entry.issue, busy: entry.operation !== null, text: bodyHasContent(entry.body) ? entry.body.body_text : null}] : []),
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
    retryRecall: memory.enter,
    recallFailureOccurrence: memory.failureOccurrence,
    recallPending: memoryRead.status === "loading" || (memoryRead.status === "ready" ? memoryRead.refreshing : memoryRead.retrying),
    recoverModel() {
      const issue = draft?.chatIssue;
      if (issue?.kind === "Model" || issue?.kind === "Catalog" || issue?.kind === "Recall") void sendChat(issue.destination, "default", { selection: issue.selection });
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
            const link = async () => {
              const prepared = await prepareTarget(writing, target);
              await createLink(writing, {source_ref: `highlight:${result.id}`, target_ref: prepared.ref, source_label: null,
                target_label: target.kind === "resource" ? item.label : null, after: null, prelude: prepared.intents});
            };
            await link().catch(error => onError(error, "couldn’t link this passage", link));
          })
            .catch((error: unknown) => {
              if (!(error instanceof LocalCommitError)) onError(error, "couldn’t link this passage");
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
      open({ identity, anchor: mark.anchor, quote: "", excerpt: null, excerpt_start: null, excerpt_end: null }, mark.id, focus, null, "Note");
    },
    highlightDeleted,
    dismiss(reason?: "outside-click" | "escape") {
      if (!canAbandon()) return false;
      const returnFocus = current.current?.ownsFocus;
      const id = current.current?.draftId;
      close(id ?? null);
      if (reason === "escape" && activeRef.current && returnFocus) reader.focusSource();
      return true;
    },
    attachmentActive(attached: boolean) {
      if (draft) store.update(draft.id, entry => entry.attachmentActive === attached ? entry : { ...entry, attachmentActive: attached });
    },
    linkInputActive(active: boolean) {
      if (draft) store.update(draft.id, entry => entry.linkInputActive === active ? entry : { ...entry, linkInputActive: active });
    },
    compositionStart() { if (draft) store.update(draft.id, entry => ({ ...entry, revision: entry.revision + 1 })); },
    edit(edit: NoteEdit) {
      if (draft) store.update(draft.id, (entry) => ({ ...entry, body: edit.after, revision: entry.revision + 1,
        selection: edit.selectionAfter, issue: entry.issue?.kind === "Capacity" ? null : entry.issue, history: recordDraftEdit(entry.history, edit) }));
    },
    selection(selection: NoteEdit["selectionAfter"]) { if (draft) store.update(draft.id, (entry) => ({ ...entry, selection })); },
    historyBoundary() { if (draft) store.update(draft.id, (entry) => ({ ...entry, history: { ...entry.history, group: entry.history.group + 1 } })); },
    undo() {
      if (!draft) return;
      store.update(draft.id, (entry) => { const edit = entry.history.undo.at(-1); return edit ? { ...entry, body: edit.before, selection: edit.selectionBefore, revision: entry.revision + 1, issue: entry.issue?.kind === "Capacity" ? null : entry.issue,
        history: { undo: entry.history.undo.slice(0, -1), redo: [...entry.history.redo, edit], group: entry.history.group + 1 } } : entry; });
      restoreHistoryFocus();
    },
    redo() {
      if (!draft) return;
      store.update(draft.id, (entry) => { const edit = entry.history.redo.at(-1); return edit ? { ...entry, body: edit.after, selection: edit.selectionAfter, revision: entry.revision + 1, issue: entry.issue?.kind === "Capacity" ? null : entry.issue,
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
