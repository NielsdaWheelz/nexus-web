"use client";

// One note body editor: a ProseMirror view over one block, its formatting toolbar and
// link dialog, paste normalised to one block, one dropped or pasted file uploaded into
// a media embed, embeds that open on click or Enter, passage pulses and, in an
// outline, the structural keys. Undo is the outline's when `history` is given, else
// the editor's own. The view lives as long as `editorKey`; a new `revision` replaces
// its document by a diff (never while composing, never into its history).
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Fragment, Slice, type Node as PMNode } from "prosemirror-model";
import {
  EditorState,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import { DecorationSet, EditorView } from "prosemirror-view";
import { history as ownHistory, redo as ownRedo, undo as ownUndo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { Bold, Code2, Italic, Link2, Strikethrough, Underline } from "lucide-react";
import { useFeedback } from "@/components/feedback/Feedback";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { getFileUploadError, uploadIngestFile } from "@/lib/imports/ingest";
import { captureErrorFeedback } from "@/lib/imports/copy";
import {
  bodyFromNode,
  docFromBody,
  hrefFromInput,
  noteBodySchema as schema,
  pulseDecorations,
  type NoteBody,
} from "@/lib/notes/noteBody";
import type { FocusSelection, NoteEdit } from "@/lib/notes/useOutline";
import { workspaceTargetClickIntent } from "@/lib/panes/targetLinkActivation";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import "prosemirror-view/style/prosemirror.css";
import styles from "./NoteEditor.module.css";

export interface NotePulse {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly serial: number;
}

/** What an outline row does with the keys that change structure. */
export interface StructuralKeys {
  split(left: NoteBody, right: NoteBody): void;
  emptyBackspace(): void;
  join(direction: "backward" | "forward"): void;
  indent(at: { anchor: number; head: number }): void; // the selection the moved row keeps
  outdent(at: { anchor: number; head: number }): void;
  selectBlock(): void;
}

export interface NoteEditorProps {
  editorKey: string;
  body: NoteBody;
  revision: number;
  editable: boolean;
  label: string;
  compact?: boolean;
  pulse?: NotePulse | null;
  focus?: { selection: FocusSelection; serial: number } | null;
  history: { undo(): void; redo(): void; boundary(): void } | null;
  keys?: StructuralKeys | null;
  onEdit(edit: NoteEdit): void;
  onOpenEmbed(ref: string, disposition: WorkspaceTargetDisposition): void;
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
const PULSE_MS = 2400;
const pulseKey = new PluginKey<DecorationSet>("notePulse");

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
  const host = useRef<HTMLDivElement | null>(null);
  const shell = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const applied = useRef(props.revision);
  const busy = useRef(false);
  const linkInputId = useId();
  const linkInput = useRef<HTMLInputElement | null>(null);
  const [toolbar, setToolbar] = useState(false);
  const [active, setActive] = useState<ReadonlySet<Format>>(new Set());
  const [link, setLink] = useState<LinkDialog | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const feedback = useFeedback();
  const handleUnauthenticated = useUnauthenticatedApiHandler();
  const warn = useCallback(
    (title: string, message: string) =>
      feedback.publish({ kind: "Hud", content: { tone: "Warning", title, message } }),
    [feedback],
  );

  const refreshMarks = useCallback((state: EditorState) => {
    const stored = state.storedMarks ?? state.selection.$from.marks();
    const { from, to, empty } = state.selection;
    const on = FORMATS.filter(([name]) => {
      const type = schema.marks[name]!;
      return empty ? type.isInSet(stored) : state.doc.rangeHasMark(from, to, type);
    });
    setActive(new Set(on.map(([name]) => name)));
  }, []);

  const format = useCallback((name: Format): boolean => {
    const view = viewRef.current;
    if (!view || !latest.current.editable || view.composing) return false;
    const { from, to, empty, $from } = view.state.selection;
    if ($from.parent.type.spec.code) return false;
    latest.current.history?.boundary();
    const type = schema.marks[name]!;
    const tr = view.state.tr.setMeta(SOURCE, "format");
    if (empty) {
      if (type.isInSet(view.state.storedMarks ?? $from.marks())) tr.removeStoredMark(type);
      else tr.addStoredMark(type.create());
    } else if (view.state.doc.rangeHasMark(from, to, type)) tr.removeMark(from, to, type);
    else tr.addMark(from, to, type.create());
    view.dispatch(tr);
    view.focus();
    return true;
  }, []);

  const openLink = useCallback((): boolean => {
    const view = viewRef.current;
    const box = shell.current?.getBoundingClientRect();
    if (!view || !box || !latest.current.editable || view.composing) return false;
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
    if (!view || !link) return;
    const href = hrefFromInput(link.query);
    if (!href)
      return setLink({ ...link, error: "Enter a web address, email address, or local path." });
    const size = view.state.doc.content.size;
    if (link.to > size || view.state.doc.textBetween(link.from, link.to, " ", " ") !== link.text) {
      setLink(null);
      return warn("Selection changed", "The selected text changed. Select it again to add a link.");
    }
    const mark = schema.marks.link!.create({ href });
    const tr = view.state.tr.setMeta(SOURCE, "format");
    if (link.from === link.to) {
      tr.insertText(href, link.from).addMark(link.from, link.from + href.length, mark);
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
        feedback.publish({
          kind: "Hud",
          content: { tone: "Danger", title: "Attachment wasn’t added", message },
        });
      if (!latest.current.editable) return;
      if (!replaceable(view)) return refuse("Select the note body or empty it before attaching a file.");
      if (files.length > 1) return refuse("Attach one file at a time here.");
      const problem = getFileUploadError(files[0]!);
      if (problem) return refuse(problem);
      busy.current = true;
      view.setProps({ editable: () => false });
      try {
        const upload = await uploadIngestFile({ file: files[0]!, libraryIds: [], id: crypto.randomUUID() });
        if (view.isDestroyed || !replaceable(view))
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
        view.dispatch(tr.replaceWith(0, view.state.doc.content.size, embed).scrollIntoView());
      } catch (error) {
        if (handleUnauthenticated(error)) return;
        try {
          feedback.publish({ kind: "Hud", content: captureErrorFeedback(error, "AddAttachment") });
        } catch (unmodeled) {
          setDefect({ error: unmodeled });
        }
      } finally {
        busy.current = false;
        if (!view.isDestroyed) view.setProps({ editable: () => latest.current.editable });
      }
    },
    [feedback, handleUnauthenticated],
  );

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const outline = latest.current.history;
    const run = (action: () => boolean | void) => (_: EditorState, __?: unknown, view?: EditorView) =>
      !view?.composing && action() !== false;
    const enter = (state: EditorState, dispatch?: (tr: Transaction) => void) => {
      const code = state.selection.$from.parent.type.spec.code;
      const tr = code
        ? state.tr.insertText("\n")
        : state.tr.replaceSelectionWith(schema.nodes.hard_break!.create());
      dispatch?.(tr.scrollIntoView());
      return true;
    };
    const undoCommand = outline ? run(() => latest.current.history!.undo()) : ownUndo;
    const redoCommand = outline ? run(() => latest.current.history!.redo()) : ownRedo;
    const embedOf = (target: EventTarget | null) =>
      target instanceof HTMLElement
        ? target.closest<HTMLElement>("[data-object-type][data-object-id]")
        : null;
    const open = (embed: HTMLElement, event: { detail: number; shiftKey: boolean }) =>
      latest.current.onOpenEmbed(
        `${embed.dataset.objectType}:${embed.dataset.objectId}`,
        workspaceTargetClickIntent(event).disposition,
      );
    const view = new EditorView(element, {
      state: EditorState.create({
        doc: docFromBody(latest.current.body),
        plugins: [
          pulsePlugin(),
          ...(outline ? [] : [ownHistory()]),
          keymap({
            Enter: enter,
            "Shift-Enter": enter,
            ...Object.fromEntries(FORMATS.map(([name, , key]) => [key, run(() => format(name))])),
            "Mod-k": run(openLink),
            "Mod-z": undoCommand,
            "Shift-Mod-z": redoCommand,
            "Mod-y": redoCommand,
          }),
        ],
      }),
      attributes: {
        class: latest.current.compact ? `${styles.view} ${styles.compact}` : styles.view,
        role: "textbox",
        "aria-label": latest.current.label,
        "aria-multiline": "true",
      },
      editable: () => latest.current.editable && !busy.current,
      transformPasted: (slice, current) =>
        current.state.selection.$from.parent.type.spec.code ? slice : (oneBlock(slice) ?? slice),
      handlePaste(current, _event, slice) {
        const lone = slice.content.childCount === 1 && slice.content.firstChild?.type === schema.nodes.object_embed;
        if (lone && !replaceable(current)) {
          warn("Paste not applied", "Select the note body or empty it before pasting an embedded item.");
          return true;
        }
        if (oneBlock(slice)) return false;
        warn("Paste not applied", "Paste one embedded item at a time.");
        return true;
      },
      handleDOMEvents: {
        // the browser's own undo (a menu, or Cmd-Z while no editor has focus) goes to ours.
        beforeinput(current, event) {
          const redo = event.inputType === "historyRedo";
          if (!redo && event.inputType !== "historyUndo") return false;
          event.preventDefault();
          return (redo ? redoCommand : undoCommand)(current.state, current.dispatch, current);
        },
        focus(current) {
          refreshMarks(current.state);
          setToolbar(!current.state.selection.empty);
          return false;
        },
        blur() {
          latest.current.history?.boundary();
          return false;
        },
        compositionstart() {
          latest.current.history?.boundary();
          return false;
        },
        compositionend(current) {
          latest.current.history?.boundary();
          window.setTimeout(() => {
            if (current.isDestroyed || current.composing) return;
            if (latest.current.revision === applied.current) return;
            applied.current = latest.current.revision;
            replaceDoc(current, docFromBody(latest.current.body));
          }, 0);
          return false;
        },
        click(_current, event) {
          const embed = embedOf(event.target);
          if (!embed || !element.contains(embed)) return false;
          event.preventDefault();
          open(embed, event);
          return true;
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
        if (current.composing || event.isComposing || event.keyCode === 229) return false;
        const embed = embedOf(event.target);
        if (embed && element.contains(embed) && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          open(embed, { detail: 0, shiftKey: event.shiftKey });
          return true;
        }
        const keys = latest.current.keys;
        if (!keys || event.altKey || event.ctrlKey || event.metaKey) return false;
        const act = (action: () => void) => {
          event.preventDefault();
          action();
          return true;
        };
        if (event.key === "Escape") return act(keys.selectBlock);
        if (!["Tab", "Backspace", "Delete", "Enter"].includes(event.key)) return false;
        syncNativeSelection(current);
        const { selection } = current.state;
        const at = { anchor: selection.anchor, head: selection.head };
        if (event.key === "Tab") return act(() => (event.shiftKey ? keys.outdent : keys.indent)(at));
        if (event.shiftKey) return false;
        const { $from } = selection;
        const paragraph = $from.parent.type === schema.nodes.paragraph;
        if (selection.empty && paragraph) {
          const size = $from.parent.content.size;
          if (event.key === "Backspace" && $from.parentOffset === 0)
            return act(size === 0 ? keys.emptyBackspace : () => keys.join("backward"));
          if (event.key === "Delete" && $from.parentOffset === size)
            return act(() => keys.join("forward"));
        }
        if (event.key !== "Enter" || !paragraph) return false;
        const state = selection.empty ? current.state : current.state.apply(current.state.tr.deleteSelection());
        const body = state.doc.firstChild!;
        const offset = state.selection.$from.parentOffset;
        const left = bodyFromNode(body.copy(body.content.cut(0, offset)));
        const right = bodyFromNode(body.copy(body.content.cut(offset)));
        return act(() => keys.split(left, right));
      },
      dispatchTransaction(tr) {
        const before = view.state;
        const after = before.apply(tr);
        view.updateState(after);
        if (tr.docChanged && tr.getMeta(SOURCE) !== "external") {
          const meta = tr.getMeta(SOURCE) as NoteEdit["source"] | undefined;
          const source = meta ?? (tr.getMeta("uiEvent") === "paste" ? "paste" : view.composing ? "composition" : "input");
          latest.current.onEdit({
            before: bodyFromNode(before.doc.firstChild!),
            after: bodyFromNode(after.doc.firstChild!),
            selectionBefore: { anchor: before.selection.anchor, head: before.selection.head },
            selectionAfter: { anchor: after.selection.anchor, head: after.selection.head },
            source,
          });
        } else if (!before.selection.eq(after.selection)) latest.current.history?.boundary();
        refreshMarks(after);
        if (view.hasFocus()) setToolbar(!after.selection.empty);
      },
    });
    viewRef.current = view;
    applied.current = latest.current.revision;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // The view lives as long as its key; everything else is read through `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.editorKey]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.composing || props.revision === applied.current) return;
    applied.current = props.revision;
    replaceDoc(view, docFromBody(props.body));
  }, [props.body, props.revision]);

  const focusSerial = props.focus?.serial;
  useEffect(() => {
    const view = viewRef.current;
    const focus = latest.current.focus;
    if (!view || !focus) return;
    const size = view.state.doc.content.size;
    const block = view.state.doc.firstChild;
    const end = Math.max(1, size - 1);
    const anchor = focus.selection === "end" ? end : Math.min(focus.selection.anchor, end);
    const head = focus.selection === "end" ? end : Math.min(focus.selection.head, end);
    const at = block?.isTextblock ? TextSelection.create(view.state.doc, anchor, head) : Selection.atEnd(view.state.doc);
    view.dispatch(view.state.tr.setSelection(at).scrollIntoView());
    view.focus();
  }, [focusSerial]);

  const { pulse } = props;
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !pulse) return;
    view.dispatch(view.state.tr.setMeta(pulseKey, pulse));
    view.dom.querySelector("[data-note-pulse-range]")?.scrollIntoView({ block: "center" });
    const timer = window.setTimeout(() => {
      if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(pulseKey, null));
    }, PULSE_MS);
    return () => window.clearTimeout(timer);
  }, [pulse]);

  useEffect(() => {
    viewRef.current?.setProps({ editable: () => latest.current.editable && !busy.current });
    if (!props.editable) setLink(null);
  }, [props.editable]);

  const linkOpen = link !== null;
  useEffect(() => {
    if (linkOpen) linkInput.current?.focus();
  }, [linkOpen]);

  if (defect) throw defect.error;
  return (
    <div
      ref={shell}
      className={styles.shell}
      onBlurCapture={() =>
        window.requestAnimationFrame(() => {
          if (shell.current?.contains(document.activeElement)) return;
          setToolbar(false);
          setLink(null);
        })
      }
    >
      <div ref={host} className={styles.host} />
      {props.editable && toolbar && !link ? (
        <div className={styles.toolbar} role="toolbar" aria-label="Text formatting">
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
              value={link.query}
              onChange={(event) => setLink({ ...link, query: event.target.value, error: null })}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
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
            <span className={styles.linkError} role="alert">
              {link.error}
            </span>
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
  const tr = view.state.tr.setMeta(SOURCE, "external").setMeta("addToHistory", false);
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
  if (anchor === state.selection.anchor && head === state.selection.head) return;
  if (!state.doc.resolve(anchor).parent.inlineContent || !state.doc.resolve(head).parent.inlineContent) return;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, anchor, head)));
}

/** A paste as one block: blocks join with hard breaks; a lone embed stays an embed. */
function oneBlock(slice: Slice): Slice | null {
  const first = slice.content.firstChild;
  if (slice.content.childCount === 1 && first?.type === schema.nodes.object_embed) return slice;
  const inline: PMNode[] = [];
  let blocks = 0;
  let foreign = false;
  slice.content.forEach((node) => {
    if (node.isInline) return void inline.push(node);
    if (node.type !== schema.nodes.paragraph && node.type !== schema.nodes.code_block) {
      foreign = true;
      return;
    }
    if (blocks++) inline.push(schema.nodes.hard_break!.create());
    if (node.type === schema.nodes.paragraph) return void node.content.forEach((child) => void inline.push(child));
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
  if (!body || (body.content.size === 0 && !body.textContent.trim())) return true;
  const { selection } = view.state;
  return !selection.empty && selection.from <= 1 && selection.to >= view.state.doc.content.size - 1;
}

function pulsePlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: pulseKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const pulse = tr.getMeta(pulseKey) as NotePulse | null | undefined;
        if (pulse === undefined) return set.map(tr.mapping, tr.doc);
        return pulse ? pulseDecorations(tr.doc, pulse) : DecorationSet.empty;
      },
    },
    props: { decorations: (state) => pulseKey.getState(state) },
  });
}
