"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
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
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { usePaneReturnDescendantReady } from "@/lib/panes/paneRuntime";
import { workspaceTargetClickIntent } from "@/lib/panes/targetLinkActivation";
import {
  createNoteBodyKeymap,
  createObjectRefSyntaxPlugin,
  splitNoteBodyAtSelection,
  type NoteBodySplit as ProseMirrorNoteBodySplit,
} from "@/lib/notes/prosemirror/commands";
import {
  createNoteBodyDoc,
  noteBodySchema,
  noteBodyValueFromDoc,
  type NoteBodyValue,
} from "@/lib/notes/prosemirror/schema";
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
import { codepointLength, codepointToUtf16 } from "@/lib/highlights/codepoints";
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
  initialBodyPmJson: Record<string, unknown>;
  fallbackBodyText?: string;
  returnScope?: "Notes.EditorBlocks";
  editable?: boolean;
  ariaLabel?: string;
  compact?: boolean;
  onBodyChange?: (body: NoteBodyChange) => void;
  onFocusChange?: (focused: boolean) => void;
  onBlurFlush?: (body: NoteBodyChange) => void;
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
  onMove?: (direction: "up" | "down") => void;
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
  left: number;
  top: number;
}

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

function PaneReturnEditorScope({
  rootRef,
  ready,
  children,
}: {
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly ready: boolean;
  readonly children: ReactNode;
}) {
  usePaneReturnDescendantReady({ rootRef, ready });
  return (
    <div
      ref={rootRef}
      className={styles.editorShell}
      data-pane-return-scope="Notes.EditorBlocks"
    >
      {children}
    </div>
  );
}

export default function NoteBodyEditor({
  resourceKey,
  initialBodyPmJson,
  fallbackBodyText = "",
  returnScope,
  editable = true,
  ariaLabel = "Note content",
  compact = false,
  onBodyChange,
  onFocusChange,
  onBlurFlush,
  onOpenObject,
  onFeedback,
  onError,
  notePulseTarget,
  focusRequest = 0,
  onSplit,
  onEmptyBackspace,
  onMove,
  inputHandoff = null,
  onInputHandoffClaimed,
}: NoteBodyEditorProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const autocompleteListboxId = useId();
  const viewRef = useRef<EditorView | null>(null);
  const externalDoc = useMemo(
    () =>
      createNoteBodyDoc({
        bodyPmJson: initialBodyPmJson,
        fallbackBodyText,
      }),
    [fallbackBodyText, initialBodyPmJson],
  );
  const initialDocRef = useRef(externalDoc);
  const initialResourceKeyRef = useRef(resourceKey);
  const ariaLabelRef = useRef(ariaLabel);
  const compactRef = useRef(compact);
  const focusRequestRef = useRef(focusRequest);
  const editableRef = useRef(editable);
  const attachmentBusyRef = useRef(false);
  const onBodyChangeRef = useRef(onBodyChange);
  const onFocusChangeRef = useRef(onFocusChange);
  const onBlurFlushRef = useRef(onBlurFlush);
  const onOpenObjectRef = useRef(onOpenObject);
  const onFeedbackRef = useRef(onFeedback);
  const onErrorRef = useRef(onError);
  const onSplitRef = useRef(onSplit);
  const onEmptyBackspaceRef = useRef(onEmptyBackspace);
  const onMoveRef = useRef(onMove);
  const onInputHandoffClaimedRef = useRef(onInputHandoffClaimed);
  const claimedInputHandoffIdsRef = useRef<Set<string>>(new Set());
  const notePulseTargetRef = useRef(notePulseTarget);
  const notePulseTimeoutRef = useRef<number | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [trigger, setTrigger] = useState<ObjectRefTrigger | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const triggerRef = useRef<ObjectRefTrigger | null>(null);
  const targetsRef = useRef<ResourceTarget[]>([]);
  const activeKeyRef = useRef<string | null>(null);
  const menuOpenRef = useRef(false);
  const handleUnauthenticatedApiError = useUnauthenticatedApiHandler();

  if (initialResourceKeyRef.current !== resourceKey) {
    initialResourceKeyRef.current = resourceKey;
    initialDocRef.current = externalDoc;
  }

  onBodyChangeRef.current = onBodyChange;
  onFocusChangeRef.current = onFocusChange;
  onBlurFlushRef.current = onBlurFlush;
  onOpenObjectRef.current = onOpenObject;
  onFeedbackRef.current = onFeedback;
  onErrorRef.current = onError;
  onSplitRef.current = onSplit;
  onEmptyBackspaceRef.current = onEmptyBackspace;
  onMoveRef.current = onMove;
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
    const maxTextOffset = nextDoc.textContent.length;
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
    view.updateState(
      EditorState.create({
        schema: noteBodySchema,
        doc: nextDoc,
        selection: TextSelection.create(nextDoc, from, to),
        plugins: view.state.plugins,
      }),
    );
    onBodyChangeRef.current?.(noteBodyValueFromDoc(nextDoc));
    view.focus();
    onInputHandoffClaimedRef.current?.(inputHandoff.handoffId);
  }, [editorReady, externalDoc, inputHandoff]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.eq(externalDoc)) return;
    const selectionPosition = Math.min(
      view.state.selection.from,
      externalDoc.content.size,
    );
    view.updateState(
      EditorState.create({
        schema: noteBodySchema,
        doc: externalDoc,
        selection: Selection.near(externalDoc.resolve(selectionPosition)),
        plugins: view.state.plugins,
      }),
    );
  }, [externalDoc]);

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
  }, []);

  const insertObjectRef = useCallback((target: ResourceTarget) => {
    const view = viewRef.current;
    const activeTrigger = triggerRef.current;
    if (!view || !activeTrigger || target.kind !== "resource") return;
    const parsed = parseResourceRef(target.item.ref);
    if (!parsed) return;

    const node = noteBodySchema.nodes.object_ref!.create({
      objectType: parsed.scheme,
      objectId: parsed.id,
      label: target.item.label,
    });
    const space = noteBodySchema.text(" ");
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
    closeObjectRefMenu();
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }, [closeObjectRefMenu]);

  const menuOpen = Boolean(trigger && targets.length > 0);
  menuOpenRef.current = menuOpen;
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
      view.dispatch(
        view.state.tr
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
        let referenced = false;
        const upload = await uploadIngestFile({
          file,
          libraryIds: [],
          onAcceptedIdentity: ({ mediaId }) => {
            referenced = insertMedia(view, mediaId, file.name);
            if (!referenced) {
              throw new MediaAttachmentContractDefect(
                "The accepted attachment target changed unexpectedly.",
              );
            }
          },
        });
        const { warning } = projectUploadReference({
          result: upload,
          processingFailureFeedback: {
            severity: "warning",
            title: "File was attached, but source processing failed.",
          },
        });
        if (warning) onFeedbackRef.current?.(warning);
      } catch (caught: unknown) {
        if (handleUnauthenticatedApiError(caught)) return;
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

  const attachUrl = useCallback(
    async (view: EditorView, url: string) => {
      if (!editableRef.current || !canReplaceBodyWithAttachment(view)) return;
      attachmentBusyRef.current = true;
      view.setProps({ editable: () => false });
      try {
        const result = await captureSourceUrl({ url, libraryIds: [] });
        if (!result.ok) {
          onErrorRef.current?.(new Error(result.feedback.title));
          return;
        }
        if (!insertMedia(view, result.mediaId, result.label)) {
          throw new MediaAttachmentContractDefect(
            "The accepted URL attachment target changed unexpectedly.",
          );
        }
        if (result.sourceFailed) {
          onFeedbackRef.current?.({
            severity: "warning",
            title: "URL was attached, but source processing failed.",
          });
        }
      } catch (caught: unknown) {
        if (handleUnauthenticatedApiError(caught)) return;
        if (
          isMediaAttachmentDefect(caught) ||
          isSourceUrlCaptureDefect(caught)
        ) {
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
        left: Math.max(0, caret.left - shellBox.left),
        top: Math.max(0, caret.bottom - shellBox.top + 6),
      });
    }

    function refreshObjectRefMenu(view: EditorView, state: EditorState) {
      const range = objectRefTriggerFromState(state);
      if (range) openObjectRefMenu(view, range);
      else closeObjectRefMenu();
    }

    const view = new EditorView(host, {
      state: EditorState.create({
        schema: noteBodySchema,
        doc: initialDocRef.current,
        plugins: [
          history(),
          createNotePulseDecorationPlugin(),
          createNoteBodyKeymap(),
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
      handleDOMEvents: {
        focus() {
          onFocusChangeRef.current?.(true);
          return false;
        },
        blur(currentView) {
          onFocusChangeRef.current?.(false);
          onBlurFlushRef.current?.(noteBodyValueFromDoc(currentView.state.doc));
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
          const plainText = event.clipboardData?.getData("text/plain") ?? "";
          const urls = extractUrls(plainText);
          if (
            urls.length !== 1 ||
            !isUrlOnlyPaste(plainText, urls) ||
            !canReplaceBodyWithAttachment(currentView)
          ) {
            return false;
          }
          event.preventDefault();
          void attachUrl(currentView, urls[0]!);
          return true;
        },
        keydown(currentView, event) {
          if (event.isComposing || event.keyCode === 229) return false;
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
          if (event.key === "Escape") return true;
          if (
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            !event.shiftKey &&
            event.key.toLowerCase() === "k"
          ) {
            const range = objectRefSelectionFromState(currentView.state);
            if (!range) return false;
            event.preventDefault();
            openObjectRefMenu(currentView, range);
            return true;
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
          if (event.altKey && !event.metaKey && !event.ctrlKey) {
            if (event.key === "ArrowUp" && onMoveRef.current) {
              event.preventDefault();
              onMoveRef.current("up");
              return true;
            }
            if (event.key === "ArrowDown" && onMoveRef.current) {
              event.preventDefault();
              onMoveRef.current("down");
              return true;
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
        const nextState = view.state.apply(transaction);
        view.updateState(nextState);
        if (transaction.docChanged) {
          onBodyChangeRef.current?.(noteBodyValueFromDoc(nextState.doc));
        }
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
    attachUrl,
    autocompleteListboxId,
    closeObjectRefMenu,
    insertObjectRef,
    resourceKey,
  ]);

  if (defect) throw defect.error;

  const editorContents = (
    <>
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
    </>
  );

  if (returnScope === undefined) {
    return (
      <div ref={shellRef} className={styles.editorShell}>
        {editorContents}
      </div>
    );
  }
  return (
    <PaneReturnEditorScope rootRef={shellRef} ready={editorReady}>
      {editorContents}
    </PaneReturnEditorScope>
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
  let consumed = 0;
  let position = doc.content.size;
  doc.descendants((node, nodePosition) => {
    if (!node.isText) return true;
    const length = node.text?.length ?? 0;
    if (textOffset <= consumed + length) {
      position = nodePosition + Math.max(0, textOffset - consumed);
      return false;
    }
    consumed += length;
    return true;
  });
  return Math.max(1, Math.min(position, doc.content.size));
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

function notePulseDecorations(
  doc: ProseMirrorNode,
  target: NotePulseEditorTarget,
): DecorationSet {
  const fromOffset = Math.max(0, Math.floor(target.startOffset));
  const toOffset = Math.max(fromOffset, Math.floor(target.endOffset));
  const body = doc.firstChild;
  if (!body || toOffset <= fromOffset) return DecorationSet.empty;

  const decorations: Decoration[] = [];
  let logicalOffset = 0;
  body.forEach((child, childOffset) => {
    const logicalLength = notePulseLogicalLength(child);
    const logicalFrom = logicalOffset;
    const logicalTo = logicalOffset + logicalLength;
    logicalOffset = logicalTo;
    if (
      logicalLength <= 0 ||
      toOffset <= logicalFrom ||
      fromOffset >= logicalTo
    ) {
      return;
    }
    const childFrom = 1 + childOffset;
    let decorationFrom = childFrom;
    let decorationTo = childFrom + child.nodeSize;
    if (child.isText) {
      const text = child.text ?? "";
      decorationFrom += codepointToUtf16(
        text,
        Math.max(0, fromOffset - logicalFrom),
      );
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
  return DecorationSet.create(doc, decorations);
}

function notePulseLogicalLength(node: ProseMirrorNode): number {
  if (node.isText) return codepointLength(node.text ?? "");
  if (node.type === noteBodySchema.nodes.hard_break) return 1;
  if (
    (node.type === noteBodySchema.nodes.object_ref ||
      node.type === noteBodySchema.nodes.object_embed) &&
    typeof node.attrs.label === "string"
  ) {
    return codepointLength(node.attrs.label);
  }
  if (
    node.type === noteBodySchema.nodes.image &&
    typeof node.attrs.alt === "string"
  ) {
    return codepointLength(node.attrs.alt);
  }
  return 0;
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

function objectRefSelectionFromState(
  state: EditorState,
): ObjectRefTextRange | null {
  if (state.selection.empty) return null;
  const { $from, $to, from, to } = state.selection;
  if ($from.parent !== $to.parent || !$from.parent.inlineContent) return null;
  const query = state.doc
    .textBetween(from, to, " ", " ")
    .trim()
    .slice(0, OBJECT_REF_SEARCH_QUERY_MAX_LENGTH)
    .trim();
  return query ? { from, to, query, filter: "all" } : null;
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

function isUrlOnlyPaste(text: string, urls: string[]): boolean {
  let remainder = text;
  for (const url of urls) remainder = remainder.split(url).join("");
  return remainder.replace(/[\s),.;!?]+/g, "") === "";
}
