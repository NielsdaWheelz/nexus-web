"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Fragment, type Node as ProseMirrorNode } from "prosemirror-model";
import { EditorState, Plugin, PluginKey, Selection, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { history } from "prosemirror-history";
import {
  createMarkdownPastePlugin,
  createObjectRefSyntaxPlugin,
  createOutlineKeymap,
} from "@/lib/notes/prosemirror/commands";
import { extractUrls } from "@/lib/extractUrls";
import {
  getFileUploadError,
  isFailedSourceIngest,
  uploadIngestFile,
} from "@/lib/media/ingestionClient";
import { captureSourceUrl } from "@/lib/media/sourceUrlCapture";
import { outlineSchema } from "@/lib/notes/prosemirror/schema";
import { codepointLength, codepointToUtf16 } from "@/lib/highlights/codepoints";
import {
  searchObjectRefs,
  type HydratedObjectRef,
  type ObjectRefSearchOptions,
} from "@/lib/objectRefs";
import ObjectRefAutocomplete from "@/components/notes/ObjectRefAutocomplete";
import "prosemirror-view/style/prosemirror.css";
import styles from "./ProseMirrorOutlineEditor.module.css";

interface ProseMirrorOutlineEditorProps {
  resourceKey: string;
  initialDoc: ProseMirrorNode;
  editable?: boolean;
  ariaLabel?: string;
  createBlockId?: () => string;
  singleBlock?: boolean;
  compact?: boolean;
  searchObjects?: (
    query: string,
    options?: ObjectRefSearchOptions
  ) => Promise<HydratedObjectRef[]>;
  onDocChange?: (doc: ProseMirrorNode) => void;
  onFocusChange?: (focused: boolean) => void;
  onBlurFlush?: (doc: ProseMirrorNode) => void;
  onOpenBlock?: (blockId: string, openInNewPane: boolean) => void;
  onOpenObject?: (objectType: string, objectId: string, openInNewPane: boolean) => void;
  onError?: (error: unknown) => void;
  notePulseTarget?: NotePulseEditorTarget | null;
  focusRequest?: number;
}

interface ObjectRefTextRange {
  from: number;
  to: number;
  query: string;
  filter: "all" | "page_note" | "tag";
}

interface ObjectRefMenuState extends ObjectRefTextRange {
  left: number;
  top: number;
  objects: HydratedObjectRef[];
}

export interface NotePulseEditorTarget {
  blockId: string;
  startOffset: number;
  endOffset: number;
  pulseId: number;
}

const OBJECT_REF_SEARCH_QUERY_MAX_LENGTH = 200;
const NOTE_PULSE_RANGE_DURATION_MS = 2400;
const notePulseDecorationKey = new PluginKey<DecorationSet>("notePulseRange");

function searchEditorObjectRefs(query: string, options?: ObjectRefSearchOptions) {
  return searchObjectRefs(query, 8, options);
}

export default function ProseMirrorOutlineEditor({
  resourceKey,
  initialDoc,
  editable = true,
  ariaLabel = "Notes outline",
  createBlockId,
  singleBlock = false,
  compact = false,
  searchObjects = searchEditorObjectRefs,
  onDocChange,
  onFocusChange,
  onBlurFlush,
  onOpenBlock,
  onOpenObject,
  onError,
  notePulseTarget,
  focusRequest = 0,
}: ProseMirrorOutlineEditorProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const autocompleteListboxId = useId();
  const viewRef = useRef<EditorView | null>(null);
  const initialDocRef = useRef(initialDoc);
  const initialDocResourceKeyRef = useRef(resourceKey);
  const onDocChangeRef = useRef(onDocChange);
  const onFocusChangeRef = useRef(onFocusChange);
  const onBlurFlushRef = useRef(onBlurFlush);
  const onOpenBlockRef = useRef(onOpenBlock);
  const onOpenObjectRef = useRef(onOpenObject);
  const onErrorRef = useRef(onError);
  const editableRef = useRef(editable);
  const searchObjectsRef = useRef(searchObjects);
  const searchRequestRef = useRef(0);
  const notePulseTargetRef = useRef(notePulseTarget);
  const focusRequestRef = useRef(focusRequest);
  const notePulseTimeoutRef = useRef<number | null>(null);
  const [objectRefMenu, setObjectRefMenu] = useState<ObjectRefMenuState | null>(null);
  const [activeObjectRefKey, setActiveObjectRefKey] = useState<string | null>(null);
  const objectRefMenuRef = useRef<ObjectRefMenuState | null>(null);
  const activeObjectRefKeyRef = useRef<string | null>(null);

  if (initialDocResourceKeyRef.current !== resourceKey) {
    initialDocResourceKeyRef.current = resourceKey;
    initialDocRef.current = initialDoc;
  }

  // Latest-value refs read by ProseMirror plugins / view callbacks.
  onDocChangeRef.current = onDocChange;
  onFocusChangeRef.current = onFocusChange;
  onBlurFlushRef.current = onBlurFlush;
  onOpenBlockRef.current = onOpenBlock;
  onOpenObjectRef.current = onOpenObject;
  onErrorRef.current = onError;
  searchObjectsRef.current = searchObjects;
  objectRefMenuRef.current = objectRefMenu;
  activeObjectRefKeyRef.current = activeObjectRefKey;
  notePulseTargetRef.current = notePulseTarget;
  focusRequestRef.current = focusRequest;

  useEffect(() => {
    editableRef.current = editable;
    viewRef.current?.setProps({ editable: () => editableRef.current });
    if (!editable) {
      searchRequestRef.current += 1;
      setObjectRefMenu(null);
      setActiveObjectRefKey(null);
    }
  }, [editable]);

  useEffect(() => {
    if (focusRequest > 0) {
      viewRef.current?.focus();
    }
  }, [focusRequest]);

  const applyNotePulseTarget = useCallback((target: NotePulseEditorTarget | null) => {
    if (notePulseTimeoutRef.current !== null) {
      window.clearTimeout(notePulseTimeoutRef.current);
      notePulseTimeoutRef.current = null;
    }
    const view = viewRef.current;
    if (!view) {
      return;
    }
    view.dispatch(view.state.tr.setMeta(notePulseDecorationKey, target));
    if (!target) {
      return;
    }
    notePulseTimeoutRef.current = window.setTimeout(() => {
      notePulseTimeoutRef.current = null;
      const latestView = viewRef.current;
      if (!latestView) return;
      latestView.dispatch(latestView.state.tr.setMeta(notePulseDecorationKey, null));
    }, NOTE_PULSE_RANGE_DURATION_MS);
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    applyNotePulseTarget(notePulseTarget ?? null);
  }, [applyNotePulseTarget, notePulseTarget]);

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
    setActiveObjectRefKey(null);
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }

  function closeObjectRefMenu() {
    searchRequestRef.current += 1;
    setObjectRefMenu(null);
    setActiveObjectRefKey(null);
  }

  function activateObjectRefOption(objectKey: string) {
    setActiveObjectRefKey(objectKey);
  }

  const activeOptionId =
    objectRefMenu && activeObjectRefKey
      ? `${autocompleteListboxId}-option-${activeObjectRefKey}`
      : undefined;

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const menuOpen = Boolean(objectRefMenu && objectRefMenu.objects.length > 0);
    view.setProps({
      attributes: editorAttributes({
        ariaLabel,
        compact,
        menuOpen,
        autocompleteListboxId,
        activeOptionId,
      }),
    });
  }, [activeOptionId, ariaLabel, autocompleteListboxId, compact, objectRefMenu]);

  const attachFiles = useCallback(
    async (view: EditorView, files: File[]) => {
      if (!editableRef.current || files.length === 0) {
        return;
      }
      if (!createBlockId) {
        onErrorRef.current?.(new Error("This note cannot attach files."));
        return;
      }

      for (const file of files) {
        const uploadError = getFileUploadError(file);
        if (uploadError) {
          onErrorRef.current?.(new Error(uploadError));
          continue;
        }

        try {
          const result = await uploadIngestFile({ file, libraryIds: [] });
          if (isFailedSourceIngest(result)) {
            throw new Error("File could not be attached.");
          }
          insertMediaAttachment(view, {
            mediaId: result.mediaId,
            label: file.name,
            createBlockId,
            singleBlock,
          });
        } catch (error: unknown) {
          onErrorRef.current?.(error);
        }
      }
    },
    [createBlockId, singleBlock]
  );

  const attachUrls = useCallback(
    async (view: EditorView, urls: string[]) => {
      if (!editableRef.current || urls.length === 0) {
        return;
      }
      if (!createBlockId) {
        onErrorRef.current?.(new Error("This note cannot attach URLs."));
        return;
      }

      for (const url of urls) {
        const result = await captureSourceUrl({ url, libraryIds: [] });
        if (!result.ok) {
          onErrorRef.current?.(new Error(result.feedback.title));
          continue;
        }
        insertMediaAttachment(view, {
          mediaId: result.mediaId,
          label: result.label,
          createBlockId,
          singleBlock,
        });
        if (result.sourceFailed) {
          onErrorRef.current?.(new Error("URL was attached, but source processing failed."));
        }
      }
    },
    [createBlockId, singleBlock]
  );

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
        setActiveObjectRefKey(null);
        return;
      }

      const request = searchRequestRef.current + 1;
      searchRequestRef.current = request;
      const caret = view.coordsAtPos(trigger.to);
      const shellBox = shell.getBoundingClientRect();
      const objects = await searchObjectsRef.current(
        trigger.query,
        objectRefSearchOptions(trigger.filter)
      );
      if (searchRequestRef.current !== request) {
        return;
      }

      const latest = readLatestTrigger(view.state);
      if (
        !latest ||
        latest.from !== trigger.from ||
        latest.to !== trigger.to ||
        latest.query !== trigger.query ||
        latest.filter !== trigger.filter
      ) {
        setObjectRefMenu(null);
        return;
      }

      const filteredObjects = filterObjectRefResults(objects, trigger.filter);
      setObjectRefMenu({
        ...trigger,
        objects: filteredObjects,
        left: Math.max(0, caret.left - shellBox.left),
        top: Math.max(0, caret.bottom - shellBox.top + 6),
      });
      setActiveObjectRefKey(filteredObjects[0] ? objectRefKey(filteredObjects[0]) : null);
    }

    async function refreshObjectRefMenu(nextState: EditorState) {
      const view = viewRef.current;
      const trigger = objectRefTriggerFromState(nextState);
      if (!view || !trigger) {
        searchRequestRef.current += 1;
        setObjectRefMenu(null);
        setActiveObjectRefKey(null);
        return;
      }

      await openObjectRefMenu(view, trigger, objectRefTriggerFromState);
    }

    const view = new EditorView(host, {
      state: EditorState.create({
        schema: outlineSchema,
        doc: initialDocRef.current,
        plugins: [
          history(),
          createNotePulseDecorationPlugin(),
          createOutlineKeymap(createBlockId, singleBlock),
          ...(singleBlock ? [] : [createMarkdownPastePlugin(createBlockId)]),
          createObjectRefSyntaxPlugin(),
        ],
      }),
      attributes: {
        ...editorAttributes({
          ariaLabel,
          compact,
          menuOpen: false,
          autocompleteListboxId,
          activeOptionId: undefined,
        }),
      },
      editable: () => editableRef.current,
      handleDOMEvents: {
        focus() {
          onFocusChangeRef.current?.(true);
          return false;
        },
        blur(view) {
          onFocusChangeRef.current?.(false);
          onBlurFlushRef.current?.(view.state.doc);
          return false;
        },
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
        drop(view, event) {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (files.length === 0) {
            return false;
          }
          event.preventDefault();
          if (singleBlock && !canReplaceSingleBlockWithAttachment(view)) {
            onErrorRef.current?.(
              new Error("Select the note body or empty it before attaching files.")
            );
            return true;
          }
          const position = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (position) {
            view.dispatch(
              view.state.tr.setSelection(Selection.near(view.state.doc.resolve(position.pos)))
            );
          }
          void attachFiles(view, files);
          return true;
        },
        paste(view, event) {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length > 0) {
            event.preventDefault();
            if (singleBlock && !canReplaceSingleBlockWithAttachment(view)) {
              onErrorRef.current?.(
                new Error("Select the note body or empty it before attaching files.")
              );
              return true;
            }
            void attachFiles(view, files);
            return true;
          }

          const plainText = event.clipboardData?.getData("text/plain") ?? "";
          const urls = extractUrls(plainText);
          if (urls.length === 0 || !isUrlOnlyPaste(plainText, urls)) {
            return false;
          }
          if (singleBlock && !canReplaceSingleBlockWithAttachment(view)) {
            return false;
          }

          event.preventDefault();
          void attachUrls(view, urls);
          return true;
        },
        keydown(_view, event) {
          if (!(event.target instanceof HTMLElement)) {
            return false;
          }
          const handledAutocompleteKey = handleObjectRefMenuKeydown(event, {
            menu: objectRefMenuRef.current,
            activeObjectKey: activeObjectRefKeyRef.current,
            setActiveObjectKey: setActiveObjectRefKey,
            close: closeObjectRefMenu,
            pick: insertObjectRef,
          });
          if (handledAutocompleteKey) {
            return true;
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
    if (notePulseTargetRef.current) {
      applyNotePulseTarget(notePulseTargetRef.current);
    }
    if (focusRequestRef.current > 0) {
      view.focus();
    }
    return () => {
      if (notePulseTimeoutRef.current !== null) {
        window.clearTimeout(notePulseTimeoutRef.current);
        notePulseTimeoutRef.current = null;
      }
      view.destroy();
      if (viewRef.current === view) {
        viewRef.current = null;
      }
    };
  }, [
    ariaLabel,
    applyNotePulseTarget,
    attachFiles,
    attachUrls,
    autocompleteListboxId,
    compact,
    createBlockId,
    resourceKey,
    singleBlock,
  ]);

  return (
    <div ref={shellRef} className={styles.editorShell}>
      <div ref={hostRef} className={styles.editorHost} />
      {objectRefMenu && objectRefMenu.objects.length > 0 ? (
        <div
          className={styles.autocomplete}
          style={{ left: objectRefMenu.left, top: objectRefMenu.top }}
        >
          <ObjectRefAutocomplete
            id={autocompleteListboxId}
            objects={objectRefMenu.objects}
            activeObjectKey={activeObjectRefKey}
            optionIdForObject={(object) =>
              `${autocompleteListboxId}-option-${objectRefKey(object)}`
            }
            onActiveChange={activateObjectRefOption}
            onPick={insertObjectRef}
          />
        </div>
      ) : null}
    </div>
  );
}

function insertMediaAttachment(
  view: EditorView,
  input: {
    mediaId: string;
    label: string;
    createBlockId: () => string;
    singleBlock: boolean;
  }
) {
  const embed = outlineSchema.nodes.object_embed!.create({
    objectType: "media",
    objectId: input.mediaId,
    label: input.label,
    relationType: "embeds",
    displayMode: "compact",
  });
  const { $from } = view.state.selection;
  let blockDepth = -1;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type === outlineSchema.nodes.outline_block) {
      blockDepth = depth;
      break;
    }
  }
  if (blockDepth < 0) {
    return;
  }

  const block = $from.node(blockDepth);
  const blockPos = $from.before(blockDepth);
  if (input.singleBlock) {
    if (!canReplaceSingleBlockWithAttachment(view)) {
      return false;
    }
    const body = block.firstChild;
    if (!body) {
      return false;
    }
    const bodyFrom = $from.start(blockDepth);
    const bodyTo = bodyFrom + body.nodeSize;
    view.dispatch(
      view.state.tr
        .setNodeMarkup(blockPos, undefined, block.attrs)
        .replaceWith(bodyFrom, bodyTo, embed)
        .scrollIntoView()
    );
    return true;
  }

  const attachmentBlock = outlineSchema.nodes.outline_block!.create(
    { id: input.createBlockId(), collapsed: false },
    [embed]
  );
  view.dispatch(view.state.tr.insert(blockPos + block.nodeSize, attachmentBlock).scrollIntoView());
  return true;
}

function canReplaceSingleBlockWithAttachment(view: EditorView): boolean {
  const { $from } = view.state.selection;
  let blockDepth = -1;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type === outlineSchema.nodes.outline_block) {
      blockDepth = depth;
      break;
    }
  }
  if (blockDepth < 0) {
    return false;
  }
  const block = $from.node(blockDepth);
  const body = block.firstChild;
  if (!body) {
    return true;
  }
  if (body.content.size === 0 && body.textContent.trim() === "") {
    return true;
  }
  const bodyFrom = $from.start(blockDepth);
  const bodyTo = bodyFrom + body.nodeSize;
  const bodyContentFrom = bodyFrom + 1;
  const bodyContentTo = bodyTo - 1;
  const selection = view.state.selection;
  return !selection.empty && selection.from <= bodyContentFrom && selection.to >= bodyContentTo;
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
          return meta ? notePulseDecorations(transaction.doc, meta) : DecorationSet.empty;
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

function notePulseDecorations(
  doc: ProseMirrorNode,
  target: NotePulseEditorTarget
): DecorationSet {
  const fromOffset = Math.max(0, Math.floor(target.startOffset));
  const toOffset = Math.max(fromOffset, Math.floor(target.endOffset));
  if (toOffset <= fromOffset) {
    return DecorationSet.empty;
  }

  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type !== outlineSchema.nodes.outline_block || node.attrs.id !== target.blockId) {
      return true;
    }
    const body = node.firstChild;
    if (!body) {
      return false;
    }
    const bodyContentStart = pos + 2;
    let logicalOffset = 0;
    body.forEach((child, childOffset) => {
      const logicalLength = notePulseLogicalLength(child);
      if (logicalLength <= 0) {
        return;
      }
      const logicalFrom = logicalOffset;
      const logicalTo = logicalOffset + logicalLength;
      logicalOffset = logicalTo;
      if (toOffset <= logicalFrom || fromOffset >= logicalTo) {
        return;
      }

      const childFrom = bodyContentStart + childOffset;
      let decorationFrom = childFrom;
      let decorationTo = childFrom + child.nodeSize;
      if (child.isText) {
        const text = child.text ?? "";
        decorationFrom =
          childFrom + codepointToUtf16(text, Math.max(0, fromOffset - logicalFrom));
        decorationTo =
          childFrom + codepointToUtf16(text, Math.min(logicalLength, toOffset - logicalFrom));
      }
      if (decorationTo > decorationFrom) {
        decorations.push(
          Decoration.inline(decorationFrom, decorationTo, {
            class: "nexus-note-range-pulse",
            "data-note-pulse-range": "true",
          })
        );
      }
    });
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

function notePulseLogicalLength(node: ProseMirrorNode): number {
  if (node.isText) {
    return codepointLength(node.text ?? "");
  }
  if (node.type === outlineSchema.nodes.hard_break) {
    return 1;
  }
  if (
    (node.type === outlineSchema.nodes.object_ref ||
      node.type === outlineSchema.nodes.object_embed) &&
    typeof node.attrs.label === "string"
  ) {
    return codepointLength(node.attrs.label);
  }
  if (node.type === outlineSchema.nodes.image && typeof node.attrs.alt === "string") {
    return codepointLength(node.attrs.alt);
  }
  return 0;
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
      filter: "page_note",
    };
  }

  const tagMatch = /(^|\s)#([A-Za-z0-9][A-Za-z0-9_-]{0,79})$/.exec(textBefore);
  if (tagMatch) {
    const query = tagMatch[2]!.trim();
    const tagIndex = tagMatch.index + tagMatch[1]!.length;
    return {
      from: $from.pos - ($from.parentOffset - tagIndex),
      to: $from.pos,
      query,
      filter: "tag",
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
    filter: "all",
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

  return { from, to, query, filter: "all" };
}

function filterObjectRefResults(
  objects: HydratedObjectRef[],
  filter: ObjectRefTextRange["filter"]
): HydratedObjectRef[] {
  if (filter === "page_note") {
    return objects.filter(
      (object) => object.objectType === "page" || object.objectType === "note_block"
    );
  }
  if (filter === "tag") {
    return objects.filter((object) => object.objectType === "tag");
  }
  return objects;
}

function objectRefSearchOptions(filter: ObjectRefTextRange["filter"]): ObjectRefSearchOptions {
  if (filter === "page_note") {
    return { objectTypes: ["page", "note_block"] };
  }
  if (filter === "tag") {
    return { objectTypes: ["tag"] };
  }
  return {};
}

function objectRefKey(object: HydratedObjectRef): string {
  return `${object.objectType}:${object.objectId}`;
}

function editorAttributes(input: {
  ariaLabel: string;
  compact: boolean;
  menuOpen: boolean;
  autocompleteListboxId: string;
  activeOptionId: string | undefined;
}): Record<string, string> {
  return {
    class: input.compact ? `${styles.editorView} ${styles.compact}` : styles.editorView,
    role: "textbox",
    "aria-label": input.ariaLabel,
    "aria-multiline": "true",
    "aria-expanded": input.menuOpen ? "true" : "false",
    ...(input.menuOpen
      ? {
          "aria-autocomplete": "list",
          "aria-controls": input.autocompleteListboxId,
          ...(input.activeOptionId ? { "aria-activedescendant": input.activeOptionId } : {}),
        }
      : {}),
  };
}

function handleObjectRefMenuKeydown(
  event: KeyboardEvent,
  input: {
    menu: ObjectRefMenuState | null;
    activeObjectKey: string | null;
    setActiveObjectKey: (objectKey: string | null) => void;
    close: () => void;
    pick: (object: HydratedObjectRef) => void;
  }
): boolean {
  const objects = input.menu?.objects ?? [];
  if (objects.length === 0) {
    return false;
  }
  const currentIndex = Math.max(
    0,
    objects.findIndex((object) => objectRefKey(object) === input.activeObjectKey)
  );
  const setIndex = (index: number) => {
    const object = objects[(index + objects.length) % objects.length];
    if (object) {
      input.setActiveObjectKey(objectRefKey(object));
    }
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
      setIndex(objects.length - 1);
      return true;
    case "Enter":
    case "Tab": {
      event.preventDefault();
      const selected =
        objects.find((object) => objectRefKey(object) === input.activeObjectKey) ??
        objects[0];
      if (selected) {
        input.pick(selected);
      }
      return true;
    }
    case "Escape":
      event.preventDefault();
      input.close();
      return true;
    default:
      return false;
  }
}

function isUrlOnlyPaste(text: string, urls: string[]): boolean {
  let remainder = text;
  for (const url of urls) {
    remainder = remainder.split(url).join("");
  }
  return remainder.replace(/[\s),.;!?]+/g, "") === "";
}
