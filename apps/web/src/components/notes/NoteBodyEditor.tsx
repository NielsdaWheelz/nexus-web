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
import { nextRovingIndexForKey } from "@/lib/ui/rovingIndex";
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
  onFeedback: (feedback: FeedbackContent) => void;
  onError?: (error: unknown) => void;
  notePulseTarget?: NotePulseEditorTarget | null;
  focusRequest?: number;
  onSplit?: (split: NoteBodySplit) => void;
  onEmptyBackspace?: () => void;
  onIndent?: () => void;
  onOutdent?: () => void;
  onSelectBlock?: () => void;
  onBoundaryJoin?: (direction: "backward" | "forward") => void;
  inputHandoff?: NoteBodyInputHandoff | null;
  onInputHandoffClaimed?: (handoffId: string) => void;
}

interface ObjectRefTextRange {
  from: number;
  to: number;
  query: string;
  filter: "all" | "page_note";
}

interface ObjectRefMenu extends ObjectRefTextRange {
  activeKey: string | null;
  error: string | null;
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

export default function NoteBodyEditor(props: NoteBodyEditorProps) {
  const {
    resourceKey,
    document,
    restoreSelection,
    inputHandoff,
    editable = true,
    ariaLabel = "Note content",
    compact = false,
    focusRequest = 0,
    notePulseTarget,
  } = props;
  const shellRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const linkInputRef = useRef<HTMLInputElement | null>(null);
  const autocompleteListboxId = useId();
  const doc = useMemo(
    () => createNoteBodyDoc({ bodyPmJson: document.body.bodyPmJson }),
    [document.body.bodyPmJson],
  );
  const inputs = useRef({ ...props, editable, ariaLabel, compact, focusRequest, doc });
  inputs.current = { ...props, editable, ariaLabel, compact, focusRequest, doc };
  const owner = useRef<{
    resourceKey: string;
    view: EditorView | null;
    state: EditorState;
    revision: number;
    focused: boolean;
  } | null>(null);
  const claimedHandoffs = useRef(new Set<string>());
  const restoredToken = useRef<number | null>(null);
  const pulseTimeout = useRef<number | null>(null);
  const attachmentBusy = useRef(false);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [formatState, setFormatState] = useState<FormatState>(EMPTY_FORMAT_STATE);
  const [menu, setMenu] = useState<ObjectRefMenu | null>(null);
  const menuRef = useRef<ObjectRefMenu | null>(null);
  const handleUnauthenticatedApiError = useUnauthenticatedApiHandler();

  const publishMenu = useCallback((next: ObjectRefMenu | null) => {
    menuRef.current = next;
    setMenu(next);
  }, []);
  const closeMenu = useCallback(() => publishMenu(null), [publishMenu]);
  const schemes = menu?.filter === "page_note" ? PAGE_NOTE_SCHEMES : undefined;
  const { targets, loading, error } = useResourceTargetSearch({
    purpose: "reference",
    query: menu?.query ?? "",
    schemes,
  });
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  useEffect(() => {
    const current = menuRef.current;
    if (!current) return;
    const activeKey = current.activeKey &&
      targets.some(target => resourceTargetKey(target) === current.activeKey)
      ? current.activeKey : (targets[0] ? resourceTargetKey(targets[0]) : null);
    if (activeKey !== current.activeKey) publishMenu({ ...current, activeKey });
  }, [menu, publishMenu, targets]);

  const chooseKey = useCallback((activeKey: string) => {
    const current = menuRef.current;
    if (current) publishMenu({ ...current, activeKey });
  }, [publishMenu]);

  const moveMenuSelection = useCallback((key: string, homeEnd: boolean): boolean => {
    const current = menuRef.current;
    if (!current) return false;
    const rows = targetsRef.current;
    const next = nextRovingIndexForKey({
      key,
      currentIndex: Math.max(0, rows.findIndex(
        target => resourceTargetKey(target) === current.activeKey,
      )),
      itemCount: rows.length,
      orientation: "vertical",
      wrap: true,
      homeEnd,
    });
    if (next === null) return false;
    chooseKey(resourceTargetKey(rows[next]!));
    return true;
  }, [chooseKey]);

  const refreshFormatState = useCallback((state: EditorState) => {
    const marks = state.storedMarks ?? state.selection.$from.marks();
    const next = { ...EMPTY_FORMAT_STATE };
    for (const name of Object.keys(next) as NoteBodyFormat[]) {
      const type = noteBodySchema.marks[name];
      next[name] = Boolean(type && (state.selection.empty
        ? type.isInSet(marks)
        : state.doc.rangeHasMark(state.selection.from, state.selection.to, type)));
    }
    setFormatState(current => (Object.keys(next) as NoteBodyFormat[]).every(
      name => current[name] === next[name],
    ) ? current : next);
  }, []);

  const runFormat = useCallback((name: NoteBodyFormat): boolean => {
    const view = owner.current?.view;
    if (!view || !inputs.current.editable || view.composing) return false;
    inputs.current.onHistoryBoundary();
    const changed = toggleNoteBodyFormat(name, view.state, view.dispatch);
    if (changed) {
      refreshFormatState(view.state);
      view.focus();
    }
    return changed;
  }, [refreshFormatState]);

  const openMenu = useCallback((view: EditorView, range: ObjectRefTextRange, mode: "reference" | "link") => {
    const shell = shellRef.current;
    if (!shell || !inputs.current.editable) {
      closeMenu();
      return;
    }
    const caret = view.coordsAtPos(range.to);
    const box = shell.getBoundingClientRect();
    publishMenu({
      ...range,
      mode,
      activeKey: menuRef.current?.activeKey ?? null,
      error: null,
      selectedText: view.state.doc.textBetween(range.from, range.to, " ", " "),
      left: Math.max(0, caret.left - box.left),
      top: Math.max(0, caret.bottom - box.top + 6),
    });
  }, [closeMenu, publishMenu]);

  const openLinkMenu = useCallback((): boolean => {
    const view = owner.current?.view;
    if (!view || !shellRef.current || !inputs.current.editable || view.composing) return false;
    if (!(view.state.selection instanceof TextSelection)) return false;
    const { from, to } = view.state.selection;
    inputs.current.onHistoryBoundary();
    openMenu(view, {
      from,
      to,
      filter: "all",
      query: view.state.doc.textBetween(from, to, " ", " ").trim()
        .slice(0, OBJECT_REF_SEARCH_QUERY_MAX_LENGTH),
    }, "link");
    return true;
  }, [openMenu]);

  const selectionStillMatches = useCallback((view: EditorView, current: ObjectRefMenu, kind: "reference" | "link") => {
    if (current.to <= view.state.doc.content.size &&
        view.state.doc.textBetween(current.from, current.to, " ", " ") === current.selectedText) return true;
    closeMenu();
    inputs.current.onFeedback({
      tone: "Warning",
      title: "Selection changed",
      message: `The selected text changed. Select it again to add a ${kind}.`,
    });
    return false;
  }, [closeMenu]);

  const insertObjectRef = useCallback((target: ResourceTarget) => {
    const view = owner.current?.view;
    const current = menuRef.current;
    if (!view || !current || target.kind !== "resource") return;
    const parsed = parseResourceRef(target.item.ref);
    if (!parsed || !selectionStillMatches(view, current, "reference")) return;
    const node = noteBodySchema.nodes.object_ref!.create({
      objectType: parsed.scheme,
      objectId: parsed.id,
      label: target.item.label,
    });
    const space = noteBodySchema.text(" ");
    inputs.current.onHistoryBoundary();
    const tr = view.state.tr.setMeta(noteBodyEditSourceMeta, "reference")
      .replaceWith(current.from, current.to, Fragment.fromArray([node, space]));
    tr.setSelection(TextSelection.create(tr.doc, current.from + node.nodeSize + space.nodeSize));
    closeMenu();
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }, [closeMenu, selectionStillMatches]);

  const insertWebLink = useCallback(() => {
    const view = owner.current?.view;
    const current = menuRef.current;
    if (!view || !current || current.mode !== "link") return;
    const href = noteBodyHrefFromInput(current.query);
    if (!href) {
      publishMenu({ ...current, error: "Enter a web address, email address, or local path." });
      return;
    }
    if (!selectionStillMatches(view, current, "link")) return;
    const mark = noteBodySchema.marks.link!.create({ href });
    inputs.current.onHistoryBoundary();
    const tr = view.state.tr.setMeta(noteBodyEditSourceMeta, "format");
    if (current.from === current.to) {
      tr.insertText(href, current.from, current.to);
      tr.addMark(current.from, current.from + href.length, mark);
      tr.setSelection(TextSelection.create(tr.doc, current.from + href.length));
      tr.removeStoredMark(noteBodySchema.marks.link!);
    } else {
      tr.addMark(current.from, current.to, mark);
      tr.setSelection(TextSelection.create(tr.doc, current.from, current.to));
    }
    closeMenu();
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }, [closeMenu, publishMenu, selectionStillMatches]);

  const applyPulse = useCallback((target: NotePulseEditorTarget | null) => {
    if (pulseTimeout.current !== null) {
      window.clearTimeout(pulseTimeout.current);
      pulseTimeout.current = null;
    }
    const view = owner.current?.view;
    if (!view) return;
    view.dispatch(view.state.tr.setMeta(notePulseDecorationKey, target));
    if (!target) return;
    view.dom.querySelector<HTMLElement>("[data-note-pulse-range]")?.scrollIntoView({ block: "center" });
    pulseTimeout.current = window.setTimeout(() => {
      pulseTimeout.current = null;
      const current = owner.current?.view;
      if (current) current.dispatch(current.state.tr.setMeta(notePulseDecorationKey, null));
    }, NOTE_PULSE_RANGE_DURATION_MS);
  }, []);

  const insertMedia = useCallback((view: EditorView, mediaId: string, label: string): boolean => {
    if (!canReplaceBodyWithAttachment(view)) return false;
    const embed = noteBodySchema.nodes.object_embed!.create({
      objectType: "media",
      objectId: mediaId,
      label,
      relationType: "embeds",
      displayMode: "compact",
    });
    inputs.current.onHistoryBoundary();
    view.dispatch(view.state.tr.setMeta(noteBodyEditSourceMeta, "attachment")
      .replaceWith(0, view.state.doc.content.size, embed).scrollIntoView());
    return true;
  }, []);

  const attachFiles = useCallback(async (view: EditorView, files: File[]) => {
    if (!inputs.current.editable || files.length === 0) return;
    const refuse = (message: string) => inputs.current.onFeedback({
      tone: "Danger",
      title: "Attachment wasn’t added",
      message,
    });
    if (!canReplaceBodyWithAttachment(view)) {
      refuse("Select the note body or empty it before attaching a file.");
      return;
    }
    if (files.length > 1) {
      refuse("Attach one file at a time here.");
      return;
    }
    const file = files[0]!;
    const uploadError = getFileUploadError(file);
    if (uploadError) {
      refuse(uploadError);
      return;
    }
    attachmentBusy.current = true;
    view.setProps({ editable: () => false });
    try {
      const upload = await uploadIngestFile({ file, libraryIds: [] });
      if (!insertMedia(view, upload.mediaId, file.name)) {
        throw new MediaAttachmentContractDefect("The published attachment target changed unexpectedly.");
      }
    } catch (caught: unknown) {
      if (handleUnauthenticatedApiError(caught)) return;
      if (caught instanceof UploadSessionError) {
        try {
          inputs.current.onFeedback(mediaCaptureErrorMessage(caught, "AddAttachment"));
        } catch (caughtDefect: unknown) {
          setDefect({ error: caughtDefect });
        }
        return;
      }
      if (isMediaAttachmentDefect(caught)) {
        setDefect({ error: caught });
        return;
      }
      inputs.current.onError?.(caught);
    } finally {
      attachmentBusy.current = false;
      view.setProps({ editable: () => inputs.current.editable });
    }
  }, [handleUnauthenticatedApiError, insertMedia]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    function refreshObjectRefMenu(view: EditorView, state: EditorState) {
      if (menuRef.current?.mode === "link") return;
      const range = objectRefTriggerFromState(state);
      if (range) openMenu(view, range, "reference");
      else closeMenu();
    }
    const previous = owner.current?.resourceKey === resourceKey ? owner.current : null;
    const state = previous?.state ?? EditorState.create({
      schema: noteBodySchema,
      doc: inputs.current.doc,
      plugins: [
        createNotePulseDecorationPlugin(),
        createNoteBodyKeymap({
          format: runFormat,
          link: openLinkMenu,
          undo: () => {
            inputs.current.onHistoryBoundary();
            inputs.current.onUndoRequest();
          },
          redo: () => {
            inputs.current.onHistoryBoundary();
            inputs.current.onRedoRequest();
          },
        }),
        createObjectRefSyntaxPlugin(),
      ],
    });
    const view = new EditorView(host, {
      state,
      attributes: editorAttributes({
        ariaLabel: inputs.current.ariaLabel,
        compact: inputs.current.compact,
        menuOpen: false,
        autocompleteListboxId,
        activeOptionId: undefined,
      }),
      editable: () => inputs.current.editable && !attachmentBusy.current,
      transformPasted(slice) {
        if (view.state.selection.$from.parent.type.spec.code) return slice;
        return compactPastedSlice(slice) ?? slice;
      },
      handlePaste(currentView, _event, slice) {
        const embedded = slice.content.childCount === 1 &&
          slice.content.firstChild?.type === noteBodySchema.nodes.object_embed;
        if (embedded && !canReplaceBodyWithAttachment(currentView)) {
          inputs.current.onFeedback({
            tone: "Warning",
            title: "Paste not applied",
            message: "Select the note body or empty it before pasting an embedded item.",
          });
          return true;
        }
        if (compactPastedSlice(slice) !== null) return false;
        inputs.current.onFeedback({
          tone: "Warning",
          title: "Paste not applied",
          message: "Paste one embedded item at a time.",
        });
        return true;
      },
      handleDOMEvents: {
        focus(currentView) {
          refreshFormatState(currentView.state);
          setToolbarOpen(!currentView.state.selection.empty);
          inputs.current.onFocusChange?.(true);
          return false;
        },
        blur() {
          inputs.current.onHistoryBoundary();
          inputs.current.onFocusChange?.(false);
          inputs.current.onFlushRequest();
          return false;
        },
        compositionstart() {
          inputs.current.onHistoryBoundary();
          return false;
        },
        compositionend() {
          inputs.current.onHistoryBoundary();
          window.setTimeout(() => {
            const current = owner.current;
            const latest = inputs.current;
            if (!current?.view || current.view.composing ||
                latest.document.revision <= current.revision) return;
            applyCanonicalDoc(current.view, latest.doc);
            current.revision = latest.document.revision;
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
          inputs.current.onOpenObject?.(
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
          inputs.current.onHistoryBoundary();
          return false;
        },
        keydown(currentView, event) {
          if (currentView.composing || event.isComposing || event.keyCode === 229) return false;
          const currentMenu = menuRef.current;
          if (currentMenu?.mode === "reference" && targetsRef.current.length > 0) {
            if (event.key === "Escape") {
              event.preventDefault();
              closeMenu();
              return true;
            }
            if (moveMenuSelection(event.key, true)) {
              event.preventDefault();
              return true;
            }
            if (event.key === "Enter" &&
                !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
              event.preventDefault();
              const selected = targetsRef.current.find(
                target => resourceTargetKey(target) === currentMenu.activeKey,
              ) ?? targetsRef.current[0];
              if (selected) insertObjectRef(selected);
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
              inputs.current.onOpenObject?.(
                objectRef.dataset.objectType ?? "",
                objectRef.dataset.objectId ?? "",
                workspaceTargetClickIntent(event).disposition,
              );
              return true;
            }
          }
          return false;
        },
      },
      handleKeyDown(currentView, event) {
        if (currentView.composing || event.isComposing || event.keyCode === 229) return false;
        if (event.target instanceof HTMLElement && event.target !== currentView.dom &&
            event.target.closest("button, a, input, textarea, select, [contenteditable='false']")) return false;
        const structural = inputs.current;
        if ((event.key === "Enter" && inputs.current.onSplit) ||
            (event.key === "Backspace" && (inputs.current.onEmptyBackspace || structural.onBoundaryJoin)) ||
            (event.key === "Delete" && structural.onBoundaryJoin) ||
            (event.key === "Tab" && (structural.onIndent || structural.onOutdent)) ||
            (event.key === "Escape" && structural.onSelectBlock)) {
          // Native navigation can move the caret before selectionchange fires.
          // Structural commands must use that caret, not the previous PM state.
          const native = currentView.dom.ownerDocument.getSelection();
          if (native?.anchorNode && native.focusNode &&
              currentView.dom.contains(native.anchorNode) && currentView.dom.contains(native.focusNode)) {
            const anchor = currentView.posAtDOM(native.anchorNode, native.anchorOffset);
            const head = currentView.posAtDOM(native.focusNode, native.focusOffset);
            const state = currentView.state;
            if ((anchor !== state.selection.anchor || head !== state.selection.head) &&
                state.doc.resolve(anchor).parent.inlineContent && state.doc.resolve(head).parent.inlineContent) {
              currentView.dispatch(state.tr.setSelection(TextSelection.create(state.doc, anchor, head)));
            }
          }
        }
        if (event.key === "Escape" && structural.onSelectBlock) {
          event.preventDefault(); structural.onSelectBlock(); return true;
        }
        if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
          const action = event.shiftKey ? structural.onOutdent : structural.onIndent;
          if (action) { event.preventDefault(); action(); return true; }
        }
        if (structural.onBoundaryJoin && currentView.state.selection.empty &&
            currentView.state.selection.$from.parent.type === noteBodySchema.nodes.paragraph &&
            !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
          const position = currentView.state.selection.$from;
          if (event.key === "Backspace" && position.parentOffset === 0 && position.parent.content.size > 0) {
            event.preventDefault(); structural.onBoundaryJoin("backward"); return true;
          }
          if (event.key === "Delete" && position.parentOffset === position.parent.content.size) {
            event.preventDefault(); structural.onBoundaryJoin("forward"); return true;
          }
        }
        if (
          event.key === "Backspace" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey &&
          inputs.current.onEmptyBackspace &&
          isEmptyBodyAtStart(currentView.state)
        ) {
          event.preventDefault();
          inputs.current.onEmptyBackspace();
          return true;
        }
        if (
          event.key === "Enter" &&
          !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey &&
          inputs.current.onSplit &&
          !currentView.state.selection.$from.parent.type.spec.code
        ) {
          const split = splitNoteBodyAtSelection(currentView.state);
          if (!split) return false;
          event.preventDefault();
          inputs.current.onSplit(publicSplit(split));
          return true;
        }
        return false;
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
          inputs.current.onEdit({
            before: noteBodyValueFromDoc(before.doc),
            after: noteBodyValueFromDoc(nextState.doc),
            selectionBefore: bodySelection(before.selection),
            selectionAfter: bodySelection(nextState.selection),
            source,
          });
        } else if (!before.selection.eq(nextState.selection)) {
          inputs.current.onHistoryBoundary();
          inputs.current.onSelectionChange(bodySelection(nextState.selection));
        }
        refreshFormatState(nextState);
        if (view.hasFocus()) setToolbarOpen(!nextState.selection.empty);
        refreshObjectRefMenu(view, nextState);
      },
    });

    owner.current = {
      resourceKey,
      view,
      state: view.state,
      revision: previous?.revision ?? inputs.current.document.revision,
      focused: false,
    };
    if (inputs.current.notePulseTarget) applyPulse(inputs.current.notePulseTarget);
    if (previous ? previous.focused : inputs.current.focusRequest > 0) view.focus();
    return () => {
      if (pulseTimeout.current !== null) {
        window.clearTimeout(pulseTimeout.current);
        pulseTimeout.current = null;
      }
      const current = owner.current;
      if (current?.view === view) {
        current.state = view.state;
        current.focused = view.hasFocus();
        current.view = null;
      }
      view.destroy();
    };
  }, [
    applyPulse, attachFiles, autocompleteListboxId, closeMenu, insertObjectRef,
    openLinkMenu, openMenu, refreshFormatState, resourceKey, runFormat, moveMenuSelection,
  ]);

  useLayoutEffect(() => {
    const current = owner.current;
    if (!current?.view || !inputHandoff || inputHandoff.composition !== "Complete" ||
        claimedHandoffs.current.has(inputHandoff.handoffId)) return;
    const maxOffset = doc.firstChild ? projectNoteBody(doc.firstChild).text.length : 0;
    const start = Math.min(inputHandoff.selectionStart, maxOffset);
    const end = Math.min(inputHandoff.selectionEnd, maxOffset);
    claimedHandoffs.current.add(inputHandoff.handoffId);
    applyCanonicalDoc(current.view, doc, {
      anchor: noteBodyPositionForTextOffset(doc, start),
      head: noteBodyPositionForTextOffset(doc, Math.max(start, end)),
    });
    current.revision = document.revision;
    current.view.focus();
    inputs.current.onInputHandoffClaimed?.(inputHandoff.handoffId);
  }, [doc, document.revision, inputHandoff, resourceKey]);

  useEffect(() => {
    const current = owner.current;
    if (!current?.view || current.view.composing || document.revision <= current.revision) return;
    applyCanonicalDoc(current.view, doc);
    current.revision = document.revision;
  }, [doc, document.revision, resourceKey]);

  useEffect(() => {
    const current = owner.current;
    if (!current?.view || !restoreSelection || restoredToken.current === restoreSelection.token) return;
    restoredToken.current = restoreSelection.token;
    applyCanonicalDoc(current.view, inputs.current.doc, restoreSelection.selection);
  }, [resourceKey, restoreSelection]);

  useEffect(() => {
    owner.current?.view?.setProps({ editable: () => inputs.current.editable && !attachmentBusy.current });
    if (!editable) closeMenu();
  }, [closeMenu, editable]);
  useEffect(() => {
    if (focusRequest > 0) owner.current?.view?.focus();
  }, [focusRequest]);
  useEffect(() => {
    applyPulse(notePulseTarget ?? null);
  }, [applyPulse, notePulseTarget]);
  useEffect(() => {
    if (menu?.mode === "link") linkInputRef.current?.focus();
  }, [menu?.mode]);

  const menuOpen = Boolean(menu && (menu.mode === "link" || targets.length > 0));
  const activeOptionId = menu?.activeKey ? `${autocompleteListboxId}-option-${menu.activeKey}` : undefined;
  useLayoutEffect(() => {
    owner.current?.view?.setProps({
      attributes: editorAttributes({
        ariaLabel, compact, menuOpen, autocompleteListboxId, activeOptionId,
      }),
    });
  }, [activeOptionId, ariaLabel, autocompleteListboxId, compact, menuOpen, resourceKey]);

  if (defect) throw defect.error;
  return (
    <div ref={shellRef} className={styles.editorShell}
      onFocusCapture={() => {
        if (owner.current?.view?.state.selection.empty === false) setToolbarOpen(true);
      }}
      onBlurCapture={() => {
        window.requestAnimationFrame(() => {
          if (shellRef.current?.contains(window.document.activeElement)) return;
          setToolbarOpen(false);
          closeMenu();
        });
      }}
    >
      <div ref={hostRef} className={styles.editorHost} />
      {editable && toolbarOpen && menu?.mode !== "link" ? (
        <div className={styles.formatToolbar} role="toolbar" aria-label="Text formatting">
          {FORMAT_CONTROLS.map(({ name, label, shortcut, Icon }) => (
            <button key={name} type="button" className={styles.formatButton}
              aria-label={label} aria-pressed={formatState[name]} title={`${label} (${shortcut})`}
              onMouseDown={event => event.preventDefault()} onClick={() => { runFormat(name); }}
            ><Icon size={16} aria-hidden="true" /></button>
          ))}
          <button type="button" className={styles.formatButton} aria-label="Link" title="Link (⌘/Ctrl+K)"
            onMouseDown={event => event.preventDefault()} onClick={openLinkMenu}
          ><Link2 size={16} aria-hidden="true" /></button>
        </div>
      ) : null}
      {menu && menuOpen ? (
        <div className={styles.autocomplete} style={{ left: menu.left, top: menu.top }}>
          {menu.mode === "link" ? (
            <div className={styles.linkPicker}>
              <label className={styles.linkLabel} htmlFor={`${autocompleteListboxId}-input`}>Link address or note</label>
              <div className={styles.linkControls}>
                <input ref={linkInputRef} id={`${autocompleteListboxId}-input`} className={styles.linkInput}
                  role="combobox" aria-expanded aria-controls={autocompleteListboxId}
                  aria-activedescendant={activeOptionId} aria-label="Link address or note" value={menu.query}
                  onChange={event => {
                    const current = menuRef.current;
                    if (current) publishMenu({ ...current, query: event.target.value, error: null });
                  }}
                  onKeyDown={event => {
                    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                    const current = menuRef.current;
                    if (!current) return;
                    if (event.key === "Escape") {
                      event.preventDefault();
                      closeMenu();
                      owner.current?.view?.focus();
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      if (noteBodyHrefFromInput(current.query)) insertWebLink();
                      else {
                        const selected = targets.find(target => resourceTargetKey(target) === current.activeKey) ?? targets[0];
                        if (selected) insertObjectRef(selected);
                        else publishMenu({ ...current, error: "Enter a web address or choose a note." });
                      }
                    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      moveMenuSelection(event.key, false);
                    }
                  }}
                />
                <button type="button" className={styles.linkAdd} disabled={!noteBodyHrefFromInput(menu.query)} onClick={insertWebLink}>Add link</button>
              </div>
              {menu.error ? <span className={styles.linkError} role="alert">{menu.error}</span> : null}
            </div>
          ) : null}
          <ResourceTargetListbox id={autocompleteListboxId}
            ariaLabel={menu.mode === "link" ? "Note references" : "Object references"}
            targets={targets} activeKey={menu.activeKey} loading={loading} error={error}
            emptyMessage={menu.mode === "link" ? "No notes found" : "No matches"}
            onHover={target => chooseKey(resourceTargetKey(target))} onPick={insertObjectRef}
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
