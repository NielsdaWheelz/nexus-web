"use client";

// One note body editor: a ProseMirror view over one block, its formatting toolbar and
// link dialog, paste normalised to one block, one dropped or pasted file uploaded into
// a media embed, shared resource rows, persistent source inspection and, in an
// outline, the structural keys. Undo is the outline's when `history` is given, else
// the editor's own. The view lives for one `editorKey` in one visit. Canonical body
// changes reach peers independent of revision; own echoes are diff no-ops. The diff
// never runs while composing or enters local history. Embedded
// atom deletion changes this containing body through its existing versioned save.
// With a coarse pointer, boundary deletion requires explicit block selection:
// software keyboards can report held deletion as successive fresh key presses.
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { readWriting, subscribeWriting } from "@/lib/notes/journal";
import { createPortal } from "react-dom";
import ReferencePicker from "@/components/resources/ReferencePicker";
import {
  useReferenceInput,
  type ReferenceInputHost,
} from "@/lib/resourceGraph/useReferenceInput";
import ResourceOutlineList, {
  ResourceBranch,
  ResourceOutlineContext,
} from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import ResourceLink from "@/components/resources/ResourceLink";
import {
  enterOutlineOccurrence,
  type OutlineBranch,
} from "@/lib/resources/outlineProjection";
import { resolveResourceItem, type ResourceItem } from "@/lib/resources/items";
import { Fragment, Slice, type Node as PMNode } from "prosemirror-model";
import {
  AllSelection,
  EditorState,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import { DecorationSet, EditorView } from "prosemirror-view";
import {
  history as ownHistory,
  redo as ownRedo,
  undo as ownUndo,
} from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import {
  Bold,
  Code2,
  Italic,
  Link2,
  Strikethrough,
  Underline,
} from "lucide-react";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { FieldFeedback, useFeedback } from "@/components/feedback/Feedback";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { getFileUploadError, uploadIngestFile } from "@/lib/imports/ingest";
import { captureErrorFeedback } from "@/lib/imports/copy";
import { holdBrowserWork } from "@/lib/unsavedWork";
import {
  bodyFromNode,
  docFromBody,
  hrefFromInput,
  noteBodySchema as schema,
  inspectionDecorations,
  type NoteBody,
} from "@/lib/notes/noteBody";
import type { FocusSelection, NoteEdit } from "@/lib/notes/useOutlineSession";
import "prosemirror-view/style/prosemirror.css";
import styles from "./NoteEditor.module.css";

export interface NoteInspection {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly activationId: string;
  readonly signal: AbortSignal;
  readonly mayFocus: () => boolean;
  readonly restored: boolean;
}

/** What an outline row does with the keys that change structure. */
export interface StructuralKeys {
  split?(left: NoteBody, right: NoteBody): void;
  emptyBackspace?(): void;
  join?(direction: "backward" | "forward"): void;
  indent?(at: { anchor: number; head: number }): void;
  outdent?(at: { anchor: number; head: number }): void;
  selectBlock?(): void;
}

export interface NoteEditorProps {
  reference?: ReferenceInputHost | null;
  editorKey: string;
  occurrenceKey?: string;
  /** The acknowledged note identity; drafts supply null. */
  containingNoteRef: string | null;
  body: NoteBody;
  revision: number;
  editable: boolean;
  label: string;
  placeholder?: string;
  compact?: boolean;
  inspection?: NoteInspection | null;
  embeddedItem?: ResourceItem | null;
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
  onSave?(): void;
  onNewChat?(): void;
  onContinueChat?(): void;
  onEmptyBackspace?(): void;
}

// [mark, label, key]; the title spells the key as "⌘/Ctrl+B".
const FORMATS = [
  ["strong", "Bold", "Mod-b", Bold],
  ["em", "Italic", "Mod-i", Italic],
  ["underline", "Underline", "Mod-u", Underline],
  ["strikethrough", "Strikethrough", "Shift-Mod-s", Strikethrough],
  ["code", "Inline code", "Mod-e", Code2],
] as const;
type Format = (typeof FORMATS)[number][0];
const shortcut = (key: string) =>
  `⌘/Ctrl+${key.startsWith("Shift") ? "Shift+" : ""}${key.at(-1)!.toUpperCase()}`;
const SOURCE = "noteEditSource";
const inspectionKey = new PluginKey<DecorationSet>("noteInspection");

interface LinkDialog {
  from: number;
  to: number;
  text: string;
  query: string;
  error: string | null;
  left: number;
  top: number;
}

export default function NoteEditor(props: NoteEditorProps) {
  const paused = useSyncExternalStore(subscribeWriting, () => readWriting().paused, () => true);
  const inheritedBranch = useContext(ResourceBranch);
  const outline = useContext(ResourceOutlineContext);
  const occurrenceKey = props.occurrenceKey ?? props.editorKey;
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
  const latest = useRef(props);
  latest.current = { ...props, editable: props.editable && !paused };
  const busy = useRef(false);
  const linkInputId = useId();
  const linkErrorId = useId();
  const linkInput = useRef<HTMLInputElement | null>(null);
  const [embed, setEmbed] = useState<{ dom: HTMLElement; ref: string } | null>(
    null,
  );
  const [toolbar, setToolbar] = useState(false);
  const [active, setActive] = useState<ReadonlySet<Format>>(new Set());
  const [link, setLink] = useState<LinkDialog | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const feedback = useFeedback();
  const reference = useReferenceInput(props.editorKey, props.reference ?? null);
  latest.current = { ...props, editable: props.editable && !paused && reference.ready };
  const referenceRef = useRef(reference);
  referenceRef.current = reference;
  const referenceId = `reference-${useId().replaceAll(":", "")}`;
  const suspended = useRef(false);
  const [referenceFocused, setReferenceFocused] = useState(false);
  const [referenceVisible, setReferenceVisible] = useState(true);
  const literalSuppressed = useRef(false);
  const compositionBase = useRef<{
    body: NoteBody;
    selection: { anchor: number; head: number };
  } | null>(null);
  const completedReference = useRef({
    key: reference.owner,
    completion: reference.completion,
  });
  const literal = (view: EditorView) => {
    const intent = referenceRef.current.getState();
    if (!intent) return;
    const consumed = referenceRef.current.literal();
    if (consumed === false) return;
    literalSuppressed.current = true;
    const doc = view.state.doc;
    const selection = {
      anchor: view.state.selection.anchor,
      head: view.state.selection.head,
    };
    const after = bodyFromNode(doc.firstChild!);
    // Query undo was local. Conversion enters prose history as one edit.
    view.updateState(
      EditorState.create({
        doc: docFromBody(intent.base),
        plugins: view.state.plugins,
      }),
    );
    const tr = view.state.tr
      .replaceWith(0, view.state.doc.content.size, doc.content)
      .setMeta(SOURCE, "external");
    tr.setSelection(
      TextSelection.create(tr.doc, selection.anchor, selection.head),
    );
    view.dispatch(tr);
    latest.current.onEdit({
      before: intent.base,
      after,
      selectionBefore: { anchor: 1, head: 1 },
      selectionAfter: selection,
      source: "input",
      referenceBase: {
        value: intent.base,
        acknowledged: intent.referenceBase?.acknowledged ?? null,
        consumed_reference: consumed,
      },
    });
  };
  const handleUnauthenticated = useUnauthenticatedApiHandler();
  const warn = useCallback(
    (title: string, message: string) =>
      feedback.offer({
        key: "note-attachment",
        announcement: "Polite",
        content: { tone: "Warning", title, message },
      }),
    [feedback],
  );

  const refreshMarks = useCallback((state: EditorState) => {
    const stored = state.storedMarks ?? state.selection.$from.marks();
    const { from, to, empty } = state.selection;
    const on = FORMATS.filter(([name]) => {
      const type = schema.marks[name]!;
      return empty
        ? type.isInSet(stored)
        : state.doc.rangeHasMark(from, to, type);
    });
    setActive(new Set(on.map(([name]) => name)));
  }, []);

  const format = useCallback((name: Format): boolean => {
    const view = viewRef.current;
    if (
      !view ||
      !latest.current.editable ||
      view.composing ||
      referenceRef.current.getState() !== null
    )
      return false;
    const { from, to, empty, $from } = view.state.selection;
    if ($from.parent.type.spec.code) return false;
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
  }, []);

  const openLink = useCallback((): boolean => {
    const view = viewRef.current;
    const box = shell.current?.getBoundingClientRect();
    if (
      !view ||
      !box ||
      !latest.current.editable ||
      view.composing ||
      referenceRef.current.getState() !== null
    )
      return false;
    if (!(view.state.selection instanceof TextSelection)) return false;
    const { from, to } = view.state.selection;
    const caret = view.coordsAtPos(to);
    const text = view.state.doc.textBetween(from, to, " ", " ");
    latest.current.history?.boundary();
    setLink({
      from,
      to,
      text,
      query: hrefFromInput(text) ?? "",
      error: null,
      left: Math.max(0, caret.left - box.left),
      top: Math.max(0, caret.bottom - box.top + 6),
    });
    return true;
  }, []);

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
        error: "Enter a web address, email address, or local path.",
      });
    const size = view.state.doc.content.size;
    if (
      link.to > size ||
      view.state.doc.textBetween(link.from, link.to, " ", " ") !== link.text
    ) {
      setLink(null);
      return warn(
        "Selection changed",
        "The selected text changed. Select it again to add a link.",
      );
    }
    const mark = schema.marks.link!.create({ href });
    const tr = view.state.tr.setMeta(SOURCE, "format");
    if (link.from === link.to) {
      tr.insertText(href, link.from).addMark(
        link.from,
        link.from + href.length,
        mark,
      );
      tr.setSelection(TextSelection.create(tr.doc, link.from + href.length));
      tr.removeStoredMark(schema.marks.link!);
    } else {
      tr.addMark(link.from, link.to, mark);
      tr.setSelection(TextSelection.create(tr.doc, link.from, link.to));
    }
    setLink(null);
    view.dispatch(tr.scrollIntoView());
    view.focus();
  };

  const attach = useCallback(
    async (view: EditorView, files: File[]) => {
      const refuse = (message: string) =>
        feedback.offer({
          key: "note-attachment",
          announcement: "Polite",
          content: {
            tone: "Danger",
            title: "Attachment wasn’t added",
            message,
          },
        });
      if (!latest.current.editable || referenceRef.current.getState() !== null)
        return;
      if (!replaceable(view))
        return refuse(
          "Select the note body or empty it before attaching a file.",
        );
      if (!navigator.onLine) return refuse("connect to add this attachment.");
      if (files.length > 1) return refuse("Attach one file at a time here.");
      const problem = getFileUploadError(files[0]!);
      if (problem) return refuse(problem);
      busy.current = true;
      const releaseWork = holdBrowserWork();
      view.setProps({ editable: () => false });
      try {
        const upload = await uploadIngestFile({
          file: files[0]!,
          libraryIds: [],
          id: crypto.randomUUID(),
        });
        if (view.isDestroyed || !latest.current.editable || !replaceable(view))
          return refuse("The note changed before the upload finished.");
        const embed = schema.nodes.object_embed!.create({
          objectType: "media",
          objectId: upload.mediaId,
          label: files[0]!.name,
          relationType: "embeds",
          displayMode: "compact",
        });
        latest.current.history?.boundary();
        const tr = view.state.tr.setMeta(SOURCE, "attachment");
        view.dispatch(
          tr
            .replaceWith(0, view.state.doc.content.size, embed)
            .scrollIntoView(),
        );
      } catch (error) {
        if (handleUnauthenticated(error)) return;
        try {
          feedback.offer({
            key: "note-attachment",
            announcement: "Polite",
            content: captureErrorFeedback(error, "AddAttachment"),
          });
        } catch (unmodeled) {
          setDefect({ error: unmodeled });
        }
      } finally {
        releaseWork();
        busy.current = false;
        if (!view.isDestroyed)
          view.setProps({ editable: () => latest.current.editable });
      }
    },
    [feedback, handleUnauthenticated],
  );

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    literalSuppressed.current = false;
    compositionBase.current = null;
    suspended.current = false;
    setReferenceFocused(false);
    setReferenceVisible(true);
    const outline = latest.current.history;
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
      const code = state.selection.$from.parent.type.spec.code;
      const tr = code
        ? state.tr.insertText("\n")
        : state.tr.replaceSelectionWith(schema.nodes.hard_break!.create());
      dispatch?.(tr.scrollIntoView());
      return true;
    };
    const undoCommand = outline
      ? run(() => latest.current.history!.undo())
      : ownUndo;
    const redoCommand = outline
      ? run(() => latest.current.history!.redo())
      : ownRedo;
    const restoredReference = referenceRef.current.getState();
    const view = new EditorView(element, {
      state: EditorState.create({
        doc: docFromBody(
          restoredReference
            ? {
                body_pm_json: {
                  type: "paragraph",
                  content: [{ type: "text", text: restoredReference.raw }],
                },
                body_text: restoredReference.raw,
              }
            : latest.current.body,
        ),
        plugins: [
          inspectionPlugin(),
          ownHistory(),
          keymap({
            Enter: enter,
            "Shift-Enter": enter,
            ...Object.fromEntries(
              FORMATS.map(([name, , key]) => [key, run(() => format(name))]),
            ),
            "Mod-k": run(openLink),
            "Mod-a": (state, dispatch) => {
              if (state.doc.firstChild?.type !== schema.nodes.object_embed)
                return false;
              dispatch?.(state.tr.setSelection(new AllSelection(state.doc)));
              return true;
            },
            "Mod-z": undoCommand,
            "Shift-Mod-z": redoCommand,
            "Mod-y": redoCommand,
          }),
        ],
      }),
      attributes: (state) => ({
        class: latest.current.compact
          ? `${styles.view} ${styles.compact}`
          : styles.view,
        role: referenceRef.current.getState() !== null ? "combobox" : "textbox",
        "aria-readonly": String(
          !latest.current.editable || busy.current,
        ),
        ...(referenceRef.current.getState() !== null
          ? {
              "aria-expanded": String(!suspended.current),
              "aria-controls": referenceId,
              tabindex: "0",
              "aria-autocomplete": "list",
              "aria-activedescendant": referenceRef.current.selected
                ? `${referenceId}-${referenceRef.current.selected}`
                : "",
            }
          : {}),
        "aria-label": latest.current.label,
        "aria-multiline": "true",
        "data-placeholder":
          latest.current.placeholder ??
          (latest.current.reference ? "write a note, or @ link something" : ""),
        "data-empty": String(
          state.doc.firstChild?.type === schema.nodes.paragraph &&
            state.doc.firstChild?.content.size === 0,
        ),
      }),
      nodeViews: {
        object_embed(node) {
          const dom = document.createElement("div");
          dom.contentEditable = "false";
          dom.className = "note-object-embed";
          const ref = `${node.attrs.objectType}:${node.attrs.objectId}`;
          setEmbed({ dom, ref });
          return {
            dom,
            stopEvent: () => true,
            ignoreMutation: () => true,
            destroy: () =>
              setEmbed((current) => (current?.dom === dom ? null : current)),
          };
        },
      },
      editable: () =>
        latest.current.editable && !busy.current,
      transformPasted: (slice, current) =>
        current.state.selection.$from.parent.type.spec.code
          ? slice
          : (oneBlock(slice) ?? slice),
      handleTextInput(current, _from, _to, text) {
        const body = current.state.doc.firstChild;
        if (
          text !== "@" ||
          current.composing ||
          literalSuppressed.current ||
          !latest.current.reference ||
          referenceRef.current.getState() !== null ||
          body?.type !== schema.nodes.paragraph ||
          body.content.size !== 0
        )
          return false;
        latest.current.history?.boundary();
        referenceRef.current.begin(bodyFromNode(body));
        setReferenceVisible(true);
        return false;
      },
      handlePaste(current, _event, slice) {
        const lone =
          slice.content.childCount === 1 &&
          slice.content.firstChild?.type === schema.nodes.object_embed;
        if (lone && !replaceable(current)) {
          warn(
            "Paste not applied",
            "Select the note body or empty it before pasting an embedded item.",
          );
          return true;
        }
        if (oneBlock(slice)) return false;
        warn("Paste not applied", "Paste one embedded item at a time.");
        return true;
      },
      handleDOMEvents: {
        keydown(current, event) {
          // Returning true leaves the browser event alone while stopping PM's
          // keymap/capture fallback from turning composition into a newline.
          if (current.composing || event.isComposing || event.keyCode === 229)
            return true;
          if (
            event.target instanceof HTMLElement &&
            event.target !== current.dom &&
            event.target.closest("input, textarea, select, button")
          )
            return true;
          const intent = referenceRef.current.getState();
          if (intent && ["Enter", "ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Enter") {
              if (
                !event.repeat &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.shiftKey
              )
                referenceRef.current.enter();
            } else if (
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.shiftKey
            )
              referenceRef.current.move(event.key === "ArrowDown" ? 1 : -1);
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
          if (
            intent &&
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "z"
          ) {
            event.preventDefault();
            (event.shiftKey ? ownRedo : ownUndo)(
              current.state,
              current.dispatch,
              current,
            );
            return true;
          }
          // Without an outline command, Escape belongs to the containing overlay.
          if (event.key === "Escape" && !latest.current.keys) return true;
          if (!latest.current.editable || busy.current) return true;
          return false;
        },
        // the browser's own undo (a menu, or Cmd-Z while no editor has focus) goes to ours.
        beforeinput(current, event) {
          const redo = event.inputType === "historyRedo";
          if (!redo && event.inputType !== "historyUndo") return false;
          event.preventDefault();
          if (!latest.current.editable || busy.current || current.composing)
            return true;
          const intent = referenceRef.current.getState();
          if (intent !== null)
            return (redo ? ownRedo : ownUndo)(
                  current.state,
                  current.dispatch,
                  current,
                );
          return (redo ? redoCommand : undoCommand)(
            current.state,
            current.dispatch,
            current,
          );
        },
        focus(current) {
          suspended.current = false;
          setReferenceFocused(true);
          setReferenceVisible(true);
          refreshMarks(current.state);
          setToolbar(!current.state.selection.empty);
          return false;
        },
        blur(current) {
          syncNativeSelection(current);
          latest.current.history?.boundary();
          return false;
        },
        compositionstart(current) {
          const block = current.state.doc.firstChild;
          if (
            latest.current.reference &&
            !literalSuppressed.current &&
            referenceRef.current.getState() === null &&
            block?.type === schema.nodes.paragraph &&
            block.content.size === 0
          )
            compositionBase.current = {
              body: bodyFromNode(block),
              selection: {
                anchor: current.state.selection.anchor,
                head: current.state.selection.head,
              },
            };
          latest.current.history?.boundary();
          return false;
        },
        compositionend(current) {
          latest.current.history?.boundary();
          window.setTimeout(() => {
            if (current.isDestroyed || current.composing) return;
            const original = compositionBase.current;
            compositionBase.current = null;
            if (original) {
              const block = current.state.doc.firstChild!;
              if (
                block.type === schema.nodes.paragraph &&
                block.textContent === "@" &&
                block.childCount === 1 &&
                block.firstChild?.isText
              )
                referenceRef.current.begin(original.body);
              else
                latest.current.onEdit({
                  before: original.body,
                  after: bodyFromNode(block),
                  source: "composition",
                  selectionBefore: original.selection,
                  selectionAfter: {
                    anchor: current.state.selection.anchor,
                    head: current.state.selection.head,
                  },
                });
              return;
            }
            if (referenceRef.current.getState() !== null) return;
            replaceDoc(current, docFromBody(latest.current.body));
          }, 0);
          return false;
        },
        drop(current, event) {
          const files = [...(event.dataTransfer?.files ?? [])];
          if (!files.length) return false;
          event.preventDefault();
          void attach(current, files);
          return true;
        },
        paste(current, event) {
          const files = [...(event.clipboardData?.files ?? [])];
          if (!files.length) {
            latest.current.history?.boundary();
            return false;
          }
          event.preventDefault();
          void attach(current, files);
          return true;
        },
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
        if (
          !latest.current.editable ||
          busy.current ||
          referenceRef.current.getState() !== null
        )
          return false;
        const act = (action: () => void) => {
          event.preventDefault();
          action();
          return true;
        };
        if (event.key === "Enter" && !event.altKey) {
          const mac = /Mac|iPhone|iPad/.test(navigator.platform);
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
        const allowBoundaryDeletion = !window.matchMedia(
          "(any-pointer: coarse)",
        ).matches;
        if (
          allowBoundaryDeletion &&
          event.key === "Backspace" &&
          latest.current.onEmptyBackspace &&
          !event.repeat &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey
        ) {
          syncNativeSelection(current);
          const { selection } = current.state;
          if (
            selection.empty &&
            selection.$from.parent.type === schema.nodes.paragraph &&
            selection.$from.parent.content.size === 0 &&
            selection.$from.parentOffset === 0
          )
            return act(latest.current.onEmptyBackspace);
        }
        if (
          (event.key === "Backspace" || event.key === "Delete") &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey &&
          current.state.doc.firstChild?.type === schema.nodes.object_embed &&
          !current.state.selection.empty
        )
          return act(() =>
            current.dispatch(
              current.state.tr.deleteSelection().scrollIntoView(),
            ),
          );
        const keys = latest.current.keys;
        if (!keys || event.altKey || event.ctrlKey || event.metaKey)
          return false;
        if (event.key === "Escape")
          return keys.selectBlock ? act(keys.selectBlock) : false;
        if (!["Tab", "Backspace", "Delete", "Enter"].includes(event.key))
          return false;
        syncNativeSelection(current);
        const { selection } = current.state;
        const at = { anchor: selection.anchor, head: selection.head };
        if (event.key === "Tab") {
          const arrange = event.shiftKey ? keys.outdent : keys.indent;
          return arrange ? act(() => arrange(at)) : false;
        }
        if (event.shiftKey) return false;
        const { $from } = selection;
        const paragraph = $from.parent.type === schema.nodes.paragraph;
        if (allowBoundaryDeletion && selection.empty && paragraph) {
          const size = $from.parent.content.size;
          if (
            event.key === "Backspace" &&
            !event.repeat &&
            $from.parentOffset === 0
          ) {
            const remove =
              size === 0
                ? keys.emptyBackspace
                : keys.join
                  ? () => keys.join!("backward")
                  : null;
            return remove ? act(remove) : false;
          }
          if (event.key === "Delete" && $from.parentOffset === size)
            return keys.join ? act(() => keys.join!("forward")) : false;
        }
        if (event.key !== "Enter" || !paragraph || !keys.split) return false;
        if (event.repeat) {
          event.preventDefault();
          return true;
        }
        const state = selection.empty
          ? current.state
          : current.state.apply(current.state.tr.deleteSelection());
        const body = state.doc.firstChild!;
        const offset = state.selection.$from.parentOffset;
        const left = bodyFromNode(body.copy(body.content.cut(0, offset)));
        const right = bodyFromNode(body.copy(body.content.cut(offset)));
        return act(() => keys.split!(left, right));
      },
      dispatchTransaction(tr) {
        if (tr.docChanged && tr.getMeta(SOURCE) !== "external" && readWriting().paused) return;
        const before = view.state;
        const after = before.apply(tr);
        view.updateState(after);
        if (tr.docChanged && tr.getMeta(SOURCE) !== "external") {
          const meta = tr.getMeta(SOURCE) as NoteEdit["source"] | undefined;
          const source =
            meta ??
            (tr.getMeta("uiEvent") === "paste"
              ? "paste"
              : view.composing
                ? "composition"
                : "input");
          const intent = referenceRef.current.getState();
          if (intent !== null) {
            const raw = after.doc.textBetween(
              0,
              after.doc.content.size,
              "\n",
              "\n",
            );
            referenceRef.current.edit(raw);
            if (!raw.startsWith("@"))
              literal(view);
          } else if (compositionBase.current === null)
            latest.current.onEdit({
              before: bodyFromNode(before.doc.firstChild!),
              after: bodyFromNode(after.doc.firstChild!),
              selectionBefore: {
                anchor: before.selection.anchor,
                head: before.selection.head,
              },
              selectionAfter: {
                anchor: after.selection.anchor,
                head: after.selection.head,
              },
              source,
            });
          if (
            after.doc.firstChild?.type === schema.nodes.paragraph &&
            after.doc.firstChild.content.size === 0
          )
            literalSuppressed.current = false;
        } else if (!before.selection.eq(after.selection))
          latest.current.history?.boundary();
        if (!before.selection.eq(after.selection))
          latest.current.onSelectionChange?.({
            anchor: after.selection.anchor,
            head: after.selection.head,
          });
        refreshMarks(after);
        if (view.hasFocus()) setToolbar(!after.selection.empty);
      },
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // The view belongs to this editor identity and visit; other props use `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.editorKey, reference.owner]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || view.composing || referenceRef.current.getState() !== null)
      return;
    replaceDoc(view, docFromBody(props.body));
  }, [props.body, props.revision]);

  useLayoutEffect(() => {
    const raw = reference.state?.raw;
    const view = viewRef.current;
    if (raw === undefined || !view || view.composing) return;
    const paragraph = schema.nodes.paragraph!.create(null, raw ? schema.text(raw) : null);
    replaceDoc(view, schema.nodes.doc!.create(null, paragraph));
  }, [reference.state?.raw]);

  useLayoutEffect(() => {
    if (completedReference.current.key !== reference.owner) {
      completedReference.current = {
        key: reference.owner,
        completion: reference.completion,
      };
      return;
    }
    if (completedReference.current.completion === reference.completion) return;
    completedReference.current = {
      key: reference.owner,
      completion: reference.completion,
    };
    const view = viewRef.current;
    if (!view) return;
    // Accepted query history is not prose history. Keep the preserved body's identity.
    view.updateState(
      EditorState.create({
        doc: docFromBody(latest.current.body),
        plugins: view.state.plugins,
      }),
    );
  }, [reference.owner, reference.completion]);

  useLayoutEffect(() => {
    viewRef.current?.setProps({
      editable: () =>
        latest.current.editable && !busy.current,
    });
    if (!props.editable || paused) setLink(null);
  }, [
    props.editable,
    paused,
    reference.ready,
    reference.state?.raw,
    reference.selected,
    referenceFocused,
  ]);

  const focusSerial = props.focus?.serial;
  useLayoutEffect(() => {
    const view = viewRef.current;
    const focus = latest.current.focus;
    if (!view || !focus || !view.editable) return;
    const size = view.state.doc.content.size;
    const block = view.state.doc.firstChild;
    const end = Math.max(1, size - 1);
    const anchor =
      focus.selection === "end" ? end : Math.min(focus.selection.anchor, end);
    const head =
      focus.selection === "end" ? end : Math.min(focus.selection.head, end);
    const at = block?.isTextblock
      ? TextSelection.create(view.state.doc, anchor, head)
      : Selection.atEnd(view.state.doc);
    const tr = view.state.tr.setSelection(at);
    view.dispatch(focus.preventScroll ? tr : tr.scrollIntoView());
    view.focus();
  }, [props.editorKey, props.editable, reference.ready, focusSerial]);

  const { inspection } = props;
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const clear = () => {
      if (!view.isDestroyed)
        view.dispatch(view.state.tr.setMeta(inspectionKey, null));
    };
    if (!inspection || inspection.signal.aborted) {
      clear();
      return;
    }
    view.dispatch(view.state.tr.setMeta(inspectionKey, inspection));
    if (!inspection.restored) {
      view.dom
        .querySelector("[data-note-inspection-range]")
        ?.scrollIntoView({ block: "center" });
      if (inspection.mayFocus()) shell.current?.focus({ preventScroll: true });
    }
    inspection.signal.addEventListener("abort", clear, { once: true });
    return () => {
      inspection.signal.removeEventListener("abort", clear);
      clear();
    };
  }, [inspection]);

  const linkOpen = link !== null;
  useEffect(() => {
    if (linkOpen) linkInput.current?.focus();
  }, [linkOpen]);

  if (defect) throw defect.error;
  return (
    <div
      ref={shell}
      data-reference-editor={props.editorKey}
      tabIndex={-1}
      data-outline-occurrence={occurrenceKey}
      data-row-focusable="true"
      className={styles.shell}
      onKeyDownCapture={(event) => {
        const view = viewRef.current;
        const intent = referenceRef.current.getState();
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
        literal(view);
      }}
      onBlurCapture={() =>
        window.requestAnimationFrame(() => {
          if (shell.current?.contains(document.activeElement)) return;
          suspended.current = true;
          setReferenceFocused(false);
          setToolbar(false);
          setLink(null);
        })
      }
    >
      <div ref={host} className={styles.host} />
      {embed
        ? createPortal(
            <EmbeddedResource
              resourceRef={embed.ref}
              supplied={props.embeddedItem ?? null}
              scope={`${occurrenceKey}/embed`}
              branch={branch}
              containingNoteRef={props.containingNoteRef}
              atomic={props.atomicEmbeds === true}
              onRevealRoot={() => shell.current?.focus()}
            />,
            embed.dom,
            embed.ref,
          )
        : null}
      {reference.state && referenceFocused && referenceVisible ? (
        <ReferencePicker
          input={reference}
          id={referenceId}
          onReviewPosition={() => { reference.reviewPosition(); viewRef.current?.focus(); }}
        />
      ) : null}
      {props.editable && !paused && toolbar && !link && reference.state === null ? (
        <div
          className={styles.toolbar}
          role="toolbar"
          aria-label="Text formatting"
        >
          {FORMATS.map(([name, label, key, Icon]) => (
            <button
              key={name}
              type="button"
              className={styles.button}
              aria-label={label}
              aria-pressed={active.has(name)}
              title={`${label} (${shortcut(key)})`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => format(name)}
            >
              <Icon size={16} aria-hidden="true" />
            </button>
          ))}
          <button
            type="button"
            className={styles.button}
            aria-label="Link"
            title="Link (⌘/Ctrl+K)"
            onMouseDown={(event) => event.preventDefault()}
            onClick={openLink}
          >
            <Link2 size={16} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {link ? (
        <div
          className={styles.linkDialog}
          style={{ left: link.left, top: link.top }}
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
                  setLink(null);
                  viewRef.current?.focus();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  insertLink();
                }
              }}
            />
            <button
              type="button"
              className={styles.linkAdd}
              disabled={!hrefFromInput(link.query)}
              onClick={insertLink}
            >
              Add link
            </button>
          </div>
          {link.error ? (
            <div role="alert">
              <FieldFeedback
                id={linkErrorId}
                content={{ tone: "Danger", title: link.error }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Replace the document by its changed range, outside history. */
function replaceDoc(view: EditorView, doc: PMNode) {
  const start = view.state.doc.content.findDiffStart(doc.content);
  if (start === null) return;
  const end = view.state.doc.content.findDiffEnd(doc.content)!;
  const tr = view.state.tr
    .setMeta(SOURCE, "external")
    .setMeta("addToHistory", false);
  view.dispatch(tr.replaceWith(start, end.a, doc.content.cut(start, end.b)));
}

/** Native navigation can move the caret before selectionchange; structural keys use it. */
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

/** A paste as one block: blocks join with hard breaks; a lone embed stays an embed. */
function oneBlock(slice: Slice): Slice | null {
  const first = slice.content.firstChild;
  if (
    slice.content.childCount === 1 &&
    first?.type === schema.nodes.object_embed
  )
    return slice;
  const inline: PMNode[] = [];
  let blocks = 0;
  let foreign = false;
  slice.content.forEach((node) => {
    if (node.isInline) return void inline.push(node);
    if (
      node.type !== schema.nodes.paragraph &&
      node.type !== schema.nodes.code_block
    ) {
      foreign = true;
      return;
    }
    if (blocks++) inline.push(schema.nodes.hard_break!.create());
    if (node.type === schema.nodes.paragraph)
      return void node.content.forEach((child) => void inline.push(child));
    node.textContent.split("\n").forEach((line, index) => {
      if (index) inline.push(schema.nodes.hard_break!.create());
      if (line) inline.push(schema.text(line));
    });
  });
  if (foreign) return null;
  return blocks ? new Slice(Fragment.fromArray(inline), 0, 0) : slice;
}

/** An attachment or embed may replace the body only when it is empty or wholly selected. */
function replaceable(view: EditorView): boolean {
  const body = view.state.doc.firstChild;
  if (!body || (body.content.size === 0 && !body.textContent.trim()))
    return true;
  const { selection } = view.state;
  return (
    !selection.empty &&
    selection.from <= 1 &&
    selection.to >= view.state.doc.content.size - 1
  );
}

function inspectionPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: inspectionKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        if (tr.docChanged) return DecorationSet.empty;
        const inspection = tr.getMeta(inspectionKey) as
          NoteInspection | null | undefined;
        if (inspection === undefined) return set;
        return inspection
          ? inspectionDecorations(tr.doc, inspection)
          : DecorationSet.empty;
      },
    },
    props: { decorations: (state) => inspectionKey.getState(state) },
  });
}

/** Existing bodies arrive batched; a newly pasted/uploaded target resolves once. */
function EmbeddedResource({
  resourceRef,
  supplied,
  scope,
  branch,
  containingNoteRef,
  atomic,
  onRevealRoot,
}: {
  resourceRef: string;
  supplied: ResourceItem | null;
  scope: string;
  branch: OutlineBranch;
  containingNoteRef: string | null;
  atomic: boolean;
  onRevealRoot(): void;
}) {
  const [resolved, setResolved] = useState<ResourceItem | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const item =
    supplied?.ref === resourceRef
      ? supplied
      : resolved?.ref === resourceRef
        ? resolved
        : null;
  const handleUnauthenticated = useUnauthenticatedApiHandler();
  useEffect(() => {
    if (item) return;
    const controller = new AbortController();
    setFailed(false);
    void resolveResourceItem(resourceRef, controller.signal).then(
      setResolved,
      (error: unknown) => {
        if (controller.signal.aborted || handleUnauthenticated(error)) return;
        if (!isApiError(error) || isSameSystemApiDefect(error))
          setDefect({ error });
        else setFailed(true);
      },
    );
    return () => controller.abort();
  }, [resourceRef, item, attempt, handleUnauthenticated]);
  if (defect) throw defect.error;
  if (item && atomic) return <ResourceLink item={item} />;
  return item ? (
    <ResourceOutlineList
      scope={scope}
      ariaLabel="Embedded resource"
      branch={branch}
      onRevealRoot={onRevealRoot}
    >
      <ResourceOutlineRow
        incoming={null}
        item={item}
        occurrenceKey={scope}
        embeddedInNoteRef={containingNoteRef}
      />
    </ResourceOutlineList>
  ) : (
    <p role={failed ? "alert" : "status"}>
      {failed ? (
        <>
          couldn’t load embedded resource{" "}
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            retry
          </button>
        </>
      ) : (
        "loading embedded resource…"
      )}
    </p>
  );
}
