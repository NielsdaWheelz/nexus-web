"use client";

// A caret around one existing reference, never a stored note body. New prose and
// pasted items continue as siblings through the outline owner; rejected input
// stays in this visit's draft. The reference token itself cannot be rewritten.
import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Schema } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history as localHistory, undo, redo } from "prosemirror-history";
import ReferencePicker from "@/components/resources/ReferencePicker";
import ResourceBody from "@/components/resources/ResourceBody";
import { bodyText, emptyBody, type NoteBody } from "@/lib/notes/noteBody";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import {
  useReferenceInput,
  type ReferenceInputHost,
} from "@/lib/resourceGraph/useReferenceInput";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import type { ResourceItem } from "@/lib/resources/items";
import "prosemirror-view/style/prosemirror.css";
import styles from "./ReferenceRowEditor.module.css";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph" },
    paragraph: { content: "reference text*", toDOM: () => ["p", 0] },
    reference: {
      inline: true,
      atom: true,
      selectable: true,
      parseDOM: [{ tag: "span[data-outline-reference-token]" }],
      toDOM: () => [
        "span",
        { contenteditable: "false", "data-outline-reference-token": "" },
      ],
    },
    text: {},
  },
});

function documentWith(text: string) {
  return schema.node(
    "doc",
    null,
    schema.node("paragraph", null, [
      schema.node("reference"),
      ...(text ? [schema.text(text)] : []),
    ]),
  );
}

export interface ReferenceRowEditorProps {
  item: ResourceItem;
  occurrenceKey: string;
  focusSerial: number | null;
  reference: ReferenceInputHost | null;
  editable: boolean;
  label?: string;
  onInsert(body: NoteBody): boolean | Promise<boolean>;
  onPaste(clipboard: DataTransfer): boolean | Promise<boolean>;
  onIndent?(): void;
  onSelect?(extend: boolean): void;
  onCopy?(clipboard: DataTransfer, cut: boolean): boolean;
  history: { undo(): void; redo(): void; boundary(): void };
}

export default function ReferenceRowEditor(props: ReferenceRowEditorProps) {
  const runtime = usePaneRuntime();
  const host = useRef<HTMLDivElement | null>(null);
  const shell = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const inserting = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  const draft = useResourceDraft<{
    text: string;
    failure: string | null;
    completion: number;
  }>(`Resources.ReferenceContinuation:${props.occurrenceKey}`, () => ({
    text: "",
    failure: null,
    completion: 0,
  }), value => ({ changed: value.text !== "", unconfirmed: false, stopsBrowserWork: false }));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [focused, setFocused] = useState(false);
  const [pickerVisible, setPickerVisible] = useState(true);
  const reference = useReferenceInput(
    `continuation:${props.occurrenceKey}`,
    props.reference === null
      ? null
      : {
          ...props.reference,
          onFocus(result) {
            // A picker button may disappear on acceptance. Return focus to this stable
            // editor before the outline waits for the accepted occurrence to arrive.
            viewRef.current?.setProps({});
            viewRef.current?.focus();
            latest.current.reference?.onFocus?.(result);
          },
        },
    focused && pickerVisible,
  );
  const referenceRef = useRef(reference);
  referenceRef.current = reference;
  const deferredLiteral = useRef<ReferenceRowEditorProps["onInsert"] | null>(
    null,
  );
  const [token, setToken] = useState<HTMLElement | null>(null);
  const pickerShown = useRef(false);
  pickerShown.current = focused && pickerVisible;
  const pickerId = `reference-${useId().replaceAll(":", "")}`;
  const statusId = useId();

  function reset(view: EditorView) {
    draftRef.current.set({
      text: "",
      failure: null,
      completion: referenceRef.current.completion,
    });
    const doc = documentWith("");
    if (!view.isDestroyed)
      view.updateState(
        EditorState.create({
          doc,
          plugins: view.state.plugins,
          selection: TextSelection.create(doc, 2),
        }),
      );
  }

  async function insert(view: EditorView, text: string) {
    if (inserting.current || !latest.current.editable) return;
    inserting.current = true;
    view.setProps({ editable: () => false });
    const admitted = await latest.current.onInsert(bodyText(text));
    if (admitted) {
      if (!view.isDestroyed) reset(view);
    } else
      draftRef.current.set((previous) => ({
        ...previous,
        text,
        failure: "couldn’t insert here; your draft is kept",
      }));
    inserting.current = false;
    if (!view.isDestroyed)
      view.setProps({ editable: () => latest.current.editable });
  }

  function literal(view: EditorView) {
    if (!referenceRef.current.literal()) return;
    const text = view.state.doc.firstChild!.textContent;
    draftRef.current.set((previous) => ({ ...previous, text, failure: null }));
    // The outline's admission guard is React state. Wait for its next callback
    // before converting the query; releasing it does not update this closure.
    deferredLiteral.current = latest.current.onInsert;
    latest.current.reference?.onActiveChange?.(false);
  }

  const handlers = useRef({ insert, literal });
  handlers.current = { insert, literal };

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const initial =
      referenceRef.current.getState()?.raw ?? draftRef.current.read().text;
    const doc = documentWith(initial);
    const view = new EditorView(element, {
      state: EditorState.create({
        doc,
        plugins: [localHistory()],
        selection: TextSelection.create(doc, initial.length + 2),
      }),
      attributes: () => {
        const input = referenceRef.current;
        return {
          class: styles.editor,
          role: input.getState() ? "combobox" : "textbox",
          tabindex: "0",
          "aria-label":
            latest.current.label ??
            `continue after ${latest.current.item.label}`,
          "data-row-focusable": "true",
          "aria-readonly": String(
            !latest.current.editable ||
              ["submitting", "unknown"].includes(input.getState()?.phase ?? ""),
          ),
          "aria-describedby": draftRef.current.read().failure ? statusId : "",
          ...(input.getState()
            ? {
                "aria-expanded": String(pickerShown.current),
                "aria-controls": pickerShown.current ? pickerId : "",
                "aria-autocomplete": "list",
                "aria-activedescendant":
                  pickerShown.current && input.selected
                    ? `${pickerId}-${input.selected}`
                    : "",
              }
            : {}),
        };
      },
      editable: () =>
        latest.current.editable &&
        !["submitting", "unknown"].includes(
          referenceRef.current.getState()?.phase ?? "",
        ),
      nodeViews: {
        reference() {
          const dom = document.createElement("span");
          dom.contentEditable = "false";
          dom.dataset.outlineReferenceToken = "";
          dom.className = styles.token;
          setToken(dom);
          return {
            dom,
            stopEvent: (event) =>
              event.target instanceof Element &&
              event.target.closest("a") !== null,
            ignoreMutation: () => true,
          };
        },
      },
      clipboardTextSerializer: (slice) =>
        slice.content.textBetween(
          0,
          slice.content.size,
          "\n",
          latest.current.item.label,
        ),
      handleTextInput(current, from, to, text) {
        if (!latest.current.editable || current.composing) return false;
        current.dispatch(
          current.state.tr.insertText(text, Math.max(2, from), Math.max(2, to)),
        );
        return true;
      },
      handleKeyDown(current, event) {
        if (event.target instanceof Element && event.target.closest("a"))
          return true;
        if (current.composing || event.isComposing || event.keyCode === 229)
          return true;
        const input = referenceRef.current;
        const intent = input.getState();
        const bare =
          !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
        const consume = () => {
          event.preventDefault();
          event.stopPropagation();
        };
        if (!latest.current.editable) return true;
        if (
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          event.key.toLowerCase() === "z"
        ) {
          consume();
          if (intent || draftRef.current.read().text) {
            if (
              !intent ||
              intent.phase === "search" ||
              intent.phase === "rejected"
            )
              (event.shiftKey ? redo : undo)(
                current.state,
                current.dispatch,
                current,
              );
          } else
            (event.shiftKey
              ? latest.current.history.redo
              : latest.current.history.undo)();
          return true;
        }
        if (intent && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          consume();
          if (bare) input.move(event.key === "ArrowDown" ? 1 : -1);
          return true;
        }
        if (event.key === "Enter") {
          consume();
          if (!bare || event.repeat) return true;
          if (intent) input.enter();
          else
            handlers.current.insert(
              current,
              current.state.doc.firstChild!.textContent,
            );
          return true;
        }
        if (event.key === "Escape" && bare) {
          consume();
          if (event.repeat) return true;
          if (intent) {
            if (intent.phase === "search" || intent.phase === "rejected")
              handlers.current.literal(current);
            else setPickerVisible(false);
          } else latest.current.onSelect?.(false);
          return true;
        }
        if (
          bare &&
          !intent &&
          ((event.key === "Backspace" && current.state.selection.from <= 2) ||
            (event.key === "Delete" && current.state.selection.from < 2))
        ) {
          consume();
          // Soft-keyboard holds can emit distinct nonrepeat key pairs. Only
          // deliberate block selection admits structural deletion on touch.
          if (
            !event.repeat &&
            !window.matchMedia("(any-pointer: coarse)").matches
          )
            latest.current.onSelect?.(false);
          return true;
        }
        if (
          !intent &&
          event.key === "Tab" &&
          !event.shiftKey &&
          latest.current.onIndent
        ) {
          event.preventDefault();
          if (!event.repeat) latest.current.onIndent();
          return true;
        }
        if (intent && event.key === "Tab") {
          event.stopPropagation();
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        beforeinput(current, event) {
          if (current.composing || event.isComposing) return false;
          if (
            event.inputType === "insertParagraph" ||
            event.inputType === "insertLineBreak"
          ) {
            event.preventDefault();
            if (!current.composing && latest.current.editable) {
              if (referenceRef.current.getState()) referenceRef.current.enter();
              else
                handlers.current.insert(
                  current,
                  current.state.doc.firstChild!.textContent,
                );
            }
            return true;
          }
          if (
            !current.composing &&
            !event.isComposing &&
            !referenceRef.current.getState() &&
            ((event.inputType === "deleteContentBackward" &&
              current.state.selection.from <= 2) ||
              (event.inputType === "deleteContentForward" &&
                current.state.selection.from < 2))
          ) {
            event.preventDefault();
            if (
              latest.current.editable &&
              !window.matchMedia("(any-pointer: coarse)").matches
            )
              latest.current.onSelect?.(false);
            return true;
          }
          if (
            event.inputType !== "historyUndo" &&
            event.inputType !== "historyRedo"
          )
            return false;
          event.preventDefault();
          if (!latest.current.editable || current.composing) return true;
          const forward = event.inputType === "historyRedo";
          const intent = referenceRef.current.getState();
          if (intent?.phase === "submitting" || intent?.phase === "unknown")
            return true;
          if (intent || draftRef.current.read().text)
            (forward ? redo : undo)(current.state, current.dispatch, current);
          else
            (forward
              ? latest.current.history.redo
              : latest.current.history.undo)();
          return true;
        },
        copy(current, event) {
          if (
            current.state.doc.firstChild!.textContent ||
            current.state.selection.from > 1 ||
            current.state.selection.to < 2 ||
            !event.clipboardData ||
            !latest.current.onCopy
          )
            return false;
          event.preventDefault();
          event.stopPropagation();
          latest.current.onCopy?.(event.clipboardData, false);
          return true;
        },
        cut(current, event) {
          if (
            current.state.doc.firstChild!.textContent ||
            current.state.selection.from > 1 ||
            current.state.selection.to < 2 ||
            !event.clipboardData ||
            !latest.current.onCopy
          )
            return false;
          event.preventDefault();
          event.stopPropagation();
          if (
            latest.current.editable &&
            referenceRef.current.getState() === null
          )
            latest.current.onCopy?.(event.clipboardData, true);
          return true;
        },
        paste(current, event) {
          event.preventDefault();
          event.stopPropagation();
          if (!latest.current.editable || !event.clipboardData) return true;
          const intent = referenceRef.current.getState();
          if (intent) {
            if (intent.phase === "search" || intent.phase === "rejected") {
              const text = event.clipboardData.getData("text/plain");
              if (text)
                current.dispatch(
                  current.state.tr.insertText(
                    text,
                    Math.max(2, current.state.selection.from),
                    Math.max(2, current.state.selection.to),
                  ),
                );
              else
                draftRef.current.set((value) => ({
                  ...value,
                  failure: "paste text into the reference search",
                }));
            }
          } else
            void Promise.resolve(
              latest.current.onPaste(event.clipboardData),
            ).then((applied) => {
              draftRef.current.set((value) => ({
                ...value,
                failure: applied
                  ? null
                  : "paste could not be applied here; nothing changed",
              }));
            });
          return true;
        },
        focus() {
          setFocused(true);
          setPickerVisible(true);
          return false;
        },
        blur() {
          latest.current.history.boundary();
          return false;
        },
        compositionstart() {
          latest.current.history.boundary();
          return false;
        },
        compositionend(current) {
          window.setTimeout(() => {
            if (current.isDestroyed || current.composing) return;
            const text = current.state.doc.firstChild!.textContent;
            if (referenceRef.current.getState()) {
              referenceRef.current.edit(text);
              if (!text.startsWith("@")) handlers.current.literal(current);
            } else if (text === "@" && latest.current.reference) {
              referenceRef.current.begin(emptyBody());
            } else if (text) handlers.current.insert(current, text);
          }, 0);
          return false;
        },
      },
      dispatchTransaction(transaction) {
        const state = view.state.apply(transaction);
        view.updateState(state);
        if (!transaction.docChanged) return;
        const text = state.doc.firstChild!.textContent;
        draftRef.current.set((previous) => ({
          ...previous,
          text,
          failure: null,
        }));
        if (view.composing) return;
        const input = referenceRef.current;
        const intent = input.getState();
        if (intent) {
          input.edit(text);
          if (
            !text.startsWith("@") &&
            (intent.phase === "search" || intent.phase === "rejected")
          )
            handlers.current.literal(view);
        } else if (text === "@" && latest.current.reference) {
          latest.current.history.boundary();
          input.begin(emptyBody());
          setPickerVisible(true);
        } else if (text) handlers.current.insert(view, text);
      },
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [draft.owner, pickerId, statusId]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || props.focusSerial === null) return;
    view.dispatch(
      view.state.tr
        .setSelection(
          TextSelection.create(view.state.doc, view.state.doc.content.size - 1),
        )
        .scrollIntoView(),
    );
    view.focus();
  }, [draft.owner, props.focusSerial]);

  useLayoutEffect(() => {
    viewRef.current?.setProps({});
    const view = viewRef.current;
    if (!view || view.composing) return;
    if (draft.value.completion !== reference.completion) {
      deferredLiteral.current = null;
      reset(view);
    }
    if (
      deferredLiteral.current !== null &&
      deferredLiteral.current !== props.onInsert &&
      reference.state === null &&
      props.editable
    ) {
      deferredLiteral.current = null;
      const text = draftRef.current.read().text;
      if (text) handlers.current.insert(view, text);
    }
  });

  const href = props.item.activation.href;
  return (
    <div
      ref={shell}
      className={styles.shell}
      data-reference-editor={`continuation:${props.occurrenceKey}`}
      onBlurCapture={() => {
        window.requestAnimationFrame(() => {
          if (!shell.current?.contains(document.activeElement))
            setFocused(false);
        });
      }}
    >
      <div ref={host} className={styles.host} />
      {token
        ? createPortal(
            href ? (
              <a
                className={styles.link}
                href={href}
                aria-label={`open ${props.item.label}`}
                data-workspace-rich-target="true"
                onClick={(event) =>
                  activateTargetLink({
                    event,
                    runtime,
                    target: { href, labelHint: props.item.label },
                  })
                }
                onKeyDown={(event) =>
                  activateTargetLink({
                    event,
                    runtime,
                    target: { href, labelHint: props.item.label },
                  })
                }
              >
                <ResourceBody body={props.item.preview.body} />
              </a>
            ) : (
              <span aria-disabled="true">
                <ResourceBody body={props.item.preview.body} />
              </span>
            ),
            token,
          )
        : null}
      {draft.value.failure ? (
        <p id={statusId} className={styles.status} role="status">
          {draft.value.failure}
          {draft.value.text && reference.state === null ? (
            <>
              {" "}
              <button
                type="button"
                className={styles.retry}
                onClick={() => {
                  const view = viewRef.current;
                  if (view) insert(view, draftRef.current.read().text);
                }}
              >
                retry insertion
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {reference.state && focused && pickerVisible ? (
        <ReferencePicker
          input={reference}
          id={pickerId}
          returnFocus={() => viewRef.current?.dom ?? null}
          onReviewPosition={reference.reviewPosition}
        />
      ) : null}
    </div>
  );
}
