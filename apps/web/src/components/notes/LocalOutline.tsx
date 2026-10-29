"use client";
/** A single native editing host renders every disclosed authored occurrence.
 * Branch components read data only; the root controls document admission. */
import {createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode} from "react";
import {ResourceBranch, ResourceOutlineContext} from "@/components/resources/ResourceOutlineList";
import Dialog from "@/components/ui/Dialog";
import {useCopyFeedback} from "@/components/ui/useCopyFeedback";
import {FeedbackBusy, FeedbackFailure} from "@/components/feedback/Feedback";
import {OutlineEmbeddingOccurrence, useEditorDraft} from "@/lib/notes/editorHost";
import {useWritingRuntime} from "@/lib/notes/hooks";
import {useAuthoredAccountId} from "@/lib/authored/provider";
import {OutlineController, OutlineActionRefusal, type BranchRequest, type RootField} from "@/lib/notes/outlineController";
import {OutlinePendingInput} from "@/lib/notes/outlinePending";
import {OutlineHistory} from "@/lib/notes/structure";
import {useOutlineWindow} from "@/lib/notes/useOutlineWindow";
import {usePaneOutlineCommands} from "@/lib/panes/paneChrome";
import {useNativeKeyboardVisibility} from "@/lib/ui/useKeyboardInset";
import {ClipboardWriteUnavailableError} from "@/lib/ui/copyText";
import {useWorkGuard} from "@/lib/unsavedWork";
import {LocalCommitError, isAuthoredStorageFailure} from "@/lib/notes/runtime";
import {emptyBody} from "@nexus/authored/body";
import type {Intent} from "@nexus/authored/commands";
import type {ResourceProjection} from "@nexus/authored/types";
import type {FocusSelection} from "@/lib/notes/editorTypes";
import type {WritingDocument} from "@/lib/notes/runtime";
import NoteEditor, {type NoteEditorHandle} from "./NoteEditor";
import OutlineEditorRows from "./OutlineEditorRow";
import AuthoredReadFailure, {DocumentReadFailure} from "./AuthoredReadFailure";

export interface LocalOutlineHandle {
  append(): Promise<void>;
  focusRoot(resolve?: (document: WritingDocument) => FocusSelection): Promise<void>;
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
  if (!runtime) return <FeedbackBusy subject={props.rootRef} pending/>;
  if (inherited) return <EmbeddedBranch controller={inherited} rootRef={props.rootRef} prefix={props.occurrencePrefix ?? props.rootRef}/>;
  return <OutlineRoot {...props}/>;
}

export type OutlineRootMetadata =
  | {ref: string; known: false; resource: null; store_revision: null}
  | {ref: string; known: true; resource: ResourceProjection | null; store_revision: string};
export interface LocalOutlineRoot {
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
    const controller = new OutlineController(runtime, history, input, rootRef, branch, configuredField, prelude, notify, changed);
    setMounted({id: crypto.randomUUID(), controller});
    if (apiRef) apiRef.current = controller;
    return () => {if (apiRef?.current === controller) apiRef.current = null; controller.close(); history.close();};
    // Presentation and latent-page props update the mounted session below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, input, rootRef, branch, notify, changed]);
  const view = current ? <MountedOutline key={current.id} controller={current.controller} pending={pending}
    rootRef={rootRef} rootField={configuredField} filter={filter} occurrencePrefix={occurrencePrefix} failure={failure} setFailure={setFailure}
    rootRead={read} onReady={setEditor}/>
    : <FeedbackBusy subject={`${accountId}:${rootRef}`} pending/>;
  return {rootRead, error: read.error, retry: read.retry, ready: current !== null && editor === current.controller, view};
}

function MountedOutline({controller, pending, rootRef, rootField, filter, occurrencePrefix, failure, setFailure, rootRead, onReady}: {
  controller: OutlineController; pending: ReturnType<typeof useEditorDraft<{input: OutlinePendingInput; revision: number}>>;
  rootRef: string; rootField: RootField | undefined; filter: string; occurrencePrefix: string; failure: unknown | null;
  setFailure: React.Dispatch<React.SetStateAction<unknown | null>>;
  rootRead: ReturnType<typeof useOutlineWindow>; onReady(controller: OutlineController | null): void;
}) {
  const resources = useContext(ResourceOutlineContext);
  const guard = useWorkGuard();
  const [manualCopy, setManualCopy] = useState<{text: string; label: string; open: boolean; occurrence: object} | null>(null);
  const copied = useCopyFeedback(pending.owner);
  const copy = (text: string, label: string) => copied.copy(text).then(() => setManualCopy(null), (error: unknown) => {
    if (error instanceof ClipboardWriteUnavailableError) setManualCopy({text, label, open: false, occurrence: {}}); else setFailure(error);
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
      if (!event.isTrusted) return;
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
  const pendingError = pending.value.input.error instanceof LocalCommitError ? null : pending.value.input.error;
  const operationError = [failure, controller.error].find(error => error !== null && !(error instanceof LocalCommitError)) ?? null;
  const error = pendingError ?? operationError;
  const [incident, setIncident] = useState<{error: unknown; occurrence: object} | null>(null);
  if (error !== null && incident === null) setIncident({error, occurrence: {}});
  else if (error === null && incident !== null) setIncident(null);
  const pendingCopyAvailable = pendingError !== null && guard.readCopyText({scopes: [], ownerIds: [pending.owner]}) !== null;
  const rootState = controller.branchRead(pending.value.input.root_id);
  if (error !== null && !(error instanceof OutlineActionRefusal) && !isAuthoredStorageFailure(error)) throw error;
  return <SharedOutline value={controller}>
    <div data-outline-session={pending.value.input.root_id} onFocusCapture={event => {
      if (event.target instanceof Element && event.target.matches('[contenteditable="true"]')) controller.setFocused(true);
    }} onBlurCapture={event => {
      const next = event.relatedTarget;
      if (!(next instanceof Element && (event.currentTarget.contains(next) || next.closest("[data-outline-commands]")))) controller.setFocused(false);
    }}>
      {error !== null && incident ? <FeedbackFailure scope="Local" occurrence={incident.occurrence}
        content={{tone: "Warning", title: error instanceof OutlineActionRefusal ? error.message : pendingError !== null ? "couldn’t apply this writing" : "couldn’t open linked resources"}}
        announcement="Polite" actions={pendingError !== null ? pendingCopyAvailable ? [
          {label: "retry pending writing", onClick: () => pending.value.input.retry()},
          {label: "copy pending outline text", copiedOccurrence: copied.occurrence ?? undefined, onClick: () => {const text = guard.readCopyText({scopes: [], ownerIds: [pending.owner]}); if (text !== null) void copy(text, "pending outline text");}},
        ] : [{label: "retry pending writing", onClick: () => pending.value.input.retry()}]
          : controller.canRetry ? [{label: "retry opening", onClick: () => controller.retry()}] : undefined}/> : null}
      {manualCopy ? <FeedbackFailure scope="Local" occurrence={manualCopy.occurrence}
        content={{tone: "Warning", title: `couldn’t copy ${manualCopy.label}`}} announcement="Polite"
        actions={[{label: "show text to copy", onClick: () => setManualCopy(current => current ? {...current, open: true,
          text: guard.readCopyText({scopes: [], ownerIds: [pending.owner]}) ?? current.text} : null)}]}/> : null}
      <Dialog open={manualCopy?.open === true} title="copy pending outline text" onClose={() => setManualCopy(current => current ? {...current, open: false} : null)}>
        <p>select the text and copy it.</p><textarea readOnly value={manualCopy?.text ?? ""} aria-label="pending outline text"/>
      </Dialog>
      <FeedbackBusy subject={rootRequest} pending={rootRead.loading || rootState.pending}/>
      <AuthoredReadFailure {...rootState} title="couldn’t open linked resources"/>
      {[...controller.documents.values()].map(({document}) => <DocumentReadFailure key={document.ref} document={document}/>)}
      {[...controller.requests.values()].filter(request => request.parent_id !== pending.value.input.root_id).map(request => <BranchCollector key={request.parent_id} controller={controller} request={request}/>)}
      <NoteEditor editorKey={`outline:${occurrencePrefix}`} occurrenceKey={`outline:${occurrencePrefix}`} containingNoteRef={rootRef}
        projection={controller.projection} body={emptyBody()} revision={0} editable={!filter.trim()} label={rootField?.label ?? "edit outline"}
        placeholder={rootField?.placeholder ?? "write or @ to link"} compact history={{undo: history.undo, redo: history.redo, boundary: () => history.boundary()}}
        onEdit={() => {}} inspection={rootField?.inspection} onEditorReady={editorReady}/>
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
