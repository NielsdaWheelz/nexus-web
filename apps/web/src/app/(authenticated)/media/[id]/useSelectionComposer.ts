"use client";
import { CommandTooLargeError } from "@nexus/authored/types";
import { ExcerptCaptureError, excerptTextParts } from "@nexus/authored/excerpt";

// A visit retains one annotation-or-question draft. An owned interaction freezes
// its initial native range; leaving before that revokes capture, not writing.
// Explicit refinement rolls back to the accepted passage. Existing highlight
// bodies have their own bound editor; this draft then owns questions.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";
import {encodeBytes, hydrateNote, readBody} from "@nexus/authored/documents";
import {applyDraftBody} from "@/lib/notes/editorBinding";
import { flushSync } from "react-dom";
import { noteEditorAttachmentOwnerId } from "@/components/notes/NoteEditor";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useWorkGuard } from "@/lib/unsavedWork";
import type { Line } from "@/components/feedback/stage";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { isNavigationAttention, NAVIGATION_ATTENTION_EVENTS } from "@/lib/ui/eventTarget";
import { getInteractionGeneration, getInteractionOwner, type Layer } from "@/lib/ui/overlay";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import { readConversationTree, type ConversationTree } from "@/lib/chat/commands";
import { fetchLatestSourceConversation, type ConversationListItem } from "@/lib/chat/conversationIndex";
import { convertReaderQuestion } from "@nexus/authored/markdown";
import { useChatSelection } from "@/lib/chat/selectionMemory";
import { chatView } from "@/lib/chat/tree";
import { readCatalog } from "@/lib/chat/catalog";
import { launchReaderChat } from "@/lib/chat/readerIntent";
import { type Catalog } from "@/lib/chat/wire";
import { createRandomId } from "@/lib/createRandomId";
import { rejectedSelectionFact, useReaderState, type DraftAnchor, type Mark, type SelectionCapture, type SelectionEvent, type SelectionNotice } from "@/lib/documentReader/DocumentReader";
import type { Reader } from "@/lib/documentReader/runtime";
import { sourceTarget, type HighlightColor } from "@/lib/documentReader/model";
import { captureSelection, createHighlight, recolorHighlight, type SourceLabel, type Capture } from "@/lib/documentReader/annotations";
import { LocalCommitError, isAuthoredStorageFailure, type LocalCommit } from "@/lib/notes/runtime";
import { createLink, prepareTarget } from "@/lib/resourceGraph/links";
import type { ReferenceInputHost } from "@/lib/resourceGraph/useReferenceInput";
import { bodyHasContent, emptyBody } from "@nexus/authored/body";
import { useAuthoredQuery, useWritingRuntime } from "@/lib/notes/hooks";
import { definePaneVisitDataKey, usePaneVisitIdentity } from "@/lib/workspace/paneReturnMemento";
import type { MediaAnnotations } from "./annotations";
import { emptyDraftHistory, recordDraftEdit, samePassage, type ComposerDraft, type NoteEdit } from "./selectionDrafts";

const DEFAULT_VISIT = definePaneVisitDataKey<Visit<{ conversation: ConversationListItem | null }>>("Reader.ChatDefault");
const TREE_VISIT = definePaneVisitDataKey<Visit<{ tree: ConversationTree | null }>>("Reader.ChatTree");
const CATALOG_VISIT = definePaneVisitDataKey<Visit<Catalog>>("Reader.ChatCatalog");
type Opening = { id: string; draftId: string; focus: boolean; ownsFocus: boolean; serial: number };
type Refinement = { id: string; draftId: string; identity: string; candidate: SelectionEvent | null; explicit: boolean; inputHeld: boolean };
type SelectionSubject = { readonly id: string; readonly capture: SelectionCapture };
type Command =
  | { kind: "Save" }
  | { kind: "Ensure" }
  | { kind: "Highlight"; color: HighlightColor };

export const SOURCE_CHANGED: Line = { fact: "the text changed.", reason: "your words are kept." };
const HIGHLIGHT_DELETED: Line = { fact: "this highlight was deleted.", reason: "your words are kept." };

export function useSelectionComposer(input: {
  reader: Reader;
  mediaId: string;
  annotations: MediaAnnotations;
  /** The literal label this host knows for a capture's source, if any. */
  sourceLabel: (sourceRef: string) => SourceLabel | null;
  active: boolean;
  isMobile: boolean;
  boundsActive: boolean;
  onError: (error: unknown, title: string, retry?: () => Promise<unknown>) => void;
}) {
  const { reader, mediaId, annotations, sourceLabel, active, isMobile, onError } = input;
  const memory = useChatSelection();
  const guard = useWorkGuard();
  const visitId = usePaneVisitIdentity();
  const { ctx } = useActionRuntime();
  const pane = requirePaneRuntime(usePaneRuntime(), "useSelectionComposer");
  const writing = useWritingRuntime();
  const catalogRead = useServerValue({ key: "/llm-catalog", stale: "", visit: CATALOG_VISIT, load: readCatalog });
  const catalog = catalogRead.status === "ready" ? catalogRead.data : null;
  const refreshCatalog = catalogRead.status === "ready" && !catalogRead.error ? () => catalogRead.revalidate() : catalogRead.refetch;
  const retained = useResourceDraft<ComposerDraft | null>("Reader.SelectionComposer", () => null,
    entry => ({changed: entry !== null && (bodyHasContent(entry.body) || entry.referenceActive || entry.linkInputActive), unconfirmed: false, stopsBrowserWork: entry?.attachmentActive ?? false}),
    entry => entry?.body.body_text ?? null);
  const {read, set, owner: draftOwner} = retained;
  const store = useMemo(() => ({
    put: (entry: ComposerDraft) => set(entry),
    remove: (id: string) => set(entry => entry?.id === id ? null : entry),
    update: (id: string, change: (entry: ComposerDraft) => ComposerDraft) => set(entry => entry?.id === id ? change(entry) : entry),
  }), [set]);
  const get = (id: string) => { const entry = read(); return entry?.id === id ? entry : null; };
  const publication = useReaderState(reader, state => state.document.status === "ready" ? state.document.doc.identity : null);
  const [refinement, setRefinement] = useState<Refinement | null>(null);
  const refining = useRef<Refinement | null>(null);
  const selectionActivation = useRef<SelectionSubject | null>(null);
  const showRefinement = useCallback((next: Refinement | null) => { refining.current = next; setRefinement(next); }, []);
  const cancelReselection = useCallback(() => {
    const session = refining.current;
    selectionActivation.current = null;
    showRefinement(null);
    if (session && !session.explicit) set(entry => {
      if (entry?.id !== session.draftId) return entry;
      if (!bodyHasContent(entry.body) && !entry.referenceActive && !entry.linkInputActive && !entry.attachmentActive && !entry.operation) return null;
      return {...entry, capture: null, issue: {kind: "Capture", line: {fact: "select the passage again.", reason: "your words are kept."}}};
    });
  }, [set, showRefinement]);
  const reselection = refinement?.explicit ? refinement : null;
  const [pickerDraftId, setPickerDraftId] = useState<string | null>(null);
  const [opening, setOpening] = useState<Opening | null>(() => retained.value
    ? {id: createRandomId(), draftId: retained.value.id, focus: false, ownsFocus: false, serial: 0} : null);
  const current = useRef<Opening | null>(opening);
  const interaction = useRef<string | null>(opening?.id ?? null);
  const serial = useRef(0);
  const attention = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const show = useCallback((next: Opening | null) => {
    current.current = next; interaction.current = next?.id ?? null; setOpening(next);
  }, []);
  useEffect(() => { if (!active) setPickerDraftId(null); }, [active]);
  useEffect(() => { cancelReselection(); }, [active, publication, isMobile, cancelReselection]);
  useEffect(() => {
    const entry = read();
    if (publication && entry?.highlightId === null && entry.passage.identity !== publication) {
      setPickerDraftId(null);
      store.update(entry.id, value => value.issue?.kind === "Source" ? value : {...value, issue: {kind: "Source", line: SOURCE_CHANGED}});
    }
  }, [publication, read, store]);
  useEffect(() => {
    const retire = () => { if (document.visibilityState === "hidden") cancelReselection(); };
    document.addEventListener("visibilitychange", retire);
    window.addEventListener("blur", cancelReselection);
    return () => { document.removeEventListener("visibilitychange", retire); window.removeEventListener("blur", cancelReselection); };
  }, [cancelReselection]);
  useEffect(() => () => { cancelReselection(); current.current = null; interaction.current = null; activeRef.current = false; }, [cancelReselection]);
  useEffect(() => {
    const moved = (event: Event) => {
      const opened = current.current;
      if (!opened) return;
      if (event.type === "pointerdown" && event.target instanceof Element && event.target.closest("[data-passive-tooltip]")) return;
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

  const draft = active && opening && retained.value?.id === opening.draftId ? retained.value : null;
  const copyAnnotation = draft?.highlightId ? annotations.annotation(draft.highlightId) : null;
  const copyRead = useAuthoredQuery(copyAnnotation ? { kind: "excerpt", ref: copyAnnotation.ref, reading_ref: copyAnnotation.readingRef } : null);
  const copyResource = copyRead.data?.rows[0]?.resource;
  const fullCopyText = useMemo(() => copyResource?.excerpt?.kind === "content" ? excerptTextParts(copyResource.excerpt.body).exact : null, [copyResource]);
  const copyQuote = draft?.highlightId ? copyResource?.capture_revision === copyAnnotation?.projection.capture_revision && copyResource?.excerpt?.kind === "content" ? fullCopyText : null : draft?.passage.quote ?? null;
  const copyUnavailable = draft?.highlightId && copyQuote === null ? copyRead.error ? "couldn’t load this passage." : copyRead.data ? "this passage isn’t in this reading." : "loading the passage." : copyQuote?.trim() ? null : "this highlight has no text to copy.";
  const annotationOwners = useRef<readonly string[]>([]);
  const canAbandon = () => {
    const id = read()?.id;
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
      if (defaultRead.status === "failed") return { ...entry, destination: { kind: "LookupFailed", error: defaultRead.error } };
      const candidate = defaultRead.data.conversation;
      return { ...entry, destination: candidate
        ? { kind: "Selected", id: candidate.id, title: candidate.title, snapshot: { kind: "Loading" } }
        : { kind: "Absent" } };
    });
  }, [defaultId, defaultRead, defaultSource, store]);
  const loadingChatId = destination?.kind === "Selected" && destination.snapshot.kind === "Loading" ? destination.id : null;
  const treeRead = useServerValue({ key: draft && loadingChatId ? `reader-chat-tree:${draft.id}:${loadingChatId}` : null,
    stale: "", visit: TREE_VISIT, load: async () => ({ tree: await readConversationTree(loadingChatId!) }),
  });
  useEffect(() => {
    if (!draft || !loadingChatId || treeRead.status === "loading") return;
    store.update(draft.id, entry => {
      const selected = entry.destination;
      if (selected.kind !== "Selected" || selected.id !== loadingChatId || selected.snapshot.kind !== "Loading") return entry;
      if (treeRead.status === "failed") return { ...entry, destination: { ...selected, snapshot: { kind: "Failed" } } };
      return treeRead.data.tree ? { ...entry, destination: { ...selected, title: treeRead.data.tree.conversation.title,
        snapshot: { kind: "Ready", tree: treeRead.data.tree } } }
        : { ...entry, destination: { ...selected, snapshot: { kind: "Failed" } }, chatIssue: { kind: "Missing", line: { fact: "this chat isn’t available." } } };
    });
  }, [draft, loadingChatId, treeRead, store]);
  const observedTree = destination?.kind === "Selected" && destination.snapshot.kind === "Ready" ? destination.snapshot.tree : null;
  const chat = observedTree ? chatView({ messages: new Map(observedTree.messages.map(message => [message.id, message])),
    leafId: observedTree.active_leaf_message_id, history: "Ready" }, observedTree.conversation.id, null) : null;
  // Target and branch come from the canonical stored leaf, never another pane's endpoint.
  const branchCue = chat && [...chat.children.values()].some(children => children.filter(message => message.role === "user").length > 1)
    ? `branch · response ${chat.path.at(-1)?.seq ?? "empty"}` : null;
  // Deleted highlights retain their independent question until deliberate discard.
  const annotationState = useSyncExternalStore(annotations.subscribe, annotations.getState, annotations.getState);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (annotationState.local.status !== "ready") return;
    for (const annotation of annotationState.local.annotations) seen.current.add(annotation.id);
    const entry = read(), id = entry?.highlightId;
    if (!entry || !id || !seen.current.has(id) || annotations.annotation(id) || entry.operation) return;
    seen.current.delete(id);
    store.update(entry.id, value => ({...value, issue: {kind: "Source", line: HIGHLIGHT_DELETED}}));
  }, [annotationState, annotations, read, store]);

  // Opening fixes the exact capture before any command; commands reuse that frozen target.
  const prepare = (selected: ComposerDraft["passage"], highlightId: string | null, carried: ComposerDraft | null): ComposerDraft => {
    // pdf captures carry the command-only `exact`; the passage keeps the visual anchor.
    const passage: ComposerDraft["passage"] = { identity: selected.identity, quote: selected.quote, excerpt: selected.excerpt, excerpt_start: selected.excerpt_start, excerpt_end: selected.excerpt_end,
      anchor: selected.anchor.kind === "text"
        ? { kind: "text", unit: selected.anchor.unit, start: selected.anchor.start, end: selected.anchor.end }
        : { kind: "pdf", page: selected.anchor.page, quads: selected.anchor.quads },
    };
    const held = read();
    const existing = !carried && held && (highlightId ? held.highlightId === highlightId : held.highlightId === null && samePassage(held.passage, passage)) ? held : null;
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
    const entry: ComposerDraft = {
      id: carried?.id ?? createRandomId(), passage: annotation ? { ...passage, quote: "" } : passage,
      capture, highlightId, color: carried?.color ?? annotation?.color ?? "yellow", bodyRole: carried?.bodyRole ?? (highlightId ? "question" : "annotation_or_question"), annotationBase: carried?.annotationBase ?? null,
      body: carried?.body ?? emptyBody(), revision: (carried?.revision ?? -1) + 1, selection: carried?.selection ?? null, history: carried?.history ?? emptyDraftHistory(),
      operation: null, issue: highlightId || capture ? null : { kind: "Capture", line: { fact: refused ? "nexus can’t capture some text in this passage." : "couldn’t capture this passage.", reason: "your words are kept." } },
      referenceActive: false, linkInputActive: false, attachmentActive: false,
      sourceMediaId: mediaId, destination: carried?.destination ?? { kind: "Resolving" }, chatIssue: null,
    };
    store.put(entry);
    return entry;
  };
  const open = (passage: ComposerDraft["passage"], highlightId: string | null, focus: boolean, carried: ComposerDraft | null) => {
    const previous = read();
    const replacing = previous && carried === null && !(highlightId ? previous.highlightId === highlightId
      : previous.highlightId === null && samePassage(previous.passage, passage));
    if (replacing && !canAbandon()) return false;
    memory.enter();
    refreshCatalog();
    const prepared = prepare(passage, highlightId, carried);
    setPickerDraftId(null);
    const opened = current.current;
    show({ id: opened?.draftId === prepared.id ? opened.id : createRandomId(), draftId: prepared.id, focus, ownsFocus: focus, serial: ++serial.current });
    return true;
  };

  const highlightDeleted = useCallback((id: string) => {
    const entry = read();
    if (entry?.highlightId === id) store.update(entry.id, value => ({...value, issue: {kind: "Source", line: HIGHLIGHT_DELETED}}));
  }, [read, store]);

  const close = (id: string | null) => {
    if (id !== null) store.remove(id);
    show(null); setPickerDraftId(null); cancelReselection();
  };

  const currentSource = (capture: SelectionCapture) => {
    const shown = reader.getState().document;
    return activeRef.current && isMobile && document.visibilityState !== "hidden" && shown.status === "ready" &&
      !shown.refreshing && shown.doc.identity === capture.identity && reader.measureBounds() !== null;
  };
  const selectionCurrent = (subject: SelectionSubject) => selectionActivation.current === subject &&
    refining.current?.id === subject.id && currentSource(subject.capture);
  const captureRefinement = (): SelectionSubject | null => {
    const session = refining.current;
    if (!session || session.inputHeld) return null;
    const capture = reader.captureSelection();
    if (!capture || capture.kind !== "Captured" || capture.identity !== session.identity || !currentSource(capture)) {
      selectionActivation.current = null;
      showRefinement({...session, candidate: capture});
      return null;
    }
    const subject = {id: session.id, capture};
    selectionActivation.current = subject;
    showRefinement({...session, candidate: capture});
    return subject;
  };
  /** Freeze before focus changes the native range; commands read this same retained value. */
  const prepareInteraction = () => {
    const session = refining.current;
    if (input.boundsActive) return false;
    if (!session) return true;
    if (session.explicit || session.inputHeld) return false;
    const entry = get(session.draftId);
    const fresh = reader.captureSelection();
    const held = selectionActivation.current;
    const capture = fresh?.kind === "Captured" ? fresh
      : fresh === null && held && selectionCurrent(held) ? held.capture : null;
    if (!entry || !capture || capture.identity !== session.identity || !currentSource(capture)) {
      selectionActivation.current = null;
      showRefinement({...session, candidate: fresh});
      return false;
    }
    prepare(capture, null, entry);
    selectionActivation.current = null;
    showRefinement(null);
    return true;
  };
  const observeSelection = (notice: SelectionNotice) => {
    if (!activeRef.current || !isMobile) return;
    const next = notice.selection;
    const session = refining.current;
    if (!session) {
      if (notice.kind !== "Admitted" || !next || next.kind !== "Captured" || !currentSource(next)) return;
      if (!open(next, null, false, null)) return;
      showRefinement({id: createRandomId(), draftId: read()!.id, identity: next.identity, candidate: next, explicit: false, inputHeld: false});
      return;
    }
    const inputHeld = notice.kind === "Observed" ? notice.inputHeld : session.inputHeld;
    const held = selectionActivation.current;
    // A control's own focus may collapse its range after the pre-focus capture.
    if (notice.kind === "Observed" && held && !inputHeld && (next === null || next.kind === "Captured" &&
      samePassage(held.capture, next) && held.capture.quote === next.quote)) return;
    selectionActivation.current = null;
    showRefinement({...session, candidate: next, inputHeld});
  };
  const selectionDocument = reader.getState().document;
  const selectionBlocked = input.boundsActive ? "apply or cancel the selection first." : refinement === null ? null
    : refinement.explicit ? "apply or cancel the selection first."
      : refinement.candidate === null ? "select a passage first."
        : refinement.candidate.kind === "Rejected" ? rejectedSelectionFact(refinement.candidate.reason, selectionDocument.status === "ready" ? selectionDocument.doc : null)
          : refinement.inputHeld ? "finish adjusting the selection." : null;

  /** One local command for the opened draft; the input stays until its commit is durable. */
  const submit = async ({ command, opened, recovery = null }: { command: Command; opened: Opening | null; recovery?: Extract<ComposerDraft["issue"], {kind: "Failed"}> | null }): Promise<{ id: string } | null> => {
    if (recovery === null && !prepareInteraction()) return null;
    const entry = opened && get(opened.draftId);
    // a failed frame is retried, never resubmitted under a new identity.
    if (!opened || !entry || !writing || entry.operation || entry.referenceActive || entry.linkInputActive || entry.attachmentActive ||
      (command.kind === "Save" && entry.bodyRole === "question") || (entry.issue !== null && entry.issue !== recovery)) return null;
    const annotation = entry.highlightId ? annotations.annotation(entry.highlightId) : null;
    // a just-committed highlight joins the local reads a moment after its commit.
    if (entry.highlightId && !annotation) return null;
    const shown = reader.getState().document;
    if (!annotation && (!entry.capture || shown.status !== "ready" || shown.refreshing || shown.doc.identity !== entry.passage.identity)) {
      store.update(entry.id, value => ({ ...value, issue: { kind: "Source", line: SOURCE_CHANGED } }));
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
      const complete = command.kind === "Save" && unchanged;
      const restoreFocus = complete && !isMobile && intent !== null && activeRef.current &&
        current.current?.id === intent.openingId && current.current.draftId === entry.id &&
        attention.current === intent.attention && getInteractionOwner() === intent.layer && getInteractionGeneration() === intent.generation;
      store.update(entry.id, value => ({ ...value, highlightId: id, capture: null, annotationBase: createdBody ?? value.annotationBase,
        ...(command.kind === "Highlight" && value.color === submitted.color ? {color: command.color} : {}),
        operation: value.operation?.id === operationId ? null : value.operation,
        issue: failed !== null && value.issue === failed ? null : value.issue,
        ...(note && unchanged ? { body: emptyBody(), revision: value.revision + 1, selection: null, history: emptyDraftHistory() } : {}) }));
      if (complete) {
        close(entry.id);
        if (restoreFocus) reader.focusSource();
      }
      return { id };
    };
    try {
      if (annotation) {
        if (command.kind === "Highlight") {
          if (annotation.color !== command.color) await recolorHighlight(writing, annotation, command.color);
        } else if (command.kind === "Save") {
          const colour = {kind: "update_highlight" as const, ref: annotation.ref, selection: null, color: submitted.color};
          if (note) {
            if (submitted.annotationBase === null) throw new Error("a materialized selection has no annotation baseline");
            const clone = hydrateNote(submitted.annotationBase);
            const vector = Y.encodeStateVector(clone);
            let delta: Uint8Array;
            try {
              applyDraftBody(clone, readBody(clone), note);
              delta = Y.encodeStateAsUpdate(clone, vector);
              createdBody = encodeBytes(Y.encodeStateAsUpdate(clone));
            } finally {clone.destroy();}
            const document = await writing.openDocument(annotation.ref), origin = Symbol("selection annotation save");
            await writing.admitWriting({existing: [{document, origin}], notes: [], mutate: () => {Y.applyUpdate(document.doc, delta, origin);},
              prepare: async () => annotation.color === submitted.color ? [] : [colour]}).result;
          } else if (annotation.color !== submitted.color) await writing.run(colour);
        }

      } else {
        const receipt = await createHighlight(writing, { id, capture: submitted.capture!,
          color: command.kind === "Highlight" ? command.color : submitted.color, annotation: note, source: sourceLabel(submitted.capture!.sourceRef) });
        const created = receipt.change.resources.find(resource => resource.ref === `highlight:${id}`);
        if (created?.kind !== "highlight" || created.body_update === null) throw new Error("highlight creation receipt has no permanent body");
        createdBody = created.body_update;
      }
      return finish();
    } catch (error) {
      if (ctx.sessionSignal().aborted) return null;
      if (error instanceof CommandTooLargeError) {
        store.update(entry.id, value => value.operation?.id === operationId ? { ...value, operation: null, issue: { kind: "Capacity", line: { fact: "this passage is too long to save." } } } : value);
        return null;
      }
      if (error instanceof LocalCommitError) {
        intent = null;
        failed = { kind: "Failed", phase: "Commit", retry: () => {
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
        failed = {kind: "Failed", phase: "Preparation", attempt: (recovery?.phase === "Preparation" ? recovery.attempt : 0) + 1, retry: () => {
          const value = get(entry.id);
          if (!value || value.issue !== failed || value.operation) return;
          void submit({command, opened, recovery: failed});
        }};
        store.update(entry.id, value => value.operation?.id === operationId ? {...value, operation: null, issue: failed} : value);
        return null;
      }
      // Nothing committed; unexpected failures retain their defect boundary.
      store.update(entry.id, value => value.operation?.id === operationId ? { ...value, operation: null } : value);
      onError(error, "couldn’t save the highlight.");
      return null;
    }
  };

  const restoreEditor = () => {
    flushSync(() => setPickerDraftId(null));
    if (!isMobile && current.current) show({ ...current.current, focus: true, ownsFocus: true, serial: ++serial.current });
  };
  const chooseChat = () => {
    if (!prepareInteraction()) return;
    const entry = current.current && get(current.current.draftId);
    if (!entry || entry.operation || entry.referenceActive || entry.linkInputActive || entry.attachmentActive) return;
    setPickerDraftId(entry.id);
  };
  const transferringChat = useRef(false);
  const sendChat = (target: "New" | "Existing") => {
    if (transferringChat.current || !prepareInteraction()) return;
    const opened = current.current;
    const entry = opened && get(opened.draftId);
    if (!opened || !entry || entry.operation || entry.referenceActive || entry.linkInputActive || entry.attachmentActive || entry.issue || pickerDraftId !== null) return;
    const question = convertReaderQuestion(entry.body);
    if (question.kind === "Unsupported") {
      store.update(entry.id, value => ({...value, chatIssue: {kind: "Failed", line: {fact: "images and embeds can’t be sent from here."}}}));
      return;
    }
    const text = question.kind === "Blank" ? "" : question.content;
    if ([...text].length > 20_000) {
      store.update(entry.id, value => ({...value, chatIssue: {kind: "Failed", line: {fact: "this question is too long.", reason: "the limit is 20,000 characters."}}}));
      return;
    }
    const selected = entry.destination;
    if (target === "Existing" && selected.kind !== "Selected") { chooseChat(); return; }
    const observed = selected.kind === "Selected" && selected.snapshot.kind === "Ready" ? selected.snapshot.tree : null;
    const view = observed ? chatView({messages: new Map(observed.messages.map(message => [message.id,message])), leafId: observed.active_leaf_message_id, history: "Ready"}, observed.conversation.id, null) : null;
    const selection = memory.fresh(catalog) ?? {kind: "Uninitialized" as const};
    const shown = reader.getState().document;
    const anchor = entry.passage.anchor;
    const portable = shown.status === "ready" && shown.doc.identity === entry.passage.identity
      ? sourceTarget(shown.doc, anchor.kind === "text" ? {kind: "range", unit: anchor.unit, start: anchor.start, end: anchor.end} : {kind: "quads", page: anchor.page, quads: anchor.quads}) : null;
    const href = portable && reader.navigation ? reader.navigation.href({source_identity: entry.passage.identity, target: portable}) : null;
    const annotation = entry.highlightId ? annotations.annotation(entry.highlightId) : null;
    const sourceRef = entry.capture?.sourceRef ?? annotation?.sourceRef ?? `media:${mediaId}`;
    const label = sourceLabel(sourceRef);
    const revision = entry.revision;
    transferringChat.current = true;
    try {
      const result = launchReaderChat({ctx, guard, originPaneId: pane.paneId, question: text,
        capture: entry.capture, sourceMediaId: mediaId, captureId: null, highlightId: entry.highlightId,
        selection, catalog,
        destination: target === "Existing" && selected.kind === "Selected" ? {kind: "Existing", conversationId: selected.id,
          write: observed && view && (view.target.kind === "Empty" || view.target.kind === "Reply") ? {expected_revision: observed.conversation.branch_revision,
            insertion: view.target.kind === "Empty" ? {kind: "Empty"} : {kind: "Reply", parent_message_id: view.target.parentId, branch_anchor: view.target.anchor}} : null} : {kind: "New"},
        source: {ref: sourceRef, title: label?.label ?? null, media_kind: null, contributors: null, location_label: null}, href});
      if (result.kind === "Opened" && get(entry.id)?.revision === revision) close(entry.id);
      else if (result.kind === "Refused") store.update(entry.id, value => ({...value, chatIssue: {kind: "Failed", line: result.line}}));
    } finally { transferringChat.current = false; }
  };
  const restoreHistoryFocus = () => {
    if (current.current?.ownsFocus) show({ ...current.current, focus: true, serial: ++serial.current });
  };
  const hidden = retained.value?.id !== draft?.id && retained.value?.issue?.kind === "Failed" && retained.value.issue.phase === "Preparation" ? retained.value : null;
  return {
    protectOwners(owners: readonly string[]) {annotationOwners.current = owners;},
    draft, opening, copyQuote, copyUnavailable, branchCue, prepareInteraction, selectionBlocked,
    hiddenPreparationFailures: hidden && hidden.issue?.kind === "Failed" && hidden.issue.phase === "Preparation"
      ? [{id: hidden.id, issue: hidden.issue, busy: hidden.operation !== null, text: bodyHasContent(hidden.body) ? hidden.body.body_text : null}] : [],
    annotation: draft?.highlightId ? annotations.annotation(draft.highlightId) : null,
    reselection, cancelReselection,
    mobileSelection: refinement?.candidate?.kind === "Captured" ? {id: refinement.id, capture: refinement.candidate} : null,
    selectionVisible: refinement !== null && refinement.candidate?.kind === "Captured" && !refinement.inputHeld,
    observeSelection,
    captureSelection: captureRefinement,
    selectionCurrent,
    ownSelectionFocus(subject: SelectionSubject) {
      const session = refining.current;
      if (!session || session.id !== subject.id || session.inputHeld || session.candidate?.kind !== "Captured" ||
        !samePassage(session.candidate, subject.capture) || session.candidate.quote !== subject.capture.quote || !currentSource(subject.capture)) return false;
      selectionActivation.current = subject;
      return true;
    },
    cancelSelectionActivation() {
      selectionActivation.current = null;
      const session = refining.current;
      if (session) showRefinement({...session, candidate: reader.captureSelection()});
    },
    reselect() {
      const shown = reader.getState().document;
      const entry = read();
      if (!entry || entry.highlightId !== null || entry.operation || shown.status !== "ready" || shown.refreshing) return;
      showRefinement({id: createRandomId(), draftId: entry.id, identity: shown.doc.identity, candidate: null, explicit: true, inputHeld: false});
      selectionActivation.current = null;
      reader.focusSource();
    },
    applyReselection(capture: SelectionCapture) {
      const selected = refining.current, previous = selected && get(selected.draftId);
      const shown = reader.getState().document;
      if (!selected?.explicit || !previous || previous.highlightId !== null || !activeRef.current || shown.status !== "ready" || shown.refreshing ||
        capture.identity !== selected.identity || shown.doc.identity !== selected.identity) return;
      prepare(capture, null, previous);
      cancelReselection();
      if (!isMobile && current.current) show({...current.current, focus: true, serial: ++serial.current});
    },
    boundHighlight(id: string, capture: SelectionCapture) {
      const entry = read();
      if (entry?.highlightId !== id) return;
      const passage: ComposerDraft["passage"] = {identity: capture.identity, quote: "", excerpt: null, excerpt_start: null, excerpt_end: null,
        anchor: capture.anchor.kind === "text" ? capture.anchor : {kind: "pdf", page: capture.anchor.page, quads: capture.anchor.quads}};
      store.update(entry.id, value => ({...value, passage, revision: value.revision + 1}));
    },
    pickerOpen: draft !== null && pickerDraftId === draft.id,
    chooseChat, closePicker: restoreEditor,
    chooseDestination(conversation: Pick<ConversationListItem, "id" | "title">) {
      if (!draft || draft.operation || draft.referenceActive || draft.linkInputActive || draft.attachmentActive) return;
      store.update(draft.id, entry => ({ ...entry, chatIssue: null, destination: { kind: "Selected", id: conversation.id,
        title: conversation.title, snapshot: { kind: "Loading" } } }));
      restoreEditor();
    },
    retryDefault() { if (draft && draft.destination.kind === "LookupFailed") store.update(draft.id, entry => ({ ...entry, destination: { kind: "Resolving" } })); },
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
            await link().catch(error => onError(error, "couldn’t link the passage.", link));
          })
            .catch((error: unknown) => {
              if (!(error instanceof LocalCommitError)) onError(error, "couldn’t link the passage.");
            });
        } };
    },
    activePassage: active && draft && (draft.capture !== null || draft.highlightId !== null) && refinement === null && !input.boundsActive ? draft.passage : null,
    select(capture: SelectionCapture) {
      const selected = refining.current;
      const previous = selected?.identity === capture.identity ? get(selected.draftId) ?? null : null;
      cancelReselection();
      return open(capture, null, !isMobile && capture.input !== "touch", previous);
    },
    activate(mark: Mark, identity: string, focus = true) {
      cancelReselection();
      return open({ identity, anchor: mark.anchor, quote: "", excerpt: null, excerpt_start: null, excerpt_end: null }, mark.id, !isMobile && focus, null);
    },
    highlightDeleted,
    dismiss(reason?: "outside-click" | "escape") {
      if (!canAbandon()) return false;
      const returnFocus = current.current?.ownsFocus;
      const id = read()?.id;
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
    newChat() { sendChat("New"); },
    continueChat() { sendChat("Existing"); },
    setColor(color: HighlightColor) {
      if (!prepareInteraction()) return;
      const entry = read();
      if (!entry || entry.bodyRole !== "annotation_or_question" || entry.operation || entry.color === color) return;
      store.update(entry.id, value => ({...value, color, revision: value.revision + 1}));
    },
    highlight(color: HighlightColor) { void submit({ command: { kind: "Highlight", color }, opened: current.current }); },
    async ensure(): Promise<{ id: string; isCurrent: () => boolean } | null> {
      const opened = current.current;
      const result = await submit({ command: { kind: "Ensure" }, opened });
      return result && opened ? { id: result.id, isCurrent: () => activeRef.current && interaction.current === opened.id } : null;
    },
  };
}

export type SelectionComposer = ReturnType<typeof useSelectionComposer>;
