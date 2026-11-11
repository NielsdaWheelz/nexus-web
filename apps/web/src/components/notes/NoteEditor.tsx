"use client";
import * as Icon from "@/lib/ui/icons";

import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import Button from "@/components/ui/Button";

// One editing engine for a standalone body or a flat outline projection. Rich
// formatting, links, uploads, references and source inspection share its native
// packet/composition owner. Projection rows retain independent field authority;
// structural intent changes selection inside this view without replacing its
// editing host. Hardware keys and native beforeinput share the same grammar.
// The view lives for one surface in one visit. Incoming text waits for its safe
// input boundary; own echoes are diff no-ops outside authored history.
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { WritingDocument } from "@/lib/notes/runtime";
import { InlineBinding, type EditorBinding } from "@/lib/notes/editorBinding";
import * as Y from "yjs";
import { bodyInline } from "@nexus/authored/documents";
import type { TextEditBase } from "@/lib/notes/editorTypes";
import { createPortal } from "react-dom";
import { OutlineEmbeddingOccurrence, useEditorDraft, useNoteEditorHost, useOptionalNoteEditorHost, WorkspaceNoteEditorHost } from "@/lib/notes/editorHost";
import { resourceDraftOwnerId } from "@/lib/resourceGraph/useResourceDraft";
import { useWorkGuard } from "@/lib/unsavedWork";
import ReferencePicker from "@/components/resources/ReferencePicker";
import { getInteractionOwner } from "@/lib/ui/overlay";
import {
  useReferenceInput,
  type ReferenceInputHost,
} from "@/lib/resourceGraph/useReferenceInput";
import ResourceOutlineList, {
  ResourceBranch,
  ResourceOutlineContext,
} from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import NoteBodyPreview from "./NoteBodyPreview";
import {useAuthoredQuery} from "@/lib/notes/hooks";
import {PreparedResourcesContext} from "@/lib/resources/preparedResources";
import {authoredItem} from "@/lib/notes/presentation";
import {hasAuthoredContent} from "@/lib/resourceGraph/resourceRef";
import {embedDisplayLabel, localResourceHref} from "@/lib/resources/localResource";
import ResourceLink from "@/components/resources/ResourceLink";
import {
  enterOutlineOccurrence,
  type OutlineBranch,
} from "@/lib/resources/outlineProjection";
import { resolveResourceItem, type ResourceItem } from "@/lib/resources/items";
import { DOMParser as PMDOMParser, Fragment, Slice, type Node as PMNode, type ParseOptions, type ParseRule, type Schema } from "prosemirror-model";
import {
  AllSelection,
  NodeSelection,
  EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
  type Command,
} from "prosemirror-state";
import { EditorView, type DecorationSet, type DirectEditorProps } from "prosemirror-view";
import {
  history as ownHistory,
  redo as ownRedo,
  undo as ownUndo,
} from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { isApiError, isSameSystemApiDefect, outcomeUnknown } from "@/lib/api/client";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import AuthoredReadFailure from "./AuthoredReadFailure";
import { Failed, Field } from "@/components/feedback/Fact";
import type { CommandVerb, Line } from "@/components/feedback/stage";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { readAcquisitionGuard } from "@/lib/libraries/api";
import { createUploadAttempt, getFileUploadError, reviewUploadAttempt, uploadIngestFile, type UploadAttempt } from "@/lib/imports/ingest";
import { UploadSessionError } from "@/lib/imports/api";
import { captureErrorLine } from "@/lib/imports/copy";
import {
  bodyFromNode,
  bodyText,
  docFromBody,
  hrefFromInput,
  parseBody,
  noteBodySchema as canonicalSchema,
  sameBody,
  type NoteBody,
} from "@nexus/authored/body";
import type { FocusSelection, NoteEdit } from "@/lib/notes/editorTypes";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { outlineFoldCommand, outlineHistoryCommand, outlineStructuralCommand, usesMeta } from "@/lib/shortcuts";
import { inspectionDecorations } from "@/lib/notes/inspection";
import { fieldAt, fieldById, inlinePaste, outlineEditedField, outlineTransactionSource } from "@/lib/notes/outlineEditorModel";
import { clipboardPlainText } from "@/lib/notes/clipboard";
import { ACROSS_FIELDS } from "@/lib/notes/outlineSelection";
import "prosemirror-view/style/prosemirror.css";
import {cx} from "@/lib/ui/cx";
import styles from "./NoteEditor.module.css";

export interface NoteInspection {
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly activationId: string;
  readonly signal: AbortSignal;
  readonly mayFocus: () => boolean;
  readonly restored: boolean;
}

/** Editor-owned structural intents run after native reconciliation and before
 * the consumed event releases its packet. External refresh stays fenced. */
export interface StructuralKeys {
  taskPrefix?(body_state: string): void;
  /** The shown neighbours may trail an unsettled arrangement. Boundary deletion must refuse rather than replay later. */
  arranging?(): boolean;
  enter?(): void;
  split?(left: NoteBody, right: NoteBody, displayed: import("@/lib/notes/editorTypes").DisplayedSplit | null): void;
  emptyDelete?(direction: "backward" | "forward"): void;
  emptyEnter?(): void;
  join?(direction: "backward" | "forward"): void;
  indent?(): void;
  outdent?(): void;
  move?(direction: "up" | "down"): void;
  selectBlock?(): void;
  collapse?(open: boolean): void;
  extendBlock?(direction: "up" | "down"): void;
}

/** The outline can preserve an occurrence's caret without reaching into its view. */
export interface TextEditorHandle {
  readText(): string;
  encodedBytes(): number;
  readSelection(): { anchor: number; head: number };
  /** Snapshot reconciled editor state; never change native selection during focus. */
  captureSelection(): (document: WritingDocument) => FocusSelection;
  focus(selection: FocusSelection | ((document: WritingDocument) => FocusSelection), preventScroll?: boolean): void;
  canArrange(): boolean;
  settleNativeInput(): boolean;
  localHistory(command: "undo" | "redo"): {enabled: boolean; execute(): void} | null;
}
export interface NoteEditorHandle extends TextEditorHandle {
  setInputMode(mode: "text" | "blocks" | "controls"): void;
  refuse(message: string): void;
}

/** prosemirror-view 1.41.8 exposes no public DOM reconciliation operation.
 * Its own keyboard path uses this observer. Handoff must consume native text
 * before changing selection or destroying a view; parsing a second DOM model
 * would bypass its node-view and composition rules. Requalify on library bumps. */
function flushNativeDOM(view: EditorView): void {
  // justify-type-assertion: the locked view has this exact observer contract;
  // its public API cannot flush native edits before an asynchronous handoff.
  const observer = (view as EditorView & {domObserver: {forceFlush(): void; flush(): void}}).domObserver;
  observer.forceFlush();
  observer.flush();
}

/** Native code and the captured IME Return keep literal whitespace until the
 * input engine consumes the delimiter. Clipboard parsing retains the schema's
 * existing prose and HTML import policy. */
class NativeNoteParser extends PMDOMParser {
  constructor(schema: Schema, rules: readonly ParseRule[], private readonly literalComposition: () => boolean) {super(schema, rules);}
  override parse(dom: Node, options: ParseOptions = {}): PMNode {
    return super.parse(dom, options.topNode?.attrs.presentation === "code" || this.literalComposition()
      ? {...options, preserveWhitespace: "full"} : options);
  }
}
/** A projection supplies fields and their authority, never another input engine.
 * The same view, native packet fence, rich UI and reference grammar serve both. */
export interface NoteEditorProjection {
  schema: Schema;
  doc(): PMNode;
  binding: EditorBinding;
  nodeViews?: DirectEditorProps["nodeViews"];
  plugins?: readonly Plugin[];
  onViewReady(view: EditorView | null): void;
  allowTransaction(transaction: Transaction): boolean;
  onFocus(): void;
  reference(row_id: string): ReferenceInputHost | null;
  context(row_id: string): {branch: OutlineBranch; occurrenceKey: string; containingNoteRef: string | null; beforeCollapse?(scope: string): Promise<boolean>};
  itemText(row_id: string): boolean;
  keys(row_id: string): StructuralKeys | null;
  onEdit(row_id: string, edit: NoteEdit): void;
  onSelectionChange(row_id: string, selection: NoteEdit["selectionAfter"]): void;
}

export interface NoteEditorProps {
  projection?: NoteEditorProjection;
  embedding?: {row_id: string; context: ReturnType<NoteEditorProjection["context"]>};
  header?: true;
  reference?: ReferenceInputHost | null;
  writingDocument?: WritingDocument;
  writingOrigin?: unknown;
  editorKey: string;
  occurrenceKey?: string;
  /** A failed commit holds this editor's words: its caret turns `--danger`, never the sole signal. */
  wordsAtRisk?: boolean;
  "aria-describedby"?: string;
  /** The acknowledged note identity; drafts supply null. */
  containingNoteRef: string | null;
  body: NoteBody;
  editBase?: TextEditBase | null;
  revision: number;
  editable: boolean;
  label: string;
  placeholder?: string;
  inspection?: NoteInspection | null;
  /** Terminal bodies keep rich content, but embeds cannot reopen the outline. */
  atomicEmbeds?: boolean;
  focus?: {
    selection: FocusSelection;
    serial: number;
    preventScroll?: boolean;
  } | null;
  history: { undo(): void; redo(): void; boundary(): void } | null;
  keys?: StructuralKeys | null;
  onEdit(edit: NoteEdit): void;
  onSelectionChange?(selection: NoteEdit["selectionAfter"]): void;
  onEditorReady?(editor: NoteEditorHandle | null): void;
  onAttachmentActiveChange?(active: boolean): void;
  onLinkInputActiveChange?(active: boolean): void;
  onSave?(): void;
  onNewChat?(): void;
  onContinueChat?(): void;
}

// [mark, label, key]; the title spells the key as "⌘/Ctrl+B".
const FORMATS = [
  ["strong", "Bold", "Mod-b", Icon.Bold],
  ["em", "Italic", "Mod-i", Icon.Italic],
  ["underline", "Underline", "Mod-u", Icon.Underline],
  ["strikethrough", "Strikethrough", "Shift-Mod-s", Icon.Strikethrough],
  ["code", "Inline code", "Mod-e", Icon.Code],
] as const;
type Format = (typeof FORMATS)[number][0];
const shortcut = (key: string) =>
  `⌘/Ctrl+${key.startsWith("Shift") ? "Shift+" : ""}${key.at(-1)!.toUpperCase()}`;
const SOURCE = "noteEditSource";
interface InspectionState { target: NoteInspection; decorations: DecorationSet }
const inspectionKey = new PluginKey<InspectionState | null>("noteInspection");

interface LinkDialog {
  row_id: string | null;
  from: number;
  to: number;
  text: string;
  query: string;
  baseline: string;
  /** each refusal is a new line, so a repeated one speaks again */
  error: Line | null;
  left: number;
  top: number;
}
interface CompositionInput {
  row_id: string | null;
  body: NoteBody;
  selection: {anchor: number; head: number};
  reference: boolean;
  returning: {packet: number; active: boolean} | null;
  editBase: TextEditBase | null;
}

/** The explicit upload risk an enclosing composer consults before abandonment. */
export const noteEditorAttachmentOwnerId = (visitId: string, editorKey: string) =>
  resourceDraftOwnerId(visitId, `Notes.Attachment:${editorKey}`);

const NOT_INSERTED: Line = { fact: "couldn’t insert this.", reason: "your writing is kept." };
const LINK_OPEN: Line = { fact: "couldn’t do that while a link is open.", reason: "your writing is kept." };
const NOT_ATTACHED = "couldn’t attach this file.";
const NOT_ADDED = "couldn’t add this attachment.";
const UNKNOWN: Line = { fact: "not sure that saved.", reason: UNKNOWN_OUTCOME_REASON };

export default function NoteEditor(props: NoteEditorProps) {
  const supplied = useOptionalNoteEditorHost();
  return supplied ? <NoteEditorContent {...props} /> : <WorkspaceNoteEditorHost><NoteEditorContent {...props} /></WorkspaceNoteEditorHost>;
}
function NoteEditorContent(props: NoteEditorProps) {
  const describedBy = props["aria-describedby"];
  const resendFeedback = useResendFeedback();
  const editorHost = useNoteEditorHost();
  const schema = props.projection?.schema ?? canonicalSchema;
  const bindingRef = useRef<EditorBinding | null>(null);
  const inheritedBranch = useContext(ResourceBranch);
  const outline = useContext(ResourceOutlineContext);
  const occurrenceKey = props.occurrenceKey ?? props.editorKey;
  const visitId = editorHost.identity;
  // The empty root occurrence changes resource when zooming. Child occurrences
  // keep their view when a provisional note binds to its retained canonical note.
  const bodyViewKey = props.occurrenceKey || props.editorKey;
  const branch =
    props.containingNoteRef !== null &&
    !inheritedBranch.ancestors.has(props.containingNoteRef)
      ? enterOutlineOccurrence({
          branch: inheritedBranch,
          ref: props.containingNoteRef,
          target: outline
            ? { kind: "occurrence", key: occurrenceKey }
            : { kind: "root" },
          edgeIds: [],
        })
      : inheritedBranch;
  const host = useRef<HTMLDivElement | null>(null);
  const shell = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editorHandle = useRef<NoteEditorHandle | null>(null);
  const consumedFocus = useRef<number | null>(null);
  const { platform } = useRenderEnvironment();
  const latest = useRef({ ...props, platform });
  latest.current = { ...props, platform, editable: props.editable };
  const busy = useRef(false);
  const nativeInputOpen = useRef(false);
  const guard = useWorkGuard();
  const retainedInput = editorHost.retained_input;
  const linkDraft = useEditorDraft<LinkDialog | null>(`Notes.LinkInput:${props.editorKey}`, () => null,
    value => ({ changed: value !== null && value.query !== value.baseline, unconfirmed: false, stopsBrowserWork: false }));
  const attachment = useEditorDraft<{
    row_id: string | null;
    controller: AbortController; base: NoteBody; selection: NoteEdit["selectionBefore"];
    body: NoteBody | null; pending: boolean; file: File; upload: UploadAttempt; unconfirmed: Line | null; attempt: number;
  } | null>(`Notes.Attachment:${props.editorKey}`, () => null,
    value => ({ changed: value !== null, unconfirmed: value !== null && value.body === null, stopsBrowserWork: value?.pending === true }));
  busy.current = attachment.value?.pending === true;
  const [linkVisible, setLinkVisible] = useState(false);
  const link = linkDraft.value;
  const { set: setLinkDraft, read: readLink } = linkDraft;
  const setLink = useCallback((value: LinkDialog | null) => {
    latest.current.onLinkInputActiveChange?.(value !== null);
    setLinkDraft(value);
  }, [setLinkDraft]);
  useLayoutEffect(() => { latest.current.onLinkInputActiveChange?.(link !== null); }, [link]);
  useLayoutEffect(() => {
    const report = latest.current.onLinkInputActiveChange;
    return () => { if (!retainedInput) report?.(false); };
  }, [retainedInput, readLink]);
  const { read: readAttachment, set: setAttachment, owner: attachmentOwner, value: attachmentValue } = attachment;
  const attachmentActive = attachmentValue !== null;
  useLayoutEffect(() => { latest.current.onAttachmentActiveChange?.(attachmentActive); }, [attachmentActive]);
  useLayoutEffect(() => () => {
    if (!retainedInput) {
      readAttachment()?.controller.abort();
      setAttachment(null);
      latest.current.onAttachmentActiveChange?.(false);
    }
  }, [retainedInput, readAttachment, setAttachment]);
  const discardAttachment = () => { if (guard.confirmLoss({ scopes: [], ownerIds: [attachmentOwner] })) setAttachment(null); };
  const discardVerb: CommandVerb = { label: "discard", commandKey: "DiscardAttachment", run: discardAttachment };
  const linkInputId = useId();
  const linkErrorId = useId();
  const linkInput = useRef<HTMLInputElement | null>(null);
  const [embeds, setEmbeds] = useState<ReadonlyMap<HTMLElement, {ref: string; field: "annotation" | null; label: string | null; row_id: string | null; key: string}>>(() => new Map());
  const embedSerial = useRef(0);
  const [toolbar, setToolbar] = useState(false);
  const inputMode = useRef<"text" | "blocks" | "controls">("text");
  const [active, setActive] = useState<ReadonlySet<Format>>(new Set());
  const [presentation, setPresentation] = useState<"title" | "reference" | "prose" | "code">("prose");
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const { say, fail } = useOutcome();
  const [referenceFocused, setReferenceFocused] = useState(false);
  const [referenceVisible, setReferenceVisible] = useState(true);
  const referenceHost = activeRowId !== null && props.projection ? props.projection.reference(activeRowId) : props.reference ?? null;
  const reference = useReferenceInput(props.editorKey, referenceHost, referenceFocused && referenceVisible, {
    row_id: activeRowId,
    prepareAccept() {
      const view = viewRef.current;
      if (!view || view.composing) return false;
      flushNativeDOM(view);
      const query = referenceRef.current.getState();
      const field = query?.row_id ? editingRow(view.state.doc, query.row_id) : editingField(view.state);
      if (!query || !field) return false;
      referenceRef.current.edit(clipboardPlainText(field.node.content));
      return true;
    },
    accepted(row_id, base) {
      const view = viewRef.current;
      if (!view) return;
      if (compositionBase.current?.row_id === row_id) compositionBase.current = null;
      restoreReference(view, row_id, base);
    },
  });
  latest.current = { ...props, platform, editable: props.editable };
  const referenceRef = useRef(reference);
  referenceRef.current = reference;
  const activeReference = (state: EditorState) => {
    const intent = referenceRef.current.getState();
    return intent?.row_id === editingField(state)?.row_id ? intent : null;
  };
  const toolbarNode = useRef<HTMLDivElement | null>(null);
  /** The formatting toolbar sits under the selection's end, as the link dialog does, or above the selection when
   * under would leave the nearest scrollport; it shifts left to stay inside the shell. A header's toolbar stays in flow. */
  const placeToolbar = useCallback(() => {
    const node = toolbarNode.current, view = viewRef.current, box = shell.current?.getBoundingClientRect();
    if (!node || !view || !box || latest.current.header || view.state.selection.empty) return;
    let port = shell.current!.parentElement;
    while (port && !/auto|scroll/.test(getComputedStyle(port).overflowY)) port = port.parentElement;
    const bounds = port?.getBoundingClientRect() ?? {top: 0, bottom: innerHeight};
    const start = view.coordsAtPos(view.state.selection.from), end = view.coordsAtPos(view.state.selection.to), height = node.offsetHeight;
    const above = end.bottom + 6 + height > bounds.bottom && start.top - 6 - height >= bounds.top;
    const left = Math.max(0, end.left - box.left);
    node.style.left = `${left}px`;
    node.style.top = `${above ? start.top - box.top - 6 - height : Math.max(0, end.bottom - box.top + 6)}px`;
    node.style.translate = `clamp(${-left}px, ${box.width - left}px - 100%, 0px)`;
  }, []);
  /** A shown toolbar is placed when it mounts and again whenever the shell reflows. */
  const toolbarRef = useCallback((node: HTMLDivElement | null) => {
    toolbarNode.current = node;
    if (!node || !shell.current) return;
    placeToolbar();
    const observer = new ResizeObserver(placeToolbar);
    observer.observe(shell.current);
    return () => {observer.disconnect(); toolbarNode.current = null;};
  }, [placeToolbar]);
  const referenceFor = (field: EditingField) => field.row_id !== null
    ? latest.current.projection?.reference(field.row_id) ?? null : latest.current.reference ?? null;
  function restoreReference(view: EditorView, row_id: string | null, base: NoteBody) {
    // A replacement may have changed or retired the edge while preparing. Use
    // its current projection, never put the frozen old token back into the view.
    const projection = latest.current.projection?.doc() ?? null;
    const projected = row_id !== null && projection ? fieldById(projection, row_id) : null;
    const binding = bindingRef.current;
    const body = projected?.kind === "reference" ? fieldBody(projected)
      : binding?.document(row_id ?? undefined) ? binding.body(row_id ?? undefined) : base;
    view.updateState(EditorState.create({doc: view.state.doc, selection: view.state.selection, plugins: view.state.plugins}));
    if (projection && row_id !== null && projected === null)
      view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, projection.content)
        .setMeta(SOURCE, "external").setMeta(outlineTransactionSource, "projection").setMeta("addToHistory", false));
    else replaceDoc(view, docFromBody(body), row_id ?? undefined);
    binding?.refresh();
  }
  const cancelReference = (view: EditorView) => {
    const intent = referenceRef.current.getState();
    if (!intent || intent.context.replacement === null) return false;
    referenceRef.current.close();
    restoreReference(view, intent.row_id, intent.base);
    return true;
  };
  const beginTokenQuery = (view: EditorView, field: EditingField, text: string): boolean => {
    if (field.kind !== "reference" || !field.node.attrs.token_active || field.row_id === null) return false;
    const host = referenceFor(field), token = latest.current.projection && fieldById(latest.current.projection.doc(), field.row_id);
    if (!host || host.replacement === null || !token || token.kind !== "reference") return false;
    const raw = text.startsWith("@") ? text : `@${text}`;
    latest.current.history?.boundary();
    view.updateState(EditorState.create({doc: view.state.doc, selection: view.state.selection, plugins: view.state.plugins}));
    referenceRef.current.begin(fieldBody(token), field.row_id, host);
    referenceRef.current.edit(raw);
    replaceDoc(view, docFromBody(bodyText(raw)), field.row_id);
    const query = editingRow(view.state.doc, field.row_id);
    if (query) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, query.to)));
    setReferenceVisible(true);
    return true;
  };
  const suspended = useRef(false);
  const literalSuppressed = useRef<{row_id: string | null} | null>(null);
  const compositionBase = useRef<CompositionInput | null>(null);
  const notifySelection = (state: EditorState) => {
    const query = referenceRef.current.getState();
    if (query?.context.replacement && query.row_id !== editingField(state)?.row_id && viewRef.current) {
      cancelReference(viewRef.current);
      state = viewRef.current.state;
    }
    const field = editingField(state);
    if (!field) return;
    const at = fieldSelection(state, field);
    setActiveRowId(field.row_id);
    if (field.row_id !== null) latest.current.projection?.onSelectionChange(field.row_id, at);
    latest.current.onSelectionChange?.(at);
  };
  const structuralKeys = (state: EditorState) => {
    const selected = state.selection instanceof NodeSelection ? state.selection.node.attrs.row_id : null;
    const row_id = typeof selected === "string" ? selected : editingField(state)?.row_id;
    return row_id !== null && row_id !== undefined
      ? latest.current.projection?.keys(row_id) ?? null : latest.current.keys;
  };
  const literal = (view: EditorView) => {
    const intent = referenceRef.current.getState();
    if (!intent) return false;
    const field = intent.row_id === null ? editingField(view.state) : editingRow(view.state.doc, intent.row_id);
    if (!field) return false;
    const selection = editingField(view.state)?.row_id === field.row_id ? fieldSelection(view.state, field) : {anchor: 1, head: 1};
    const after = fieldBody(field);
    // Query undo was local. Conversion enters prose history as one edit.
    if (!reportEdit({
      before: intent.base,
      after,
      selectionBefore: { anchor: 1, head: 1 },
      selectionAfter: selection,
      source: "input",
      editBase: {
        value: intent.base,
        acknowledged: intent.editBase?.acknowledged ?? null,
      },
    }, field.row_id)) return false;
    if (referenceRef.current.getState() === intent) {
      referenceRef.current.close();
      literalSuppressed.current = {row_id: field.row_id};
      view.updateState(EditorState.create({doc: view.state.doc, selection: view.state.selection, plugins: view.state.plugins}));
    }
    return true;
  };
  const handleUnauthenticated = useUnauthenticatedApiHandler();
  const warn = useCallback((line: Line) => { say(line); }, [say]);

  const reportEdit = useCallback((edit: NoteEdit, row_id?: string | null): boolean => {
    try {
      const view = viewRef.current;
      const field = view && editingField(view.state);
      const target = row_id === undefined ? field?.row_id : row_id;
      bindingRef.current?.handoff(edit.before, edit.after, target ?? undefined);
      if (target !== null && target !== undefined) latest.current.projection?.onEdit(target, edit);
      else latest.current.onEdit(edit);
      queueMicrotask(() => bindingRef.current?.refresh());
      return true;
    } catch { warn(NOT_INSERTED); return false; }
  }, [warn]);
  const presentBody = (view: EditorView, field: EditingField, value: "prose" | "code") => {
    latest.current.history?.boundary();
    const at = fieldSelection(view.state, field);
    const after = bodyFromNode(field.node.type.create({presentation: value}, field.node.content));
    reportEdit({before: fieldBody(field), after, selectionBefore: at, selectionAfter: at, source: "format"});
    latest.current.history?.boundary();
  };
  const refreshMarks = useCallback((state: EditorState) => {
    const field = editingField(state);
    setPresentation(field?.kind === "title" ? "title" : field?.kind === "reference" ? "reference" : field?.node.attrs.presentation === "code" ? "code" : "prose");
    const stored = state.storedMarks ?? state.selection.$from.marks();
    const { from, to, empty } = state.selection;
    const on = FORMATS.filter(([name]) => {
      const type = schema.marks[name]!;
      return empty
        ? type.isInSet(stored)
        : state.doc.rangeHasMark(from, to, type);
    });
    setActive(new Set(on.map(([name]) => name)));
  }, [schema.marks]);

  const format = useCallback((name: Format): boolean => {
    const view = viewRef.current;
    if (
      !view ||
      !latest.current.editable || inputMode.current !== "text" ||
      view.composing || compositionBase.current !== null
    )
      return false;
    flushNativeDOM(view);
    syncNativeSelection(view);
    if (activeReference(view.state) !== null) return false;
    const { from, to, empty, $from } = view.state.selection;
    const field = editingField(view.state);
    if (!field) return false;
    if (from < field.from || to > field.to) {
      warn(ACROSS_FIELDS);
      return true;
    }
    if (field.kind !== "body" || $from.parent.attrs.presentation === "code") return false;
    latest.current.history?.boundary();
    const type = schema.marks[name]!;
    const tr = view.state.tr.setMeta(SOURCE, "format");
    if (empty) {
      if (type.isInSet(view.state.storedMarks ?? $from.marks()))
        tr.removeStoredMark(type);
      else tr.addStoredMark(type.create());
    } else if (view.state.doc.rangeHasMark(from, to, type))
      tr.removeMark(from, to, type);
    else tr.addMark(from, to, type.create());
    view.dispatch(tr);
    view.focus();
    return true;
  }, [schema.marks, warn]);

  const openLink = useCallback((): boolean => {
    const view = viewRef.current;
    const box = shell.current?.getBoundingClientRect();
    if (
      !view ||
      !box ||
      !latest.current.editable || inputMode.current !== "text" ||
      view.composing || compositionBase.current !== null
    )
      return false;
    flushNativeDOM(view);
    syncNativeSelection(view);
    if (activeReference(view.state) !== null) return false;
    if (editingField(view.state)?.kind !== "body") return false;
    if (!(view.state.selection instanceof TextSelection)) return false;
    const field = editingField(view.state);
    if (!field) return false;
    const selected = view.state.selection;
    if (selected.from < field.from || selected.to > field.to) {
      warn(ACROSS_FIELDS);
      return true;
    }
    const from = selected.from - field.from, to = selected.to - field.from;
    const caret = view.coordsAtPos(selected.to);
    const text = field.node.textBetween(from, to, " ", " ");
    const existing = view.state.doc.nodeAt(selected.from)?.marks.find(mark => mark.type === schema.marks.link)
      ?? view.state.selection.$from.marks().find(mark => mark.type === schema.marks.link);
    const baseline = existing ? String(existing.attrs.href) : "";
    latest.current.history?.boundary();
    setLinkVisible(true);
    const retained = readLink();
    if (retained) {
      setLink({ ...retained, row_id: field.row_id, from, to, text, left: Math.max(0, caret.left - box.left), top: Math.max(0, caret.bottom - box.top + 6) });
      return true;
    }
    setLink({
      row_id: field.row_id,
      from,
      to,
      text,
      query: baseline || hrefFromInput(text) || "",
      baseline,
      error: null,
      left: Math.max(0, caret.left - box.left),
      top: Math.max(0, caret.bottom - box.top + 6),
    });
    return true;
  }, [readLink, setLink, schema.marks.link, warn]);

  const insertLink = () => {
    const view = viewRef.current;
    if (
      !view ||
      !link ||
      !latest.current.editable ||
      busy.current ||
      view.composing
    )
      return;
    const href = hrefFromInput(link.query);
    if (!href)
      return setLink({
        ...link,
        error: { fact: "enter a web address, email address or local path." },
      });
    const field = link.row_id === null ? editingField(view.state) : editingRow(view.state.doc, link.row_id);
    if (
      !field || field.kind !== "body" || link.to > field.node.content.size ||
      field.node.textBetween(link.from, link.to, " ", " ") !== link.text
    ) {
      return setLink({ ...link, error: { fact: "the selected text changed. select it again; your address is kept." } });
    }
    const mark = schema.marks.link!.create({ href });
    const tr = view.state.tr.setMeta(SOURCE, "format");
    const from = field.from + link.from, to = field.from + link.to;
    if (link.from === link.to) {
      tr.insertText(href, from).addMark(
        from,
        from + href.length,
        mark,
      );
      tr.setSelection(TextSelection.create(tr.doc, from + href.length));
      tr.removeStoredMark(schema.marks.link!);
    } else {
      tr.addMark(from, to, mark);
      tr.setSelection(TextSelection.create(tr.doc, from, to));
    }
    setLink(null);
    view.dispatch(tr.scrollIntoView());
    view.focus();
  };

  const attach = useCallback(
    async (view: EditorView, files: File[]) => {
      const refuse = (line: Line) => { say(line); };
      if (!latest.current.editable || activeReference(view.state) !== null)
        return;
      if (view.composing || compositionBase.current !== null) return refuse({ fact: NOT_ATTACHED, reason: "finish typing first." });
      const field = editingField(view.state);
      if (!field || field.kind !== "body") return;
      if (!replaceable(view)) return refuse({ fact: "couldn’t attach this file here.", reason: "select the note body or empty it first." });
      if (editorHost.uploads === null) return refuse({ fact: NOT_ATTACHED, reason: "uploads aren’t available in this reader." });
      if (!navigator.onLine) return refuse({ fact: NOT_ATTACHED, reason: "you’re offline." });
      if (files.length > 1) return refuse({ fact: `couldn’t attach ${files.length} files.`, reason: "attach one at a time." });
      const problem = getFileUploadError(files[0]!);
      if (problem) return refuse({ fact: NOT_ATTACHED, reason: problem });
      const prior = readAttachment();
      if (prior?.pending) return;
      if (prior && prior.file !== files[0] && !guard.confirmLoss({ scopes: [], ownerIds: [attachmentOwner] })) return;
      const retained = prior?.file === files[0] ? prior : null;
      const controller = new AbortController();
      const uploadHost = editorHost.uploads;
      const signal = uploadHost.signal();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      const unsubscribe = uploadHost.subscribe(() => { if (!uploadHost.is_owned()) controller.abort(); });
      const task = { row_id: retained?.row_id ?? field.row_id, controller, base: retained?.base ?? fieldBody(field), selection: retained?.selection ?? fieldSelection(view.state, field), body: null, pending: true, file: files[0]!, upload: retained?.upload ?? createUploadAttempt(), unconfirmed: retained?.unconfirmed ?? null, attempt: retained?.attempt ?? 0 };
      // Each failure that holds is a new attempt, so the hold speaks when a retry fails, not when it is pressed.
      const hold = (unconfirmed: Line) => setAttachment({ ...task, pending: false, unconfirmed, attempt: task.attempt + 1 });
      setAttachment(task);
      // Disabling the view can blur it before the layout effect reports.
      latest.current.onAttachmentActiveChange?.(true);
      busy.current = true;
      view.setProps({ editable: () => false });
      try {
        let prepared = task.upload.guard;
        if (prepared === null) {
          try { prepared = await readAcquisitionGuard([], controller.signal); }
          catch (error) {
            if (controller.signal.aborted || signal.aborted) return;
            setAttachment(null);
            if (!handleUnauthenticated(error)) fail(error, NOT_ADDED);
            return;
          }
        }
        const upload = await uploadIngestFile({ file: task.file, attempt: task.upload, guard: prepared, signal: controller.signal });
        if (controller.signal.aborted || signal.aborted || readAttachment()?.controller !== controller) return;
        if (!upload.available) {
          setAttachment(null);
          say({ fact: "this item was saved, then removed." });
          return;
        }
        const embed = schema.nodes.body!.create(null, schema.nodes.resource_embed!.create({ resource_ref: `media:${upload.mediaId}`, field: null, label: files[0]!.name }));
        setAttachment({ ...task, pending: false, body: bodyFromNode(embed) });
      } catch (error) {
        if (controller.signal.aborted || signal.aborted) return;
        // A later refusal cannot settle an earlier confirmation. Only acceptance or an exact
        // publication fence retires it; retry keeps the same bytes and confirmation.
        // A malformed intent and same-system transport defects retain their failure boundary.
        if (outcomeUnknown(error)) hold(UNKNOWN);
        else if (task.upload.review_required) hold({ fact: NOT_ADDED });
        else if (task.upload.expired) { setAttachment(null); say({ fact: NOT_ADDED, reason: "the upload expired." }); }
        else if (error instanceof UploadSessionError && error.outcome.kind !== "IntentMalformed") {
          const line = { fact: NOT_ADDED, reason: captureErrorLine(error).reason };
          if (task.upload.confirmation_unsettled || error.outcome.kind === "Unresolved") hold(UNKNOWN);
          else if (error.outcome.kind === "BytesMissing") hold(line);
          else { setAttachment(null); say(line); }
        }
        else if (task.upload.confirmation_unsettled && isApiError(error) && !isSameSystemApiDefect(error)) hold(UNKNOWN);
        else { setAttachment(null); if (!handleUnauthenticated(error)) fail(error, NOT_ADDED); }
      } finally {
        unsubscribe();
        signal.removeEventListener("abort", abort);
        busy.current = false;
        if (!view.isDestroyed) view.setProps({ editable: () => latest.current.editable && inputMode.current === "text" });
      }
    },
    [handleUnauthenticated, readAttachment, setAttachment, attachmentOwner, guard, editorHost, schema.nodes.body, schema.nodes.resource_embed, say, fail],
  );

  // An uploaded attachment inserts itself where it can. Only a body it declined holds the
  // `insert` instruction, so an insertion that succeeds never flashes or speaks one.
  const [declined, setDeclined] = useState<NoteBody | null>(null);
  useEffect(() => {
    const task = attachmentValue;
    if (!task?.body) return;
    const view = viewRef.current, field = view && editingField(view.state);
    if (!props.editable || view?.composing || compositionBase.current !== null || !field || field.row_id !== task.row_id || !sameBody(fieldBody(field), task.base)) {
      setDeclined(task.body);
      return;
    }
    reportEdit({ before: fieldBody(field), after: task.body, selectionBefore: task.selection, selectionAfter: { anchor: 1, head: 1 }, source: "attachment" }, task.row_id);
    setAttachment(null);
  }, [attachmentValue, setAttachment, props, reportEdit]);

  useLayoutEffect(() => {
    latest.current = { ...latest.current, editable: props.editable };
    viewRef.current?.setProps({
      editable: () => latest.current.editable && !busy.current && inputMode.current === "text",
    });
    if (!props.editable) setLinkVisible(false);
  }, [props.editable, describedBy, reference.state?.raw, reference.selected, referenceFocused, referenceVisible]);

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    consumedFocus.current = null;
    literalSuppressed.current = null;
    compositionBase.current = null;
    suspended.current = false;
    setReferenceFocused(false);
    setReferenceVisible(true);
    const run =
      (action: () => boolean | void) =>
      (_: EditorState, __?: unknown, view?: EditorView) =>
        latest.current.editable &&
        !busy.current &&
        !view?.composing &&
        action() !== false;
    const enter = (
      state: EditorState,
      dispatch?: (tr: Transaction) => void,
    ) => {
      if (!latest.current.editable || busy.current) return false;
      const field = editingField(state);
      if (field?.kind === "reference") return true;
      if (field?.kind === "title") {
        if (referenceRef.current.getState() !== null) warn(LINK_OPEN);
        else structuralKeys(state)?.enter?.();
        return true;
      }
      const code = state.selection.$from.parent.attrs.presentation === "code";
      const tr = code
        ? state.tr.insertText("\n")
        : state.tr.replaceSelectionWith(schema.nodes.hard_break!.create());
      dispatch?.(tr.scrollIntoView());
      return true;
    };
    const undoCommand: Command = (_state, _dispatch, current) => current ? historyInput(current, false) : false;
    const redoCommand: Command = (_state, _dispatch, current) => current ? historyInput(current, true) : false;
    const binding = latest.current.projection?.binding ?? (latest.current.writingDocument ? new InlineBinding(latest.current.writingDocument, latest.current.writingOrigin) : null);
    bindingRef.current = binding;
    const taskPrefix = (current: EditorView, before: NoteBody, row_id: string | null) => {
      const prior = canonicalSchema.nodeFromJSON(before.body_pm_json);
      if (current.composing || compositionBase.current !== null || referenceRef.current.getState() !== null || prior.textBetween(0,Math.min(4,prior.content.size),"","\uFFFC") === "[ ] ") return;
      const field = row_id === null ? editingField(current.state) : editingRow(current.state.doc,row_id);
      if (!field || field.kind !== "body" || field.node.attrs.presentation === "code" || field.node.firstChild?.marks.some(mark => mark.type.name === "code") || field.node.textBetween(0,Math.min(4,field.node.content.size),"","\uFFFC") !== "[ ] ") return;
      const body_state = binding?.bodyState(row_id ?? undefined);
      const keys = row_id === null ? latest.current.keys : latest.current.projection?.keys(row_id);
      if (body_state) keys?.taskPrefix?.(body_state);
    };
    nativeInputOpen.current = false;
    let nativePacket = 0;
    let shiftedReturn = false;
    let deletionKey: string | null = null;
    let keylessDeletion: {row_id: string; backward: boolean} | null = null;
    let reconciling = false;
    const reconcile = (current: EditorView) => {
      if (reconciling || current.isDestroyed || current.composing || compositionBase.current !== null) return;
      reconciling = true;
      try { flushNativeDOM(current); } finally { reconciling = false; }
    };
    const commandSelection = (current: EditorView, preserveAtom = false) => {
      if (current.composing) return;
      if (compositionBase.current) finishComposition(current, compositionBase.current, null);
      reconcile(current);
      const selection = current.state.selection;
      if (preserveAtom && selection instanceof NodeSelection && selection.node.isInline && selection.node.isAtom) {
        const native = current.dom.ownerDocument.getSelection();
        const element = native?.anchorNode instanceof Element ? native.anchorNode : native?.anchorNode?.parentElement;
        const row = element?.closest<HTMLElement>("[data-outline-field]")?.dataset.outlineField;
        if (!row || row === editingField(current.state)?.row_id) return;
      }
      syncNativeSelection(current);
    };
    const historyInput = (current: EditorView, redo: boolean): boolean => {
      if (!latest.current.editable || busy.current || current.composing) return true;
      commandSelection(current);
      if (activeReference(current.state) !== null)
        return (redo ? ownRedo : ownUndo)(current.state, current.dispatch, current);
      if (referenceRef.current.getState() !== null) {
        warn(LINK_OPEN);
        return true;
      }
      if (latest.current.history) {
        releaseNativeInput(current);
        if (redo) latest.current.history.redo(); else latest.current.history.undo();
        return true;
      }
      return (redo ? ownRedo : ownUndo)(current.state, current.dispatch, current);
    };
    const releaseNativeInput = (current: EditorView) => {
      if (current.isDestroyed) return;
      // Keep the fence through reconciliation: transaction callbacks may ask
      // for selection, but must not dispatch against unparsed native text.
      reconcile(current);
      if (current.isDestroyed) return;
      nativeInputOpen.current = false;
      notifySelection(current.state);
      binding?.refresh();
    };
    const beginNativeInput = (current: EditorView, event: Event) => {
      const packet = ++nativePacket;
      nativeInputOpen.current = true;
      // A consumed event has no browser edit to await. Otherwise input/keyup
      // ends the native packet, including default actions after keydown.
      queueMicrotask(() => { if (event.defaultPrevented && packet === nativePacket) releaseNativeInput(current); });
    };
    const structuralInput = (current: EditorView, inputType: string): boolean => {
      if (!latest.current.editable || busy.current || current.composing) return false;
      commandSelection(current, inputType === "deleteContentBackward" || inputType === "deleteContentForward");
      if (current.isDestroyed) return false;
      const referenceField = editingField(current.state);
      if (referenceField?.kind === "reference" && activeReference(current.state) === null) {
        const host = referenceFor(referenceField);
        if (!referenceField.node.attrs.token_active || !host || host.replacement === null) return true;
        const selection = current.state.selection, keys = structuralKeys(current.state);
        if (inputType === "insertParagraph") {keys?.enter?.(); return true;}
        if (inputType === "insertLineBreak") return true;
        if (inputType === "deleteContentBackward" || inputType === "deleteContentForward") {
          const backward = inputType === "deleteContentBackward";
          if (!selection.empty || (backward ? selection.from > referenceField.from : selection.to < referenceField.to))
            keys?.emptyDelete?.(backward ? "backward" : "forward");
          return true;
        }
      }
      const selected = current.state.selection;
      if ((inputType === "deleteContentBackward" || inputType === "deleteContentForward") &&
        selected instanceof NodeSelection && selected.node.isInline && selected.node.isAtom) {
        current.dispatch(current.state.tr.deleteSelection().scrollIntoView());
        return true;
      }
      if (activeReference(current.state) !== null) {
        if (inputType === "insertParagraph") {referenceRef.current.acceptSelected(); return true;}
        return false;
      }
      const { selection } = current.state;
      const field = editingField(current.state);
      if (!field) return false;
      if (selection.from < field.from || selection.to > field.to) {
        warn(ACROSS_FIELDS);
        return true;
      }
      if ((inputType === "deleteContentBackward" || inputType === "deleteContentForward") && !selection.empty) {
        current.dispatch(current.state.tr.deleteSelection().scrollIntoView());
        return true;
      }
      const body = field.node;
      const keys = structuralKeys(current.state);
      if (inputType === "insertLineBreak" && field.kind !== "title") return enter(current.state, current.dispatch);
      const returning = inputType === "insertParagraph" || inputType === "insertLineBreak" && field.kind === "title";
      const deletingBoundary = (inputType === "deleteContentBackward" && selection.empty && selection.from === field.from ||
        inputType === "deleteContentForward" && selection.empty && selection.to === field.to) && (keys?.join || keys?.emptyDelete);
      if (deletingBoundary && keys?.arranging?.()) {
        warn({fact: "finish moving the items before deleting across them.", reason: "your writing is kept."});
        return true;
      }
      if (referenceRef.current.getState() !== null && (deletingBoundary || returning &&
        (field.kind === "title" && keys?.enter || body.attrs.presentation !== "code" && keys?.split))) {
        warn(LINK_OPEN);
        return true;
      }
      if (returning) {
        if (latest.current.onSave) { latest.current.history?.boundary(); latest.current.onSave(); return true; }
        if (field.kind === "title") { if (keys?.enter) keys.enter(); else enter(current.state, current.dispatch); return true; }
        if (body.attrs.presentation === "code" || !keys?.split) return enter(current.state, current.dispatch);
        if (body.content.size === 0 && keys.emptyEnter) { keys.emptyEnter(); return true; }
        const state = selection.empty ? current.state : current.state.apply(current.state.tr.deleteSelection());
        const content = editingField(state)!.node;
        const offset = state.selection.$from.parentOffset;
        keys.split(bodyFromNode(content.copy(content.content.cut(0, offset))),
          bodyFromNode(content.copy(content.content.cut(offset))),
          binding?.bodyState() ? {body_state: binding.bodyState()!, from: selection.from - field.from, to: selection.to - field.from} : null);
        return true;
      }
      const backward = inputType === "deleteContentBackward";
      if ((!backward && inputType !== "deleteContentForward") || !selection.empty) return false;
      if (body.content.size === 0) {
        if (keys?.emptyDelete) { keys.emptyDelete(backward ? "backward" : "forward"); return true; }
        if (body.attrs.presentation === "code") { presentBody(current, field, "prose"); return true; }
      }
      if (body.attrs.presentation === "code" || !keys?.join) return false;
      if ((backward && selection.$from.parentOffset === 0) ||
        (!backward && selection.$from.parentOffset === body.content.size)) {
        keys.join(backward ? "backward" : "forward");
        return true;
      }
      return false;
    };
    const finishComposition = (current: EditorView, original: CompositionInput, packet: number | null) => {
      if (current.isDestroyed || compositionBase.current !== original) return;
      flushNativeDOM(current);
      if (current.isDestroyed || compositionBase.current !== original) return;
      let transferred = false;
      let returning = false;
      try {
        if (!latest.current.editable) { transferred = true; return; }
        let field = original.row_id === null ? editingField(current.state) : editingRow(current.state.doc, original.row_id);
        if (!field) throw new Error("a composing outline field was withdrawn");
        const selection = current.state.selection;
        if (original.returning?.active && original.returning.packet === nativePacket && current.hasFocus() && !suspended.current && selection.empty && editingField(current.state)?.row_id === original.row_id &&
          selection.from >= field.from + Math.min(original.selection.anchor, original.selection.head) && selection.from <= field.to) {
          const marker = current.state.doc.slice(selection.from - 1, selection.from).content.firstChild;
          // This packet preserved the literal delimiter while parsing. A space
          // in the composed writing can never stand in for its final newline.
          if (marker?.type === schema.nodes.hard_break || marker?.isText && marker.text === "\n") {
            current.dispatch(current.state.tr.delete(selection.from - 1, selection.from)
              .setMeta(SOURCE, "external").setMeta(outlineTransactionSource, "projection").setMeta("addToHistory", false));
            field = original.row_id === null ? editingField(current.state) : editingRow(current.state.doc, original.row_id);
            if (!field) throw new Error("a committed composition field was withdrawn");
            returning = true;
          }
        }
        const block = field.node, committed = fieldBody(field);
        const query = referenceRef.current.getState();
        if (field.kind === "reference" && query === null) {
          if (block.textContent) transferred = beginTokenQuery(current, field, block.textContent);
          else {restoreReference(current, field.row_id, original.body); transferred = true;}
          return;
        }
        if (query !== null && query.row_id === original.row_id) {
          const raw = clipboardPlainText(block.content);
          referenceRef.current.edit(raw);
          if (raw.startsWith("@") || query.context.replacement !== null) {
            if (referenceRef.current.getState()?.raw !== (query.context.replacement !== null && !raw.startsWith("@") ? `@${raw}` : raw)) throw new Error("the reference query could not be retained");
            transferred = true;
          } else transferred = literal(current);
          return;
        }
        if (original.reference && query === null && block.type === schema.nodes.body && block.textContent === "@" && block.childCount === 1 && block.firstChild?.isText) {
          referenceRef.current.begin(original.body, original.row_id, referenceFor(field));
          if (referenceRef.current.getState()?.row_id !== original.row_id) throw new Error("the reference query could not be started");
          replaceDoc(current, docFromBody(original.body), original.row_id ?? undefined);
          current.updateState(EditorState.create({doc: current.state.doc, selection: current.state.selection, plugins: current.state.plugins}));
          current.dispatch(current.state.tr.insertText("@", field.from));
          transferred = true;
        } else if (!sameBody(original.body, committed)) transferred = reportEdit({
          before: original.body, after: committed, source: "composition",
          ...(original.editBase ? {editBase: original.editBase} : {}),
          selectionBefore: original.selection,
          selectionAfter: original.row_id === editingField(current.state)?.row_id ? fieldSelection(current.state, field) : original.selection,
        }, original.row_id);
        else { if (!binding) replaceDoc(current, docFromBody(latest.current.body)); transferred = true; }
      } catch { warn(NOT_INSERTED); }
      finally {
        if (transferred && !current.isDestroyed && compositionBase.current === original) {
          compositionBase.current = null;
          if (packet !== null && packet === nativePacket) nativeInputOpen.current = false;
          if (suspended.current) cancelReference(current);
          if (!returning) taskPrefix(current,original.body,original.row_id);
          if (returning && original.returning?.active && original.returning.packet === nativePacket && current.hasFocus() && !suspended.current) structuralInput(current, "insertParagraph");
          notifySelection(current.state);
          binding?.refresh();
        }
      }
    };
    const restoredReference = referenceRef.current.getState();
    const view = new EditorView(element, {
      domParser: new NativeNoteParser(schema, PMDOMParser.fromSchema(schema).rules,
        () => compositionBase.current !== null && compositionBase.current.returning !== null),
      state: EditorState.create({
        doc: latest.current.projection?.doc() ?? docFromBody(
          restoredReference
            ? {
                body_pm_json: {
                  type: "body",
                  content: [{ type: "text", text: restoredReference.raw }],
                },
                body_text: restoredReference.raw,
              }
            : bindingRef.current?.body() ?? latest.current.body,
        ),
        plugins: [
          ...(latest.current.projection?.plugins ?? []),
          inspectionPlugin(() => shell.current?.focus({ preventScroll: true })),
          ownHistory(),
          keymap({
            Enter: enter,
            "Shift-Enter": enter,
            ...Object.fromEntries(
              FORMATS.map(([name, , key]) => [key, run(() => format(name))]),
            ),
            "Mod-Shift-k": run(openLink),
            "Mod-a": (state, dispatch) => {
              const field = editingField(state);
              const selection = field ? TextSelection.create(state.doc, field.from, field.to) : new AllSelection(state.doc);
              dispatch?.(state.tr.setSelection(selection));
              return true;
            },
            "Mod-z": undoCommand,
            "Shift-Mod-z": redoCommand,
            "Mod-y": redoCommand,
          }),
        ],
      }),
      attributes: (state) => {
        const field = editingField(state);
        const nativeEntry = state.selection instanceof TextSelection && field?.row_id !== null && field?.row_id !== undefined &&
          state.selection.from >= field.from && state.selection.to <= field.to && !latest.current.projection?.itemText(field.row_id);
        return {
          class: cx(styles.view, latest.current.projection && styles.outline),
          role: activeReference(state) !== null ? "combobox" : "textbox",
          "aria-readonly": String(
            !latest.current.editable || busy.current || inputMode.current !== "text",
          ),
          ...(activeReference(state) !== null
            ? {
                "aria-expanded": String(referenceRef.current.bindings.inputProps["aria-expanded"] ?? false),
                "aria-controls": referenceRef.current.bindings.inputProps["aria-controls"] ?? "",
                tabindex: "0",
                "aria-autocomplete": "list",
                "aria-activedescendant": referenceRef.current.bindings.inputProps["aria-activedescendant"] ?? "",
              }
            : latest.current.projection && latest.current.editable && !busy.current
              ? {tabindex: inputMode.current !== "text" || nativeEntry ? "0" : "-1"}
              : {}),
          "aria-label": field?.kind === "reference" && field.node.attrs.token_active ? `edit reference to ${referenceFor(field)?.label ?? ""}` : latest.current.label,
          "aria-describedby": latest.current["aria-describedby"] ?? "",
          "aria-multiline": "true",
          "data-placeholder": latest.current.placeholder ?? "",
          "data-empty": String(
            !latest.current.projection && editingField(state)?.node.content.size === 0,
          ),
        };
      },
      nodeViews: {
        resource_embed(node, current, getPos) {
          const position = getPos();
          const field = current.state.doc.type.name === "outline_doc" && position !== undefined ? fieldAt(current.state.doc, position) : editingField(current.state);
          if (field?.kind === "reference") {
            const dom = document.createElement("span");
            dom.contentEditable = "false";
            dom.className = cx("note-object-embed", styles.referenceToken);
            dom.setAttribute("role", "img");
            // The atom has one native extent. A readonly label text node lets
            // Android move its composing caret inside and retire the keyboard.
            dom.setAttribute("aria-label", `@${embedDisplayLabel(node.attrs.resource_ref, null, node.attrs.label)}`);
            return {dom, stopEvent: () => true, ignoreMutation: () => true};
          }
          const standalone = field?.node.childCount === 1;
          const dom = document.createElement(standalone ? "div" : "span");
          dom.contentEditable = "false";
          dom.className = "note-object-embed";
          const ref = node.attrs.resource_ref;
          if (node.attrs.field === "annotation" || standalone && editorHost.embedded_preview === "workspace") {
            const embeddedField: "annotation" | null = node.attrs.field === "annotation" ? "annotation" : null;
            const entry = {ref, field: embeddedField, label: typeof node.attrs.label === "string" ? node.attrs.label : null, row_id: field?.row_id ?? null, key: `embed:${++embedSerial.current}`};
            setEmbeds(value => new Map(value).set(dom, entry));
          }
          else dom.textContent = embedDisplayLabel(ref, node.attrs.field, node.attrs.label);
          return {
            dom,
            stopEvent: () => true,
            ignoreMutation: () => true,
            destroy: () => setEmbeds(value => {const next = new Map(value); next.delete(dom); return next;}),
          };
        },
        ...latest.current.projection?.nodeViews,
      },
      editable: () =>
        latest.current.editable && !busy.current && inputMode.current === "text",
      clipboardTextSerializer: slice => clipboardPlainText(slice.content),
      transformPasted: (slice, current) => latest.current.projection || current.state.selection.$from.parent.attrs.presentation === "code"
        ? slice : (oneBlock(slice, schema) ?? slice),
      handleTextInput(current, _from, _to, text) {
        const field = editingField(current.state), body = field?.node;
        if (field?.kind === "reference" && !current.composing && referenceRef.current.getState() === null)
          return beginTokenQuery(current, field, text);
        if (
          text !== "@" ||
          current.composing ||
          literalSuppressed.current?.row_id === field?.row_id ||
          !field || !referenceFor(field) ||
          referenceRef.current.getState() !== null ||
          field?.kind !== "body" ||
          body?.type !== schema.nodes.body ||
          body.content.size !== 0
        )
          return false;
        latest.current.history?.boundary();
        current.updateState(EditorState.create({doc:current.state.doc,selection:current.state.selection,plugins:current.state.plugins}));
        referenceRef.current.begin(bodyFromNode(body), field.row_id, referenceFor(field));
        setReferenceVisible(true);
        return false;
      },
      handlePaste(current, _event, slice) {
        let pasted = slice;
        if (latest.current.projection) {
          try { pasted = inlinePaste(slice, editingField(current.state)?.kind ?? "body"); }
          catch {
            warn({ fact: "couldn’t paste that here." });
            return true;
          }
        }
        const lone =
          pasted.content.childCount === 1 &&
          pasted.content.firstChild?.type === schema.nodes.resource_embed;
        if (lone && !replaceable(current)) {
          warn({ fact: "couldn’t paste this here.", reason: "select the note body or empty it first." });
          return true;
        }
        if (latest.current.projection) {
          current.dispatch(current.state.tr.replaceSelection(pasted).setMeta("uiEvent", "paste").scrollIntoView());
          return true;
        }
        if (oneBlock(slice, schema)) return false;
        warn({ fact: "couldn’t paste these here.", reason: "paste one embedded item at a time." });
        return true;
      },
      handleDOMEvents: {
        pointerdown(current, event) {
          const field = event.target instanceof Element ? event.target.closest("[data-outline-field]") : null;
          if (field?.closest(".ProseMirror") === current.dom) {deletionKey = null; keylessDeletion = null;}
          return false;
        },
        keydown(current, event) {
          if (
            event.target instanceof HTMLElement &&
            event.target !== current.dom &&
            event.target.closest("input, textarea, select, button")
          )
            return true;
          if (["Shift", "Control", "Meta", "Alt", "AltGraph"].includes(event.key)) return false;
          shiftedReturn = event.key === "Enter" && event.shiftKey;
          if ((event.key === "Backspace" || event.key === "Delete") && !current.composing && !event.isComposing && event.keyCode !== 229) deletionKey = event.key;
          else if (!event.isComposing && event.keyCode !== 229 && event.key !== "Unidentified") {deletionKey = null; keylessDeletion = null;}
          beginNativeInput(current, event);
          // Returning true leaves the browser event alone while stopping PM's
          // keymap/capture fallback from turning composition into a newline.
          if (current.composing || event.isComposing || event.keyCode === 229)
            return true;
          commandSelection(current, event.key === "Backspace" || event.key === "Delete");
          const intent = activeReference(current.state);
          if (intent && referenceRef.current.bindings.handleKey(event, current.composing)) {
            event.preventDefault();
            event.stopPropagation();
            return true;
          }
          if (
            intent &&
            (event.key === "Tab" ||
              event.key === "Backspace" ||
              event.key === "Delete")
          ) {
            // Native text editing proceeds; structural key handlers do not.
            if (event.key === "Tab") {
              event.stopPropagation();
              return true;
            }
          }
          const queryHistory = intent && outlineHistoryCommand(event, latest.current.platform);
          if (queryHistory) {
            event.preventDefault();
            historyInput(current, queryHistory === "redo");
            return true;
          }
          // Without an outline command, Escape belongs to the containing overlay.
          if (event.key === "Escape" && !structuralKeys(current.state)?.selectBlock) return true;
          if (!latest.current.editable || busy.current) return true;
          return false;
        },
        keyup(current, event) {
          if (event.key === "Enter") shiftedReturn = false;
          if (event.key === deletionKey) {deletionKey = null; keylessDeletion = null;}
          releaseNativeInput(current); return false;
        },
        input(current, event) {
          if (event.target === current.dom) releaseNativeInput(current);
          return false;
        },
        // the browser's own undo (a menu, or Cmd-Z while no editor has focus) goes to ours.
        beforeinput(current, event) {
          beginNativeInput(current, event);
          const composition = compositionBase.current;
          if (composition && event.inputType === "insertCompositionText") {
            const field = editingField(current.state), keys = structuralKeys(current.state);
            composition.returning = !shiftedReturn && !latest.current.onSave && event.data?.endsWith("\n") === true &&
              !!field && !!(keys?.split || keys?.enter) && (field.kind !== "body" || field.node.attrs.presentation !== "code") ? {packet: nativePacket, active: true} : null;
          }
          if (!current.composing && !event.isComposing)
            commandSelection(current, event.inputType === "deleteContentBackward" || event.inputType === "deleteContentForward");
          const deleting = event.inputType.startsWith("delete") && /(?:Backward|Forward)$/u.test(event.inputType);
          if (!deleting) keylessDeletion = null;
          if (deleting && deletionKey === null && event.cancelable && !event.isComposing && !current.composing) {
            const field = editingField(current.state), keys = structuralKeys(current.state), selection = current.state.selection;
            if (field && field.row_id !== null && (keys?.join || keys?.emptyDelete)) {
              const backward = event.inputType.endsWith("Backward");
              // Keyless keyboards expose no release or repeat identity. Keep the stream in its first field until explicit input re-arms it.
              if (keylessDeletion?.backward === backward && (keylessDeletion.row_id !== field.row_id ||
                selection.empty && (backward ? selection.from === field.from : selection.to === field.to))) {
                event.preventDefault(); return true;
              }
              keylessDeletion = {row_id: field.row_id, backward};
            }
          }
          const redo = event.inputType === "historyRedo";
          if (!redo && event.inputType !== "historyUndo") {
            if (!event.cancelable || event.isComposing) return false;
            if (!structuralInput(current, event.inputType)) return false;
            event.preventDefault();
            return true;
          }
          if (!event.cancelable) return false;
          event.preventDefault();
          return historyInput(current, redo);
        },
        focus(current) {
          suspended.current = false;
          latest.current.projection?.onFocus();
          notifySelection(current.state);
          setReferenceFocused(true);
          setReferenceVisible(true);
          refreshMarks(current.state);
          setToolbar(!current.state.selection.empty);
          placeToolbar();
          return false;
        },
        blur(current) {
          deletionKey = null;
          releaseNativeInput(current);
          if (current.isDestroyed) return false;
          if (!current.composing && compositionBase.current === null) syncNativeSelection(current);
          latest.current.history?.boundary();
          return false;
        },
        compositionstart(current) {
          const previous = compositionBase.current;
          if (previous) finishComposition(current, previous, null);
          syncNativeSelection(current);
          const field = editingField(current.state), block = field?.node;
          if (block && field && compositionBase.current === null)
            compositionBase.current = {
              row_id: field.row_id,
              body: fieldBody(field),
              editBase: latest.current.editBase ?? null,
              reference: Boolean(referenceFor(field)) && literalSuppressed.current?.row_id !== field.row_id &&
                referenceRef.current.getState() === null && block.type === schema.nodes.body && block.content.size === 0,
              returning: null,
              selection: fieldSelection(current.state, field),
            };
          latest.current.history?.boundary();
          notifySelection(current.state);
          return false;
        },
        compositionend(current, event) {
          latest.current.history?.boundary();
          const packet = nativePacket;
          const original = compositionBase.current;
          if (original && !event.data.endsWith("\n")) original.returning = null;
          window.setTimeout(() => {
            if (!current.isDestroyed && !current.composing && original) finishComposition(current, original, packet);
          }, 0);
          return false;
        },
        drop(current, event) {
          const files = [...(event.dataTransfer?.files ?? [])];
          if (!files.length) return false;
          event.preventDefault();
          const position = current.posAtCoords({left: event.clientX, top: event.clientY});
          const field = position && (current.state.doc.type.name === "outline_doc" ? fieldAt(current.state.doc, position.pos) : editingField(current.state));
          if (!position || !field) return true;
          const at = Math.max(field.from, Math.min(position.pos, field.to));
          const selected = current.state.selection;
          if (editingField(current.state)?.row_id !== field.row_id || selected.from !== field.from || selected.to !== field.to)
            current.dispatch(current.state.tr.setSelection(TextSelection.create(current.state.doc, at)));
          void attach(current, files);
          return true;
        },
        paste(current, event) {
          if (!current.composing) commandSelection(current, true);
          const field = editingField(current.state);
          if (field?.kind === "reference") {
            event.preventDefault();
            if (current.composing || compositionBase.current !== null) return true;
            const text = event.clipboardData?.getData("text/plain") ?? "";
            if (!text) return true;
            if (referenceRef.current.getState() === null) beginTokenQuery(current, field, text);
            else current.dispatch(current.state.tr.insertText(text).setMeta("uiEvent", "paste"));
            return true;
          }
          if (editingField(current.state)?.kind === "title" && event.clipboardData?.types.includes("text/plain")) {
            event.preventDefault();
            latest.current.history?.boundary();
            const text = event.clipboardData.getData("text/plain");
            if (text) current.dispatch(current.state.tr.insertText(text));
            return true;
          }
          const files = [...(event.clipboardData?.files ?? [])];
          if (!files.length) {
            latest.current.history?.boundary();
            return false;
          }
          event.preventDefault();
          void attach(current, files);
          return true;
        },
        copy(current) {if (!current.composing) commandSelection(current, true); return false;},
        cut(current) {if (!current.composing) commandSelection(current, true); return false;},
      },
      handleKeyDown(current, event) {
        if (current.composing || event.isComposing || event.keyCode === 229)
          return false;
        if (
          event.target instanceof HTMLElement &&
          event.target !== current.dom &&
          event.target.closest(
            "input, textarea, select, button, [contenteditable='false']",
          )
        )
          return false;
        commandSelection(current, event.key === "Backspace" || event.key === "Delete");
        if (
          !latest.current.editable ||
          busy.current ||
          activeReference(current.state) !== null
        )
          return false;
        const act = (action: () => void) => {
          event.preventDefault();
          action();
          return true;
        };
        const arrangeAt = (action: () => void) => {
          if (referenceRef.current.getState() !== null)
            return act(() => warn(LINK_OPEN));
          const selection = current.state.selection;
          if (selection instanceof NodeSelection && typeof selection.node.attrs.row_id === "string") return act(action);
          const field = editingField(current.state);
          if (!field) return false;
          if (selection instanceof TextSelection && (selection.from < field.from || selection.to > field.to))
            return act(() => warn(ACROSS_FIELDS));
          return act(action);
        };
        if (event.key === "Enter" && !event.altKey) {
          const mac = usesMeta(latest.current.platform);
          const modifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
          const command = modifier
            ? event.shiftKey ? latest.current.onContinueChat : latest.current.onNewChat
            : !event.metaKey && !event.ctrlKey && !event.shiftKey ? latest.current.onSave : null;
          if (command) {
            event.preventDefault();
            if (!event.repeat) {
              latest.current.history?.boundary();
              command();
            }
            return true;
          }
        }
        const keys = structuralKeys(current.state);
        const structural = outlineStructuralCommand(event, latest.current.platform);
        if (structural && keys?.selectBlock) {
          if (event.repeat) return act(() => {});
          return arrangeAt(() => {
            if (structural === "indent") keys.indent?.();
            else if (structural === "outdent") keys.outdent?.();
            else keys.move?.(structural === "move_up" ? "up" : "down");
          });
        }
        const fold = outlineFoldCommand(event, latest.current.platform);
        if (fold && keys?.collapse) {
          if (event.repeat) return act(() => {});
          return arrangeAt(() => keys.collapse!(fold === "expand"));
        }
        const primary = usesMeta(latest.current.platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
        if (primary && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a" && keys?.selectBlock) {
          // The keymap's Mod-a selects the field's text first; a wholly selected or empty field steps to the item.
          const field = editingField(current.state), {from, to} = current.state.selection;
          if (field && (field.node.content.size === 0 || from === field.from && to === field.to)) return act(keys.selectBlock);
          return false;
        }
        if (event.altKey || event.ctrlKey || event.metaKey) return false;
        if (event.key === "Escape")
          return keys?.selectBlock ? act(keys.selectBlock) : false;
        if (event.key === "Tab") {
          const arrange = event.shiftKey ? keys?.outdent : keys?.indent;
          if (!arrange) return false;
          return arrangeAt(arrange);
        }
        if (event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && keys?.extendBlock) {
          const direction = event.key === "ArrowUp" ? "up" : "down";
          if (current.endOfTextblock(direction)) return arrangeAt(() => keys.extendBlock!(direction));
        }
        if (event.key === "Enter" && event.repeat) {
          event.preventDefault();
          return true;
        }
        if (event.shiftKey) return false;
        const inputType = event.key === "Enter" ? "insertParagraph"
          : event.key === "Backspace" ? "deleteContentBackward"
          : event.key === "Delete" ? "deleteContentForward" : null;
        if (inputType === null) return false;
        if (event.repeat && inputType !== "insertParagraph") {
          // A held deletion repeats inside the field and never crosses its boundary.
          const field = editingField(current.state), selection = current.state.selection;
          if (field && selection.empty && (inputType === "deleteContentBackward" ? selection.from === field.from : selection.to === field.to)) return act(() => {});
        }
        if (!structuralInput(current, inputType)) return false;
        event.preventDefault();
        return true;
      },
      dispatchTransaction(tr) {
        const projectionSource = tr.getMeta(outlineTransactionSource);
        const external = tr.getMeta(SOURCE) === "external" || projectionSource === "projection" || projectionSource === "semantic";
        if (!external && latest.current.projection?.allowTransaction(tr) === false) {view.updateState(view.state); return;}
        if (inputMode.current !== "text" && !external && (tr.docChanged || tr.selectionSet && !(tr.selection instanceof NodeSelection && typeof tr.selection.node.attrs.row_id === "string"))) return;
        const first = tr.steps[0]?.toJSON();
        const changed = first && typeof first.from === "number" && view.state.doc.type.name === "outline_doc" ? fieldAt(view.state.doc, first.from) : editingField(view.state);
        const query = referenceRef.current.getState();
        const editingQuery = query !== null && changed?.row_id === query.row_id;
        const composition = compositionBase.current;
        const composingField = composition !== null && changed?.row_id === composition.row_id;
        const referenceField = changed?.kind === "reference";
        if (referenceField && tr.docChanged && !external) {
          const host = referenceFor(changed);
          if (!changed.node.attrs.token_active || !host || host.replacement === null) {view.updateState(view.state); return;}
          if (tr.steps.some((step, index) => {
            const edit = step.toJSON(), field = typeof edit.from === "number" ? fieldAt(tr.docs[index]!, edit.from) : null;
            return edit.stepType !== "replace" || !field || field.row_id !== changed.row_id || edit.from < field.from || edit.to > field.to;
          })) {view.updateState(view.state); warn(ACROSS_FIELDS); return;}
        }
        if (binding && tr.docChanged && !external && !referenceField && !editingQuery && !(composingField && (composition.reference || composition.returning !== null))) {
          try { binding.apply(tr); }
          catch { warn({ fact: "couldn’t apply that edit.", reason: "your writing is kept." }); return; }
        }
        if(binding && !editingQuery)tr.setMeta("addToHistory",false);
        const before = view.state;
        const after = before.apply(tr);
        view.updateState(after);
        if (tr.docChanged && !external) {
          const meta = tr.getMeta(SOURCE) as NoteEdit["source"] | undefined;
          const source =
            meta ??
            (tr.getMeta("uiEvent") === "paste"
              ? "paste"
              : view.composing
                ? "composition"
                : "input");
          const intent = editingQuery ? referenceRef.current.getState() : null;
          if (referenceField && intent === null && !composingField) {
            const field = changed.row_id === null ? editingField(after) : editingRow(after.doc, changed.row_id);
            if (field?.node.textContent) beginTokenQuery(view, changed, field.node.textContent);
            else if (field?.node.content.size === 0) {
              // Noncancelable native deletion has already changed the DOM.
              // Restore the token before admitting its structural conversion.
              view.updateState(before);
              structuralKeys(before)?.emptyDelete?.("backward");
            }
          } else if (intent !== null && !composingField) {
            const field = intent.row_id === null ? editingField(after) : fieldById(after.doc, intent.row_id);
            if (!field) throw new Error("a reference input field was withdrawn");
            const raw = clipboardPlainText(field.node.content);
            referenceRef.current.edit(raw);
            if (!raw.startsWith("@") && intent.context.replacement === null)
              literal(view);
          } else if (!composingField && !referenceField) {
            const editedRow = tr.getMeta(outlineEditedField);
            const row_id = typeof editedRow === "string" ? editedRow : null;
            const edited = row_id ? fieldById(before.doc, row_id) : changed;
            const next = edited?.row_id ? editingRow(after.doc, edited.row_id) : editingField(after);
            if (edited && next) {
            reportEdit({
              before: fieldBody(edited),
              after: fieldBody(next),
              selectionBefore: selectionForEdit(before, edited, first?.from, first?.to),
              selectionAfter: selectionForEdit(after, next, first ? tr.mapping.map(first.from) : undefined, first ? tr.mapping.map(first.to) : undefined),
              source,
            }, edited.row_id);
            if (source === "input") taskPrefix(view,fieldBody(edited),edited.row_id);
            }
          }
          if (editingField(after)?.node.content.size === 0 && literalSuppressed.current?.row_id === editingField(after)?.row_id)
            literalSuppressed.current = null;
        } else if (!before.selection.eq(after.selection))
          latest.current.history?.boundary();
        if ((!compositionBase.current || editingField(view.state)?.row_id !== compositionBase.current.row_id) && (!before.selection.eq(view.state.selection) || editingField(before)?.row_id !== editingField(view.state)?.row_id))
          notifySelection(view.state);
        refreshMarks(view.state);
        if (view.hasFocus()) {setToolbar(!view.state.selection.empty); placeToolbar();}
        if (binding && !external) queueMicrotask(() => binding.refresh());
      },
    });
    viewRef.current = view;
    const revokeReturn = () => {const returning = compositionBase.current?.returning; if (returning) returning.active = false;};
    const releaseDeletionKey = () => {deletionKey = null; revokeReturn();};
    window.addEventListener("blur", releaseDeletionKey);
    document.addEventListener("pointerdown", revokeReturn, true);
    binding?.attach(view, () => nativeInputOpen.current || compositionBase.current !== null || referenceRef.current.getState() !== null);
    const handle: NoteEditorHandle = {
      encodedBytes: () => binding?.baseline ? Y.encodeStateAsUpdate(binding.baseline).byteLength : 0,
      readText() {
        flushNativeDOM(view);
        const field = editingField(view.state);
        return field ? clipboardPlainText(field.node.content) : "";
      },
      readSelection() {
        latest.current.projection?.onFocus();
        if (!nativeInputOpen.current && !view.composing && compositionBase.current === null) syncNativeSelection(view);
        const field = editingField(view.state);
        const selection = field ? fieldSelection(view.state, field) : {anchor: 1, head: 1};
        notifySelection(view.state);
        return selection;
      },
      captureSelection() {
        const field = editingField(view.state);
        const selection = field ? fieldSelection(view.state, field) : {anchor: 1, head: 1};
        if (!binding?.baseline) return () => selection;
        const inline = editingField(view.state)?.kind === "title" ? binding.baseline.getText("title") : bodyInline(binding.baseline);
        const relative = (position: number) => Y.createRelativePositionFromTypeIndex(inline,
          Math.max(0, Math.min(inline.length, position - 1)));
        const anchor = relative(selection.anchor), head = relative(selection.head);
        return document => {
          const a = Y.createAbsolutePositionFromRelativePosition(anchor, document.doc);
          const b = Y.createAbsolutePositionFromRelativePosition(head, document.doc);
          return {anchor: a ? a.index + 1 : selection.anchor, head: b ? b.index + 1 : selection.head};
        };
      },
      focus(selection, preventScroll = false) {
        if (!view.editable || view.composing) return;
        if (typeof selection === "function") {
          const document = binding?.document() ?? latest.current.writingDocument;
          if (!document) return;
          selection = selection(document);
        }
        const field = editingField(view.state);
        if (!field) return;
        const end = field.to - field.from + 1;
        const anchor = selection === "end" ? end : Math.max(1, Math.min(selection.anchor, end));
        const head = selection === "end" ? end : Math.max(1, Math.min(selection.head, end));
        const at = TextSelection.create(view.state.doc, field.from + anchor - 1, field.from + head - 1);
        const transaction = view.state.tr.setSelection(at);
        view.dispatch(preventScroll ? transaction : transaction.scrollIntoView());
        view.focus();
      },
      setInputMode(mode) {
        inputMode.current = mode;
        view.setProps({editable: () => latest.current.editable && !busy.current && inputMode.current === "text"});
        if (mode !== "text") {setToolbar(false); setLinkVisible(false);}
      },
      refuse(message) {warn({ fact: "couldn’t change this outline.", reason: message });},
      canArrange() {
        return latest.current.editable && !busy.current && !nativeInputOpen.current && !view.composing &&
          compositionBase.current === null && referenceRef.current.getState() === null;
      },
      settleNativeInput() {
        if (nativeInputOpen.current || view.composing) return false;
        if (compositionBase.current) {
          const hadReference = referenceRef.current.getState() !== null;
          // an ended composition may still need transfer before this command;
          // a new query changes ownership before its host can observe it.
          finishComposition(view, compositionBase.current, null);
          if (!hadReference && referenceRef.current.getState() !== null) return false;
        }
        reconcile(view);
        if (view.isDestroyed || nativeInputOpen.current || view.composing || compositionBase.current !== null) return false;
        syncNativeSelection(view);
        return true;
      },
      localHistory(command) {
        const action = command === "undo" ? ownUndo : ownRedo;
        if (!latest.current.editable || busy.current || nativeInputOpen.current || view.composing || compositionBase.current !== null)
          return {enabled: false, execute() {}};
        if (activeReference(view.state) === null) return null;
        return {enabled: action(view.state), execute() {
          if (latest.current.editable && !busy.current && !nativeInputOpen.current && !view.composing &&
            compositionBase.current === null && activeReference(view.state) !== null)
            action(view.state, view.dispatch, view);
        }};
      },
    };
    editorHandle.current = handle;
    latest.current.projection?.onViewReady(view);
    latest.current.onEditorReady?.(handle);
    return () => {
      window.removeEventListener("blur", releaseDeletionKey);
      document.removeEventListener("pointerdown", revokeReturn, true);
      latest.current.projection?.onViewReady(null);
      latest.current.onEditorReady?.(null);
      editorHandle.current = null;
      if (latest.current.projection) binding?.detach(); else binding?.close();
      bindingRef.current = null;
      viewRef.current = null;
      view.destroy();
    };
    // Canonical refs and query branch owners may change within this body view.
    // All event handlers read the current authority through `latest`/`referenceRef`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitId, bodyViewKey]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (props.projection || props.writingDocument || !view || view.composing || compositionBase.current !== null || referenceRef.current.getState() !== null)
      return;
    replaceDoc(view, docFromBody(props.body));
  }, [props.body, props.revision, props.writingDocument, props.projection]);

  useLayoutEffect(() => {
    const raw = reference.state?.raw;
    const view = viewRef.current;
    if (raw === undefined || !view || view.composing) return;
    replaceDoc(view, docFromBody(bodyText(raw)), reference.state?.row_id ?? undefined);
  }, [reference.state?.raw, reference.state?.row_id]);

  const focusSerial = props.focus?.serial;
  useLayoutEffect(() => {
    const view = viewRef.current;
    const focus = latest.current.focus;
    if (!view || !focus || !view.editable || consumedFocus.current === focus.serial) return;
    editorHandle.current?.focus(focus.selection, focus.preventScroll);
    consumedFocus.current = focus.serial;
  }, [visitId, bodyViewKey, props.editable, focusSerial]);

  const { inspection } = props;
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (inspection && view.composing) return;
    const clear = () => {
      if (!view.isDestroyed)
        view.dispatch(view.state.tr.setMeta(inspectionKey, null));
    };
    if (!inspection || inspection.signal.aborted) {
      clear();
      return;
    }
    view.dispatch(view.state.tr.setMeta(inspectionKey, inspection));
    inspection.signal.addEventListener("abort", clear, { once: true });
    return () => {
      inspection.signal.removeEventListener("abort", clear);
      clear();
    };
  }, [visitId, bodyViewKey, inspection]);

  const linkOpen = link !== null && linkVisible;
  useEffect(() => {
    if (linkOpen) linkInput.current?.focus();
  }, [linkOpen]);

  return (
    <div
      ref={shell}
      data-reference-editor={props.editorKey}
      tabIndex={-1}
      data-row-focusable="true"
      className={styles.shell}
      data-header-editor={props.header ? "true" : undefined}
      data-words-at-risk={props.wordsAtRisk || undefined}
      onKeyDownCapture={(event) => {
        if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
        const view = viewRef.current;
        const intent = view && activeReference(view.state);
        if (event.key === "Escape" && (view?.composing || compositionBase.current !== null || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) {
          event.stopPropagation();
          return;
        }
        if (
          event.key !== "Escape" ||
          !view ||
          !intent ||
          view.composing ||
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        view.focus();
        if (!cancelReference(view)) literal(view);
      }}
      onBlurCapture={() =>
        window.requestAnimationFrame(() => {
          const focused = document.activeElement, view = viewRef.current;
          if (shell.current?.contains(focused)) {
            if (view && focused !== view.dom && focused?.closest("[data-reference-chooser]")?.closest("[data-reference-editor]") !== shell.current) {
              suspended.current = true;
              if (!view.composing && compositionBase.current === null) cancelReference(view);
            }
            return;
          }
          const owner = getInteractionOwner();
          const opener = owner?.opener instanceof HTMLElement ? owner.opener : owner?.opener?.element;
          if (owner?.options.current.kind === "modal" && opener && shell.current?.contains(opener)
            && owner.element?.contains(document.activeElement)) return;
          if (view && !view.composing && compositionBase.current === null) cancelReference(view);
          suspended.current = true;
          setReferenceFocused(false);
          setToolbar(false);
          setLinkVisible(false);
        })
      }
    >
      <div ref={host} className={styles.host} />
      {attachmentValue?.unconfirmed && !attachmentValue.body ? <Hold id={`attachment:${props.editorKey}`} attempt={attachmentValue.attempt} {...resendFeedback({ line: attachmentValue.unconfirmed,
          resend: { label: "retry", commandKey: "RetryAttachment", busy: attachmentValue.pending, run: () => {
          const task = readAttachment(), view = viewRef.current;
          if (task && view) { reviewUploadAttempt(task.upload); void attach(view, [task.file]); }
        } }, secondary: discardVerb })} /> : null}
      {attachmentValue?.body && attachmentValue.body === declined ? <Hold id={`attachment:${props.editorKey}:ready`} line={{ fact: "attachment uploaded.", reason: "select or empty the note body to insert it." }} verbs={[{
        label: "insert", commandKey: "InsertAttachment", run: () => {
          const task = readAttachment(), view = viewRef.current;
          if (!view || view.composing || compositionBase.current !== null) return;
          flushNativeDOM(view); syncNativeSelection(view);
          const field = editingField(view.state);
          if (!task?.body || !view || !field || field.row_id !== task.row_id || !replaceable(view) || !latest.current.editable) return;
          reportEdit({ before: fieldBody(field), after: task.body, selectionBefore: task.selection, selectionAfter: { anchor: 1, head: 1 }, source: "attachment" }, task.row_id);
          setAttachment(null);
        },
      }, discardVerb]} /> : null}
      {[...embeds].map(([dom, embed]) => {
        const owner = embed.row_id ?? props.embedding?.row_id ?? null;
        const context = embed.row_id !== null ? props.projection?.context(embed.row_id) : props.embedding?.context;
        // A portal has a mount identity; history names the stable field occurrence.
        const scope = owner !== null ? `${owner}/embed:${embed.ref}` : `${occurrenceKey}/${embed.key}`;
        const beforeCollapse = context?.beforeCollapse;
        return createPortal(<OutlineEmbeddingOccurrence value={owner}><EmbeddedResource
          resourceRef={embed.ref} field={embed.field} label={embed.label} inRow={embed.row_id !== null}
          scope={scope}
          branch={context?.branch ?? branch}
          beforeCollapse={beforeCollapse ? () => beforeCollapse(scope) : undefined}
          atomic={props.atomicEmbeds === true} onRevealRoot={() => shell.current?.focus()}
        /></OutlineEmbeddingOccurrence>, dom, embed.key);
      })}
      {reference.state && reference.state.row_id === activeRowId && referenceFocused && referenceVisible ? (
        <div data-reference-chooser data-collection-constrained={props.header || undefined}>
          <ReferencePicker
            input={reference}
            returnFocus={() => viewRef.current?.dom ?? null}
            onReviewPosition={() => { reference.reviewPosition(); viewRef.current?.focus(); }}
          />
        </div>
      ) : null}
      {props.editable && inputMode.current === "text" && toolbar && presentation !== "title" && presentation !== "reference" && !(link && linkVisible) && (reference.state === null || reference.state.row_id !== activeRowId) ? (
        <div
          ref={toolbarRef}
          className={styles.toolbar}
          role="toolbar"
          aria-label="Text formatting"
        >
          {FORMATS.map(([name, label, key, Glyph]) => (
            <Button
              key={name}
              iconOnly
              icon={<Glyph aria-hidden="true" />}
              aria-label={label}
              aria-pressed={active.has(name)}
              disabled={presentation === "code"}
              tooltip={{text: `${label} (${shortcut(key)})`}}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => format(name)}
            />
          ))}
          <Button iconOnly icon={<Icon.Code aria-hidden="true" />} aria-label="Code presentation"
            aria-pressed={presentation === "code"}
            tooltip={{text:"Code presentation"}} onMouseDown={event=>event.preventDefault()} onClick={()=>{
              const view=viewRef.current;if(!view||!latest.current.editable||inputMode.current!=="text"||view.composing||compositionBase.current!==null)return;
              flushNativeDOM(view);syncNativeSelection(view);
              if(activeReference(view.state)!==null)return;
              const field=editingField(view.state);if(!field||field.kind!=="body")return;
              if(view.state.selection.from<field.from||view.state.selection.to>field.to){
                warn(ACROSS_FIELDS);return;
              }
              presentBody(view,field,field.node.attrs.presentation==="code"?"prose":"code");
            }} />
          <Button
            iconOnly
            icon={<Icon.Link aria-hidden="true" />}
            disabled={presentation === "code"}
            aria-label="Link"
            tooltip={{text: "Link (⌘/Ctrl+Shift+K)"}}
            onMouseDown={(event) => event.preventDefault()}
            onClick={openLink}
          />
        </div>
      ) : null}
      {link && linkVisible ? (
        <div
          className={styles.linkDialog}
          style={props.header ? undefined : { left: link.left, top: link.top }}
          role="dialog"
          aria-label="Add hyperlink"
        >
          <label className={styles.linkLabel} htmlFor={linkInputId}>
            Link address
          </label>
          <div className={styles.linkControls}>
            <input
              ref={linkInput}
              id={linkInputId}
              className={styles.linkInput}
              aria-invalid={link.error !== null || undefined}
              aria-describedby={link.error ? linkErrorId : undefined}
              value={link.query}
              onChange={(event) =>
                setLink({ ...link, query: event.target.value, error: null })
              }
              onKeyDown={(event) => {
                if (
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229
                )
                  return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  if (!guard.confirmLoss({ scopes: [], ownerIds: [linkDraft.owner] })) return;
                  setLink(null);
                  setLinkVisible(false);
                  viewRef.current?.focus();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  insertLink();
                }
              }}
            />
            <Button
              emphasis="strong"
              disabled={!hrefFromInput(link.query)}
              onClick={insertLink}
            >
              Add link
            </Button>
          </div>
          {/* focus is already in the address input, so its description is not read again: the refusal speaks */}
          {link.error ? <Field id={linkErrorId} line={link.error} /> : null}
        </div>
      ) : null}
    </div>
  );
}

interface EditingField { row_id: string | null; kind: "body" | "title" | "reference"; from: number; to: number; node: PMNode }
function editingField(state: EditorState): EditingField | null {
  if (state.doc.type.name === "outline_doc") return fieldAt(state.doc, state.selection.anchor);
  const node = state.doc.firstChild;
  return node?.isTextblock ? {row_id: null, kind: "body", from: 1, to: node.content.size + 1, node} : null;
}
function editingRow(doc: PMNode, row_id: string): EditingField | null {
  let field: EditingField | null = null;
  doc.forEach((row, at) => { if (row.attrs.row_id === row_id) field = fieldAt(doc, at + 1); });
  return field;
}
function fieldBody(field: EditingField): NoteBody {
  return field.kind === "title" ? bodyText(field.node.textContent)
    : field.kind === "reference" ? parseBody({type: "body", content: field.node.content.toJSON() ?? []}) : bodyFromNode(field.node);
}
function fieldSelection(state: EditorState, field: EditingField): NoteEdit["selectionAfter"] {
  return {anchor: state.selection.anchor - field.from + 1, head: state.selection.head - field.from + 1};
}
function selectionForEdit(state: EditorState, field: EditingField, from = field.from, to = from): NoteEdit["selectionAfter"] {
  if (state.selection.anchor >= field.from && state.selection.anchor <= field.to && state.selection.head >= field.from && state.selection.head <= field.to)
    return fieldSelection(state, field);
  const local = (position: number) => Math.max(field.from, Math.min(position, field.to)) - field.from + 1;
  return {anchor: local(from), head: local(to)};
}

/** Replace the document by its changed range, outside history. */
function replaceDoc(view: EditorView, doc: PMNode, row_id?: string) {
  if (view.state.doc.type.name === "outline_doc") {
    const field = row_id ? fieldById(view.state.doc, row_id) : editingField(view.state);
    if (!field) return;
    const content = field.kind === "title" ? (doc.textContent ? Fragment.from(view.state.schema.text(doc.textContent)) : Fragment.empty)
      : view.state.schema.nodeFromJSON(doc.firstChild!.toJSON()).content;
    const start = field.node.content.findDiffStart(content);
    const tr = view.state.tr.setMeta(SOURCE, "external").setMeta(outlineTransactionSource, "projection").setMeta("addToHistory", false);
    if (start !== null) {
      const end = field.node.content.findDiffEnd(content)!;
      const overlap = Math.max(0, start - Math.min(end.a, end.b));
      tr.replaceWith(field.from + start, field.from + end.a + overlap, content.cut(start, end.b + overlap));
    }
    if (field.kind === "body" && field.node.attrs.presentation !== doc.firstChild!.attrs.presentation)
      tr.setNodeMarkup(field.from - 1, undefined, doc.firstChild!.attrs);
    if (tr.docChanged) view.dispatch(tr);
    return;
  }
  const start = view.state.doc.content.findDiffStart(doc.content);
  if (start === null) return;
  const end = view.state.doc.content.findDiffEnd(doc.content)!;
  const overlap = Math.max(0, start - Math.min(end.a, end.b));
  const tr = view.state.tr
    .setMeta(SOURCE, "external")
    .setMeta("addToHistory", false);
  view.dispatch(tr.replaceWith(start, end.a + overlap, doc.content.cut(start, end.b + overlap)));
}

/** Native selection can precede selectionchange; commands use the current browser range. */
function syncNativeSelection(view: EditorView) {
  const native = view.dom.ownerDocument.getSelection();
  const { anchorNode, focusNode } = native ?? {};
  if (!native || !anchorNode || !focusNode) return;
  if (!view.dom.contains(anchorNode) || !view.dom.contains(focusNode)) return;
  const anchor = view.posAtDOM(anchorNode, native.anchorOffset);
  const head = view.posAtDOM(focusNode, native.focusOffset);
  const { state } = view;
  if (anchor === state.selection.anchor && head === state.selection.head)
    return;
  if (
    !state.doc.resolve(anchor).parent.inlineContent ||
    !state.doc.resolve(head).parent.inlineContent
  )
    return;
  view.dispatch(
    state.tr.setSelection(TextSelection.create(state.doc, anchor, head)),
  );
}

/** Paste joins body blocks with hard breaks and retains every inline atom/mark. */
function oneBlock(slice: Slice, schema = canonicalSchema): Slice | null {
  const inline: PMNode[] = [];
  let blocks = 0;
  let foreign = false;
  slice.content.forEach(node => {
    if (node.isInline) { inline.push(node); return; }
    if (node.type !== schema.nodes.body) { foreign = true; return; }
    if (blocks++) inline.push(schema.nodes.hard_break!.create());
    node.content.forEach(child => inline.push(child));
  });
  return foreign ? null : new Slice(Fragment.fromArray(inline), 0, 0);
}

/** An attachment or embed may replace the body only when it is empty or wholly selected. */
function replaceable(view: EditorView): boolean {
  const field = editingField(view.state), body = field?.node;
  const { selection } = view.state;
  if (!field || !body || field.kind !== "body" || selection.from < field.from || selection.to > field.to) return false;
  if (body.content.size === 0 && !body.textContent.trim()) return true;
  return (
    !selection.empty &&
    selection.from === field.from &&
    selection.to === field.to
  );
}

/** A projection may hydrate after arrival. Paint only the exact target body;
 * edits, abort or a changed body after paint retire its offsets permanently. */
function inspectionPlugin(focus: () => void): Plugin<InspectionState | null> {
  return new Plugin<InspectionState | null>({
    key: inspectionKey,
    state: {
      init: () => null,
      apply(tr, previous) {
        const inspection = tr.getMeta(inspectionKey) as
          NoteInspection | null | undefined;
        if (inspection === undefined && !tr.docChanged) return previous;
        const target = inspection === undefined ? previous?.target ?? null : inspection;
        if (!target || target.signal.aborted || (tr.docChanged && tr.getMeta(outlineTransactionSource) !== "projection")) return null;
        const decorations = inspectionDecorations(tr.doc, target);
        if (inspection === undefined && previous?.decorations.find().length && !decorations.find().length) return null;
        return { target, decorations };
      },
    },
    props: { decorations: (state) => inspectionKey.getState(state)?.decorations ?? null },
    view: () => ({ update(view, before) {
      const current = inspectionKey.getState(view.state), previous = inspectionKey.getState(before);
      if (!current?.decorations.find().length || current.target.restored) return;
      if (current.target === previous?.target && previous?.decorations.find().length) return;
      view.dom.querySelector("[data-note-inspection-range]")?.scrollIntoView({ block: "center" });
      if (current.target.mayFocus()) focus();
    } }),
  });
}

function EmbeddedResource({
  field, label,
  resourceRef,
  scope,
  branch,
  atomic,
  inRow,
  onRevealRoot,
  beforeCollapse,
}: {
  resourceRef: string;
  field: "annotation" | null;
  label: string | null;
  scope: string;
  branch: OutlineBranch;
  atomic: boolean;
  inRow: boolean;
  onRevealRoot(): void;
  beforeCollapse?(): Promise<boolean>;
}) {
  if (field === "annotation") return <EmbeddedAnnotation resourceRef={resourceRef} label={label}/>;
  return <EmbeddedWholeResource resourceRef={resourceRef} scope={scope} branch={branch} atomic={atomic} inRow={inRow} onRevealRoot={onRevealRoot} beforeCollapse={beforeCollapse}/>;
}
function EmbeddedAnnotation({resourceRef, label}: {resourceRef: string; label: string | null}) {
  const prepared = useContext(PreparedResourcesContext);
  const held = prepared?.has(resourceRef) ?? false;
  const read = useAuthoredQuery(held ? null : {kind: "resource", ref: resourceRef});
  const resource = held ? prepared!.get(resourceRef)?.resource : read.data?.rows[0]?.resource;
  return <>
    <a href={`/highlights/${resourceRef.split(":")[1]}#annotation`} data-workspace-rich-target="true">{label !== null ? label : resource?.kind === "highlight" && resource.authored_by_viewer && resource.body_pm_json !== null
      ? <NoteBodyPreview body={{body_pm_json: resource.body_pm_json, body_text: resource.body_text!}}/>
      : held || read.data ? "annotation unavailable" : "annotation"}</a>
  </>;
}
function EmbeddedWholeResource({resourceRef, scope, branch, atomic, inRow, onRevealRoot, beforeCollapse}: {
  resourceRef: string; scope: string; branch: OutlineBranch; atomic: boolean; inRow: boolean; onRevealRoot(): void; beforeCollapse?(): Promise<boolean>;
}) {
  const prepared = useContext(PreparedResourcesContext);
  const held = prepared?.has(resourceRef) ?? false;
  const read = useAuthoredQuery(held ? null : {kind: "resource", ref: resourceRef});
  const resource = held ? prepared!.get(resourceRef)?.resource : read.data?.rows[0]?.resource;
  const serverOwned = resource ? !resource.authored_by_viewer : (held || read.data !== null) && !hasAuthoredContent(resourceRef);
  const [resolved, setResolved] = useState<ResourceItem | null>(null);
  const [failure, setFailure] = useState<unknown | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const item = resolved?.ref === resourceRef ? resolved : null;
  const handleUnauthenticated = useUnauthenticatedApiHandler();
  useEffect(() => {
    // A missing authored target stays local. Server-only domains need no captured stub.
    if (!serverOwned || item) return;
    const controller = new AbortController();
    setLoading(true);
    void resolveResourceItem(resourceRef, controller.signal).then(
      value => {if (!controller.signal.aborted) {setResolved(value); setFailure(null); setLoading(false);}},
      (error: unknown) => {
        if (controller.signal.aborted || handleUnauthenticated(error)) return;
        if (!isApiError(error) || isSameSystemApiDefect(error))
          setDefect({ error });
        else {setFailure(error); setLoading(false);}
      },
    );
    return () => controller.abort();
  }, [resourceRef, serverOwned, item, attempt, handleUnauthenticated]);
  if (defect) throw defect.error;
  const owned = resource?.authored_by_viewer ? resource : null;
  return <>
    {!owned && !item && read.error !== null ? <AuthoredReadFailure {...read} noun="this item"/> : null}
    {owned || item ? atomic ? <ResourceLink item={owned ? authoredItem(owned, null, localResourceHref(owned)) : item!}/> : (
      <ResourceOutlineList scope={scope} ariaLabel="Embedded resource" branch={branch} onRevealRoot={onRevealRoot}>
        <ResourceOutlineRow beforeCollapse={beforeCollapse} editable={false} inRow={inRow} incoming={null} defaultOpen={false}
          {...owned ? {resource: owned} : {item: item!}} occurrenceKey={scope}/>
      </ResourceOutlineList>
     ) : failure !== null ? <Failed error={failure} noun="embedded items" retry={{busy: loading, run: () => setAttempt(value => value + 1)}}/>
      : !resource && !serverOwned && (held || read.data) ? <span>not available on this device</span> : null}
  </>;
}
