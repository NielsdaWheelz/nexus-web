"use client";
/** A single native editing host renders every disclosed authored occurrence.
 * Branch components read data only; the root controls document admission. */
import {createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore} from "react";
import {ResourceBranch, ResourceOutlineContext} from "@/components/resources/ResourceOutlineList";
import Button from "@/components/ui/Button";
import {OutlineEmbeddingOccurrence, useEditorDraft} from "@/lib/notes/editorHost";
import {useWritingRuntime} from "@/lib/notes/hooks";
import {OutlineController, type BranchRequest, type RootField} from "@/lib/notes/outlineController";
import {OutlinePendingInput} from "@/lib/notes/outlinePending";
import {OutlineHistory} from "@/lib/notes/structure";
import {useOutlineWindow} from "@/lib/notes/useOutlineWindow";
import {usePaneOutlineCommands} from "@/lib/panes/paneChrome";
import {useNativeKeyboardVisibility} from "@/lib/ui/useKeyboardInset";
import {ClipboardWriteUnavailableError, copyText} from "@/lib/ui/copyText";
import {useWorkGuard} from "@/lib/unsavedWork";
import {writingStoreStopped} from "@/lib/notes/runtime";
import {emptyBody} from "@nexus/authored/body";
import type {Intent} from "@nexus/authored/commands";
import type {FocusSelection} from "@/lib/notes/editorTypes";
import type {WritingDocument, WritingRuntime} from "@/lib/notes/runtime";
import NoteEditor from "./NoteEditor";
import OutlineEditorRows from "./OutlineEditorRow";

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
  if (!runtime) return <p role="status">opening outline…</p>;
  if (inherited) return <EmbeddedBranch controller={inherited} rootRef={props.rootRef} prefix={props.occurrencePrefix ?? props.rootRef}/>;
  return <OutlineRoot {...props} runtime={runtime}/>;
}

function OutlineRoot({rootRef, rootField, prelude = EMPTY_INTENTS, apiRef, filter = "", occurrencePrefix = rootRef, runtime}: Props & {runtime: WritingRuntime}) {
  const inherited = useContext(ResourceBranch);
  const branch = useMemo(() => inherited.ancestors.has(rootRef) ? inherited : {...inherited, ancestors: new Map(inherited.ancestors).set(rootRef, {kind: "root"} as const)}, [inherited, rootRef]);
  const [, setRevision] = useState(0);
  const notify = useCallback(() => setRevision(value => value + 1), []);
  const pending = useEditorDraft(`Outline.Session:${occurrencePrefix}`, () => ({input: new OutlinePendingInput(), revision: 0}), pendingRisk, pendingCopy);
  const setPending = pending.set;
  const changed = useCallback(() => setPending(value => ({...value, revision: value.revision + 1})), [setPending]);
  const [failure, setFailure] = useState<unknown | null>(null);
  const [mounted, setMounted] = useState<{id: string; controller: OutlineController} | null>(null);
  const input = pending.value.input;
  useLayoutEffect(() => {
    const history = new OutlineHistory(runtime, setFailure);
    const controller = new OutlineController(runtime, history, input, rootRef, branch, rootField, prelude, notify, changed);
    setMounted({id: crypto.randomUUID(), controller});
    if (apiRef) apiRef.current = controller;
    return () => {if (apiRef?.current === controller) apiRef.current = null; controller.close(); history.close();};
    // Presentation and latent-page props update the mounted session below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, input, rootRef, branch, notify, changed]);
  return mounted ? <MountedOutline key={mounted.id} controller={mounted.controller} pending={pending} runtime={runtime}
    rootRef={rootRef} rootField={rootField} filter={filter} occurrencePrefix={occurrencePrefix} failure={failure} setFailure={setFailure}/>
    : <p role="status">opening outline…</p>;
}

function MountedOutline({controller, pending, runtime, rootRef, rootField, filter, occurrencePrefix, failure, setFailure}: {
  controller: OutlineController; pending: ReturnType<typeof useEditorDraft<{input: OutlinePendingInput; revision: number}>>; runtime: WritingRuntime;
  rootRef: string; rootField: RootField | undefined; filter: string; occurrencePrefix: string; failure: unknown | null;
  setFailure: React.Dispatch<React.SetStateAction<unknown | null>>;
}) {
  const resources = useContext(ResourceOutlineContext);
  const saved = useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot);
  const guard = useWorkGuard();
  const [manualCopy, setManualCopy] = useState<{text: string; label: string} | null>(null);
  const copy = (text: string, label: string) => copyText(text).then(() => setManualCopy(null), (error: unknown) => {
    if (error instanceof ClipboardWriteUnavailableError) setManualCopy({text, label}); else setFailure(error);
  });
  const history = controller.history;
  useLayoutEffect(() => {controller.filter = filter; controller.revealExternal = resources?.reveal ?? null; controller.configure(rootField); controller.refresh();}, [controller, filter, pending.value.revision, rootField, resources?.reveal]);
  useEffect(() => {
    const intent = (event: Event) => {
      if (!event.isTrusted) return;
      controller.revoke();
      if (event.type === "pointerdown" && event.target instanceof Element && !event.target.closest(`[data-outline-session="${pending.value.input.root_id}"]`) && !event.target.closest("[data-outline-commands]")) controller.withdraw();
    };
    document.addEventListener("pointerdown", intent, true); document.addEventListener("keydown", intent, true); document.addEventListener("beforeinput", intent, true);
    return () => {document.removeEventListener("pointerdown", intent, true); document.removeEventListener("keydown", intent, true); document.removeEventListener("beforeinput", intent, true);};
  }, [controller, pending.value.input.root_id]);
  const keyboard = useNativeKeyboardVisibility();
  const previousKeyboard = useRef(keyboard);
  useEffect(() => {const before = previousKeyboard.current; previousKeyboard.current = keyboard; if (before === true && keyboard === false) controller.dismissKeyboard();}, [controller, keyboard]);
  usePaneOutlineCommands(controller.publication());
  const error = saved.error ?? failure ?? controller.error ?? pending.value.input.error;
  const pendingCopyAvailable = error !== null && guard.readCopyText({scopes: [], ownerIds: [pending.owner]}) !== null;
  return <SharedOutline value={controller}>
    <div data-outline-session={pending.value.input.root_id} onFocusCapture={event => {
      if (event.target instanceof Element && event.target.matches('[contenteditable="true"]')) controller.setFocused(true);
    }} onBlurCapture={event => {
      const next = event.relatedTarget;
      if (!(next instanceof Element && (event.currentTarget.contains(next) || next.closest("[data-outline-commands]")))) controller.setFocused(false);
    }}>
      {error ? <div role="alert"><p>{error instanceof Error ? error.message : "this writing couldn’t be saved on this device."}</p>
        {writingStoreStopped(error) ? <Button onClick={() => window.location.reload()}>restart nexus</Button>
          : saved.error !== null ? <Button onClick={() => {void runtime.retry().then(() => setFailure(null), setFailure); pending.value.input.retry();}}>retry saving</Button>
            : pending.value.input.error !== null ? <Button onClick={() => pending.value.input.retry()}>retry pending writing</Button>
              : controller.error !== null && controller.canRetry ? <Button onClick={() => controller.retry()}>retry opening</Button> : null}
        {pendingCopyAvailable ? <Button onClick={() => {const text = guard.readCopyText({scopes: [], ownerIds: [pending.owner]}); if (text !== null) void copy(text, "pending outline text");}}>copy pending outline text</Button> : null}
        {saved.error !== null ? <Button onClick={() => {void runtime.uncommittedText().then(text => copy(text, "unsaved note edits"), setFailure);}}>copy unsaved note edits</Button> : null}
      </div> : null}
      {manualCopy ? <><p>copying is unavailable here. select the text and copy it.</p><textarea readOnly value={manualCopy.text} aria-label={manualCopy.label}/></> : null}
      {controller.loading ? <p role="status">loading this outline window…</p> : null}
      {[...controller.requests.values()].map(request => <BranchCollector key={request.parent_id} controller={controller} request={request}/>)}
      <NoteEditor editorKey={`outline:${occurrencePrefix}`} occurrenceKey={`outline:${occurrencePrefix}`} containingNoteRef={rootRef}
        projection={controller.projection} body={emptyBody()} revision={0} editable={!filter.trim()} label={rootField?.label ?? "edit outline"}
        placeholder={rootField?.placeholder ?? "write or @ to link"} compact history={{undo: history.undo, redo: history.redo, boundary: () => history.boundary()}}
        onEdit={() => {}} inspection={rootField?.inspection} onEditorReady={handle => controller.setHandle(handle)}/>
      <OutlineEditorRows mounts={[...controller.mounts.values()]} rows={controller.chrome()}/>
    </div>
  </SharedOutline>;
}

function BranchCollector({controller, request}: {controller: OutlineController; request: BranchRequest}) {
  const read = useOutlineWindow(request.anchor === null ? {kind: "adjacency", ref: request.ref, cursor: request.cursor, limit: request.limit}
    : {kind: "adjacency_window", ref: request.ref, link_id: request.anchor, cursor: null, limit: request.limit}, request.branch, controller.runtime);
  useLayoutEffect(() => {if (read.window) controller.accept(request.parent_id, read.window);}, [controller, request.parent_id, read.window]);
  return read.error ? <div role="alert"><p>couldn’t open these items on this device.</p><Button onClick={read.retry}>retry</Button></div> : null;
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
