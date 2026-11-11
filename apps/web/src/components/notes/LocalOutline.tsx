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
import {OutlineController, OutlineActionRefusal, type BranchRequest, type OutlineSession, type RootField} from "@/lib/notes/outlineController";
import {OutlinePendingInput} from "@/lib/notes/outlinePending";
import {OutlineHistory} from "@/lib/notes/structure";
import {useOutlineWindows, type OutlineWindow} from "@/lib/notes/useOutlineWindow";
import {OutlinePresentationAllowance} from "@/lib/notes/outlinePresentationAllowance";
import {OutlineHistoryAllowance} from "@/lib/notes/outlineHistoryAllowance";
import {WorkHistoryContext} from "@/lib/notes/work";
import {WorkConversionError, WorkJoinError, WorkUnavailableError} from "@nexus/authored/types";
import {usePaneAnchorGeometry, usePaneBeforeLayout, usePaneInputLease, usePaneRevealAnchor, usePaneVisitRetained} from "@/lib/workspace/paneReturnMemento";
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
import OutlineDrag from "./OutlineDrag";
import OutlineEditorRows from "./OutlineEditorRow";
import AuthoredReadFailure from "./AuthoredReadFailure";
import {useAuthoredPaneRoot, type RootPresentation} from "./AuthoredPaneRoot";

export interface LocalOutlineHandle {
  append(): Promise<void>;
  revealRoot(): void;
  focusRoot(resolve?: (document: WritingDocument) => FocusSelection, mayFocus?: () => boolean): Promise<void>;
  focusNote(ref: string, signal?: AbortSignal): Promise<boolean>;
  focusFirst(): void;
  rootText(): string;
}
type Props = {rootRef: string; rootField?: RootField; prelude?: readonly Intent[]; apiRef?: React.RefObject<LocalOutlineHandle | null>;
  filter?: string; occurrencePrefix?: string; attached?: boolean; historyAllowance?: OutlineHistoryAllowance | null; presentationAllowance?: OutlinePresentationAllowance | null; rootPresentation?: RootPresentation; initialRows?: 1 | 32;
  onControllerReady?(controller: OutlineController | null): void; childrenVisible?: boolean;
  /** The link the pane was opened through; the outline omits it, so the parent is not listed as a child. */
  entering?: string};
const EMPTY_INTENTS: readonly Intent[] = [];
const SharedOutline = createContext<OutlineController | null>(null);
type Session = OutlineSession & {input: OutlinePendingInput; revision: number};
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
  /** The session's first content is on screen: every window it first requested, the root's and each open branch's, painted or
   * failed. A pane's return position waits for it; it stays true for the controller afterwards. */
  ready: boolean;
  controller: OutlineController | null;
  retainSession: boolean;
  showTitle(): void;
  view: ReactNode;
}
function OutlineRoot(props: Props) {return useLocalOutlineRoot(props).view;}

/** The route and editing host consume one root read; descendants retain their
 * own collectors. Canonical root metadata survives paging and refresh failure. */
export function useLocalOutlineRoot({rootRef, rootField, prelude = EMPTY_INTENTS, apiRef, filter = "", occurrencePrefix = rootRef, entering, onControllerReady, childrenVisible = true,
  attached = true, historyAllowance = null, presentationAllowance = null, rootPresentation = "header", initialRows = 32}: Props): LocalOutlineRoot {
  const runtime = useWritingRuntime();
  const guard = useWorkGuard();
  const accountId = useAuthoredAccountId();
  const beforeLayout = usePaneBeforeLayout();
  const revealAnchor = usePaneRevealAnchor();
  const paneInputLease = usePaneInputLease();
  const retained = usePaneVisitRetained();
  const inherited = useContext(ResourceBranch);
  const branch = useMemo(() => {
    const rooted = inherited.ancestors.has(rootRef) ? inherited : {...inherited, ancestors: new Map(inherited.ancestors).set(rootRef, {kind: "root"} as const)};
    return entering ? {...rooted, traversedEdgeIds: new Set(rooted.traversedEdgeIds).add(entering)} : rooted;
  }, [inherited, rootRef, entering]);
  const [revision, setRevision] = useState(0);
  const notify = useCallback(() => setRevision(value => value + 1), []);
  const pending = useEditorDraft<Session>(`Outline.Session:${occurrencePrefix}`, () => ({input: new OutlinePendingInput(), revision: 0, opened: new Set(), identities: new Map()}), pendingRisk, pendingCopy);
  const setPending = pending.set;
  const changed = useCallback(() => setPending(value => ({...value, revision: value.revision + 1})), [setPending]);
  const [failure, setFailure] = useState<unknown | null>(null);
  const [mounted, setMounted] = useState<{id: string; controller: OutlineController} | null>(null);
  const [editor, setEditor] = useState<OutlineController | null>(null);
  const [painted, setPainted] = useState<OutlineController | null>(null);
  const [presented, setPresented] = useState(attached);
  const input = pending.value.input;
  const current = mounted?.controller.runtime === runtime && mounted.controller.pending === input && mounted.controller.rootRef === rootRef && mounted.controller.rootBranch === branch ? mounted : null;
  const [metadata, setMetadata] = useState<{accountId: string | null; root: OutlineRootMetadata}>(() => ({accountId, root: {ref: rootRef, resource: null, store_revision: null, known: false}}));
  const rootRead = metadata.accountId === accountId && metadata.root.ref === rootRef ? metadata.root : {ref: rootRef, resource: null, store_revision: null, known: false} as const;
  const received = useCallback((window: OutlineWindow) => {
    setMetadata(previous => previous.accountId === accountId && previous.root.ref === rootRef && previous.root.store_revision !== null &&
      BigInt(previous.root.store_revision) > BigInt(window.data.store_revision) ? previous :
      {accountId, root: {ref: rootRef, resource: window.rootResource, store_revision: window.data.store_revision, known: true}});
  }, [accountId, rootRef]);
  const configuredField = useMemo(() => rootField?.inspection && rootField.inspection.text !== rootRead.resource?.body_text ? {...rootField, inspection: null} : rootField, [rootField, rootRead.resource?.body_text]);
  useLayoutEffect(() => {
    if (!runtime) return;
    const history = new OutlineHistory(runtime, setFailure, historyAllowance ?? new OutlineHistoryAllowance(), notify);
    const controller = new OutlineController(runtime, history, input, rootRef, branch, configuredField, prelude, notify, changed, guard, pending.value, presentationAllowance ?? new OutlinePresentationAllowance(notify),
      (anchor, focus) => revealAnchor(`outline:${occurrencePrefix}`, anchor, focus), retained ? paneInputLease : null, initialRows);
    controller.beforeLayout = beforeLayout;
    setMounted({id: crypto.randomUUID(), controller});
    if (apiRef) apiRef.current = controller;
    return () => {if (apiRef?.current === controller) apiRef.current = null; controller.close(); history.close();};
    // Presentation and latent-page props update the mounted session below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, input, rootRef, branch, notify, changed, guard, historyAllowance, presentationAllowance, occurrencePrefix, revealAnchor, retained, paneInputLease, initialRows]);
  const controller = current?.controller ?? null;
  useLayoutEffect(() => {
    if (attached) setPresented(true);
    else if (!controller || controller.releasePresentation()) setPresented(false);
  }, [attached, controller, revision]);
  const presentation = useAuthoredPaneRoot(controller, configuredField, rootPresentation);
  usePaneAnchorGeometry({scope: `outline:${occurrencePrefix}`, geometry: controller?.readLayout().geometry ?? null, ready: true});
  useLayoutEffect(() => {onControllerReady?.(controller); return () => onControllerReady?.(null);}, [controller, onControllerReady]);
  useLayoutEffect(() => {controller?.refresh();}, [controller, childrenVisible]);
  const wrap = (node: ReactNode) => <SharedOutline value={controller}><ResourceBranch value={branch}>{node}</ResourceBranch></SharedOutline>;
  const rootEditor = !presented ? null : presentation.rootEditor;
  const published = rootEditor === null ? null : rootEditor.kind === "Inline"
    ? {...rootEditor, content: wrap(rootEditor.content), feedback: rootEditor.feedback === null ? null : wrap(rootEditor.feedback)}
    : {...rootEditor, control: wrap(rootEditor.control), content: wrap(rootEditor.content), feedback: rootEditor.feedback === null ? null : wrap(rootEditor.feedback)};
  const view = current && presented ? <div hidden={!childrenVisible}><MountedOutline key={current.id} controller={current.controller} pending={pending}
    rootRef={rootRef} rootField={configuredField} filter={filter} occurrencePrefix={occurrencePrefix} failure={failure} setFailure={setFailure}
    received={received} onReady={setEditor}/></div> : presented ? <Ruling/> : null;
  if (current && painted !== current.controller && editor === current.controller &&
    [...current.controller.requests.keys()].every(id => current.controller.windows.has(id) || current.controller.branchRead(id).error !== null)) setPainted(current.controller);
  const read = controller?.branchRead(input.root_id);
  return {rootEditor: published, rootTitle: presentation.rootTitle, rootReady: presentation.rootReady, rootRead, error: read?.error ?? null,
    retry: () => read?.retry(), ready: current !== null && painted === current.controller, controller,
    retainSession: controller?.retainsSession() ?? false, showTitle: presentation.showTitle, view};
}

function MountedOutline({controller, pending, rootRef, rootField, filter, occurrencePrefix, failure, setFailure, received, onReady}: {
  controller: OutlineController; pending: ReturnType<typeof useEditorDraft<Session>>;
  rootRef: string; rootField: RootField | undefined; filter: string; occurrencePrefix: string; failure: unknown | null;
  setFailure: React.Dispatch<React.SetStateAction<unknown | null>>;
  received(window: OutlineWindow): void; onReady(controller: OutlineController | null): void;
}) {
  const resources = useContext(ResourceOutlineContext);
  useLayoutEffect(() => controller.readLayout().geometry.refreshRange());
  controller.platform = useRenderEnvironment().platform;
  const guard = useWorkGuard();
  const {say} = useOutcome();
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const copied = useCopyFeedback(pending.owner);
  const copy = (text: string) => copied.copy(text).then(() => setManualCopy(null), (error: unknown) => {
    if (error instanceof ClipboardWriteUnavailableError) setManualCopy(text); else setFailure(error);
  });
  const history = controller.history;
  useLayoutEffect(() => {
    const geometry = controller.readLayout().geometry;
    const frame = geometry.read();
    if (!frame) return;
    const update = () => geometry.refreshRange();
    frame.scrollport.addEventListener("scroll", update, {passive: true});
    const resize = new ResizeObserver(update); resize.observe(frame.scrollport);
    update();
    return () => {frame.scrollport.removeEventListener("scroll", update); resize.disconnect();};
  }, [controller]);
  const editorReady = useCallback((handle: NoteEditorHandle | null) => {controller.setHandle(handle); onReady(handle ? controller : null);}, [controller, onReady]);
  useLayoutEffect(() => {controller.filter = filter; controller.revealExternal = resources?.reveal ?? null; controller.configure(rootField); controller.refresh();}, [controller, filter, pending.value.revision, rootField, resources?.reveal]);
  useEffect(() => {
    const intent = (event: Event) => {
      if (!event.isTrusted || controller.inertInput(event)) return;
      controller.revoke();
      controller.revealTouchCommands(event);
      if (event instanceof KeyboardEvent && event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing)
        controller.armNativeEntry();
      if (event.type === "pointerdown" && !controller.ownsInteraction(event.target)) controller.withdraw();
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
    if (failed !== null) say({fact: failed instanceof WorkConversionError || failed instanceof WorkJoinError || failed instanceof WorkUnavailableError ? failed.message : "couldn’t change this outline on this device."});
    setFailure(null);
  }, [failure, failed, pendingError, say, setFailure]);
  useEffect(() => {
    if (refusal === null || pendingError !== null) return;
    return say(refusal instanceof OutlineActionRefusal ? refusal.line : {fact: "couldn’t change this outline on this device."});
  }, [refusal, pendingError, say]);
  const defect = [pendingError, failed, refusal].find(error => error !== null && !(error instanceof OutlineActionRefusal) && !(error instanceof WorkConversionError) && !(error instanceof WorkJoinError) && !(error instanceof WorkUnavailableError) && !isAuthoredStorageFailure(error));
  if (defect !== undefined) throw defect;
  // A retry keeps its slip, and the caret its danger, until the retry settles.
  const retryPending: CommandVerb = {label: "retry", commandKey: "RetryPendingOutline", busy: pending.value.input.retrying, run: () => pending.value.input.retry()};
  const copyPending: CommandVerb = {label: "copy text", commandKey: "CopyPendingOutline", copied: copied.occurrence ?? undefined, run: () => {
    const text = guard.readCopyText({scopes: [], ownerIds: [pending.owner]});
    if (text !== null) void copy(text);
  }};
  return <WorkHistoryContext value={history}><SharedOutline value={controller}>
    <div data-outline-session={pending.value.input.root_id} data-pane-return-scope={`outline:${occurrencePrefix}`} onFocusCapture={event => {
      if (event.target instanceof Element && event.target.matches('.ProseMirror') && event.target.closest("[data-reference-editor]")?.getAttribute("data-reference-editor") === `outline:${occurrencePrefix}`) controller.setFocused(true);
    }} onBlurCapture={event => {
      const next = event.relatedTarget;
      if (!(next instanceof Element && (next.closest(`[data-outline-session="${pending.value.input.root_id}"]`) || next.closest("[data-outline-commands]")))) controller.setFocused(false);
    }}><OutlineDrag controller={controller}>
      {pendingError !== null ? <Hold id={`outline-pending:${occurrencePrefix}`} attempt={pending.value.input.failures} risk line={WORDS_AT_RISK}
        verbs={pendingCopyAvailable ? [retryPending, copyPending] : [retryPending]}/> : null}
      <Dialog open={manualCopy !== null} title="copy text" onClose={() => setManualCopy(null)}>
        <p>select the text and copy it.</p><textarea readOnly value={manualCopy ?? ""} aria-label="pending outline text"/>
      </Dialog>
      {/* rows stand once the root's window is installed, not once it is read: its admission can fail */}
      {rootState.error !== null ? <AuthoredReadFailure {...rootState} noun="linked items"/>
        : controller.windows.has(pending.value.input.root_id) ? null : <Ruling/>}
      {[...controller.requests.values()].map(request => <BranchCollector key={request.parent_id} controller={controller} request={request} received={request.parent_id === pending.value.input.root_id ? received : null}/>)}
      <NoteEditor editorKey={`outline:${occurrencePrefix}`} occurrenceKey={`outline:${occurrencePrefix}`} containingNoteRef={rootRef}
        projection={controller.projection} body={emptyBody()} revision={0} editable={!filter.trim()} label="edit linked items" wordsAtRisk={wordsAtRisk || pendingError !== null}
        history={{undo: history.undo, redo: history.redo, boundary: () => history.boundary()}}
        onEdit={() => {}} onEditorReady={editorReady}/>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true"><span key={controller.announcementId}>{controller.announcement}</span></span>
      <OutlineEditorRows mounts={[...controller.mounts.values()]} rows={controller.chrome()} history={history}/>
    </OutlineDrag></div>
  </SharedOutline></WorkHistoryContext>;
}

function BranchCollector({controller, request, received}: {controller: OutlineController; request: BranchRequest; received: ((window: OutlineWindow) => void) | null}) {
  const traversed = [...request.branch.traversedEdgeIds];
  const read = useOutlineWindows({ref: request.ref, ranges: request.ranges ?? [{cursor: request.cursor, anchor_link_id: request.anchor, limit: request.limit}],
    excluded_link_ids: traversed, entering_link_id: traversed.at(-1) ?? null}, request.branch, controller.runtime);
  useLayoutEffect(() => controller.publishRead(request, {pending: read.loading, error: read.error, occurrence: read.occurrence, retry: read.retry}),
    [controller, request, read.loading, read.error, read.occurrence, read.retry]);
  useLayoutEffect(() => {
    if (!read.windows) return;
    if (received) received(read.windows[0]!);
    controller.acceptWindows(request.parent_id, read.windows);
  }, [controller, request.parent_id, read.windows, received]);
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
