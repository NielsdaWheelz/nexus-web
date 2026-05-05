"use client";

import { useEffect, useRef, useState } from "react";
import { Fragment, type Node as ProseMirrorNode } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history } from "prosemirror-history";
import {
  createMarkdownPastePlugin,
  createObjectRefSyntaxPlugin,
  createOutlineKeymap,
} from "@/lib/notes/prosemirror/commands";
import { outlineSchema } from "@/lib/notes/prosemirror/schema";
import { searchObjectRefs, type HydratedObjectRef } from "@/lib/objectRefs";
import ObjectRefAutocomplete from "@/components/notes/ObjectRefAutocomplete";
import "prosemirror-view/style/prosemirror.css";
import styles from "./ProseMirrorOutlineEditor.module.css";

interface ProseMirrorOutlineEditorProps {
  doc: ProseMirrorNode;
  editable?: boolean;
  ariaLabel?: string;
  createBlockId?: () => string;
  singleBlock?: boolean;
  searchObjects?: (query: string) => Promise<HydratedObjectRef[]>;
  onDocChange?: (doc: ProseMirrorNode) => void;
  onOpenBlock?: (blockId: string, openInNewPane: boolean) => void;
  onOpenObject?: (objectType: string, objectId: string, openInNewPane: boolean) => void;
}

interface ObjectRefTextRange {
  from: number;
  to: number;
  query: string;
  pageAndNoteOnly: boolean;
}

interface ObjectRefMenuState extends ObjectRefTextRange {
  left: number;
  top: number;
  objects: HydratedObjectRef[];
}

const OBJECT_REF_SEARCH_QUERY_MAX_LENGTH = 200;

export default function ProseMirrorOutlineEditor({
  doc,
  editable = true,
  ariaLabel = "Notes outline",
  createBlockId,
  singleBlock = false,
  searchObjects = searchObjectRefs,
  onDocChange,
  onOpenBlock,
  onOpenObject,
}: ProseMirrorOutlineEditorProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onDocChangeRef = useRef(onDocChange);
  const onOpenBlockRef = useRef(onOpenBlock);
  const onOpenObjectRef = useRef(onOpenObject);
  const editableRef = useRef(editable);
  const searchObjectsRef = useRef(searchObjects);
  const searchRequestRef = useRef(0);
  const [objectRefMenu, setObjectRefMenu] = useState<ObjectRefMenuState | null>(null);
  const objectRefMenuRef = useRef<ObjectRefMenuState | null>(null);

  useEffect(() => {
    onDocChangeRef.current = onDocChange;
  }, [onDocChange]);

  useEffect(() => {
    onOpenBlockRef.current = onOpenBlock;
    onOpenObjectRef.current = onOpenObject;
  }, [onOpenBlock, onOpenObject]);

  useEffect(() => {
    searchObjectsRef.current = searchObjects;
  }, [searchObjects]);

  useEffect(() => {
    editableRef.current = editable;
    viewRef.current?.setProps({ editable: () => editableRef.current });
    if (!editable) {
      searchRequestRef.current += 1;
      setObjectRefMenu(null);
    }
  }, [editable]);

  useEffect(() => {
    objectRefMenuRef.current = objectRefMenu;
  }, [objectRefMenu]);

  function insertObjectRef(object: HydratedObjectRef) {
    const view = viewRef.current;
    const menu = objectRefMenuRef.current;
    if (!view || !menu) {
      return;
    }

    const node = outlineSchema.nodes.object_ref!.create({
      objectType: object.objectType,
      objectId: object.objectId,
      label: object.label,
    });
    const space = outlineSchema.text(" ");
    const tr = view.state.tr.replaceWith(
      menu.from,
      menu.to,
      Fragment.fromArray([node, space])
    );
    tr.setSelection(TextSelection.create(tr.doc, menu.from + node.nodeSize + space.nodeSize));
    searchRequestRef.current += 1;
    setObjectRefMenu(null);
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }

  useEffect(() => {
    const host = hostRef.current;
    const shell = shellRef.current;
    if (!host) {
      return;
    }

    async function openObjectRefMenu(
      view: EditorView,
      trigger: ObjectRefTextRange,
      readLatestTrigger: (state: EditorState) => ObjectRefTextRange | null
    ) {
      if (!shell || !editableRef.current) {
        searchRequestRef.current += 1;
        setObjectRefMenu(null);
        return;
      }

      const request = searchRequestRef.current + 1;
      searchRequestRef.current = request;
      const caret = view.coordsAtPos(trigger.to);
      const shellBox = shell.getBoundingClientRect();
      const objects = await searchObjectsRef.current(trigger.query);
      if (searchRequestRef.current !== request) {
        return;
      }

      const latest = readLatestTrigger(view.state);
      if (
        !latest ||
        latest.from !== trigger.from ||
        latest.to !== trigger.to ||
        latest.query !== trigger.query ||
        latest.pageAndNoteOnly !== trigger.pageAndNoteOnly
      ) {
        setObjectRefMenu(null);
        return;
      }

      setObjectRefMenu({
        ...trigger,
        objects: trigger.pageAndNoteOnly
          ? objects.filter(
              (object) => object.objectType === "page" || object.objectType === "note_block"
            )
          : objects,
        left: Math.max(0, caret.left - shellBox.left),
        top: Math.max(0, caret.bottom - shellBox.top + 6),
      });
    }

    async function refreshObjectRefMenu(nextState: EditorState) {
      const view = viewRef.current;
      const trigger = objectRefTriggerFromState(nextState);
      if (!view || !trigger) {
        searchRequestRef.current += 1;
        setObjectRefMenu(null);
        return;
      }

      await openObjectRefMenu(view, trigger, objectRefTriggerFromState);
    }

    const view = new EditorView(host, {
      state: EditorState.create({
        schema: outlineSchema,
        doc,
        plugins: [
          history(),
          createOutlineKeymap(createBlockId, singleBlock),
          ...(singleBlock ? [] : [createMarkdownPastePlugin(createBlockId)]),
          createObjectRefSyntaxPlugin(),
        ],
      }),
      attributes: {
        class: styles.editorView,
        role: "textbox",
        "aria-label": ariaLabel,
        "aria-multiline": "true",
      },
      editable: () => editableRef.current,
      handleDOMEvents: {
        click(_view, event) {
          if (!(event.target instanceof HTMLElement)) {
            return false;
          }
          const target = event.target;
          const objectRef = target.closest<HTMLElement>("[data-object-type][data-object-id]");
          if (objectRef && host.contains(objectRef)) {
            event.preventDefault();
            onOpenObjectRef.current?.(
              objectRef.dataset.objectType ?? "",
              objectRef.dataset.objectId ?? "",
              event.shiftKey
            );
            return true;
          }
          const blockHandle = target.closest<HTMLElement>("[data-note-block-open]");
          if (blockHandle && host.contains(blockHandle)) {
            event.preventDefault();
            onOpenBlockRef.current?.(blockHandle.dataset.noteBlockOpen ?? "", event.shiftKey);
            return true;
          }
          return false;
        },
        keydown(_view, event) {
          if (!(event.target instanceof HTMLElement)) {
            return false;
          }
          if (
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            !event.shiftKey &&
            event.key.toLowerCase() === "k"
          ) {
            const trigger = objectRefSelectionFromState(_view.state);
            if (!trigger) {
              return false;
            }
            event.preventDefault();
            void openObjectRefMenu(_view, trigger, objectRefSelectionFromState);
            return true;
          }
          if (event.key !== "Enter" && event.key !== " ") {
            return false;
          }

          const target = event.target;
          const objectRef = target.closest<HTMLElement>("[data-object-type][data-object-id]");
          if (objectRef && host.contains(objectRef)) {
            event.preventDefault();
            onOpenObjectRef.current?.(
              objectRef.dataset.objectType ?? "",
              objectRef.dataset.objectId ?? "",
              event.shiftKey
            );
            return true;
          }

          const blockHandle = target.closest<HTMLElement>("[data-note-block-open]");
          if (blockHandle && host.contains(blockHandle)) {
            event.preventDefault();
            onOpenBlockRef.current?.(blockHandle.dataset.noteBlockOpen ?? "", event.shiftKey);
            return true;
          }
          return false;
        },
      },
      dispatchTransaction(transaction) {
        const nextState = view.state.apply(transaction);
        view.updateState(nextState);
        if (transaction.docChanged) {
          onDocChangeRef.current?.(nextState.doc);
        }
        void refreshObjectRefMenu(nextState);
      },
    });

    viewRef.current = view;
    return () => {
      view.destroy();
      if (viewRef.current === view) {
        viewRef.current = null;
      }
    };
  }, [ariaLabel, createBlockId, doc, singleBlock]);

  return (
    <div ref={shellRef} className={styles.editorShell}>
      <div ref={hostRef} className={styles.editorHost} />
      {objectRefMenu && objectRefMenu.objects.length > 0 ? (
        <div
          className={styles.autocomplete}
          style={{ left: objectRefMenu.left, top: objectRefMenu.top }}
        >
          <ObjectRefAutocomplete objects={objectRefMenu.objects} onPick={insertObjectRef} />
        </div>
      ) : null}
    </div>
  );
}

function objectRefTriggerFromState(state: EditorState): ObjectRefTextRange | null {
  if (!state.selection.empty) {
    return null;
  }
  const { $from } = state.selection;
  if (!$from.parent.inlineContent) {
    return null;
  }

  const textBefore = $from.parent.textBetween(0, $from.parentOffset, "\n", "\n");
  const pageMatch = /(^|\s)\[\[([A-Za-z0-9][A-Za-z0-9 _.'-]{0,79})$/.exec(textBefore);
  if (pageMatch) {
    const query = pageMatch[2]!.trim();
    if (!query) {
      return null;
    }
    const linkIndex = pageMatch.index + pageMatch[1]!.length;
    return {
      from: $from.pos - ($from.parentOffset - linkIndex),
      to: $from.pos,
      query,
      pageAndNoteOnly: true,
    };
  }

  const match = /(^|\s)@([A-Za-z0-9][A-Za-z0-9 _.'-]{0,79})$/.exec(textBefore);
  if (!match) {
    return null;
  }
  const query = match[2]!.trim();
  if (!query) {
    return null;
  }

  const atIndex = match.index + match[1]!.length;
  return {
    from: $from.pos - ($from.parentOffset - atIndex),
    to: $from.pos,
    query,
    pageAndNoteOnly: false,
  };
}

function objectRefSelectionFromState(state: EditorState): ObjectRefTextRange | null {
  if (state.selection.empty) {
    return null;
  }
  const { $from, $to, from, to } = state.selection;
  if ($from.parent !== $to.parent || !$from.parent.inlineContent) {
    return null;
  }

  const query = state.doc
    .textBetween(from, to, " ", " ")
    .trim()
    .slice(0, OBJECT_REF_SEARCH_QUERY_MAX_LENGTH)
    .trim();
  if (!query) {
    return null;
  }

  return { from, to, query, pageAndNoteOnly: false };
}
