"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
} from "prosemirror-model";
import {
  EditorState,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
} from "prosemirror-state";
import { DecorationSet, EditorView } from "prosemirror-view";
import { Bold, Code2, Italic, Link2, Strikethrough, Underline } from "lucide-react";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { workspaceTargetClickIntent } from "@/lib/panes/targetLinkActivation";
import {
  createNoteBodyKeymap,
  createObjectRefSyntaxPlugin,
  noteBodyEditSourceMeta,
  splitNoteBodyAtSelection,
  toggleNoteBodyFormat,
  type NoteBodyFormat,
  type NoteBodySplit as ProseMirrorNoteBodySplit,
} from "@/lib/notes/prosemirror/commands";
import {
  createNoteBodyDoc,
  isSafeNoteBodyHref,
  noteBodySchema,
  noteBodyValueFromDoc,
  type NoteBodyValue,
} from "@/lib/notes/prosemirror/schema";
import {
  getFileUploadError,
  UploadSessionError,
  uploadIngestFile,
} from "@/lib/media/ingestionClient";
import { mediaCaptureErrorMessage } from "@/lib/media/captureFeedback";
import { notePulseDecorations } from "@/lib/notes/prosemirror/notePulse";
import { projectNoteBody } from "@/lib/notes/prosemirror/noteBodyProjection";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import {
  parseResourceRef,
  type ResourceScheme,
} from "@/lib/resourceGraph/resourceRef";
import { useResourceTargetSearch } from "@/lib/resources/useResourceTargetSearch";
import type { ResourceTarget } from "@/lib/resources/resourceTargets";
import ResourceTargetListbox, {
  resourceTargetKey,
} from "@/components/resources/ResourceTargetListbox";
import "prosemirror-view/style/prosemirror.css";
import styles from "./NoteBodyEditor.module.css";

export type NoteBodyChange = NoteBodyValue;

export interface NoteBodySelection {
  anchor: number;
  head: number;
}

export type NoteBodyEditSource =
  | "input"
  | "composition"
  | "paste"
  | "format"
  | "reference"
  | "attachment";

export interface NoteBodyEdit {
  before: NoteBodyValue;
  after: NoteBodyValue;
  selectionBefore: NoteBodySelection;
  selectionAfter: NoteBodySelection;
  source: NoteBodyEditSource;
}

export interface NoteBodyEditorDocument {
  body: NoteBodyValue;
  revision: number;
}

export interface NoteBodySplit {
  leftBodyPmJson: Record<string, unknown>;
  leftBodyText: string;
  rightBodyPmJson: Record<string, unknown>;
  rightBodyText: string;
}

export interface NotePulseEditorTarget {
  startOffset: number;
  endOffset: number;
  pulseId: number;
}

export interface NoteBodyInputHandoff {
  handoffId: string;
  text: string;
  selectionStart: number;
  selectionEnd: number;
  composition: "Composing" | "Complete";
}

export interface NoteBodyEditorProps {
  resourceKey: string;
  document: NoteBodyEditorDocument;
  restoreSelection?: { token: number; selection: NoteBodySelection };
  editable?: boolean;
  ariaLabel?: string;
  compact?: boolean;
  onEdit: (edit: NoteBodyEdit) => void;
  onSelectionChange: (selection: NoteBodySelection) => void;
  onHistoryBoundary: () => void;
  onUndoRequest: () => void;
  onRedoRequest: () => void;
  onFlushRequest: () => void;
  onFocusChange?: (focused: boolean) => void;
  onOpenObject?: (
    objectType: string,
    objectId: string,
    disposition: WorkspaceTargetDisposition,
  ) => void;
  onFeedback?: (feedback: FeedbackContent) => void;
  onError?: (error: unknown) => void;
  notePulseTarget?: NotePulseEditorTarget | null;
  focusRequest?: number;
  onSplit?: (split: NoteBodySplit) => void;
  onEmptyBackspace?: () => void;
  inputHandoff?: NoteBodyInputHandoff | null;
  onInputHandoffClaimed?: (handoffId: string) => void;
}

interface ObjectRefTextRange {
  from: number;
  to: number;
  query: string;
  filter: "all" | "page_note";
}

interface ObjectRefTrigger extends ObjectRefTextRange {
  mode: "reference" | "link";
  left: number;
  top: number;
  selectedText: string;
}

type FormatState = Record<NoteBodyFormat, boolean>;
const EMPTY_FORMAT_STATE: FormatState = {
  strong: false,
  em: false,
  underline: false,
  strikethrough: false,
  code: false,
};

class MediaAttachmentContractDefect extends Error {
  constructor(message: string) {
    // justify-defect: losing the editor insertion target after media acceptance
    // violates the durable attachment contract.
    super(message);
    this.name = "MediaAttachmentContractDefect";
  }
}

const OBJECT_REF_SEARCH_QUERY_MAX_LENGTH = 200;
const NOTE_PULSE_RANGE_DURATION_MS = 2400;
const notePulseDecorationKey = new PluginKey<DecorationSet>("noteBodyPulse");
const PAGE_NOTE_SCHEMES = [
  "page",
  "note_block",
] as const satisfies readonly ResourceScheme[];

const FORMAT_CONTROLS = [
  { name: "strong", label: "Bold", shortcut: "⌘/Ctrl+B", Icon: Bold },
  { name: "em", label: "Italic", shortcut: "⌘/Ctrl+I", Icon: Italic },
  { name: "underline", label: "Underline", shortcut: "⌘/Ctrl+U", Icon: Underline },
  { name: "strikethrough", label: "Strikethrough", shortcut: "⌘/Ctrl+Shift+S", Icon: Strikethrough },
  { name: "code", label: "Inline code", shortcut: "⌘/Ctrl+E", Icon: Code2 },
] as const satisfies readonly {
  name: NoteBodyFormat;
  label: string;
  shortcut: string;
  Icon: typeof Bold;
}[];

export default function NoteBodyEditor({
  resourceKey,
  document,
  restoreSelection,
  editable = true,
  ariaLabel = "Note content",
  compact = false,
  onEdit,
  onSelectionChange,
  onHistoryBoundary,
  onUndoRequest,
  onRedoRequest,
  onFlushRequest,
  onFocusChange,
  onOpenObject,
  onFeedback,
  onError,
  notePulseTarget,
  focusRequest = 0,
  onSplit,
  onEmptyBackspace,
  inputHandoff = null,
  onInputHandoffClaimed,
}: NoteBodyEditorProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const linkInputRef = useRef<HTMLInputElement | null>(null);
  const autocompleteListboxId = useId();
  const viewRef = useRef<EditorView | null>(null);
  const externalDoc = useMemo(
    () => createNoteBodyDoc({
      bodyPmJson: document.body.bodyPmJson,
      fallbackBodyText: document.body.bodyText,
    }),
    [document.body.bodyPmJson, document.body.bodyText],
  );
  const initialDocRef = useRef(externalDoc);
  const initialResourceKeyRef = useRef(resourceKey);
  const appliedRevisionRef = useRef(document.revision);
  const latestDocumentRef = useRef({ doc: externalDoc, revision: document.revision });
  const restoredSelectionTokenRef = useRef<number | null>(null);
  const ariaLabelRef = useRef(ariaLabel);
  const compactRef = useRef(compact);
  const focusRequestRef = useRef(focusRequest);
  const editableRef = useRef(editable);
  const attachmentBusyRef = useRef(false);
  const onEditRef = useRef(onEdit);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onHistoryBoundaryRef = useRef(onHistoryBoundary);
  const onUndoRequestRef = useRef(onUndoRequest);
  const onRedoRequestRef = useRef(onRedoRequest);
  const onFlushRequestRef = useRef(onFlushRequest);
  const onFocusChangeRef = useRef(onFocusChange);
  const onOpenObjectRef = useRef(onOpenObject);
  const onFeedbackRef = useRef(onFeedback);
  const onErrorRef = useRef(onError);
  const onSplitRef = useRef(onSplit);
  const onEmptyBackspaceRef = useRef(onEmptyBackspace);
  const onInputHandoffClaimedRef = useRef(onInputHandoffClaimed);
  const claimedInputHandoffIdsRef = useRef<Set<string>>(new Set());
  const notePulseTargetRef = useRef(notePulseTarget);
  const notePulseTimeoutRef = useRef<number | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [trigger, setTrigger] = useState<ObjectRefTrigger | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [formatState, setFormatState] = useState<FormatState>(EMPTY_FORMAT_STATE);
  const [linkError, setLinkError] = useState<string | null>(null);
  const triggerRef = useRef<ObjectRefTrigger | null>(null);
  const targetsRef = useRef<ResourceTarget[]>([]);
  const activeKeyRef = useRef<string | null>(null);
  const menuOpenRef = useRef(false);
  const openLinkMenuRef = useRef<() => boolean>(() => false);
  const runFormatRef = useRef<(name: NoteBodyFormat) => boolean>(() => false);
  const handleUnauthenticatedApiError = useUnauthenticatedApiHandler();

  if (initialResourceKeyRef.current !== resourceKey) {
    initialResourceKeyRef.current = resourceKey;
    initialDocRef.current = externalDoc;
    appliedRevisionRef.current = document.revision;
  }

  latestDocumentRef.current = { doc: externalDoc, revision: document.revision };
  onEditRef.current = onEdit;
  onSelectionChangeRef.current = onSelectionChange;
  onHistoryBoundaryRef.current = onHistoryBoundary;
  onUndoRequestRef.current = onUndoRequest;
  onRedoRequestRef.current = onRedoRequest;
  onFlushRequestRef.current = onFlushRequest;
  onFocusChangeRef.current = onFocusChange;
  onOpenObjectRef.current = onOpenObject;
  onFeedbackRef.current = onFeedback;
  onErrorRef.current = onError;
  onSplitRef.current = onSplit;
  onEmptyBackspaceRef.current = onEmptyBackspace;
  onInputHandoffClaimedRef.current = onInputHandoffClaimed;
  notePulseTargetRef.current = notePulseTarget;
  ariaLabelRef.current = ariaLabel;
  compactRef.current = compact;
  focusRequestRef.current = focusRequest;
  triggerRef.current = trigger;
  activeKeyRef.current = activeKey;

  const schemes =
    trigger?.filter === "page_note" ? PAGE_NOTE_SCHEMES : undefined;
  const { targets, loading, error } = useResourceTargetSearch({
    purpose: "reference",
    query: trigger?.query ?? "",
    schemes,
  });
  targetsRef.current = targets;

  useEffect(() => {
    if (!trigger) {
      setActiveKey(null);
      return;
    }
    const keys = targets.map(resourceTargetKey);
    setActiveKey((current) =>
      current && keys.includes(current) ? current : (keys[0] ?? null),
    );
  }, [trigger, targets]);

  useEffect(() => {
    editableRef.current = editable;
    viewRef.current?.setProps({
      editable: () => editableRef.current && !attachmentBusyRef.current,
    });
    if (!editable) {
      setTrigger(null);
      setActiveKey(null);
    }
  }, [editable]);

  useEffect(() => {
    if (focusRequest > 0) {
      viewRef.current?.focus();
    }
  }, [focusRequest]);

  const refreshFormatState = useCallback((state: EditorState) => {
    const marks = state.storedMarks ?? state.selection.$from.marks();
    const next: FormatState = {
      strong: false,
      em: false,
      underline: false,
      strikethrough: false,
      code: false,
    };
    for (const name of Object.keys(next) as NoteBodyFormat[]) {
      const type = noteBodySchema.marks[name];
      next[name] = Boolean(
        type && (state.selection.empty
          ? type.isInSet(marks)
          : state.doc.rangeHasMark(state.selection.from, state.selection.to, type)),
      );
    }
    setFormatState((current) =>
      (Object.keys(next) as NoteBodyFormat[]).every(
        (name) => current[name] === next[name],
      ) ? current : next,
    );
  }, []);

  const runFormat = useCallback((name: NoteBodyFormat): boolean => {
    const view = viewRef.current;
    if (!view || !editableRef.current || view.composing) return false;
    onHistoryBoundaryRef.current();
    const changed = toggleNoteBodyFormat(name, view.state, view.dispatch);
    if (changed) {
      refreshFormatState(view.state);
      view.focus();
    }
    return changed;
  }, [refreshFormatState]);
  runFormatRef.current = runFormat;

  const openLinkMenu = useCallback((): boolean => {
    const view = viewRef.current;
    const shell = shellRef.current;
    if (!view || !shell || !editableRef.current || view.composing) return false;
    const selection = view.state.selection;
    if (!(selection instanceof TextSelection)) return false;
    const from = selection.from;
    const to = selection.to;
    const query = view.state.doc.textBetween(from, to, " ", " ")
      .trim()
      .slice(0, OBJECT_REF_SEARCH_QUERY_MAX_LENGTH);
    const caret = view.coordsAtPos(to);
    const shellBox = shell.getBoundingClientRect();
    onHistoryBoundaryRef.current();
    setLinkError(null);
    setTrigger({
      from,
      to,
      query,
      filter: "all",
      mode: "link",
      selectedText: view.state.doc.textBetween(from, to, " ", " "),
      left: Math.max(0, caret.left - shellBox.left),
      top: Math.max(0, caret.bottom - shellBox.top + 6),
    });
    return true;
  }, []);
  openLinkMenuRef.current = openLinkMenu;

  useEffect(() => {
    if (trigger?.mode === "link") linkInputRef.current?.focus();
  }, [trigger?.mode]);

  useLayoutEffect(() => {
    if (
      !editorReady ||
      !inputHandoff ||
      inputHandoff.composition !== "Complete" ||
      claimedInputHandoffIdsRef.current.has(inputHandoff.handoffId)
    ) {
      return;
    }
    const view = viewRef.current;
    if (!view) {
      return;
    }
    const nextDoc = externalDoc;
    const maxTextOffset = nextDoc.firstChild
      ? projectNoteBody(nextDoc.firstChild).text.length
      : 0;
    const selectionStart = Math.min(
      inputHandoff.selectionStart,
      maxTextOffset,
    );
    const selectionEnd = Math.min(inputHandoff.selectionEnd, maxTextOffset);
    const from = noteBodyPositionForTextOffset(nextDoc, selectionStart);
    const to = noteBodyPositionForTextOffset(
      nextDoc,
      Math.max(selectionStart, selectionEnd),
    );
    claimedInputHandoffIdsRef.current.add(inputHandoff.handoffId);
    applyCanonicalDoc(view, nextDoc, { anchor: from, head: to });
    appliedRevisionRef.current = document.revision;
    view.focus();
    onInputHandoffClaimedRef.current?.(inputHandoff.handoffId);
  }, [document.revision, editorReady, externalDoc, inputHandoff]);

  useEffect(() => {
    const view = viewRef.current;
    if (
      !view ||
      view.composing ||
      document.revision <= appliedRevisionRef.current
    ) return;
    applyCanonicalDoc(view, externalDoc);
    appliedRevisionRef.current = document.revision;
  }, [document.revision, externalDoc]);

  useEffect(() => {
    const view = viewRef.current;
    if (
      !view ||
      !restoreSelection ||
      restoredSelectionTokenRef.current === restoreSelection.token
    ) return;
    restoredSelectionTokenRef.current = restoreSelection.token;
    applyCanonicalDoc(view, latestDocumentRef.current.doc, restoreSelection.selection);
  }, [restoreSelection]);

  const applyNotePulseTarget = useCallback(
    (target: NotePulseEditorTarget | null) => {
      if (notePulseTimeoutRef.current !== null) {
        window.clearTimeout(notePulseTimeoutRef.current);
        notePulseTimeoutRef.current = null;
      }
      const view = viewRef.current;
      if (!view) return;
      view.dispatch(view.state.tr.setMeta(notePulseDecorationKey, target));
      if (!target) return;
      view.dom
        .querySelector<HTMLElement>("[data-note-pulse-range]")
        ?.scrollIntoView({ block: "center" });
      notePulseTimeoutRef.current = window.setTimeout(() => {
        notePulseTimeoutRef.current = null;
        viewRef.current?.dispatch(
          viewRef.current.state.tr.setMeta(notePulseDecorationKey, null),
        );
      }, NOTE_PULSE_RANGE_DURATION_MS);
    },
    [],
  );

  useEffect(() => {
    applyNotePulseTarget(notePulseTarget ?? null);
  }, [applyNotePulseTarget, notePulseTarget]);

  const closeObjectRefMenu = useCallback(() => {
    setTrigger(null);
    setActiveKey(null);
    setLinkError(null);
  }, []);

  const insertObjectRef = useCallback((target: ResourceTarget) => {
    const view = viewRef.current;
    const activeTrigger = triggerRef.current;
    if (!view || !activeTrigger || target.kind !== "resource") return;
    const parsed = parseResourceRef(target.item.ref);
    if (!parsed) return;
    if (view.state.doc.textBetween(
      activeTrigger.from, activeTrigger.to, " ", " ",
    ) !== activeTrigger.selectedText) {
      closeObjectRefMenu();
      onErrorRef.current?.(new Error(
        "The selected text changed. Select it again to add a reference.",
      ));
      return;
    }

    const node = noteBodySchema.nodes.object_ref!.create({
      objectType: parsed.scheme,
      objectId: parsed.id,
      label: target.item.label,
    });
    const space = noteBodySchema.text(" ");
    onHistoryBoundaryRef.current();
    const tr = view.state.tr
      .setMeta(noteBodyEditSourceMeta, "reference")
      .replaceWith(
        activeTrigger.from,
        activeTrigger.to,
        Fragment.fromArray([node, space]),
      );
    tr.setSelection(
      TextSelection.create(
        tr.doc,
        activeTrigger.from + node.nodeSize + space.nodeSize,
      ),
    );
    closeObjectRefMenu();
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }, [closeObjectRefMenu]);

  const insertWebLink = useCallback(() => {
    const view = viewRef.current;
    const active = triggerRef.current;
    if (!view || !active || active.mode !== "link") return;
    const href = noteBodyHrefFromInput(active.query);
    if (!href) {
      setLinkError("Enter a web address, email address, or local path.");
      return;
    }
    const currentText = view.state.doc.textBetween(active.from, active.to, " ", " ");
    if (currentText !== active.selectedText) {
      closeObjectRefMenu();
      onErrorRef.current?.(new Error("The selected text changed. Select it again to add a link."));
      return;
    }
    const mark = noteBodySchema.marks.link!.create({ href });
    onHistoryBoundaryRef.current();
    const tr = view.state.tr.setMeta(noteBodyEditSourceMeta, "format");
    if (active.from === active.to) {
      tr.insertText(href, active.from, active.to);
      tr.addMark(active.from, active.from + href.length, mark);
      tr.setSelection(TextSelection.create(tr.doc, active.from + href.length));
      tr.removeStoredMark(noteBodySchema.marks.link!);
    } else {
      tr.addMark(active.from, active.to, mark);
      tr.setSelection(TextSelection.create(tr.doc, active.from, active.to));
    }
    closeObjectRefMenu();
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }, [closeObjectRefMenu]);

  const menuOpen = Boolean(trigger && (trigger.mode === "link" || targets.length > 0));
  menuOpenRef.current = Boolean(trigger?.mode === "reference" && targets.length > 0);
  const activeOptionId =
    trigger && activeKey
      ? `${autocompleteListboxId}-option-${activeKey}`
      : undefined;

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.setProps({
      attributes: editorAttributes({
        ariaLabel: ariaLabelRef.current,
        compact: compactRef.current,
        menuOpen,
        autocompleteListboxId,
        activeOptionId,
      }),
    });
  }, [activeOptionId, ariaLabel, autocompleteListboxId, compact, menuOpen]);

  const insertMedia = useCallback(
    (view: EditorView, mediaId: string, label: string): boolean => {
      if (!canReplaceBodyWithAttachment(view)) return false;
      const embed = noteBodySchema.nodes.object_embed!.create({
        objectType: "media",
        objectId: mediaId,
        label,
        relationType: "embeds",
        displayMode: "compact",
      });
      onHistoryBoundaryRef.current();
      view.dispatch(
        view.state.tr
          .setMeta(noteBodyEditSourceMeta, "attachment")
          .replaceWith(0, view.state.doc.content.size, embed)
          .scrollIntoView(),
      );
      return true;
    },
    [],
  );

  const attachFiles = useCallback(
    async (view: EditorView, files: File[]) => {
      if (!editableRef.current || files.length === 0) return;
      if (!canReplaceBodyWithAttachment(view)) {
        onErrorRef.current?.(
          new Error("Select the note body or empty it before attaching a file."),
        );
        return;
      }
      if (files.length > 1) {
        onErrorRef.current?.(new Error("Attach one file at a time here."));
        return;
      }
      const file = files[0]!;
      const uploadError = getFileUploadError(file);
      if (uploadError) {
        onErrorRef.current?.(new Error(uploadError));
        return;
      }

      attachmentBusyRef.current = true;
      view.setProps({ editable: () => false });
      try {
        const upload = await uploadIngestFile({
          file,
          libraryIds: [],
        });
        if (!insertMedia(view, upload.mediaId, file.name)) {
          throw new MediaAttachmentContractDefect(
            "The published attachment target changed unexpectedly.",
          );
        }
      } catch (caught: unknown) {
        if (handleUnauthenticatedApiError(caught)) return;
        if (caught instanceof UploadSessionError) {
          try {
            onFeedbackRef.current?.(
              mediaCaptureErrorMessage(caught, "AddAttachment"),
            );
          } catch (caughtDefect: unknown) {
            setDefect({ error: caughtDefect });
          }
          return;
        }
        if (isMediaAttachmentDefect(caught)) {
          setDefect({ error: caught });
          return;
        }
        onErrorRef.current?.(caught);
      } finally {
        attachmentBusyRef.current = false;
        view.setProps({ editable: () => editableRef.current });
      }
    },
    [handleUnauthenticatedApiError, insertMedia],
  );

  useEffect(() => {
    const host = hostRef.current;
    const shell = shellRef.current;
    if (!host) return;

    function openObjectRefMenu(view: EditorView, range: ObjectRefTextRange) {
      if (!shell || !editableRef.current) {
        closeObjectRefMenu();
        return;
      }
      const caret = view.coordsAtPos(range.to);
      const shellBox = shell.getBoundingClientRect();
      setTrigger({
        ...range,
        mode: "reference",
        selectedText: view.state.doc.textBetween(range.from, range.to, " ", " "),
        left: Math.max(0, caret.left - shellBox.left),
        top: Math.max(0, caret.bottom - shellBox.top + 6),
      });
    }

    function refreshObjectRefMenu(view: EditorView, state: EditorState) {
      if (triggerRef.current?.mode === "link") return;
      const range = objectRefTriggerFromState(state);
      if (range) openObjectRefMenu(view, range);
      else closeObjectRefMenu();
    }

    const view = new EditorView(host, {
      state: EditorState.create({
        schema: noteBodySchema,
        doc: initialDocRef.current,
        plugins: [
          createNotePulseDecorationPlugin(),
          createNoteBodyKeymap({
            format: (name) => runFormatRef.current(name),
            link: () => openLinkMenuRef.current(),
            undo: () => {
              onHistoryBoundaryRef.current();
              onUndoRequestRef.current();
            },
            redo: () => {
              onHistoryBoundaryRef.current();
              onRedoRequestRef.current();
            },
          }),
          createObjectRefSyntaxPlugin(),
        ],
      }),
      attributes: editorAttributes({
        ariaLabel: ariaLabelRef.current,
        compact: compactRef.current,
        menuOpen: false,
        autocompleteListboxId,
        activeOptionId: undefined,
      }),
      editable: () => editableRef.current && !attachmentBusyRef.current,
      transformPasted(slice) {
        if (view.state.selection.$from.parent.type.spec.code) return slice;
        return compactPastedSlice(slice) ?? slice;
      },
      handlePaste(currentView, _event, slice) {
        const embedded = slice.content.childCount === 1 &&
          slice.content.firstChild?.type === noteBodySchema.nodes.object_embed;
        if (embedded && !canReplaceBodyWithAttachment(currentView)) {
          onErrorRef.current?.(new Error(
            "Select the note body or empty it before pasting an embedded item.",
          ));
          return true;
        }
        if (compactPastedSlice(slice) !== null) return false;
        onErrorRef.current?.(new Error("Paste one embedded item at a time."));
        return true;
      },
      handleDOMEvents: {
        focus(currentView) {
          refreshFormatState(currentView.state);
          setToolbarOpen(!currentView.state.selection.empty);
          onFocusChangeRef.current?.(true);
          return false;
        },
        blur() {
          onHistoryBoundaryRef.current();
          onFocusChangeRef.current?.(false);
          onFlushRequestRef.current();
          return false;
        },
        compositionstart() {
          onHistoryBoundaryRef.current();
          return false;
        },
        compositionend() {
          onHistoryBoundaryRef.current();
          window.setTimeout(() => {
            const current = viewRef.current;
            const latest = latestDocumentRef.current;
            if (!current || current.composing ||
                latest.revision <= appliedRevisionRef.current) return;
            applyCanonicalDoc(current, latest.doc);
            appliedRevisionRef.current = latest.revision;
          }, 0);
          return false;
        },
        click(_currentView, event) {
          if (!(event.target instanceof HTMLElement)) return false;
          const objectRef = event.target.closest<HTMLElement>(
            "[data-object-type][data-object-id]",
          );
          if (!objectRef || !host.contains(objectRef)) return false;
          event.preventDefault();
          onOpenObjectRef.current?.(
            objectRef.dataset.objectType ?? "",
            objectRef.dataset.objectId ?? "",
            workspaceTargetClickIntent(event).disposition,
          );
          return true;
        },
        drop(currentView, event) {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (files.length === 0) return false;
          event.preventDefault();
          void attachFiles(currentView, files);
          return true;
        },
        paste(currentView, event) {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length > 0) {
            event.preventDefault();
            void attachFiles(currentView, files);
            return true;
          }
          onHistoryBoundaryRef.current();
          return false;
        },
        keydown(currentView, event) {
          if (currentView.composing || event.isComposing || event.keyCode === 229) return false;
          if (menuOpenRef.current) {
            if (
              handleObjectRefMenuKeydown(event, {
                targets: targetsRef.current,
                activeKey: activeKeyRef.current,
                setActiveKey,
                close: closeObjectRefMenu,
                pick: insertObjectRef,
              })
            ) {
              return true;
            }
          }
          if (event.target instanceof HTMLElement) {
            const objectRef = event.target.closest<HTMLElement>(
              "[data-object-type][data-object-id]",
            );
            if (
              objectRef &&
              host.contains(objectRef) &&
              (event.key === "Enter" || event.key === " ")
            ) {
              event.preventDefault();
              onOpenObjectRef.current?.(
                objectRef.dataset.objectType ?? "",
                objectRef.dataset.objectId ?? "",
                workspaceTargetClickIntent(event).disposition,
              );
              return true;
            }
            if (
              event.target !== currentView.dom &&
              event.target.closest(
                "button, a, input, textarea, select, [contenteditable='false']",
              )
            ) {
              return false;
            }
          }
          if (
            event.key === "Backspace" &&
            onEmptyBackspaceRef.current &&
            isEmptyBodyAtStart(currentView.state)
          ) {
            event.preventDefault();
            onEmptyBackspaceRef.current();
            return true;
          }
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            onSplitRef.current &&
            !currentView.state.selection.$from.parent.type.spec.code
          ) {
            const split = splitNoteBodyAtSelection(currentView.state);
            if (!split) return false;
            event.preventDefault();
            onSplitRef.current(publicSplit(split));
            return true;
          }
          return false;
        },
      },
      dispatchTransaction(transaction) {
        const before = view.state;
        const nextState = before.apply(transaction);
        view.updateState(nextState);
        if (transaction.docChanged) {
          const explicit = transaction.getMeta(noteBodyEditSourceMeta) as
            | NoteBodyEditSource
            | undefined;
          const source: NoteBodyEditSource = explicit ??
            (transaction.getMeta("uiEvent") === "paste"
              ? "paste"
              : view.composing ? "composition" : "input");
          onEditRef.current({
            before: noteBodyValueFromDoc(before.doc),
            after: noteBodyValueFromDoc(nextState.doc),
            selectionBefore: bodySelection(before.selection),
            selectionAfter: bodySelection(nextState.selection),
            source,
          });
        } else if (!before.selection.eq(nextState.selection)) {
          onHistoryBoundaryRef.current();
          onSelectionChangeRef.current(bodySelection(nextState.selection));
        }
        refreshFormatState(nextState);
        if (view.hasFocus()) setToolbarOpen(!nextState.selection.empty);
        refreshObjectRefMenu(view, nextState);
      },
    });

    viewRef.current = view;
    setEditorReady(true);
    if (notePulseTargetRef.current) {
      applyNotePulseTarget(notePulseTargetRef.current);
    }
    if (focusRequestRef.current > 0) view.focus();
    return () => {
      if (notePulseTimeoutRef.current !== null) {
        window.clearTimeout(notePulseTimeoutRef.current);
        notePulseTimeoutRef.current = null;
      }
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
  }, [
    applyNotePulseTarget,
    attachFiles,
    autocompleteListboxId,
    closeObjectRefMenu,
    insertObjectRef,
    refreshFormatState,
    resourceKey,
  ]);

  if (defect) throw defect.error;

  return (
    <div
      ref={shellRef}
      className={styles.editorShell}
      onFocusCapture={() => {
        if (viewRef.current?.state.selection.empty === false) setToolbarOpen(true);
      }}
      onBlurCapture={() => {
        window.requestAnimationFrame(() => {
          if (shellRef.current?.contains(window.document.activeElement)) return;
          setToolbarOpen(false);
          closeObjectRefMenu();
        });
      }}
    >
      <div ref={hostRef} className={styles.editorHost} />
      {editable && toolbarOpen && trigger?.mode !== "link" ? (
        <div className={styles.formatToolbar} role="toolbar" aria-label="Text formatting">
          {FORMAT_CONTROLS.map(({ name, label, shortcut, Icon }) => (
            <button
              key={name}
              type="button"
              className={styles.formatButton}
              aria-label={label}
              aria-pressed={formatState[name]}
              title={`${label} (${shortcut})`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { runFormat(name); }}
            >
              <Icon size={16} aria-hidden="true" />
            </button>
          ))}
          <button
            type="button"
            className={styles.formatButton}
            aria-label="Link"
            title="Link (⌘/Ctrl+K)"
            onMouseDown={(event) => event.preventDefault()}
            onClick={openLinkMenu}
          >
            <Link2 size={16} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {trigger && (trigger.mode === "link" || targets.length > 0) ? (
        <div
          className={styles.autocomplete}
          style={{ left: trigger.left, top: trigger.top }}
        >
          {trigger.mode === "link" ? (
            <div className={styles.linkPicker}>
              <label className={styles.linkLabel} htmlFor={`${autocompleteListboxId}-input`}>
                Link address or note
              </label>
              <div className={styles.linkControls}>
                <input
                  ref={linkInputRef}
                  id={`${autocompleteListboxId}-input`}
                  className={styles.linkInput}
                  role="combobox"
                  aria-expanded
                  aria-controls={autocompleteListboxId}
                  aria-activedescendant={activeOptionId}
                  aria-label="Link address or note"
                  value={trigger.query}
                  onChange={(event) => {
                    setLinkError(null);
                    setTrigger((current) => current?.mode === "link"
                      ? { ...current, query: event.target.value }
                      : current);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      closeObjectRefMenu();
                      viewRef.current?.focus();
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      if (noteBodyHrefFromInput(trigger.query)) insertWebLink();
                      else {
                        const selected = targets.find(
                          (target) => resourceTargetKey(target) === activeKey,
                        ) ?? targets[0];
                        if (selected) insertObjectRef(selected);
                        else setLinkError("Enter a web address or choose a note.");
                      }
                    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      if (targets.length === 0) return;
                      const index = Math.max(0, targets.findIndex(
                        (target) => resourceTargetKey(target) === activeKey,
                      ));
                      const next = event.key === "ArrowDown" ? index + 1 : index - 1;
                      setActiveKey(resourceTargetKey(
                        targets[(next + targets.length) % targets.length]!,
                      ));
                    }
                  }}
                />
                <button
                  type="button"
                  className={styles.linkAdd}
                  disabled={!noteBodyHrefFromInput(trigger.query)}
                  onClick={insertWebLink}
                >
                  Add link
                </button>
              </div>
              {linkError ? <span className={styles.linkError} role="alert">{linkError}</span> : null}
            </div>
          ) : null}
          <ResourceTargetListbox
            id={autocompleteListboxId}
            ariaLabel={trigger.mode === "link" ? "Note references" : "Object references"}
            targets={targets}
            activeKey={activeKey}
            loading={loading}
            error={error}
            emptyMessage={trigger.mode === "link" ? "No notes found" : "No matches"}
            onHover={(target) => setActiveKey(resourceTargetKey(target))}
            onPick={insertObjectRef}
          />
        </div>
      ) : null}
    </div>
  );
}

function publicSplit(split: ProseMirrorNoteBodySplit): NoteBodySplit {
  return {
    leftBodyPmJson: split.left.bodyPmJson,
    leftBodyText: split.left.bodyText,
    rightBodyPmJson: split.right.bodyPmJson,
    rightBodyText: split.right.bodyText,
  };
}

function noteBodyPositionForTextOffset(
  doc: ProseMirrorNode,
  textOffset: number,
): number {
  const body = doc.firstChild;
  if (!body) return 1;
  const projection = projectNoteBody(body);
  const offset = Array.from(projection.text.slice(0, textOffset)).length;
  for (const span of projection.spans) {
    if (offset > span.endOffset) continue;
    if (span.kind === "inline" && span.exactText !== null) {
      const prefix = Array.from(span.exactText)
        .slice(0, Math.max(0, offset - span.startOffset))
        .join("");
      return span.from + prefix.length;
    }
    return offset <= span.startOffset ? span.from : span.to;
  }
  return Math.max(1, doc.content.size - 1);
}

function bodySelection(selection: Selection): NoteBodySelection {
  return { anchor: selection.anchor, head: selection.head };
}

function applyCanonicalDoc(
  view: EditorView,
  doc: ProseMirrorNode,
  restore?: NoteBodySelection,
): void {
  const transaction = view.state.tr.setMeta(noteBodyEditSourceMeta, "external");
  const from = view.state.doc.content.findDiffStart(doc.content);
  if (from !== null) {
    const end = view.state.doc.content.findDiffEnd(doc.content);
    if (!end) throw new Error("Changed note body has no diff end");
    transaction.replaceWith(from, end.a, doc.content.cut(from, end.b));
  }
  if (restore) {
    const anchor = Math.max(0, Math.min(restore.anchor, transaction.doc.content.size));
    const head = Math.max(0, Math.min(restore.head, transaction.doc.content.size));
    const body = transaction.doc.firstChild;
    const selection = body?.isTextblock
      ? TextSelection.create(transaction.doc, anchor, head)
      : Selection.near(transaction.doc.resolve(head));
    transaction.setSelection(selection);
  }
  if (transaction.docChanged || transaction.selectionSet) {
    view.updateState(view.state.apply(transaction));
  }
}

function noteBodyHrefFromInput(input: string): string | null {
  const trimmed = input.trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:/iu.test(trimmed);
  const candidate = !hasScheme && !trimmed.startsWith("/") &&
    /^(?:localhost(?:[:/]|$)|[^\s/:]+\.[^\s/:]+(?:[:/]|$))/iu.test(trimmed)
      ? `https://${trimmed}`
      : trimmed;
  return isSafeNoteBodyHref(candidate) ? candidate : null;
}

function compactPastedSlice(slice: Slice): Slice | null {
  const content: ProseMirrorNode[] = [];
  let blocks = 0;
  let standaloneEmbed = false;
  slice.content.forEach((node) => {
    if (node.isInline) {
      content.push(node);
      return;
    }
    if (node.type === noteBodySchema.nodes.object_embed) {
      standaloneEmbed = true;
      return;
    }
    if (node.type !== noteBodySchema.nodes.paragraph &&
        node.type !== noteBodySchema.nodes.code_block) {
      standaloneEmbed = true;
      return;
    }
    if (blocks > 0) content.push(noteBodySchema.nodes.hard_break!.create());
    blocks += 1;
    if (node.type === noteBodySchema.nodes.paragraph) {
      node.content.forEach((child) => content.push(child));
    } else {
      const lines = node.textContent.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (index > 0) content.push(noteBodySchema.nodes.hard_break!.create());
        if (lines[index]) content.push(noteBodySchema.text(lines[index]!));
      }
    }
  });
  if (standaloneEmbed) {
    return slice.content.childCount === 1 &&
      slice.content.firstChild?.type === noteBodySchema.nodes.object_embed
      ? slice : null;
  }
  if (blocks === 0) return slice;
  return new Slice(Fragment.fromArray(content), 0, 0);
}

function isMediaAttachmentDefect(error: unknown): boolean {
  return (
    error instanceof MediaAttachmentContractDefect ||
    isSameSystemApiDefect(error) ||
    (!isApiError(error) &&
      !(error instanceof TypeError) &&
      !(error instanceof DOMException))
  );
}

function canReplaceBodyWithAttachment(view: EditorView): boolean {
  const body = view.state.doc.firstChild;
  if (!body || (body.content.size === 0 && body.textContent.trim() === "")) {
    return true;
  }
  const selection = view.state.selection;
  return (
    !selection.empty &&
    selection.from <= 1 &&
    selection.to >= view.state.doc.content.size - 1
  );
}

function isEmptyBodyAtStart(state: EditorState): boolean {
  const body = state.doc.firstChild;
  return Boolean(
    body &&
      body.type === noteBodySchema.nodes.paragraph &&
      body.content.size === 0 &&
      state.selection.empty &&
      state.selection.from === 1,
  );
}

function createNotePulseDecorationPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: notePulseDecorationKey,
    state: {
      init: () => DecorationSet.empty,
      apply(transaction, decorations) {
        const meta = transaction.getMeta(notePulseDecorationKey) as
          | NotePulseEditorTarget
          | null
          | undefined;
        if (meta !== undefined) {
          return meta
            ? notePulseDecorations(transaction.doc, meta)
            : DecorationSet.empty;
        }
        return decorations.map(transaction.mapping, transaction.doc);
      },
    },
    props: {
      decorations(state) {
        return notePulseDecorationKey.getState(state) ?? DecorationSet.empty;
      },
    },
  });
}

function objectRefTriggerFromState(
  state: EditorState,
): ObjectRefTextRange | null {
  if (!state.selection.empty) return null;
  const { $from } = state.selection;
  if (!$from.parent.inlineContent) return null;
  const textBefore = $from.parent.textBetween(
    0,
    $from.parentOffset,
    "\n",
    "\n",
  );
  const pageMatch = /(^|\s)\[\[([A-Za-z0-9][A-Za-z0-9 _.'-]{0,79})$/.exec(
    textBefore,
  );
  if (pageMatch) {
    const query = pageMatch[2]!.trim();
    if (!query) return null;
    const linkIndex = pageMatch.index + pageMatch[1]!.length;
    return {
      from: $from.pos - ($from.parentOffset - linkIndex),
      to: $from.pos,
      query,
      filter: "page_note",
    };
  }
  const match = /(^|\s)@([A-Za-z0-9][A-Za-z0-9 _.'-]{0,79})$/.exec(textBefore);
  if (!match) return null;
  const query = match[2]!.trim();
  if (!query) return null;
  const atIndex = match.index + match[1]!.length;
  return {
    from: $from.pos - ($from.parentOffset - atIndex),
    to: $from.pos,
    query,
    filter: "all",
  };
}

function editorAttributes(input: {
  ariaLabel: string;
  compact: boolean;
  menuOpen: boolean;
  autocompleteListboxId: string;
  activeOptionId: string | undefined;
}): Record<string, string> {
  return {
    class: input.compact
      ? `${styles.editorView} ${styles.compact}`
      : styles.editorView,
    role: "textbox",
    "aria-label": input.ariaLabel,
    "aria-multiline": "true",
    "aria-expanded": input.menuOpen ? "true" : "false",
    ...(input.menuOpen
      ? {
          "aria-autocomplete": "list",
          "aria-controls": input.autocompleteListboxId,
          ...(input.activeOptionId
            ? { "aria-activedescendant": input.activeOptionId }
            : {}),
        }
      : {}),
  };
}

function handleObjectRefMenuKeydown(
  event: KeyboardEvent,
  input: {
    targets: ResourceTarget[];
    activeKey: string | null;
    setActiveKey: (key: string | null) => void;
    close: () => void;
    pick: (target: ResourceTarget) => void;
  },
): boolean {
  if (event.key === "Escape") {
    event.preventDefault();
    input.close();
    return true;
  }
  if (input.targets.length === 0) return false;
  const currentIndex = Math.max(
    0,
    input.targets.findIndex(
      (target) => resourceTargetKey(target) === input.activeKey,
    ),
  );
  const setIndex = (index: number) => {
    const target =
      input.targets[
        (index + input.targets.length) % input.targets.length
      ];
    if (target) input.setActiveKey(resourceTargetKey(target));
  };
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      setIndex(currentIndex + 1);
      return true;
    case "ArrowUp":
      event.preventDefault();
      setIndex(currentIndex - 1);
      return true;
    case "Home":
      event.preventDefault();
      setIndex(0);
      return true;
    case "End":
      event.preventDefault();
      setIndex(input.targets.length - 1);
      return true;
    case "Enter": {
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
        return false;
      }
      event.preventDefault();
      const selected =
        input.targets.find(
          (target) => resourceTargetKey(target) === input.activeKey,
        ) ?? input.targets[0];
      if (selected) input.pick(selected);
      return true;
    }
    default:
      return false;
  }
}
