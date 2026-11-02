"use client";
/** A single native editing host renders every disclosed authored occurrence.
 * Branch components read data only; the root controls document admission. */
import {createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode} from "react";
import {ResourceBranch, ResourceOutlineContext} from "@/components/resources/ResourceOutlineList";
import Dialog from "@/components/ui/Dialog";
import {useCopyFeedback} from "@/components/ui/useCopyFeedback";
import {Hold, useOutcome} from "@/components/feedback/Feedback";
import {Ruling} from "@/components/feedback/Ruling";
import type {CommandVerb} from "@/components/feedback/stage";
import {OutlineEmbeddingOccurrence, useEditorDraft} from "@/lib/notes/editorHost";
import {useWordsAtRisk, useWritingRuntime} from "@/lib/notes/hooks";
import {useAuthoredAccountId, WORDS_AT_RISK} from "@/lib/authored/provider";
import {OutlineController, OutlineActionRefusal, type BranchRequest, type RootField} from "@/lib/notes/outlineController";
import {OutlinePendingInput} from "@/lib/notes/outlinePending";
import {OutlineHistory} from "@/lib/notes/structure";
import {useOutlineWindow} from "@/lib/notes/useOutlineWindow";
import type {PaneHeaderEditor} from "@/lib/panes/paneChrome";
import {usePaneOutlineCommands} from "@/lib/panes/paneChrome";
import {useNativeKeyboardVisibility} from "@/lib/ui/useKeyboardInset";
import {ClipboardWriteUnavailableError} from "@/lib/ui/copyText";
import {useRenderEnvironment} from "@/lib/renderEnvironment/provider";
import {useWorkGuard} from "@/lib/unsavedWork";
import {LocalCommitError, isAuthoredStorageFailure} from "@/lib/notes/runtime";
import {emptyBody} from "@nexus/authored/body";
import type {Intent} from "@nexus/authored/commands";
import type {ResourceProjection} from "@nexus/authored/types";
import type {FocusSelection} from "@/lib/notes/editorTypes";
import type {WritingDocument} from "@/lib/notes/runtime";
import NoteEditor, {type NoteEditorHandle} from "./NoteEditor";
import OutlineEditorRows from "./OutlineEditorRow";
import AuthoredReadFailure from "./AuthoredReadFailure";
import {useAuthoredPaneRoot} from "./AuthoredPaneRoot";

export interface LocalOutlineHandle {
  append(): Promise<void>;
  revealRoot(): void;
  focusRoot(resolve?: (document: WritingDocument) => FocusSelection, mayFocus?: () => boolean): Promise<void>;
  focusNote(ref: string, signal?: AbortSignal): Promise<boolean>;
  focusFirst(): void;
  rootText(): string;
}
type Props = {rootRef: string; rootField?: RootField; prelude?: readonly Intent[]; apiRef?: React.RefObject<LocalOutlineHandle | null>;
  filter?: string; occurrencePrefix?: string; ancestors?: readonly string[]};
const EMPTY_INTENTS: readonly Intent[] = [];
const SharedOutline = createContext<OutlineController | null>(null);
const pendingRisk = (value: {input: OutlinePendingInput}) => value.input.risk();
const pendingCopy = (value: {input: OutlinePendingInput}) => value.input.copyText();

export default function LocalOutline(props: Props) {
  const runtime = useWritingRuntime();
  const inherited = useContext(SharedOutline);
  if (!runtime) return <Ruling/>;
  if (inherited) return <EmbeddedBranch controller={inherited} rootRef={props.rootRef} prefix={props.occurrencePrefix ?? props.rootRef}/>;
  return <OutlineRoot {...props}/>;
}

export type OutlineRootMetadata =
  | {ref: string; known: false; resource: null; store_revision: null}
  | {ref: string; known: true; resource: ResourceProjection | null; store_revision: string};
export interface LocalOutlineRoot {
  rootEditor: PaneHeaderEditor | null;
  rootTitle: string | null;
  rootReady: boolean;
  rootRead: OutlineRootMetadata;
  error: unknown | null;
  retry(): void;
  ready: boolean;
  view: ReactNode;
}
function OutlineRoot(props: Props) {return useLocalOutlineRoot(props).view;}

/** The route and editing host consume one root read; descendants retain their
 * own collectors. Canonical root metadata survives paging and refresh failure. */
export function useLocalOutlineRoot({rootRef, rootField, prelude = EMPTY_INTENTS, apiRef, filter = "", occurrencePrefix = rootRef}: Props): LocalOutlineRoot {
  const runtime = useWritingRuntime();
  const guard = useWorkGuard();
  const accountId = useAuthoredAccountId();
  const inherited = useContext(ResourceBranch);
  const branch = useMemo(() => inherited.ancestors.has(rootRef) ? inherited : {...inherited, ancestors: new Map(inherited.ancestors).set(rootRef, {kind: "root"} as const)}, [inherited, rootRef]);
  const [, setRevision] = useState(0);
  const notify = useCallback(() => setRevision(value => value + 1), []);
  const pending = useEditorDraft(`Outline.Session:${occurrencePrefix}`, () => ({input: new OutlinePendingInput(), revision: 0}), pendingRisk, pendingCopy);
  const setPending = pending.set;
  const changed = useCallback(() => setPending(value => ({...value, revision: value.revision + 1})), [setPending]);
  const [failure, setFailure] = useState<unknown | null>(null);
  const [mounted, setMounted] = useState<{id: string; controller: OutlineController} | null>(null);
  const [editor, setEditor] = useState<OutlineController | null>(null);
  const input = pending.value.input;
  const current = mounted?.controller.runtime === runtime && mounted.controller.pending === input && mounted.controller.rootRef === rootRef && mounted.controller.rootBranch === branch ? mounted : null;
  const request = current?.controller.requests.get(input.root_id) ?? {parent_id: input.root_id, ref: rootRef, branch, cursor: null, anchor: null, limit: 48};
  const read = useOutlineWindow(request.anchor === null ? {kind: "adjacency", ref: request.ref, cursor: request.cursor, limit: request.limit}
    : {kind: "adjacency_window", ref: request.ref, link_id: request.anchor, cursor: null, limit: request.limit}, request.branch, runtime);
  const [metadata, setMetadata] = useState<{accountId: string | null; root: OutlineRootMetadata}>(() => ({accountId, root: {ref: rootRef, resource: null, store_revision: null, known: false}}));
  let rootRead = metadata.root;
  if (metadata.accountId !== accountId || rootRead.ref !== rootRef) {
    rootRead = {ref: rootRef, resource: null, store_revision: null, known: false};
    setMetadata({accountId, root: rootRead});
  }
  if (read.window && (rootRead.store_revision === null || BigInt(read.window.data.store_revision) >= BigInt(rootRead.store_revision))
    && (rootRead.store_revision !== read.window.data.store_revision || rootRead.resource !== read.window.rootResource)) {
    rootRead = {ref: rootRef, resource: read.window.rootResource, store_revision: read.window.data.store_revision, known: true};
    setMetadata({accountId, root: rootRead});
  }
  const configuredField = useMemo(() => rootField?.inspection && rootField.inspection.text !== rootRead.resource?.body_text ? {...rootField, inspection: null} : rootField, [rootField, rootRead.resource?.body_text]);
  useLayoutEffect(() => {
    if (!runtime) return;
    const history = new OutlineHistory(runtime, setFailure);
    const controller = new OutlineController(runtime, history, input, rootRef, branch, configuredField, prelude, notify, changed, guard);
    setMounted({id: crypto.randomUUID(), controller});
    if (apiRef) apiRef.current = controller;
    return () => {if (apiRef?.current === controller) apiRef.current = null; controller.close(); history.close();};
    // Presentation and latent-page props update the mounted session below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, input, rootRef, branch, notify, changed, guard]);
  const presentation = useAuthoredPaneRoot(current?.controller ?? null, configuredField);
  const wrap = (node: ReactNode) => <SharedOutline value={current?.controller ?? null}><ResourceBranch value={branch}>{node}</ResourceBranch></SharedOutline>;
  const rootEditor = presentation.rootEditor;
  const published = rootEditor === null ? null : rootEditor.kind === "Inline"
    ? {...rootEditor, content: wrap(rootEditor.content), feedback: rootEditor.feedback === null ? null : wrap(rootEditor.feedback)}
    : {...rootEditor, control: wrap(rootEditor.control), content: wrap(rootEditor.content), feedback: rootEditor.feedback === null ? null : wrap(rootEditor.feedback)};
  const view = current ? <MountedOutline key={current.id} controller={current.controller} pending={pending}
    rootRef={rootRef} rootField={configuredField} filter={filter} occurrencePrefix={occurrencePrefix} failure={failure} setFailure={setFailure}
    rootRead={read} onReady={setEditor}/>
    : <Ruling/>;
  return {rootEditor: published, rootTitle: presentation.rootTitle, rootReady: presentation.rootReady, rootRead, error: read.error, retry: read.retry, ready: current !== null && editor === current.controller, view};
}

function MountedOutline({controller, pending, rootRef, rootField, filter, occurrencePrefix, failure, setFailure, rootRead, onReady}: {
  controller: OutlineController; pending: ReturnType<typeof useEditorDraft<{input: OutlinePendingInput; revision: number}>>;
  rootRef: string; rootField: RootField | undefined; filter: string; occurrencePrefix: string; failure: unknown | null;
  setFailure: React.Dispatch<React.SetStateAction<unknown | null>>;
  rootRead: ReturnType<typeof useOutlineWindow>; onReady(controller: OutlineController | null): void;
}) {
  const resources = useContext(ResourceOutlineContext);
  controller.platform = useRenderEnvironment().platform;
  const guard = useWorkGuard();
  const {say} = useOutcome();
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const copied = useCopyFeedback(pending.owner);
  const copy = (text: string) => copied.copy(text).then(() => setManualCopy(null), (error: unknown) => {
    if (error instanceof ClipboardWriteUnavailableError) setManualCopy(text); else setFailure(error);
  });
  const history = controller.history;
  const editorReady = useCallback((handle: NoteEditorHandle | null) => {controller.setHandle(handle); onReady(handle ? controller : null);}, [controller, onReady]);
  useLayoutEffect(() => {controller.filter = filter; controller.revealExternal = resources?.reveal ?? null; controller.configure(rootField); controller.refresh();}, [controller, filter, pending.value.revision, rootField, resources?.reveal]);
  const rootRequest = controller.requests.get(pending.value.input.root_id)!;
  useLayoutEffect(() => controller.publishRead(rootRequest, {pending: rootRead.loading, error: rootRead.error, occurrence: rootRead.occurrence, retry: rootRead.retry}),
    [controller, rootRequest, rootRead.loading, rootRead.error, rootRead.occurrence, rootRead.retry]);
  useLayoutEffect(() => {if (rootRead.window) controller.accept(pending.value.input.root_id, rootRead.window);}, [controller, pending.value.input.root_id, rootRead.window]);
  useEffect(() => {
    const intent = (event: Event) => {
      if (!event.isTrusted || controller.inertInput(event)) return;
      controller.revoke();
      controller.revealTouchCommands(event);
      if (event instanceof KeyboardEvent && event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing)
        controller.armNativeEntry();
      if (event.type === "pointerdown" && event.target instanceof Element && !event.target.closest(`[data-outline-session="${pending.value.input.root_id}"]`) && !event.target.closest("[data-outline-commands]")) controller.withdraw();
    };
    document.addEventListener("pointerdown", intent, true); document.addEventListener("keydown", intent, true); document.addEventListener("beforeinput", intent, true);
    return () => {document.removeEventListener("pointerdown", intent, true); document.removeEventListener("keydown", intent, true); document.removeEventListener("beforeinput", intent, true);};
  }, [controller, pending.value.input.root_id]);
  const keyboard = useNativeKeyboardVisibility();
  const previousKeyboard = useRef(keyboard);
  useEffect(() => {
    const before = previousKeyboard.current; previousKeyboard.current = keyboard;
    if (keyboard === true) controller.setTouchCommandsVisible(true);
    else if (before === true && keyboard === false) controller.setTouchCommandsVisible(false);
  }, [controller, keyboard]);
  usePaneOutlineCommands(controller.publication());
  // A failed commit is the account's words at risk, not the outline's.
  const pendingError = pending.value.input.error instanceof LocalCommitError ? null : pending.value.input.error;
  const failed = failure instanceof LocalCommitError ? null : failure;
  const refusal = controller.error instanceof LocalCommitError ? null : controller.error;
  const pendingCopyAvailable = pendingError !== null && guard.readCopyText({scopes: [], ownerIds: [pending.owner]}) !== null;
  const rootState = controller.branchRead(pending.value.input.root_id);
  const wordsAtRisk = useWordsAtRisk([rootRef, ...controller.documents.keys()]);
  // A command's outcome is one slip per error; no verb redoes a failed change, the person makes it
  // again. A failed change is said once and let go, so a later refusal speaks too. A refusal stands
  // while the controller holds it and retracts once it clears. Pending writing that failed is words
  // at risk, held below, and says nothing else meanwhile.
  useEffect(() => {
    if (failure === null || pendingError !== null) return;
    if (failed !== null) say({fact: "couldn’t change this outline on this device."});
    setFailure(null);
  }, [failure, failed, pendingError, say, setFailure]);
  useEffect(() => {
    if (refusal === null || pendingError !== null) return;
    return say(refusal instanceof OutlineActionRefusal ? refusal.line : {fact: "couldn’t change this outline on this device."});
  }, [refusal, pendingError, say]);
  const defect = [pendingError, failed, refusal].find(error => error !== null && !(error instanceof OutlineActionRefusal) && !isAuthoredStorageFailure(error));
  if (defect !== undefined) throw defect;
  // A retry keeps its slip, and the caret its danger, until the retry settles.
  const retryPending: CommandVerb = {label: "retry", commandKey: "RetryPendingOutline", busy: pending.value.input.retrying, run: () => pending.value.input.retry()};
  const copyPending: CommandVerb = {label: "copy text", commandKey: "CopyPendingOutline", copied: copied.occurrence ?? undefined, run: () => {
    const text = guard.readCopyText({scopes: [], ownerIds: [pending.owner]});
    if (text !== null) void copy(text);
  }};
  return <SharedOutline value={controller}>
    <div data-outline-session={pending.value.input.root_id} onFocusCapture={event => {
      if (event.target instanceof Element && event.target.matches('.ProseMirror') && event.target.closest("[data-reference-editor]")?.getAttribute("data-reference-editor") === `outline:${occurrencePrefix}`) controller.setFocused(true);
    }} onBlurCapture={event => {
      const next = event.relatedTarget;
      if (!(next instanceof Element && (next.closest(`[data-outline-session="${pending.value.input.root_id}"]`) || next.closest("[data-outline-commands]")))) controller.setFocused(false);
    }}>
      {pendingError !== null ? <Hold id={`outline-pending:${occurrencePrefix}`} attempt={pending.value.input.failures} risk line={WORDS_AT_RISK}
        verbs={pendingCopyAvailable ? [retryPending, copyPending] : [retryPending]}/> : null}
      <Dialog open={manualCopy !== null} title="copy text" onClose={() => setManualCopy(null)}>
        <p>select the text and copy it.</p><textarea readOnly value={manualCopy ?? ""} aria-label="pending outline text"/>
      </Dialog>
      {/* rows stand once the root's window is installed, not once it is read: its admission can fail */}
      {controller.windows.has(pending.value.input.root_id) ? null
        : rootState.error !== null ? <AuthoredReadFailure {...rootState} noun="linked items"/> : rootRead.window === null ? <Ruling/> : null}
      {[...controller.requests.values()].filter(request => request.parent_id !== pending.value.input.root_id).map(request => <BranchCollector key={request.parent_id} controller={controller} request={request}/>)}
      <NoteEditor editorKey={`outline:${occurrencePrefix}`} occurrenceKey={`outline:${occurrencePrefix}`} containingNoteRef={rootRef}
        projection={controller.projection} body={emptyBody()} revision={0} editable={!filter.trim()} label="edit linked items" wordsAtRisk={wordsAtRisk || pendingError !== null}
        placeholder="write or @ to link" compact history={{undo: history.undo, redo: history.redo, boundary: () => history.boundary()}}
        onEdit={() => {}} onEditorReady={editorReady}/>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true"><span key={controller.announcementId}>{controller.announcement}</span></span>
      <OutlineEditorRows mounts={[...controller.mounts.values()]} rows={controller.chrome()}/>
    </div>
  </SharedOutline>;
}

function BranchCollector({controller, request}: {controller: OutlineController; request: BranchRequest}) {
  const read = useOutlineWindow(request.anchor === null ? {kind: "adjacency", ref: request.ref, cursor: request.cursor, limit: request.limit}
    : {kind: "adjacency_window", ref: request.ref, link_id: request.anchor, cursor: null, limit: request.limit}, request.branch, controller.runtime);
  useLayoutEffect(() => controller.publishRead(request, {pending: read.loading, error: read.error, occurrence: read.occurrence, retry: read.retry}),
    [controller, request, read.loading, read.error, read.occurrence, read.retry]);
  useLayoutEffect(() => {if (read.window) controller.accept(request.parent_id, read.window);}, [controller, request.parent_id, read.window]);
  return null;
}

function EmbeddedBranch({controller, rootRef, prefix}: {controller: OutlineController; rootRef: string; prefix: string}) {
  const branch = useContext(ResourceBranch);
  const owner = useContext(OutlineEmbeddingOccurrence);
  const branchKey = JSON.stringify([[...branch.ancestors], [...branch.traversedEdgeIds]]);
  useLayoutEffect(() => controller.attachEmbedded(prefix, rootRef, branch, owner),
    // Branch proof values own registration; freshly allocated maps do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [controller, prefix, rootRef, branchKey, owner]);
  return null;
}
