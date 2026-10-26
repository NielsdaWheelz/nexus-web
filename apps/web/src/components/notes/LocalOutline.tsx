"use client";
/** One outline session owns visible occurrence selection, input handoff and focus.
 * Content and undo remain in the authored runtime; relationships never own nodes. */
import { createContext, useContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import * as Y from "yjs";
import Button from "@/components/ui/Button";
import ResourceOutlineList, { ResourceBranch } from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import { usePaneOutlineCommands } from "@/lib/panes/paneChrome";
import { readOutlineClipboard, writeOutlineClipboard, type ClipItem } from "@/lib/notes/clipboard";
import type { DisplayedSplit, FocusSelection, OutlineCommand } from "@/lib/notes/editorTypes";
import BoundNoteEditor from "./BoundNoteEditor";
import BoundPageTitleEditor from "./BoundPageTitleEditor";
import OutlineDraft, {type OutlineInputPeer, type OutlineBoundaryPlan} from "./OutlineDraft";
import OutlineLiveInput from "./OutlineLiveInput";
import type { NoteEditorHandle, StructuralKeys } from "./NoteEditor";
import { useAuthoredQuery, useWritingRuntime } from "@/lib/notes/hooks";
import { useOutlineWindow, type OutlineEdge } from "@/lib/notes/useOutlineWindow";
import { classifyOutlineOccurrence } from "@/lib/resources/outlineProjection";
import { OutlineHistory, type CreatedOutlineNote, type OutlineBookmark } from "@/lib/notes/structure";
import { LocalCommitError, writingStoreStopped, selectStates, type WritingSnapshot, type WritingDocument } from "@/lib/notes/runtime";
import { isVisible, mergeVector } from "@nexus/authored/merge";
import { applyBodyEdits, bodyInline, encodeBytes, hydrateNote, readBody, sliceInline } from "@nexus/authored/documents";
import { bodyFromNode, docFromBody, emptyBody, parseBody, type NoteBody } from "@nexus/authored/body";
import type { Intent } from "@nexus/authored/commands";
import { prepareTarget } from "@/lib/resourceGraph/links";
import { localResourceLabel } from "@/lib/resources/localResource";
import { sortedEndpoints } from "@nexus/authored/identity";
import type { LinkState, ResourceProjection, QueryResult } from "@nexus/authored/types";
import { outlineHistoryCommand, outlineStructuralCommand } from "@/lib/shortcuts";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { useNativeKeyboardVisibility } from "@/lib/ui/useKeyboardInset";

interface SelectedRow { key: string; link: LinkState; resource: ResourceProjection; endpoint: string; prefix: string }
interface OutlineSession {
  state: { anchor: string | null; keys: readonly string[]; target: string | null };
  set: React.Dispatch<React.SetStateAction<OutlineSession["state"]>>;
  root: React.RefObject<HTMLDivElement | null>;
  registry: Map<string, SelectedRow>;
  editors: Map<string, NoteEditorHandle>;
  positions: Map<string, FocusSelection>;
  ready: Map<string, () => void>;
  revealPending(): void;
  read(): OutlineSession["state"];
  transition: { current: boolean };
  transient: { current: OutlineBookmark | null };
  focus(bookmark: OutlineBookmark, mayFocus?: () => boolean): Promise<void>;
  lease(): () => boolean;
  capture(): OutlineBookmark | null;
}
const SessionContext = createContext<OutlineSession | null>(null);
const HistoryContext = createContext<OutlineHistory | null>(null);
export interface RootOutlineEditor {
  history: OutlineHistory;
  structuralKeys: StructuralKeys;
  onEditorReady(editor: NoteEditorHandle | null): void;
  onSelectionChange(selection: {anchor: number; head: number}): void;
  onSplit(split: DisplayedSplit): void;
  onEnter(): void;
}
export interface LocalOutlineHandle { append(): Promise<void>; focusRoot(resolve?: (document: WritingDocument) => FocusSelection): Promise<void>; focusNote(ref: string, signal?: AbortSignal): Promise<boolean>; focusFirst(): void }
const EMPTY_INTENTS: readonly Intent[] = [];
type PendingNote = { id: string; admission: number; after: string | null; body: NoteBody; before: OutlineBookmark | null; split: DisplayedSplit | null; source: string | null; join: {entry: SelectedRow; displayed: Promise<WritingSnapshot>} | null; created: CreatedOutlineNote | null; previous?: OutlineInputPeer; tail?: OutlineEdge | null; sourceSnapshot?: Promise<WritingSnapshot>; sourceLink?: LinkState; startAfter?: string | null; plan?: OutlineBoundaryPlan; waitFor?: Promise<OutlineBookmark | null>; placement?: {link: LinkState | null}; adopt?: {ref: string; snapshot: Promise<WritingSnapshot>}; emptyEnterAdmission?: number; live?: {document: WritingDocument; before: OutlineBookmark; index: number} };
export default function LocalOutline({ rootRef, prelude = EMPTY_INTENTS, apiRef, filter = "", session: suppliedHistory, occurrencePrefix = rootRef, rootEditor }: {
  rootEditor?: (editor: RootOutlineEditor) => React.ReactNode;
  rootRef: string; ancestors?: readonly string[]; prelude?: readonly Intent[]; apiRef?: React.RefObject<LocalOutlineHandle | null>; filter?: string; session?: OutlineHistory; occurrencePrefix?: string;
}) {
  const runtime = useWritingRuntime();
  const contextHistory = useContext(HistoryContext);
  const inheritedHistory = suppliedHistory ?? contextHistory;
  const inherited = useContext(SessionContext);
  const inheritedBranch = useContext(ResourceBranch);
  const branch = useMemo(() => inheritedBranch.ancestors.has(rootRef) ? inheritedBranch
    : {...inheritedBranch, ancestors: new Map(inheritedBranch.ancestors).set(rootRef, {kind: "root"} as const)}, [inheritedBranch, rootRef]);
  const [error, setError] = useState<unknown | null>(null);
  const ownHistory = useMemo(() => runtime && !inheritedHistory ? new OutlineHistory(runtime, setError) : null, [runtime, inheritedHistory]);
  const history = inheritedHistory ?? ownHistory;
  useEffect(() => () => { ownHistory?.close(); }, [ownHistory]);
  const surface = useRef<HTMLDivElement>(null);
  const moreItems = useRef<HTMLDivElement>(null);
  const registry = useRef(new Map<string, SelectedRow>());
  const editors = useRef(new Map<string, NoteEditorHandle>());
  const positions = useRef(new Map<string, FocusSelection>());
  const readyEditors = useRef(new Map<string, () => void>());
  const transition = useRef(false);
  const transient = useRef<OutlineBookmark | null>(null);
  const [state, setState] = useState<OutlineSession["state"]>({ anchor: null, keys: [], target: null });
  const stateRef = useRef(state); stateRef.current = state;
  const focusIntent = useRef({revision: 0});
  const pendingFocus = useRef<{ bookmark: OutlineBookmark; mayFocus(): boolean; resolve(): void } | null>(null);
  const pendingDraft = useRef<PendingNote | null>(null);
  const inputPlacement = useRef({parent: rootRef, prefix: occurrencePrefix});
  const intendedPrefix = useRef(occurrencePrefix);
  const boundaryCursor = useRef<SelectedRow | null>(null);
  const previewHidden = useRef(new Set<string>());
  const [draft, setDraft] = useState<PendingNote | null>(null);
  const [trailingAdmission, setTrailingAdmission] = useState(false);
  const [createdDraft, setCreatedDraft] = useState<CreatedOutlineNote | null>(null);
  const handoffReady = useRef<{key: string; resolve(): void} | null>(null);
  const inputReady = useRef<(() => void) | null>(null);
  const [revision, refresh] = useState(0);
  const [windowState, setWindow] = useState<{root: string; anchor: string | null}>({root: rootRef, anchor: null});
  const anchor = windowState.root === rootRef ? windowState.anchor : null;
  const read = useOutlineWindow(anchor === null ? {kind: "adjacency", ref: rootRef, cursor: null, limit: 48}
    : {kind: "adjacency_window", ref: rootRef, link_id: anchor, cursor: null, limit: 48}, branch, runtime);
  const root = useAuthoredQuery({kind: "resource", ref: rootRef});
  const rootResource = root.data?.rows[0]?.resource;
  const rootLabel = rootResource ? localResourceLabel(rootResource) : rootRef;
  const rows = read.rows;
  const nextCursor = read.data?.next_cursor;
  useEffect(() => {
    const target = moreItems.current;
    if (!target || !nextCursor) return;
    let requested = false;
    const observer = new IntersectionObserver(entries => {
      if (!requested && entries.some(entry => entry.isIntersecting)) {
        requested = true;
        read.more();
      }
    });
    observer.observe(target);
    return () => observer.disconnect();
    // Admit one next page for each displayed cursor; autosave must not rearm it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextCursor]);
  const trailing = useRef<NoteEditorHandle | null>(null);
  const [trailingSerial, resetTrailing] = useState(0);
  const { platform } = useRenderEnvironment();
  const nativeKeyboard = useNativeKeyboardVisibility();
  const previousKeyboard = useRef(nativeKeyboard);

  const lease = useCallback(() => {
    const intent = focusIntent.current.revision;
    return () => intent === focusIntent.current.revision && surface.current?.isConnected === true;
  }, []);
  const attemptFocus = useCallback(() => {
    const reveal = (target: string, admitted: () => boolean) => {
      for (const element of surface.current?.querySelectorAll<HTMLElement>("[data-outline-occurrence]") ?? []) {
        const key = element.dataset.outlineOccurrence!;
        if (!target.startsWith(`${key}/`)) continue;
        const arrow = element.querySelector<HTMLButtonElement>(':scope > div > button[aria-expanded="false"]');
        if (arrow && !arrow.disabled && admitted()) arrow.click();
      }
    };
    const active = stateRef.current.target;
    const inputOwned = () => active !== null && active === stateRef.current.target && active.endsWith("/input") && editors.current.has(active);
    for (const [key, resolve] of readyEditors.current) {
      if (inputOwned()) reveal(key, inputOwned);
      else {readyEditors.current.delete(key); resolve();}
    }
    const request = pendingFocus.current;
    if (!request) return;
    if (!request.mayFocus()) {pendingFocus.current = null; request.resolve(); return;}
    const { bookmark } = request;
    const row = [...surface.current?.querySelectorAll<HTMLElement>("[data-outline-occurrence]") ?? []].find(element => element.dataset.outlineOccurrence === bookmark.key);
    const editor = editors.current.get(bookmark.key);
    if ((row?.getClientRects().length || (bookmark.key.endsWith("/input") || bookmark.key.endsWith("/root")) && editor) && (bookmark.selection === null || editor?.canArrange())) {
      pendingFocus.current = null;
      setState({anchor: bookmark.selection === null ? bookmark.key : null, keys: bookmark.selection === null ? [bookmark.key] : [], target: bookmark.key});
      if (bookmark.selection !== null) editor!.focus(bookmark.resolve ?? bookmark.selection);
      else row!.focus({preventScroll: true});
      request.resolve(); return;
    }
    // Open only the exact displayed ancestor chain, never another appearance of a note.
    reveal(bookmark.key, request.mayFocus);
  }, []);
  const restore = useCallback((bookmark: OutlineBookmark, mayFocus = lease()): Promise<void> => {
    pendingFocus.current?.resolve();
    return new Promise(resolve => { pendingFocus.current = {bookmark, mayFocus, resolve}; attemptFocus(); });
  }, [attemptFocus, lease]);
  const capture = useCallback((): OutlineBookmark | null => {
    const key = stateRef.current.target;
    if (!key) return null;
    if (transient.current && key.endsWith("/input")) return {...transient.current, selection: editors.current.get(key)?.readSelection() ?? transient.current.selection};
    const entry = registry.current.get(key);
    const input = editors.current.get(key);
    if (entry) {
      const selected = stateRef.current.keys.includes(key);
      const resolve = !selected ? input?.captureSelection() : undefined;
      return {key, ref: entry.resource.ref, selection: selected ? null : input?.readSelection() ?? null, ...(resolve ? {resolve} : {})};
    }
    if (key === `${occurrencePrefix}/root` && input) {
      const resolve = input.captureSelection();
      return {key, ref: rootRef, selection: input.readSelection(), resolve};
    }
    const pending = pendingDraft.current;
    if (pending?.created) return {key: `${occurrencePrefix}/${pending.created.link_id}`, ref: pending.created.ref, selection: input?.readSelection() ?? "end"};
    return null;
  }, [occurrencePrefix, rootRef]);
  const ownSession = useMemo<OutlineSession>(() => ({state, set: setState, root: surface, registry: registry.current, editors: editors.current, positions: positions.current, ready: readyEditors.current, revealPending: attemptFocus, read: () => stateRef.current, transition, transient, focus: restore, lease, capture}), [state, restore, lease, capture, attemptFocus]);
  const owner = inherited ?? ownSession;
  const {root: ownerRoot, set: setOwnerState} = owner;
  const visible = () => [...owner.root.current?.querySelectorAll<HTMLElement>("[data-outline-occurrence]") ?? []].filter(element => element.getClientRects().length && owner.registry.has(element.dataset.outlineOccurrence!));
  const selectedRows = () => visible().flatMap(element => { const key = element.dataset.outlineOccurrence!; const entry = owner.registry.get(key); return entry && owner.state.keys.includes(key) ? [entry] : []; });
  const select = (key: string, extend = false) => {
    window.getSelection()?.removeAllRanges();
    const order = visible().map(element => element.dataset.outlineOccurrence!);
    owner.set(current => { const anchor = extend && current.anchor ? current.anchor : key; const a = order.indexOf(anchor), b = order.indexOf(key);
      return {anchor, keys: a < 0 || b < 0 ? [key] : order.slice(Math.min(a,b), Math.max(a,b)+1), target: key}; });
    [...owner.root.current?.querySelectorAll<HTMLElement>("[data-outline-occurrence]") ?? []].find(element => element.dataset.outlineOccurrence === key)?.focus({preventScroll: true});
  };
  useLayoutEffect(() => {
    const entries = rows.flatMap(row => row.link ? [{key: `${occurrencePrefix}/${row.link.link_id}`, link: row.link, resource: row.resource, endpoint: rootRef, prefix: occurrencePrefix}] : []);
    for (const entry of entries) owner.registry.set(entry.key, entry);
    return () => { for (const entry of entries) if (owner.registry.get(entry.key) === entry) owner.registry.delete(entry.key); };
  }, [rows, occurrencePrefix, rootRef, owner.registry]);
  useEffect(() => {
    if (inherited || !history) return;
    return history.bindFocus({capture, restore, lease});
  }, [inherited, history, capture, restore, lease]);
  useEffect(() => {
    if (inherited) return;
    const observer = new MutationObserver(attemptFocus);
    if (surface.current) observer.observe(surface.current, {childList: true, subtree: true, attributes: true, attributeFilter: ["aria-expanded", "disabled"]});
    return () => { observer.disconnect(); pendingFocus.current?.resolve(); pendingFocus.current = null; };
  }, [inherited, attemptFocus]);
  useLayoutEffect(() => { if (!inherited) attemptFocus(); }, [rows, inherited, attemptFocus, revision, state.target]);
  useEffect(() => {
    if (inherited) return;
    const intent = focusIntent.current;
    const revoke = (event: Event) => {
      if (!event.isTrusted) return;
      intent.revision++;
      const request = pendingFocus.current;
      pendingFocus.current = null;
      request?.resolve();
    };
    document.addEventListener("pointerdown", revoke, true);
    document.addEventListener("keydown", revoke, true);
    document.addEventListener("beforeinput", revoke, true);
    return () => {
      document.removeEventListener("pointerdown", revoke, true);
      document.removeEventListener("keydown", revoke, true);
      document.removeEventListener("beforeinput", revoke, true);
      intent.revision++;
    };
  }, [inherited]);
  useEffect(() => {
    const before = previousKeyboard.current; previousKeyboard.current = nativeKeyboard;
    if (inherited || before !== true || nativeKeyboard !== false || owner.state.keys.length) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && owner.root.current?.contains(focused) && focused.closest('[role="textbox"],textarea')) {
      focused.blur(); owner.set({anchor: null, keys: [], target: null});
    }
  }, [nativeKeyboard, inherited, owner]);
  useEffect(() => {
    if (inherited) return;
    const outside = (event: PointerEvent | FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || ownerRoot.current?.contains(target) || target.closest("[data-outline-commands]")) return;
      if (event.type === "pointerdown") {
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && ownerRoot.current?.contains(focused)) focused.blur();
      }
      setOwnerState({anchor: null, keys: [], target: null});
    };
    document.addEventListener("pointerdown", outside, true); document.addEventListener("focusin", outside, true);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("focusin", outside, true); };
  }, [inherited, ownerRoot, setOwnerState]);
  const act = (operation: Promise<unknown>) => { setError(null); void operation.catch(error => { if (!(error instanceof DOMException && error.name === "AbortError")) setError(error); }); };
  const run = (work: () => Promise<void>) => {
    if (owner.transition.current) return;
    owner.transition.current = true; refresh(value => value + 1);
    act(work().finally(() => { if (!pendingDraft.current) owner.transition.current = false; refresh(value => value + 1); }));
  };
  const registerEditor = (key: string, handle: NoteEditorHandle | null) => {
    if (handle) owner.editors.set(key, handle); else {owner.editors.delete(key); if (!owner.transition.current) owner.positions.delete(key);}
    if (key.endsWith("/input")) {const resume = inputReady.current; inputReady.current = null; resume?.();}
    if (handle) { const ready = owner.ready.get(key); owner.ready.delete(key); ready?.(); }
    if (!inherited) attemptFocus();
  };
  const loadMore = useRef(read.more); loadMore.current = read.more;
  useLayoutEffect(() => {
    const request = pendingFocus.current;
    if (inherited || request?.bookmark.key !== `${occurrencePrefix}/input` || !request.mayFocus() || read.data === null || read.data.next_cursor === null || !read.tailEdge) return;
    if (anchor !== read.tailEdge.link.link_id) setWindow({root: rootRef, anchor: read.tailEdge.link.link_id});
    else loadMore.current();
  }, [read.data, read.tailEdge, anchor, inherited, occurrencePrefix, rootRef]);
  useEffect(() => {
    const ready = handoffReady.current;
    if (ready && !owner.registry.has(ready.key) && read.data?.next_cursor) loadMore.current();
  }, [rows, read.data, owner.registry, createdDraft]);
  useEffect(() => () => { if (handoffReady.current) owner.ready.delete(handoffReady.current.key); handoffReady.current?.resolve(); handoffReady.current = null; inputReady.current?.(); inputReady.current = null; }, [owner.ready]);
  const focusResource = useCallback(async (ref: string, signal?: AbortSignal): Promise<boolean> => {
    if (!runtime) return false;
    const mayFocus = owner.lease();
    signal?.throwIfAborted();
    const store = await runtime.store;
    const [endpoint_a, endpoint_b] = sortedEndpoints(rootRef, ref);
    const binding = await store.query({kind: "binding", key: {kind: "link", endpoint_a, endpoint_b}});
    if (binding.binding_id === null) return false;
    const states = await store.readStates(selectStates({link_ids: [binding.binding_id]}));
    const link = states.links[0];
    if (!link || !isVisible(link.add_vv, link.remove_vv)) return false;
    const key = `${occurrencePrefix}/${link.link_id}`;
    signal?.throwIfAborted();
    if (!mayFocus()) return true;
    if (!owner.registry.has(key)) setWindow({root: rootRef, anchor: link.link_id});
    await owner.focus({key, ref, selection: ref.startsWith("note_block:") ? "end" : null}, mayFocus);
    return true;
  }, [runtime, rootRef, occurrencePrefix, owner]);
  useLayoutEffect(() => {
    if (!apiRef) return;
    const handle: LocalOutlineHandle = {append: () => {
      if (read.data?.next_cursor && read.tailEdge) {
        if (anchor !== read.tailEdge.link.link_id) setWindow({root: rootRef, anchor: read.tailEdge.link.link_id});
        else loadMore.current();
      }
      return owner.focus({key: `${occurrencePrefix}/input`, ref: rootRef, selection: {anchor: 1, head: 1}}, owner.lease());
    }, focusRoot: resolve => owner.focus({key: `${occurrencePrefix}/root`, ref: rootRef, selection: "end", resolve}, owner.lease()), focusNote: focusResource,
      focusFirst: () => { const first = rows[0]; if (first) act(focusResource(first.resource.ref)); else trailing.current?.focus({anchor: 1, head: 1}); }};
    apiRef.current = handle; return () => { if (apiRef.current === handle) apiRef.current = null; };
  });
  const neighbor = (entry: SelectedRow, direction: "before" | "after") => {
    const at = rows.findIndex(row => row.link?.link_id === entry.link.link_id);
    if (at < 0) return null;
    const row = direction === "before" ? rows[at - 1] ?? read.beforeEdge : rows[at + 1] ?? read.afterEdge;
    return row?.link ? {key: `${entry.prefix}/${row.link.link_id}`, link: row.link, resource: row.resource, endpoint: entry.endpoint, prefix: entry.prefix} : null;
  };
  const capturePeer = (edge: OutlineEdge): OutlineInputPeer => {
    const document = read.documents.get(edge.resource.ref);
    if (!document) throw new Error("prepared adjacent writing is unavailable");
    const peer: OutlineInputPeer = {body: readBody(document.doc), note: null, key: `${occurrencePrefix}/${edge.link.link_id}`, represented: false};
    peer.ready = document.capture().then(snapshot => peer.note = {...snapshot, ref: edge.resource.ref, link_id: edge.link.link_id, observed_add: edge.link.add_vv, input_offset: 0});
    void peer.ready.catch(() => {});
    return peer;
  };
  const finishLive = async (pending: PendingNote, after: OutlineBookmark) => {
    if (pendingDraft.current !== pending) return;
    owner.transient.current = after;
    owner.set(current => ({...current}));
    if (!owner.editors.has(after.key) && surface.current?.isConnected && owner.read().target === `${occurrencePrefix}/input`) await new Promise<void>(resolve => {
      handoffReady.current = {key: after.key, resolve}; owner.ready.set(after.key, resolve); owner.revealPending();
    });
    if (pendingDraft.current !== pending) return;
    let active = owner.editors.get(`${occurrencePrefix}/input`);
    while (active && !active.settleNativeInput()) {
      await new Promise<void>(resolve => {inputReady.current = resolve;});
      if (pendingDraft.current !== pending) return;
      active = owner.editors.get(`${occurrencePrefix}/input`);
    }
    const selection = active?.captureSelection() ?? after.resolve ?? after.selection ?? "end";
    const mayFocus = owner.read().target === `${occurrencePrefix}/input`;
    pendingDraft.current = null; owner.transient.current = null;
    inputPlacement.current = {parent: rootRef, prefix: occurrencePrefix}; intendedPrefix.current = occurrencePrefix;
    flushSync(() => {setDraft(null); owner.set(current => mayFocus ? {anchor: null, keys: [], target: after.key} : {...current});});
    if (mayFocus) owner.editors.get(after.key)?.focus(selection, true);
  };
  const arrange = (entry: SelectedRow, command: "indent" | "outdent" | "move_up" | "move_down") => {
    if (owner.read().keys.length > 1) return;
    run(async () => {
    const before = owner.capture();
    const mayFocus = owner.lease();
    if (command === "move_up" || command === "move_down") {
      await history!.withFocus(before, async () => {
        const other = await neighbor(entry, command === "move_up" ? "before" : "after");
        if (other) await history!.move(entry.link, entry.endpoint, command === "move_up" ? [other.link, entry.link] : [entry.link, other.link], command === "move_up" ? 0 : 1);
      }, () => before);
      const after = before && {...before, selection: owner.positions.get(entry.key) ?? before.selection};
      if (after && mayFocus() && owner.read().target === before?.key) await owner.focus(after, mayFocus); return;
    }
    let moving: PendingNote | null = null;
    const placement: {link: LinkState | null} = {link: null};
    const operation: Promise<OutlineBookmark | null> = history!.withFocus(before, async () => {
      const parent = command === "outdent" ? owner.registry.get(entry.prefix) : await neighbor(entry, "before");
      if (!parent || command === "indent" && (parent.resource.kind !== "note" || branch.ancestors.has(parent.resource.ref))) return null;
      const destination = command === "indent" ? parent.resource.ref : parent.endpoint;
      const prefix = command === "indent" ? parent.key : parent.prefix;
      const predecessor = command === "indent" ? null : parent.link.link_id;
      if (before?.selection !== null && before && (entry.resource.kind === "note" || entry.resource.kind === "page")) {
        const document = read.documents.get(entry.resource.ref);
        if (!document) throw new Error("prepared writing is unavailable");
        moving = {id: crypto.randomUUID(), admission: history!.admit(), after: entry.link.link_id, body: entry.resource.kind === "note" ? readBody(document.doc) : emptyBody(), before, source: entry.resource.ref, split: null, join: null, created: null,
          live: {document, before, index: rows.findIndex(row => row.link?.link_id === entry.link.link_id)}, waitFor: operation, placement};
        pendingDraft.current = moving; owner.transient.current = before;
        inputPlacement.current = {parent: destination, prefix}; intendedPrefix.current = prefix;
        flushSync(() => {setDraft(moving); owner.set({anchor: null, keys: [], target: `${occurrencePrefix}/input`});});
      }
      const changed = await history!.relink(entry.link, entry.endpoint, destination, predecessor, link => {placement.link = link;});
      return {...before, key: `${prefix}/${changed}`, ref: entry.resource.ref, selection: before?.selection === null ? null : owner.positions.get(entry.key) ?? before?.selection ?? null};
    }, bookmark => bookmark);
    let after: OutlineBookmark | null;
    try {after = await operation;} catch (error) {if (moving && before) await finishLive(moving, before); throw error;}
    if (moving && after) await finishLive(moving, after);
    else if (after && mayFocus() && owner.read().target === before?.key) await owner.focus(after, mayFocus);
    owner.positions.delete(entry.key);
    });
  };
  const remove = (entries: SelectedRow[], direction?: "backward" | "forward") => run(async () => {
    if (!entries.length) return;
    const before = owner.capture() ?? {key: entries[0]!.key, ref: entries[0]!.resource.ref, selection: null};
    const order = visible().map(element => owner.registry.get(element.dataset.outlineOccurrence!)!);
    const ids = new Set(entries.map(entry => entry.link.link_id));
    const first = order.findIndex(entry => ids.has(entry.link.link_id));
    const previous = direction ? neighbor(entries[0]!, "before") : order.slice(0, first).reverse().find(entry => !ids.has(entry.link.link_id));
    const following = direction ? neighbor(entries[0]!, "after") : order.slice(first + 1).find(entry => !ids.has(entry.link.link_id));
    const next = direction === "backward" ? previous ?? following : following ?? previous;
    const editable = next && !branch.ancestors.has(next.resource.ref) && (next.resource.kind === "note" || next.resource.kind === "page");
    const after: OutlineBookmark | null = next ? {key: next.key, ref: next.resource.ref, selection: editable ? direction && next === following ? {anchor: 1, head: 1} : "end" : null} : null;
    const mayFocus = owner.lease();
    const operation = history!.withFocus(before, async () => {await history!.unlinkMany(entries.map(entry => entry.link)); return after;}, bookmark => bookmark);
    let live: PendingNote | null = null;
    if (direction) {
      const target = after && owner.editors.get(after.key);
      if (target && after && after.selection !== null) {
        owner.set({anchor: null, keys: [], target: after.key}); target.focus(after.selection);
      } else if (after && editable) {
        const document = read.documents.get(after.ref);
        if (!document) throw new Error("prepared adjacent writing is unavailable");
        live = {id: crypto.randomUUID(), admission: history!.admit(), after: entries[0]!.link.link_id, body: emptyBody(), before: after, split: null, source: after.ref, join: null, created: null,
          live: {document, before: after, index: rows.findIndex(row => row.link?.link_id === entries[0]!.link.link_id)}, waitFor: operation, placement: {link: next!.link}};
        pendingDraft.current = live; owner.transient.current = after;
        flushSync(() => {setDraft(live); setWindow({root: rootRef, anchor: next!.link.link_id}); owner.set({anchor: null, keys: [], target: `${occurrencePrefix}/input`});});
      } else if (!after) {owner.set({anchor: null, keys: [], target: `${occurrencePrefix}/input`}); trailing.current?.focus({anchor: 1, head: 1});}
      else {owner.set({anchor: after.key, keys: [after.key], target: after.key}); await owner.focus(after, mayFocus);}
    } else owner.set({anchor: null, keys: [], target: null});
    await operation;
    if (live && after) await finishLive(live, after);
    else if (!direction && mayFocus() && owner.read().target === null) {if (after) await owner.focus(after, mayFocus); else trailing.current?.focus({anchor: 1, head: 1});}
  });
  const startSplit = (source: string, predecessor: string | null, split: DisplayedSplit | null) => {
    const live = pendingDraft.current?.live ? pendingDraft.current : null;
    if (!split || owner.transition.current && !live) return;
    owner.transition.current = true;
    const clone = hydrateNote(split.body_state);
    const body = parseBody({type: "body", attrs: readBody(clone).body_pm_json.attrs, content: sliceInline(clone, split.to, bodyInline(clone).length)});
    clone.destroy();
    const pending: PendingNote = {id: crypto.randomUUID(), admission: history!.admit(), after: predecessor, body, before: owner.capture(), split, source, join: null, created: null};
    if (live) {pending.waitFor = live.waitFor; pending.placement = live.placement;}
    if (predecessor === null && source === rootRef) {
      pending.tail = read.tailEdge;
      if (read.tailEdge?.resource.kind === "note" && !branch.ancestors.has(read.tailEdge.resource.ref)) pending.previous = capturePeer(read.tailEdge);
    }
    if (predecessor) {
      const left = hydrateNote(split.body_state);
      applyBodyEdits(left, [{kind: "replace", from: split.from, to: bodyInline(left).length, content: []}]);
      pending.previous = {body: readBody(left), note: null, key: `${occurrencePrefix}/${predecessor}`, represented: false};
      pending.sourceLink = owner.registry.get(pending.previous.key!)?.link;
      left.destroy();
      pending.sourceSnapshot = read.documents.get(source)?.capture();
    }
    pendingDraft.current = pending;
    flushSync(() => { setDraft(pending); owner.set(current => ({...current, anchor: null, keys: [], target: `${occurrencePrefix}/input`})); });
  };
  const join = (entry: SelectedRow, direction: "backward" | "forward", displayed: Promise<WritingSnapshot>) => {
    if (owner.transition.current) return;
    const document = read.documents.get(entry.resource.ref);
    if (!document) throw new Error("prepared writing is unavailable");
    const body = readBody(document.doc);
    const plan = boundaryPlan(direction, body, null, entry);
    if (!plan) return;
    owner.transition.current = true;
    const pending: PendingNote = {id: crypto.randomUUID(), admission: history!.admit(), after: entry.link.link_id, body: plan.body, before: owner.capture(), split: null, source: entry.resource.ref, join: {entry, displayed}, created: null, plan};
    pendingDraft.current = pending;
    flushSync(() => { setDraft(pending); owner.set(current => ({...current, anchor: null, keys: [], target: `${occurrencePrefix}/input`})); });
  };
  const createDraft = async (body: NoteBody, admission: number) => {
    owner.transition.current = true;
    const pending = pendingDraft.current;
    if (pending?.waitFor) {
      const placed = await pending.waitFor;
      if (placed) {
        pending.after = placed.key.slice(placed.key.lastIndexOf("/") + 1);
        pending.before = pending.before ? {...pending.before, key: placed.key} : placed;
        if (pending.previous) pending.previous.key = placed.key;
        if (pending.placement?.link) pending.sourceLink = pending.placement.link;
      }
    }
    if (!pending) setTrailingAdmission(true);
    const before = pending?.before ?? owner.capture() ?? {key: `${occurrencePrefix}/input`, ref: rootRef, selection: {anchor: 1, head: 1}};
    if (pending?.adopt) {
      const shown = await pending.adopt.snapshot, link = pending.placement?.link;
      if (!link) throw new Error("relocated input has no relationship receipt");
      return {...shown, ref: pending.adopt.ref, link_id: link.link_id, observed_add: link.add_vv, input_offset: 0};
    }
    if (pending?.plan && pending.join) {
      const {entry, displayed} = pending.join;
      const shown = await displayed;
      const note = await pending.plan.apply({...shown, ref: entry.resource.ref, link_id: entry.link.link_id, observed_add: entry.link.add_vv, input_offset: 0}, shown.body_state, pending.admission);
      if (!note) throw new Error("a joined note has no input destination");
      return note;
    }
    return history!.withFocus(before,
      async () => {
        if (!pending?.split || !pending.source) return history!.create(inputPlacement.current.parent, pending?.after ?? null, body, prelude);
        const note = await history!.split(pending.source, pending.split, inputPlacement.current.parent, pending.after);
        if (pending.previous && pending.after && pending.sourceSnapshot && pending.sourceLink) {
          const shown = await pending.sourceSnapshot;
          const clone = hydrateNote(pending.split.body_state);
          applyBodyEdits(clone, [{kind: "replace", from: pending.split.from, to: bodyInline(clone).length, content: []}]);
          pending.previous.note = {ref: pending.source, link_id: pending.after, body_state: encodeBytes(Y.encodeStateAsUpdate(clone)), observed_touch: mergeVector(shown.observed_touch, note.observed_touch), observed_add: pending.sourceLink.add_vv, input_offset: 0};
          clone.destroy();
        }
        return note;
      },
      note => ({key: `${inputPlacement.current.prefix}/${note.link_id}`, ref: note.ref, selection: {anchor: 1, head: 1}}), pending?.admission ?? admission);
  };
  const completeDraft = (note: CreatedOutlineNote | null, at: FocusSelection) => {
    const bookmark = note ? {key: `${inputPlacement.current.prefix}/${note.link_id}`, ref: note.ref, selection: at} : null;
    const mayFocus = surface.current?.isConnected && owner.read().target === `${occurrencePrefix}/input`;
    pendingDraft.current = null; owner.transient.current = null;
    boundaryCursor.current = null; previewHidden.current.clear();
    inputPlacement.current = {parent: rootRef, prefix: occurrencePrefix}; intendedPrefix.current = occurrencePrefix;
    flushSync(() => {
      if (surface.current?.isConnected) {setDraft(null); setCreatedDraft(null); setTrailingAdmission(false); resetTrailing(value => value + 1);}
      owner.set(current => mayFocus ? {anchor: null, keys: [], target: bookmark?.key ?? `${occurrencePrefix}/input`} : {...current});
    });
    owner.transition.current = false;
    if (mayFocus) {if (bookmark) owner.editors.get(bookmark.key)?.focus(at); else trailing.current?.focus({anchor: 1, head: 1});}
  };
  const boundaryPlan = (direction: "backward" | "forward", body: NoteBody, supplied: OutlineInputPeer | null, source?: SelectedRow): OutlineBoundaryPlan | null => {
    if (!source && inputPlacement.current.parent !== rootRef) return null;
    const empty = docFromBody(body).firstChild!.content.size === 0;
    let peer = supplied;
    let entry: SelectedRow | null = null;
    let backwards = direction === "backward";
    if (!peer) {
      const cursor = source ?? boundaryCursor.current;
      const pending = source ? null : pendingDraft.current;
      const siblings = rows.filter(row => {const key = `${occurrencePrefix}/${row.link?.link_id}`; return row.link?.link_id === cursor?.link.link_id || !previewHidden.current.has(key) && owner.transient.current?.key !== key;});
      const anchor = cursor?.link.link_id ?? pending?.created?.link_id ?? pending?.after ?? null;
      let at = anchor === null ? siblings.length : siblings.findIndex(row => row.link?.link_id === anchor);
      let current = (cursor !== null || !!pending?.created) && at >= 0;
      if (at < 0) { const initial = pending?.startAfter ?? pending?.sourceLink?.link_id ?? null; at = initial === null ? siblings.length : siblings.findIndex(row => row.link?.link_id === initial); current = false; }
      const before = !cursor && pending?.tail !== undefined ? pending.tail : siblings[at - (anchor === null || at === siblings.length || current ? 1 : 0)] ?? (at === 0 ? read.beforeEdge : null);
      const after = !cursor && pending?.tail !== undefined ? null : siblings[at + 1] ?? read.afterEdge;
      const chosen = direction === "backward" ? before ?? (empty ? after : undefined) : after ?? (empty ? before : undefined);
      backwards = chosen === before;
      if (chosen?.link && chosen.resource.kind === "note" && !branch.ancestors.has(chosen.resource.ref)) {
        entry = {key: `${occurrencePrefix}/${chosen.link.link_id}`, link: chosen.link, resource: chosen.resource, endpoint: rootRef, prefix: occurrencePrefix};
        if (pending?.previous?.key === entry.key) peer = pending.previous;
        else {
          peer = capturePeer({link: chosen.link, resource: chosen.resource});
        }
      }
    }
    if (!peer && !empty) return null;
    const target = peer;
    const targetNode = docFromBody(target?.body ?? emptyBody()).firstChild!, sourceNode = docFromBody(body).firstChild!;
    const preview = empty ? target?.body ?? emptyBody() : bodyFromNode(sourceNode.copy(backwards ? targetNode.content.append(sourceNode.content) : sourceNode.content.append(targetNode.content)));
    const position = empty ? backwards ? targetNode.content.size + 1 : 1 : backwards ? targetNode.content.size + 1 : sourceNode.content.size + 1;
    if (target?.key) previewHidden.current.add(target.key);
    if (entry) boundaryCursor.current = entry;
    else if (target?.key) boundaryCursor.current = owner.registry.get(target.key) ?? boundaryCursor.current;
    owner.set(current => ({...current}));
    return {body: preview, selection: {anchor: position, head: position}, apply: async (note, body_state, admission) => {
      const {prefix} = inputPlacement.current;
      const before: OutlineBookmark = {key: `${prefix}/${note.link_id}`, ref: note.ref, selection: {anchor: direction === "backward" ? 1 : sourceNode.content.size + 1, head: direction === "backward" ? 1 : sourceNode.content.size + 1}};
      const destination = target?.note ?? (target?.ready ? await target.ready : null);
      if (target && !destination) throw new Error("adjacent writing is still opening");
      if (empty) {
        const link = (await (await runtime!.store).readStates(selectStates({link_ids: [note.link_id]}))).links[0];
        if (!link) throw new Error("pending note relationship is unavailable");
        await history!.withFocus(before, () => history!.unlink({...link, add_vv: note.observed_add}), () => destination ? {key: target!.key ?? `${prefix}/${destination.link_id}`, ref: destination.ref, selection: {anchor: position, head: position}} : null, admission);
        return destination ? {...destination, input_offset: 0} : null;
      }
      if (!destination) return null;
      const result = await history!.withFocus(before,
        () => backwards ? history!.join(destination.ref, note.ref, {source: {body_state, observed_touch: note.observed_touch}, destination})
          : history!.join(note.ref, destination.ref, {source: destination, destination: {body_state, observed_touch: note.observed_touch}}),
        () => ({key: backwards ? target!.key ?? `${prefix}/${destination.link_id}` : `${prefix}/${note.link_id}`, ref: backwards ? destination.ref : note.ref, selection: {anchor: position, head: position}}), admission);
      return {...result, link_id: backwards ? destination.link_id : note.link_id, observed_add: backwards ? destination.observed_add : note.observed_add, input_offset: 0};
    }};
  };
  const clipboardItems = (): ClipItem[] => selectedRows().map((entry, index, selected) => {
    const parent = selected.findLastIndex((other, at) => at < index && entry.key.startsWith(`${other.key}/`));
    return entry.resource.kind === "note" ? {kind: "note", parent: parent < 0 ? null : parent, body: runtime!.openBody(entry.resource.ref) ?? parseBody(entry.resource.body_pm_json)}
      : {kind: "resource", parent: parent < 0 ? null : parent, ref: entry.resource.ref, label: entry.resource.title ?? entry.resource.ref};
  });
  const localTarget = owner.state.target?.startsWith(`${occurrencePrefix}/`) && !owner.state.target.slice(occurrencePrefix.length + 1).includes("/") ? owner.state.target : null;
  const currentEntry = localTarget ? owner.registry.get(localTarget) : null;
  const input = localTarget ? owner.editors.get(localTarget) : null;
  const previous = currentEntry ? neighbor(currentEntry, "before") : null;
  const following = currentEntry ? neighbor(currentEntry, "after") : null;
  const publication = useMemo(() => {
    if (!history || !localTarget || filter.trim() && localTarget !== `${occurrencePrefix}/root`) return null;
    const commandState = (command: OutlineCommand) => {
      if (command === "undo" || command === "redo") {
        const local = input?.localHistory(command);
        if (local) return {enabled: local.enabled, reason: null};
        if (owner.transition.current) return {enabled: false, reason: "finish the current change first"};
        return {enabled: command === "undo" ? history.canUndo() : history.canRedo(), reason: null};
      }
      if (owner.transition.current) return {enabled: false, reason: "finish the current change first"};
      if (!currentEntry || input && !input.canArrange() || owner.state.keys.length > 1) return {enabled: false, reason: "select one item to arrange"};
      const enabled = command === "outdent" ? owner.registry.has(currentEntry.prefix)
        : command === "indent" ? previous?.resource.kind === "note" && !branch.ancestors.has(previous.resource.ref)
        : command === "move_up" ? previous !== null
        : following !== null;
      return {enabled, reason: enabled ? null : "no item available"};
    };
    return {session: `local:${occurrencePrefix}`, commandState, executeCommand: (command: OutlineCommand) => {
      if (!commandState(command).enabled) return;
      if (command === "undo" || command === "redo") {
        const local = input?.localHistory(command);
        if (local) local.execute(); else if (command === "undo") history.undo(); else history.redo(); refresh(value => value + 1);
      } else if (currentEntry) { input?.readSelection(); arrange(currentEntry, command); }
    }};
  // Session state refreshes availability; mutable editor handles remain at the input boundary.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, filter, localTarget, currentEntry, input, owner.state, previous, following, revision]);
  usePaneOutlineCommands(publication);
  if (!runtime || !history) return null;
  const renderDraft = (pending: PendingNote | null) => <div data-outline-input="true" onFocusCapture={() => owner.set(current => ({...current, anchor: null, keys: [], target: `${occurrencePrefix}/input`}))}>{pending?.live ? <OutlineLiveInput key={pending.id} document={pending.live.document} history={history} before={pending.live.before}
    onReady={handle => {trailing.current = handle; registerEditor(`${occurrencePrefix}/input`, handle);}}
    onSelectionChange={at => {
      owner.positions.set(`${occurrencePrefix}/input`, at); refresh(value => value + 1);
      if (owner.editors.get(`${occurrencePrefix}/input`)?.canArrange()) {const resume = inputReady.current; inputReady.current = null; resume?.();}
    }}
    onSplit={split => startSplit(pending.source!, pending.after, split)} keys={{emptyEnter: () => {
      if (!owner.registry.has(inputPlacement.current.prefix)) return;
      const admission = history.admit();
      const next: PendingNote = {id: crypto.randomUUID(), admission, after: pending.after, body: emptyBody(), before: owner.capture(), split: null, source: pending.source, join: null, created: null,
        waitFor: pending.waitFor, placement: pending.placement, adopt: {ref: pending.live!.document.ref, snapshot: pending.live!.document.capture()}, emptyEnterAdmission: admission};
      pendingDraft.current = next; flushSync(() => setDraft(next));
    }}}
    onEnter={() => {
      const next: PendingNote = {id: crypto.randomUUID(), admission: history.admit(), after: pending.after, body: emptyBody(), before: owner.capture(), split: null, source: null, join: null, created: null, waitFor: pending.waitFor, placement: pending.placement};
      pendingDraft.current = next; flushSync(() => setDraft(next));
    }}/>
    : <OutlineDraft key={pending?.id ?? `tail:${trailingSerial}`} id={pending?.id ?? `${occurrencePrefix}:tail:${trailingSerial}`}
    seed={pending?.body} previousPeer={pending?.previous} initialAdmission={pending?.admission} initialEmptyEnter={pending?.emptyEnterAdmission} immediate={pending !== null} initialSelection={pending?.plan?.selection} history={history} create={createDraft} boundary={boundaryPlan}
    createFollowing={(body, admission) => history.withFocus(null, () => history.create(inputPlacement.current.parent, null, body, prelude), note => ({key: `${inputPlacement.current.prefix}/${note.link_id}`, ref: note.ref, selection: "end"}), admission)}
    split={(note, displayed, admission, peer) => {
      const {parent, prefix} = inputPlacement.current;
      if (peer) { peer.key = `${prefix}/${note.link_id}`; if (peer.represented) previewHidden.current.add(peer.key); }
      return history.withFocus({key: `${prefix}/${note.link_id}`, ref: note.ref, selection: {anchor: displayed.from + 1, head: displayed.to + 1}},
        () => history.split(note.ref, displayed, parent, note.link_id),
        next => ({key: `${prefix}/${next.link_id}`, ref: next.ref, selection: {anchor: 1, head: 1}}), admission);
    }}
    emptyEnter={() => {
      const parent = owner.registry.get(intendedPrefix.current);
      if (!parent) return null;
      intendedPrefix.current = parent.prefix;
      return async (note, body_state, admission) => {
        const {parent: source, prefix} = inputPlacement.current;
        const link = (await (await runtime.store).readStates(selectStates({link_ids: [note.link_id]}))).links[0];
        if (!link) throw new Error("pending note relationship is unavailable");
        const link_id = await history.withFocus({key: `${prefix}/${note.link_id}`, ref: note.ref, selection: {anchor: 1, head: 1}},
          () => history.relink(link, source, parent.endpoint, parent.link.link_id),
          id => ({key: `${parent.prefix}/${id}`, ref: note.ref, selection: {anchor: 1, head: 1}}), admission);
        inputPlacement.current = {parent: parent.endpoint, prefix: parent.prefix};
        const moved = (await (await runtime.store).readStates(selectStates({link_ids: [link_id]}))).links[0];
        if (!moved) throw new Error("outdented relationship is unavailable");
        return {...note, link_id, observed_add: moved.add_vv, body_state, input_offset: 0};
      };
    }}
    onCreated={note => {
      const key = `${inputPlacement.current.prefix}/${note.link_id}`;
      owner.transient.current = {key, ref: note.ref, selection: {anchor: 1, head: 1}};
      if (pendingDraft.current) {
        if (pendingDraft.current.startAfter === undefined) pendingDraft.current.startAfter = pendingDraft.current.after;
        pendingDraft.current.created = note;
        pendingDraft.current.after = note.link_id;
        setDraft(current => current && current.id === pendingDraft.current?.id ? {...current, after: note.link_id} : current);
      }
      if (!surface.current?.isConnected) return Promise.resolve();
      setCreatedDraft(note);
      owner.set(current => ({...current}));
      if (owner.editors.has(key)) return Promise.resolve();
      return new Promise<void>(resolve => {
        if (handoffReady.current) owner.ready.delete(handoffReady.current.key);
        handoffReady.current?.resolve(); handoffReady.current = {key, resolve}; owner.ready.set(key, resolve); owner.revealPending(); refresh(value => value + 1);
      });
    }}
    onComplete={completeDraft} onFailure={error => { owner.transition.current = false; setError(error); }}
    onEditorReady={handle => { trailing.current = handle; registerEditor(`${occurrencePrefix}/input`, handle); }}
    onSelectionChange={at => {owner.positions.set(`${occurrencePrefix}/input`,at); refresh(value => value + 1);}}
    reference={{source_ref: rootRef, label: rootRef, onSelected: (target, item) => run(async () => {
      const endpoint = await prepareTarget(runtime, target);
      await history.paste(rootRef, pending?.after ?? null, [{kind: "resource", ref: endpoint.ref, label: item.label, parent: null}], [...prelude, ...endpoint.intents]);
      resetTrailing(value => value + 1);
    })}}/>}</div>;
  const displayed: ({kind: "row"; row: QueryResult["rows"][number]} | {kind: "input"})[] = rows.map(row => ({kind: "row", row}));
  if (draft) { const at = draft.live ? Math.min(draft.live.index, rows.length - 1) : rows.findIndex(row => row.link?.link_id === draft.after); displayed.splice(at < 0 ? displayed.length : at + 1, 0, {kind: "input"}); }
  return <SessionContext value={owner}><HistoryContext value={history}><div ref={surface} data-local-outline="true"
    onPointerDownCapture={event => {
      if (event.target instanceof Element && !event.target.closest('[data-outline-occurrence],[data-outline-input],a,button,input,textarea,[contenteditable=true]')) {
        const focused = document.activeElement; if (focused instanceof HTMLElement && owner.root.current?.contains(focused)) focused.blur();
        owner.set({anchor: null, keys: [], target: null});
      }
    }}
    onBlurCapture={event => {
      const target = event.relatedTarget;
      if (!owner.transition.current && !(target instanceof Element && (owner.root.current?.contains(target) || target.closest("[data-outline-commands]"))))
        owner.set(current => current.keys.length ? current : {...current, target: null});
    }}>
    {rootEditor && read.data === null && read.loading ? <p role="status">opening outline…</p> : null}
    {rootEditor && read.data !== null ? <div data-outline-root-editor="true" onFocusCapture={() => owner.set({anchor: null, keys: [], target: `${occurrencePrefix}/root`})}
      onKeyDown={event => {if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing) {event.preventDefault(); if (event.target instanceof HTMLElement) event.target.blur(); owner.set({anchor: null, keys: [], target: null});}}}>
      {rootEditor({history, structuralKeys: {emptyEnter: () => undefined}, onEditorReady: handle => registerEditor(`${occurrencePrefix}/root`, handle),
        onSelectionChange: at => {owner.positions.set(`${occurrencePrefix}/root`, at); refresh(value => value + 1);},
        onSplit: split => startSplit(rootRef, null, split),
        onEnter: () => {
          if (anchor === null && read.data !== null) {
            const first = rows[0];
            if (first?.link) act(owner.focus({key: `${occurrencePrefix}/${first.link.link_id}`, ref: first.resource.ref, selection: first.resource.kind === "note" || first.resource.kind === "page" ? {anchor: 1, head: 1} : null}));
            else trailing.current?.focus({anchor: 1, head: 1});
          } else act((async () => {const first = await (await runtime.store).query({kind: "adjacency", ref: rootRef, cursor: null, limit: 1}); if (first.rows[0]) await focusResource(first.rows[0].resource.ref); else trailing.current?.focus({anchor: 1, head: 1});})());
        }})}
    </div> : null}
    {read.error ? <div role="alert"><p>couldn’t open these links on this device.</p><Button onClick={read.retry}>retry</Button></div> : null}
    {error ? <div role="alert"><p>{error instanceof Error ? error.message : "this change couldn’t be saved on this device."}</p>{writingStoreStopped(error) ? <><Button onClick={() => { void runtime.uncommittedText().then(text => navigator.clipboard.writeText(text)); }}>copy writing</Button><Button onClick={() => window.location.reload()}>restart nexus</Button></> : error instanceof LocalCommitError ? <Button onClick={() => { void error.retry().then(() => setError(null), setError); }}>retry saving</Button> : null}</div> : null}
    {anchor !== null ? <Button onClick={() => setWindow({root: rootRef, anchor: null})}>show from the start</Button> : null}
    <ResourceOutlineList scope={`local:${rootRef}`} ariaLabel="linked resources" ancestorRef={rootRef} busy={read.loading}>
      {displayed.map(item => {
        if (item.kind === "input") return <li key={draft!.id}>{renderDraft(draft)}</li>;
        const row = item.row;
        const link = row.link!;
        const ref = row.resource.ref;
        const terminal = classifyOutlineOccurrence({branch, targetRef: ref, edgeId: link.link_id}).kind === "reference";
        const key = `${occurrencePrefix}/${link.link_id}`;
        const entry = {key, link, resource: row.resource, endpoint: rootRef, prefix: occurrencePrefix};
        if (filter.trim() && ![row.resource.title, row.resource.body_text, row.resource.selection?.quote_exact].some(value => value?.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))) return null;
        const keys = {indent: () => arrange(entry, "indent"), outdent: () => arrange(entry, "outdent"), move: (direction: "up" | "down") => arrange(entry, direction === "up" ? "move_up" : "move_down"),
          emptyEnter: () => { if (owner.registry.has(occurrencePrefix)) arrange(entry, "outdent"); }, emptyDelete: (direction: "backward" | "forward") => remove([entry], direction), selectBlock: () => select(key)};
        return <ResourceOutlineRow key={link.link_id} writing projection={row.resource} onSelectBlock={() => select(key)} resourceRef={ref} occurrenceKey={key}
          childrenAvailable={read.childAvailability.get(link.link_id) ?? null}
          incoming={{kind: "link", linkId: link.link_id, parentLabel: rootLabel, unlink: () => remove([entry])}} editable={!filter.trim()}
          body={terminal ? undefined : row.resource.kind === "note" ? <BoundNoteEditor document={read.documents.get(ref)} noteRef={ref} session={history} editable={!filter.trim()}
            onEditorReady={handle => registerEditor(key, handle)} onSelectionChange={at => {owner.positions.set(key,at); refresh(value => value + 1);}}
            onSplit={split => startSplit(entry.resource.ref, entry.link.link_id, split)} onJoin={(direction, displayed) => join(entry, direction, displayed)} structuralKeys={keys}
            reference={{source_ref: rootRef, label: rootRef, onSelected: (target, item) => run(async () => { const endpoint = await prepareTarget(runtime, target); await history.paste(rootRef, link.link_id, [{kind: "resource", ref: endpoint.ref, label: item.label, parent: null}], endpoint.intents); })}}/>
            : row.resource.kind === "page" ? <BoundPageTitleEditor document={read.documents.get(ref)} pageRef={ref} session={history} label="edit page title" editable={!filter.trim()} structuralKeys={keys}
              onEditorReady={handle => registerEditor(key, handle)} onSelectionChange={at => {owner.positions.set(key,at); refresh(value => value + 1);}}
              onEnter={() => { if (owner.transition.current) return; owner.transition.current = true; const pending: PendingNote = {id: crypto.randomUUID(), admission: history!.admit(), after: link.link_id, body: emptyBody(), before: owner.capture(), split: null, source: null, join: null, created: null}; pendingDraft.current = pending; flushSync(() => { setDraft(pending); owner.set(current => ({...current, anchor: null, keys: [], target: `${occurrencePrefix}/input`})); }); }}/>
            : undefined}
          rootProps={{hidden: previewHidden.current.has(key) || owner.transient.current?.key === key || !!(draft?.join || draft?.live) && draft.source === ref, "data-selected": owner.state.keys.includes(key), tabIndex: 0,
            onFocus: event => {
              const target = event.target;
              if (target instanceof Element && target.closest("[data-outline-occurrence],[data-outline-input],[data-outline-root-editor]") === event.currentTarget && target.matches('[contenteditable="true"],textarea'))
                owner.set({anchor: null, keys: [], target: key});
            },
            onClick: event => {
              const target = event.target;
              if (!(target instanceof Element) || target.closest("[data-outline-occurrence],[data-outline-input],[data-outline-root-editor]") !== event.currentTarget) return;
              if (target.closest("[data-outline-bullet],button[data-row-focusable]")) {
                // Changing strip height during mousedown moves the control before mouseup.
                // Programmatic ancestor opening belongs to the pending focus request.
                if (event.nativeEvent.isTrusted) owner.set({anchor: null, keys: [], target: null});
              } else if (!target.closest('a,button,input,textarea,select,[contenteditable="true"]')) select(key, event.shiftKey);
            },
            onCopy: event => { if (event.target === event.currentTarget && owner.state.keys.includes(key)) { event.preventDefault(); writeOutlineClipboard(event.clipboardData, clipboardItems()); } },
            onCut: event => { if (event.target === event.currentTarget && owner.state.keys.includes(key) && !filter.trim()) { event.preventDefault(); writeOutlineClipboard(event.clipboardData, clipboardItems()); remove(selectedRows()); } },
            onPaste: event => { if (event.target !== event.currentTarget || filter.trim()) return; event.preventDefault(); try { const items = readOutlineClipboard(event.clipboardData); run(async () => { const refs = await history.paste(rootRef, link.link_id, items, prelude); if (refs[0]) await focusResource(refs[0]); }); } catch (error) { setError(error); } },
            onKeyDown: event => {
              if (filter.trim() || event.defaultPrevented || event.nativeEvent.isComposing || event.target !== event.currentTarget) return;
              const structural = outlineStructuralCommand(event, platform);
              if (structural) { event.preventDefault(); arrange(entry, structural); return; }
              const historyCommand = outlineHistoryCommand(event, platform);
              if (historyCommand) {event.preventDefault(); if (!owner.transition.current) {if (historyCommand === "redo") history.redo(); else history.undo();} return;}
              if (event.key === "Escape") { event.preventDefault(); owner.set({anchor: null, keys: [], target: null}); event.currentTarget.querySelector<HTMLElement>("[data-outline-bullet]")?.focus(); return; }
              if (event.key === " ") { event.preventDefault(); select(key); return; }
              if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); const order = visible(), at = order.findIndex(element => element.dataset.outlineOccurrence === key), next = order[at + (event.key === "ArrowUp" ? -1 : 1)]; if (next) select(next.dataset.outlineOccurrence!, event.shiftKey); return; }
              if (!owner.state.keys.includes(key) || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
              if (event.key === "Backspace" || event.key === "Delete") { event.preventDefault(); remove(selectedRows()); }
              else if (event.key === "Enter") { event.preventDefault(); if (!owner.transition.current) { owner.transition.current = true; const pending: PendingNote = {id: crypto.randomUUID(), admission: history!.admit(), after: link.link_id, body: emptyBody(), before: owner.capture(), split: null, source: null, join: null, created: null}; pendingDraft.current = pending; flushSync(() => { setDraft(pending); owner.set(current => ({...current, anchor: null, keys: [], target: `${occurrencePrefix}/input`})); }); } }
            }}}/>
      })}
    </ResourceOutlineList>
    {read.data?.next_cursor && !trailingAdmission ? <div ref={moreItems}><Button onClick={read.more}>show more items</Button></div> : read.data !== null && !filter.trim() && !draft ? renderDraft(null) : null}
  </div></HistoryContext></SessionContext>;
}
