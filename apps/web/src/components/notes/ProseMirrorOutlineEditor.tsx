"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Fragment, type Node as ProseMirrorNode } from "prosemirror-model";
import {
  EditorState,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
} from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { history } from "prosemirror-history";
import { isApiError } from "@/lib/api/client";
import {
  createMarkdownPastePlugin,
  createObjectRefSyntaxPlugin,
  createOutlineKeymap,
} from "@/lib/notes/prosemirror/commands";
import { extractUrls } from "@/lib/extractUrls";
import {
  getFileUploadError,
  isMediaIngestionDefect,
  projectUploadReference,
  uploadIngestFile,
} from "@/lib/media/ingestionClient";
import {
  captureSourceUrl,
  isSourceUrlCaptureDefect,
} from "@/lib/media/sourceUrlCapture";
import { outlineSchema } from "@/lib/notes/prosemirror/schema";
import { codepointLength, codepointToUtf16 } from "@/lib/highlights/codepoints";
import type { FeedbackContent } from "@/components/feedback/Feedback";
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
import styles from "./ProseMirrorOutlineEditor.module.css";

interface ProseMirrorOutlineEditorProps {
  resourceKey: string;
  initialDoc: ProseMirrorNode;
  editable?: boolean;
  ariaLabel?: string;
  createBlockId?: () => string;
  singleBlock?: boolean;
  compact?: boolean;
  onDocChange?: (doc: ProseMirrorNode) => void;
  onFocusChange?: (focused: boolean) => void;
  onBlurFlush?: (doc: ProseMirrorNode) => void;
  onOpenBlock?: (blockId: string, openInNewPane: boolean) => void;
  onOpenObject?: (
    objectType: string,
    objectId: string,
    openInNewPane: boolean,
  ) => void;
  onFeedback?: (feedback: FeedbackContent) => void;
  onError?: (error: unknown) => void;
  notePulseTarget?: NotePulseEditorTarget | null;
  focusRequest?: number;
}

interface ObjectRefTextRange {
  from: number;
  to: number;
  query: string;
  filter: "all" | "page_note";
}

interface ObjectRefTrigger extends ObjectRefTextRange {
  left: number;
  top: number;
}

interface AttachmentInsertionTarget {
  blockId: string;
  block: ProseMirrorNode;
}

class MediaAttachmentContractDefect extends Error {
  constructor(message: string) {
    // justify-defect: losing the stable editor insertion target after durable
    // media acceptance violates the attachment transaction contract.
    super(message);
    this.name = "MediaAttachmentContractDefect";
  }
}

function isMediaAttachmentDefect(error: unknown): boolean {
  return (
    error instanceof MediaAttachmentContractDefect ||
    isMediaIngestionDefect(error) ||
    (!isApiError(error) &&
      !(error instanceof TypeError) &&
      !(error instanceof DOMException))
  );
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

// The `[[` trigger references pages and note blocks only; `@`/Mod-K reference any
// direct note-reference target. Both go through the lexical `purpose=reference`
// target-search path (1-char, never embeds).
const PAGE_NOTE_SCHEMES = [
  "page",
  "note_block",
] as const satisfies readonly ResourceScheme[];

export default function ProseMirrorOutlineEditor({
  resourceKey,
  initialDoc,
  editable = true,
  ariaLabel = "Notes outline",
  createBlockId,
  singleBlock = false,
  compact = false,
  onDocChange,
  onFocusChange,
  onBlurFlush,
  onOpenBlock,
  onOpenObject,
  onFeedback,
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
  const onFeedbackRef = useRef(onFeedback);
  const onErrorRef = useRef(onError);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const editableRef = useRef(editable);
  const attachmentBusyRef = useRef(false);
  const notePulseTargetRef = useRef(notePulseTarget);
  const focusRequestRef = useRef(focusRequest);
  const notePulseTimeoutRef = useRef<number | null>(null);
  const [trigger, setTrigger] = useState<ObjectRefTrigger | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const triggerRef = useRef<ObjectRefTrigger | null>(null);
  const targetsRef = useRef<ResourceTarget[]>([]);
  const activeKeyRef = useRef<string | null>(null);

  const schemes =
    trigger?.filter === "page_note" ? PAGE_NOTE_SCHEMES : undefined;
  const { targets, loading, error } = useResourceTargetSearch({
    purpose: "reference",
    query: trigger?.query ?? "",
    schemes,
  });

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
  onFeedbackRef.current = onFeedback;
  onErrorRef.current = onError;
  triggerRef.current = trigger;
  targetsRef.current = targets;
  activeKeyRef.current = activeKey;
  notePulseTargetRef.current = notePulseTarget;
  focusRequestRef.current = focusRequest;

  // Keep the active option in sync with the live result set: preserve the user's
  // hovered/arrowed choice if it survives, otherwise fall back to the first row.
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

  const applyNotePulseTarget = useCallback(
    (target: NotePulseEditorTarget | null) => {
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
        latestView.dispatch(
          latestView.state.tr.setMeta(notePulseDecorationKey, null),
        );
      }, NOTE_PULSE_RANGE_DURATION_MS);
    },
    [],
  );

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    applyNotePulseTarget(notePulseTarget ?? null);
  }, [applyNotePulseTarget, notePulseTarget]);

  // Insertion is note-owned: a chosen resource target becomes an atomic
  // `object_ref` node. Only direct-resource targets reach here (`purpose=reference`
  // never returns passage candidates), so a non-resource target is ignored.
  function insertObjectRef(target: ResourceTarget) {
    const view = viewRef.current;
    const activeTrigger = triggerRef.current;
    if (!view || !activeTrigger || target.kind !== "resource") {
      return;
    }
    const parsed = parseResourceRef(target.item.ref);
    if (!parsed) {
      return;
    }

    const node = outlineSchema.nodes.object_ref!.create({
      objectType: parsed.scheme,
      objectId: parsed.id,
      label: target.item.label,
    });
    const space = outlineSchema.text(" ");
    const tr = view.state.tr.replaceWith(
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
    setTrigger(null);
    setActiveKey(null);
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }

  function closeObjectRefMenu() {
    setTrigger(null);
    setActiveKey(null);
  }

  const menuOpen = Boolean(trigger && targets.length > 0);
  const activeOptionId =
    trigger && activeKey
      ? `${autocompleteListboxId}-option-${activeKey}`
      : undefined;

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.setProps({
      attributes: editorAttributes({
        ariaLabel,
        compact,
        menuOpen,
        autocompleteListboxId,
        activeOptionId,
      }),
    });
  }, [activeOptionId, ariaLabel, autocompleteListboxId, compact, menuOpen]);

  const attachFiles = useCallback(
    async (view: EditorView, files: File[]) => {
      if (!editableRef.current || files.length === 0) {
        return;
      }
      if (!createBlockId) {
        onErrorRef.current?.(new Error("This note cannot attach files."));
        return;
      }
      if (singleBlock && files.length > 1) {
        onErrorRef.current?.(new Error("Attach one file at a time here."));
        return;
      }
      const target = attachmentInsertionTarget(view);
      if (!target) {
        onErrorRef.current?.(new Error("Choose a note block first."));
        return;
      }

      attachmentBusyRef.current = true;
      view.setProps({
        editable: () => editableRef.current && !attachmentBusyRef.current,
      });
      try {
        for (const file of files) {
          const uploadError = getFileUploadError(file);
          if (uploadError) {
            onErrorRef.current?.(new Error(uploadError));
            continue;
          }

          try {
            let referenced = false;
            const upload = await uploadIngestFile({
              file,
              libraryIds: [],
              onAcceptedIdentity: ({ mediaId }) => {
                referenced = insertMediaAttachment(view, {
                  mediaId,
                  label: file.name,
                  createBlockId,
                  singleBlock,
                  target,
                });
                if (!referenced) {
                  throw new MediaAttachmentContractDefect(
                    "The accepted attachment target changed unexpectedly.",
                  );
                }
              },
            });
            const { mediaId, warning } = projectUploadReference({
              result: upload,
              processingFailureFeedback: {
                severity: "warning",
                title: "File was attached, but source processing failed.",
              },
            });
            if (!referenced) {
              throw new MediaAttachmentContractDefect(
                `Accepted media ${mediaId} was not referenced by the note.`,
              );
            }
            if (warning) onFeedbackRef.current?.(warning);
          } catch (error: unknown) {
            if (isMediaAttachmentDefect(error)) {
              setDefect({ error });
              return;
            }
            onErrorRef.current?.(error);
          }
        }
      } finally {
        attachmentBusyRef.current = false;
        view.setProps({
          editable: () => editableRef.current && !attachmentBusyRef.current,
        });
      }
    },
    [createBlockId, singleBlock],
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
      if (singleBlock && urls.length > 1) {
        onErrorRef.current?.(new Error("Attach one URL at a time here."));
        return;
      }
      const target = attachmentInsertionTarget(view);
      if (!target) {
        onErrorRef.current?.(new Error("Choose a note block first."));
        return;
      }

      attachmentBusyRef.current = true;
      view.setProps({
        editable: () => editableRef.current && !attachmentBusyRef.current,
      });
      try {
        for (const url of urls) {
          let result;
          try {
            result = await captureSourceUrl({ url, libraryIds: [] });
          } catch (error) {
            if (isSourceUrlCaptureDefect(error)) {
              setDefect({ error });
              return;
            }
            onErrorRef.current?.(error);
            continue;
          }
          if (!result.ok) {
            onErrorRef.current?.(new Error(result.feedback.title));
            continue;
          }
          const referenced = insertMediaAttachment(view, {
            mediaId: result.mediaId,
            label: result.label,
            createBlockId,
            singleBlock,
            target,
          });
          if (!referenced) {
            setDefect({
              error: new MediaAttachmentContractDefect(
                "The accepted URL attachment target changed unexpectedly.",
              ),
            });
            return;
          }
          if (result.sourceFailed) {
            onFeedbackRef.current?.({
              severity: "warning",
              title: "URL was attached, but source processing failed.",
            });
          }
        }
      } finally {
        attachmentBusyRef.current = false;
        view.setProps({
          editable: () => editableRef.current && !attachmentBusyRef.current,
        });
      }
    },
    [createBlockId, singleBlock],
  );

  useEffect(() => {
    const host = hostRef.current;
    const shell = shellRef.current;
    if (!host) {
      return;
    }

    // Position the menu at the caret and open it for `range`. Callers pass the
    // trigger derived from the doc (`[[`/`@`) or from the selection (Mod-K).
    function openObjectRefMenu(view: EditorView, range: ObjectRefTextRange) {
      if (!shell || !editableRef.current) {
        setTrigger(null);
        setActiveKey(null);
        return;
      }
      const caret = view.coordsAtPos(range.to);
      const shellBox = shell.getBoundingClientRect();
      setTrigger({
        ...range,
        left: Math.max(0, caret.left - shellBox.left),
        top: Math.max(0, caret.bottom - shellBox.top + 6),
      });
    }

    function refreshObjectRefMenu(view: EditorView, nextState: EditorState) {
      const range = objectRefTriggerFromState(nextState);
      if (!range) {
        setTrigger(null);
        setActiveKey(null);
        return;
      }
      openObjectRefMenu(view, range);
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
      editable: () => editableRef.current && !attachmentBusyRef.current,
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
          const objectRef = target.closest<HTMLElement>(
            "[data-object-type][data-object-id]",
          );
          if (objectRef && host.contains(objectRef)) {
            event.preventDefault();
            onOpenObjectRef.current?.(
              objectRef.dataset.objectType ?? "",
              objectRef.dataset.objectId ?? "",
              event.shiftKey,
            );
            return true;
          }
          const blockHandle = target.closest<HTMLElement>(
            "[data-note-block-open]",
          );
          if (blockHandle && host.contains(blockHandle)) {
            event.preventDefault();
            onOpenBlockRef.current?.(
              blockHandle.dataset.noteBlockOpen ?? "",
              event.shiftKey,
            );
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
              new Error(
                "Select the note body or empty it before attaching files.",
              ),
            );
            return true;
          }
          const position = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          });
          if (position) {
            view.dispatch(
              view.state.tr.setSelection(
                Selection.near(view.state.doc.resolve(position.pos)),
              ),
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
                new Error(
                  "Select the note body or empty it before attaching files.",
                ),
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
          if (triggerRef.current) {
            const handledAutocompleteKey = handleObjectRefMenuKeydown(event, {
              targets: targetsRef.current,
              activeKey: activeKeyRef.current,
              setActiveKey,
              close: closeObjectRefMenu,
              pick: insertObjectRef,
            });
            if (handledAutocompleteKey) {
              return true;
            }
          }
          if (
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            !event.shiftKey &&
            event.key.toLowerCase() === "k"
          ) {
            const range = objectRefSelectionFromState(_view.state);
            if (!range) {
              return false;
            }
            event.preventDefault();
            openObjectRefMenu(_view, range);
            return true;
          }
          if (event.key !== "Enter" && event.key !== " ") {
            return false;
          }

          const target = event.target;
          const objectRef = target.closest<HTMLElement>(
            "[data-object-type][data-object-id]",
          );
          if (objectRef && host.contains(objectRef)) {
            event.preventDefault();
            onOpenObjectRef.current?.(
              objectRef.dataset.objectType ?? "",
              objectRef.dataset.objectId ?? "",
              event.shiftKey,
            );
            return true;
          }

          const blockHandle = target.closest<HTMLElement>(
            "[data-note-block-open]",
          );
          if (blockHandle && host.contains(blockHandle)) {
            event.preventDefault();
            onOpenBlockRef.current?.(
              blockHandle.dataset.noteBlockOpen ?? "",
              event.shiftKey,
            );
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
        refreshObjectRefMenu(view, nextState);
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

  if (defect) throw defect.error;

  return (
    <div ref={shellRef} className={styles.editorShell}>
      <div ref={hostRef} className={styles.editorHost} />
      {trigger && targets.length > 0 ? (
        <div
          className={styles.autocomplete}
          style={{ left: trigger.left, top: trigger.top }}
        >
          <ResourceTargetListbox
            id={autocompleteListboxId}
            ariaLabel="Object references"
            targets={targets}
            activeKey={activeKey}
            loading={loading}
            error={error}
            onHover={(target) => setActiveKey(resourceTargetKey(target))}
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
    target: AttachmentInsertionTarget;
  },
): boolean {
  const embed = outlineSchema.nodes.object_embed!.create({
    objectType: "media",
    objectId: input.mediaId,
    label: input.label,
    relationType: "embeds",
    displayMode: "compact",
  });
  const matches: Array<{ block: ProseMirrorNode; blockPos: number }> = [];
  view.state.doc.descendants((node, pos) => {
    if (
      matches.length === 0 &&
      node.type === outlineSchema.nodes.outline_block &&
      node.attrs.id === input.target.blockId
    ) {
      matches.push({ block: node, blockPos: pos });
      return false;
    }
    return matches.length === 0;
  });
  const match = matches[0];
  if (!match) return false;
  const { block, blockPos } = match;
  if (input.singleBlock) {
    if (!block.eq(input.target.block)) return false;
    const body = block.firstChild;
    if (!body) {
      return false;
    }
    const bodyFrom = blockPos + 1;
    const bodyTo = bodyFrom + body.nodeSize;
    view.dispatch(
      view.state.tr
        .setNodeMarkup(blockPos, undefined, block.attrs)
        .replaceWith(bodyFrom, bodyTo, embed)
        .scrollIntoView(),
    );
    return true;
  }

  const attachmentBlock = outlineSchema.nodes.outline_block!.create(
    { id: input.createBlockId(), collapsed: false },
    [embed],
  );
  view.dispatch(
    view.state.tr
      .insert(blockPos + block.nodeSize, attachmentBlock)
      .scrollIntoView(),
  );
  return true;
}

function attachmentInsertionTarget(
  view: EditorView,
): AttachmentInsertionTarget | null {
  const { $from } = view.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const block = $from.node(depth);
    if (block.type !== outlineSchema.nodes.outline_block) continue;
    const blockId = block.attrs.id;
    return typeof blockId === "string" && blockId.length > 0
      ? { blockId, block }
      : null;
  }
  return null;
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
  return (
    !selection.empty &&
    selection.from <= bodyContentFrom &&
    selection.to >= bodyContentTo
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

function notePulseDecorations(
  doc: ProseMirrorNode,
  target: NotePulseEditorTarget,
): DecorationSet {
  const fromOffset = Math.max(0, Math.floor(target.startOffset));
  const toOffset = Math.max(fromOffset, Math.floor(target.endOffset));
  if (toOffset <= fromOffset) {
    return DecorationSet.empty;
  }

  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (
      node.type !== outlineSchema.nodes.outline_block ||
      node.attrs.id !== target.blockId
    ) {
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
          childFrom +
          codepointToUtf16(text, Math.max(0, fromOffset - logicalFrom));
        decorationTo =
          childFrom +
          codepointToUtf16(
            text,
            Math.min(logicalLength, toOffset - logicalFrom),
          );
      }
      if (decorationTo > decorationFrom) {
        decorations.push(
          Decoration.inline(decorationFrom, decorationTo, {
            class: "nexus-note-range-pulse",
            "data-note-pulse-range": "true",
          }),
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
  if (
    node.type === outlineSchema.nodes.image &&
    typeof node.attrs.alt === "string"
  ) {
    return codepointLength(node.attrs.alt);
  }
  return 0;
}

function objectRefTriggerFromState(
  state: EditorState,
): ObjectRefTextRange | null {
  if (!state.selection.empty) {
    return null;
  }
  const { $from } = state.selection;
  if (!$from.parent.inlineContent) {
    return null;
  }

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

function objectRefSelectionFromState(
  state: EditorState,
): ObjectRefTextRange | null {
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
  const { targets } = input;
  if (targets.length === 0) {
    return false;
  }
  const currentIndex = Math.max(
    0,
    targets.findIndex(
      (target) => resourceTargetKey(target) === input.activeKey,
    ),
  );
  const setIndex = (index: number) => {
    const target = targets[(index + targets.length) % targets.length];
    if (target) {
      input.setActiveKey(resourceTargetKey(target));
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
      setIndex(targets.length - 1);
      return true;
    case "Enter":
    case "Tab": {
      event.preventDefault();
      const selected =
        targets.find(
          (target) => resourceTargetKey(target) === input.activeKey,
        ) ?? targets[0];
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
