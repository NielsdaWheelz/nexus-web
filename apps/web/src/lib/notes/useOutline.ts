"use client";

// One outline pane's session over the tab-wide outline graph. The graph is module
// state shared by every outline pane (a note shown twice shows one state, and a pane
// that unmounts mid-queue loses nothing); each pane owns its view (zoom, folds,
// selection, focus request) and its undo history: one list of text items (from the row
// editors) and structure items. A structure edit applies at once, is sent as one write
// and records its inverse; undoing it sends the inverse. Replies are adopted once no
// structure write is pending. A refused write cancels the structure writes queued
// after it, reloads every loaded outline, resets the texts those writes carried, clears
// every pane's history and reports the refusal.
import { useCallback, useEffect, useReducer, useRef, useState, useLayoutEffect } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import { apiFetch, isApiError, isSameSystemApiDefect, isStaleBuild, type ApiPath } from "@/lib/api/client";
import { publishChange, useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { docFromBody, emptyBody, parseBody, type NoteBody } from "@/lib/notes/noteBody";
import * as model from "@/lib/notes/outline";
import * as store from "@/lib/notes/texts";
import { enqueueWrite } from "@/lib/notes/writes";
import { isDeletedResource, subscribeLinkMutations } from "@/lib/resourceGraph/links";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";
import { resolveResourceItem } from "@/lib/resources/items";

const OUTLINE_VIEW = definePaneVisitDataKey<model.View>("Notes.OutlineView");

type Reply = Schema<"OutlineCommandsOut">;

// ---- the tab-wide graph ------------------------------------------------------------

const graph: model.Graph = new Map();
const latest = new Map<string, model.OutlineData>();
const loading = new Map<string, Promise<void>>();
const reloadAfterFlight = new Set<string>();
const loadErrors = new Map<string, unknown>();
const listeners = new Set<(invalidated: ReadonlySet<string> | null) => void>();
/** The texts and resource dependencies of each unsettled structure write. */
const carried = new Map<number, { texts: ReadonlySet<string>; refs: ReadonlySet<string> }>();
let observingLinks = false;
let pendingStructure = 0;
let jobSerial = 0;
let cancelledBefore = 0;
let refusals = 0;
let reportRefusal: (error: unknown) => void = () => undefined;

function publish(invalidated: ReadonlySet<string> | null = null) {
  for (const listener of listeners) listener(invalidated);
}

function liveOutline(outline: model.OutlineData): model.OutlineData | null {
  if (isDeletedResource(outline.source.item.ref)) return null;
  return { ...outline, links: outline.links.filter((link) => !isDeletedResource(link.target.item.ref)) };
}

/** The retained graph outlives its panes, so its invalidation subscription does too. */
function observeLinks() {
  if (observingLinks) return;
  observingLinks = true;
  subscribeLinkMutations((mutation) => {
    if (mutation.kind === "resource_deleted") {
      store.setGone(mutation.ref);
      for (const entries of [graph, latest]) {
        for (const [ref, outline] of entries) {
          const live = liveOutline(outline);
          if (live) entries.set(ref, live);
          else entries.delete(ref);
        }
      }
      publish(new Set([mutation.ref]));
      return;
    }
    const refs = mutation.kind === "created" || mutation.kind === "context_detached"
      ? [mutation.sourceRef, mutation.targetRef].filter((ref) => graph.has(ref))
      : [...graph].flatMap(([ref, outline]) => outline.links.some((link) => link.link_id === mutation.linkId) ? [ref] : []);
    for (const ref of refs) void load(ref, true).catch(() => undefined);
  });
}

function adopt(outline: model.OutlineData) {
  const live = liveOutline(outline);
  if (!live) {
    graph.delete(outline.source.item.ref);
    store.setGone(outline.source.item.ref);
    return;
  }
  graph.set(live.source.item.ref, live);
  for (const node of [live.source, ...live.links.map((l) => l.target)]) {
    const body = bodyOf(node);
    if (body && node.content.kind === "note")
      store.adoptText(node.item.ref, body, node.content.body_version);
    else if (node.content.kind === "page" && node === live.source)
      store.adoptText(node.item.ref, node.content.title, node.content.title_version);
  }
}

/** Keep a reply's outlines until no structure write is pending, then adopt them all. */
function receive(outlines: readonly model.OutlineData[]) {
  for (const outline of outlines) {
    const live = liveOutline(outline);
    if (live) latest.set(live.source.item.ref, live);
    else latest.delete(outline.source.item.ref);
  }
  if (pendingStructure > 0) return;
  for (const outline of latest.values()) adopt(outline);
  latest.clear();
}

/** Read `ref`'s outline (again when `force`); a loaded outline keeps its optimistic
 * state while structure writes are pending. */
function load(ref: string, force = false): Promise<void> {
  if (isDeletedResource(ref)) return Promise.resolve();
  if (!force && graph.has(ref)) return Promise.resolve();
  const inflight = loading.get(ref);
  if (inflight) {
    if (force) reloadAfterFlight.add(ref);
    return inflight;
  }
  const path = `/api/notes/outline/${encodeURIComponent(ref)}` as ApiPath;
  const request = apiFetch<ApiJson<"/notes/outline/{ref}", "get">>(path, {
    cache: "no-store",
  })
    .then(({ data }) => {
      loadErrors.delete(ref);
      if (!graph.has(ref) || pendingStructure === 0) adopt(data);
    })
    .catch((error: unknown) => { loadErrors.set(ref, error); throw error; })
    .finally(() => {
      loading.delete(ref);
      publish();
      if (reloadAfterFlight.delete(ref)) void load(ref, true).catch(() => undefined);
    });
  loading.set(ref, request);
  publish();
  return request;
}

function bodyOf(node: model.OutlineNode): NoteBody | null {
  if (node.content.kind !== "note") return null;
  const { body_pm_json, body_text } = node.content;
  return { body_pm_json, body_text };
}

const textBody = (noteId: string): NoteBody => {
  const value = store.readText(model.noteRef(noteId))?.value;
  return typeof value === "object" ? value : emptyBody();
};

const version = (ref: string) => store.readText(ref)?.acked?.version ?? 1;

/** Capture link targets before an optimistic edit can remove or move them. */
function editReferences(edits: readonly model.Edit[]): Set<string> {
  const refs = new Set<string>();
  for (const edit of edits) {
    if (edit.kind === "set_body" || edit.kind === "insert_note") refs.add(model.noteRef(edit.note_id));
    if (edit.kind === "set_title") refs.add(`page:${edit.page_id}`);
    if (edit.kind === "insert_resource") refs.add(edit.target);
    if (edit.kind === "relink") refs.add(edit.destination);
    if (!("endpoint" in edit)) continue;
    refs.add(edit.endpoint);
    const target = graph.get(edit.endpoint)?.links.find((link) => link.link_id === edit.link_id)?.target.item.ref;
    if (target) refs.add(target);
    if ("after" in edit && edit.after !== null) {
      const endpoint = edit.kind === "relink" ? edit.destination : edit.endpoint;
      const preceding = graph.get(endpoint)?.links.find((link) => link.link_id === edit.after)?.target.item.ref;
      if (preceding) refs.add(preceding);
    }
  }
  return refs;
}

/**
 * Send one structure batch. Expected versions are read when it is sent, after every
 * earlier write settled; `removed` names the note each remove's link pointed at.
 */
function sendEdits(
  edits: readonly model.Edit[],
  removed: ReadonlyMap<string, string>,
  texts: ReadonlySet<string>,
  refs: ReadonlySet<string>,
) {
  const serial = ++jobSerial;
  pendingStructure += 1;
  carried.set(serial, { texts, refs });
  enqueueWrite<Reply>({
    build() {
      if (serial <= cancelledBefore) return null;
      if ([...refs].some(isDeletedResource)) {
        refuse(null, serial, "affected");
        return null;
      }
      const commands = edits.map((edit) => {
        if (edit.kind === "set_body")
          return { ...edit, expected_version: version(model.noteRef(edit.note_id)) };
        if (edit.kind !== "remove") return edit;
        const note = removed.get(edit.link_id);
        const expected_body_version = note ? (store.readText(note)?.acked?.version ?? null) : null;
        return { ...edit, expected_body_version };
      });
      return { path: "/api/notes/outline/commands", method: "POST", body: { commands } };
    },
    settle(reply) {
      pendingStructure -= 1;
      carried.delete(serial);
      acknowledge(reply, edits);
      receive(reply.outlines);
      publishChange("Notes");
      publish();
    },
    fail(error) {
      if (!handleUnauthenticatedApiError(error)) refuse(error, serial);
    },
  });
}

/** The bodies a reply confirms: those it wrote, and the notes it inserted (a note an
 * undo recreated starts again at the server's version). A note it deleted stops saving
 * unless a later write recreates it (an undo). Titles save on their own (texts). */
function acknowledge(reply: Reply, edits: readonly model.Edit[]) {
  const later = [...carried.values()];
  for (const ref of reply.deleted) if (!later.some((entry) => entry.texts.has(ref))) store.setGone(ref);
  const inserted = new Set(
    edits.flatMap((e) => (e.kind === "insert_note" ? [model.noteRef(e.note_id)] : [])),
  );
  const targets = reply.outlines.flatMap((outline) => outline.links.map((l) => l.target));
  for (const node of [...reply.nodes, ...targets.filter((t) => inserted.has(t.item.ref))]) {
    if (isDeletedResource(node.item.ref)) continue;
    const body = bodyOf(node);
    if (body && node.content.kind === "note")
      store.acknowledgeText(node.item.ref, body, node.content.body_version);
  }
}

/** Cancel this write and every queued structure write; reload; reset their texts. */
function refuse(error: unknown, serial: number, history: "all" | "affected" = "all") {
  const texts = new Set<string>();
  const refs = new Set<string>();
  for (const [at, entry] of carried) {
    if (at < serial) continue;
    entry.texts.forEach((ref) => texts.add(ref));
    entry.refs.forEach((ref) => refs.add(ref));
  }
  carried.clear();
  cancelledBefore = jobSerial;
  pendingStructure = 0;
  if (history === "all") refusals += 1;
  latest.clear();
  for (const ref of texts) store.resetText(ref);
  for (const ref of graph.keys()) void load(ref, true).catch(() => undefined);
  reportRefusal(error);
  publish(history === "affected" ? refs : null);
}

// ---- one pane ---------------------------------------------------------------------

export type Selection =
  | { kind: "text"; key: string; anchor: number; head: number }
  | { kind: "blocks"; anchor: string; keys: readonly string[] }
  | null;

export type InsertAt = "start" | "end" | { afterRowKey: string };

const blocksInsertion = (error: unknown): boolean =>
  isStaleBuild(error) || (isApiError(error) && (error.status === 403 || error.status === 404));

export interface NoteEdit {
  before: NoteBody;
  after: NoteBody;
  selectionBefore: { anchor: number; head: number };
  selectionAfter: { anchor: number; head: number };
  source: "input" | "composition" | "paste" | "format" | "attachment";
}

type Item = { selBefore: Selection; selAfter: Selection } & (
  | { kind: "text"; ref: string; before: NoteBody; after: NoteBody; at: number }
  | { kind: "structure"; forward: readonly model.Edit[]; inverse: readonly model.Edit[]; refs: ReadonlySet<string> }
);

export type FocusSelection = { anchor: number; head: number } | "end";
export interface FocusRequest {
  readonly key: string;
  readonly selection: FocusSelection;
  readonly serial: number;
}

/** One pane's outline session: what `useOutline` returns. */
export type Outline = ReturnType<typeof useOutline>;

/** A latent day's one draft row: a link and note under client ids. */
interface Draft {
  readonly date: string;
  readonly page: string;
  readonly link: string;
  readonly note: string;
}

/** The writes that make a latent day: its page, then its draft row as it stands. */
function materialize(draft: Draft): model.Edit[] {
  return [
    { kind: "ensure_daily", local_date: draft.date },
    {
      kind: "insert_note",
      endpoint: draft.page,
      link_id: draft.link,
      note_id: draft.note,
      after: null,
      body_pm_json: textBody(draft.note).body_pm_json,
    },
  ];
}

/** Show the draft row of a latent day with no links; its first non-empty save sends
 * `materialize`, and its reply makes the day. */
function showDraft(draft: Draft, onMade: () => void) {
  const outline = graph.get(draft.page)!;
  if (outline.links.length) return;
  const node = model.newNoteNode(draft.note, emptyBody());
  const link = { link_id: draft.link, has_link_note: false, target: node };
  graph.set(draft.page, { ...outline, links: [link] });
  graph.set(node.item.ref, { source: node, links: [{ ...link, target: outline.source }] });
  store.createText(node.item.ref, emptyBody(), {
    request: () => ({
      path: "/api/notes/outline/commands",
      method: "POST",
      body: { commands: materialize(draft) },
    }),
    settle(reply) {
      // justify-type-assertion: the commands route answers OutlineCommandsOut.
      const { outlines } = reply as Reply;
      receive(outlines);
      onMade();
      publishChange("Notes");
      publish();
      const made = outlines.flatMap((o) => o.links).find((l) => l.target.item.ref === node.item.ref);
      return made?.target.content.kind === "note" ? made.target.content.body_version : 1;
    },
  });
}

/** A page (`root`) or a day (`dailyDate`, latent until its first write). */
export function useOutline(input: { root: string | null; dailyDate: string | null }) {
  const { dailyDate } = input;
  const visitId = usePaneRuntime()?.visitId;
  const feedback = useFeedback();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [latentDate, setLatentDate] = useState<string | null>(null);
  const latent = dailyDate !== null && latentDate === dailyDate;
  const previewStamp = useChangeStamp("Notes", "Metadata");
  const observedPreviewStamp = useRef(previewStamp);
  const [selection, setSelection] = useState<Selection>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const capture = useRef<model.View | null>(null);
  const saved = usePaneVisitData(OUTLINE_VIEW, useCallback(() => capture.current, []));
  const writeView = usePaneVisitDataWriter(OUTLINE_VIEW);
  const view = useRef({ visitId, folds: new Map(saved?.folds ?? []), zoom: [...(saved?.zoom ?? [])] });
  if (view.current.visitId !== visitId) {
    view.current = { visitId, folds: new Map(saved?.folds ?? []), zoom: [...(saved?.zoom ?? [])] };
    setSelection(null);
    setFocus(null);
  }
  useLayoutEffect(() => {
    const snapshot = { folds: new Map(view.current.folds), zoom: [...view.current.zoom] };
    capture.current = snapshot;
    writeView(snapshot);
  });
  const history = useRef({ items: [] as Item[], index: 0, refusals });
  const boundaryNext = useRef(true);
  const draft = useRef<Draft | null>(null);
  const resolved = useRef(new Map<string, model.OutlineNode>());

  const loadVisibleOutline = useCallback((ref: string, force: boolean): Promise<void> => {
    const owned = draft.current?.date === dailyDate ? draft.current : null;
    const draftRef = owned ? model.noteRef(owned.note) : null;
    const textRef = ref === owned?.page ? draftRef : ref;
    // local outlines exist before their resources do. reads resume on acknowledgement,
    // not queue submission; refusal recovery deliberately uses `load` directly.
    if (graph.has(ref) && textRef && store.readText(textRef)?.acked === null && (
      (latent && (ref === owned?.page || ref === draftRef)) ||
      [...carried.values()].some((entry) => entry.texts.has(textRef))
    )) return Promise.resolve();
    return load(ref, force);
  }, [dailyDate, latent]);

  const read = usePaneFreeServerValue({
    key: dailyDate ? `outline:daily:${dailyDate}` : input.root ? `outline:${input.root}` : null,
    stale: String(refusals),
    load: async (signal) => {
      if (dailyDate) {
        const path = `/api/notes/daily/${dailyDate}` as ApiPath;
        const { data } = await apiFetch<ApiJson<"/notes/daily/{local_date}", "get">>(path, {
          cache: "no-store",
          signal,
        });
        signal.throwIfAborted();
        const page = data.outline.source.item.ref;
        if (!graph.has(page) || pendingStructure === 0) adopt(data.outline);
        setLatentDate(data.materialized ? null : dailyDate);
        if (!data.materialized) {
          if (draft.current?.date !== dailyDate) {
            draft.current = {
              date: dailyDate,
              page,
              link: crypto.randomUUID(),
              note: crypto.randomUUID(),
            };
          }
          showDraft(draft.current, () => setLatentDate((current) => current === dailyDate ? null : current));
        }
        publish();
        return page;
      }
      // justify-defect: an outline read key is either a daily date or a root ref.
      if (input.root === null) throw new Error("Outline read requires a root");
      await loadVisibleOutline(input.root, true);
      signal.throwIfAborted();
      return input.root;
    },
  });
  const root = input.root ?? (read.status === "ready" ? read.data : null);
  const failure = read.status === "loading" ? null : read.error;
  // pane-entry commands wait for the refreshed outline; retained editors stay mounted.
  const status = failure !== null ? "failed" : read.status === "ready" && read.refreshing ? "loading" : read.status;
  const retrying = read.status === "failed" ? read.retrying : read.status === "ready" && read.refreshing;

  useEffect(() => {
    observeLinks();
    const changed = (invalidated: ReadonlySet<string> | null) => {
      if (invalidated && history.current.items.some((item) =>
        item.kind === "text" ? invalidated.has(item.ref) : [...item.refs].some((ref) => invalidated.has(ref)),
      )) {
        history.current = { items: [], index: 0, refusals };
        boundaryNext.current = true;
      }
      if (root) {
        while (view.current.zoom.length && model.zoomEndpoint(graph, root, view.current.zoom) === null)
          view.current.zoom = view.current.zoom.slice(0, -1);
      }
      rerender();
    };
    listeners.add(changed);
    return () => void listeners.delete(changed);
  }, [root]);
  if (history.current.refusals !== refusals)
    history.current = { items: [], index: 0, refusals };

  useEffect(() => {
    // The known refusal stays available: the change, and any text typed into rows it made, is gone.
    reportRefusal = (error) =>
      feedback.offer({ key: "notes-outline-refused", announcement: "Assertive", content: {
          tone: "Danger",
          title: "That change couldn’t be saved",
          message: "later queued outline changes were stopped. a reload was requested.",
          requestId: (error as { requestId?: string } | null)?.requestId,
        } });
  }, [feedback]);

  useEffect(() => {
    if (observedPreviewStamp.current === previewStamp) return;
    observedPreviewStamp.current = previewStamp;
    if (!root || latent) return;
    // Refresh each visible owner once; shared text adoption preserves unsaved drafts.
    const refs = new Set([root, model.zoomEndpoint(graph, root, view.current.zoom) ?? root, ...model.outlineRows(graph, root, view.current)
      .filter((row) => row.open).map((row) => row.link.target.item.ref)]);
    for (const ref of refs) void loadVisibleOutline(ref, true).catch(() => undefined);
  }, [previewStamp, root, latent, loadVisibleOutline]);

  const rows = root && graph.has(root) ? model.outlineRows(graph, root, view.current) : [];
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  const endpoint = (root && model.zoomEndpoint(graph, root, view.current.zoom)) ?? root ?? "";

  function insertionPosition(at: InsertAt, occurrences: ReadonlyMap<string, model.Row>) {
    if (!root || !graph.has(root) || isDeletedResource(root) || blocksInsertion(failure) ||
      blocksInsertion(loadErrors.get(root))) return null;
    const current = model.zoomEndpoint(graph, root, view.current.zoom);
    if (!current || !graph.has(current) || isDeletedResource(current) || blocksInsertion(loadErrors.get(current)))
      return null;
    const row = typeof at === "object" ? occurrences.get(at.afterRowKey) : null;
    if (typeof at === "object" && !row) return null;
    const target = row?.endpoint ?? current;
    const outline = graph.get(target);
    if (!outline || isDeletedResource(target) || blocksInsertion(loadErrors.get(target))) return null;
    if (row && (!outline.links.some((link) => link.link_id === row.link.link_id) ||
      model.zoomEndpoint(graph, root, row.path.slice(0, -1)) !== target)) return null;
    return {
      endpoint: target,
      after: row ? row.link.link_id : at === "start" ? null : outline.links.at(-1)?.link_id ?? null,
      parentPath: row ? row.path.slice(0, -1) : view.current.zoom,
      row,
    };
  }

  const focusRow = useCallback((key: string, at: FocusSelection = "end") => {
    setFocus((current) => ({ key, selection: at, serial: (current?.serial ?? 0) + 1 }));
    setSelection(null);
  }, []);

  /** Apply, send and (unless replaying history) record one structure batch. */
  function commit(edits: readonly model.Edit[], after: Selection, record = true, before = selection) {
    if (!edits.length) return;
    const refs = editReferences(edits);
    if ([...refs].some(isDeletedResource)) {
      feedback.offer({ key: "outline-write", announcement: "Polite", content: { tone: "Neutral", title: "a note used by this change was deleted" } });
      return;
    }
    const removed = new Map<string, string>();
    for (const edit of edits) {
      if (edit.kind !== "remove") continue;
      const link = graph.get(edit.endpoint)?.links.find((l) => l.link_id === edit.link_id);
      if (link?.target.content.kind === "note") removed.set(edit.link_id, link.target.item.ref);
    }
    const inverse = model.applyEdits(graph, edits, textBody, (ref) => resolved.current.get(ref) ?? null);
    const texts = new Set<string>();
    for (const edit of edits) {
      if (edit.kind === "set_body" || edit.kind === "insert_note") {
        const ref = model.noteRef(edit.note_id);
        const body = parseBody(edit.body_pm_json);
        if (edit.kind === "set_body") store.carryText(ref, body);
        else store.createText(ref, body, null);
        texts.add(ref);
      }
    }
    const made = latent ? draft.current : null;
    if (made) {
      const ref = model.noteRef(made.note);
      store.createText(ref, textBody(made.note), null);
      texts.add(ref);
    }
    const commands = made ? [...materialize(made), ...edits] : edits;
    if (made) editReferences(commands).forEach((ref) => refs.add(ref));
    sendEdits(commands, removed, texts, refs);
    if (made) setLatentDate(null);
    if (record) {
      const items = history.current.items.slice(0, history.current.index);
      items.push({ kind: "structure", forward: edits, inverse,
        refs: new Set([...refs, ...editReferences(inverse)]), selBefore: before, selAfter: after });
      history.current = { ...history.current, items, index: items.length };
    }
    boundaryNext.current = true;
    publish();
  }

  /** Move the caret (or the block selection) to the row a structure edit made. */
  function follow(key: string, at: FocusSelection = { anchor: 1, head: 1 }) {
    if (selection?.kind === "blocks") setSelection({ kind: "blocks", anchor: key, keys: [key] });
    else focusRow(key, at);
  }
  const landing = (key: string): Selection =>
    selection?.kind === "blocks"
      ? { kind: "blocks", anchor: key, keys: [key] }
      : { kind: "text", key, anchor: 1, head: 1 };

  function step(redo: boolean) {
    const { items, index } = history.current;
    const item = redo ? items[index] : items[index - 1];
    if (!item) return;
    history.current = { ...history.current, index: index + (redo ? 1 : -1) };
    const sel = redo ? item.selAfter : item.selBefore;
    if (item.kind === "text") store.replaceText(item.ref, redo ? item.after : item.before);
    else commit(redo ? item.forward : item.inverse, sel, false);
    if (sel?.kind === "text") focusRow(sel.key, { anchor: sel.anchor, head: sel.head });
    else setSelection(sel);
    boundaryNext.current = true;
  }

  function removeRows(selected: readonly model.Row[]) {
    if (latent) return;
    const removable = selected.filter((row) => row.terminal === null && !row.link.has_link_note);
    if (!removable.length) return;
    const keys = new Set(removable.map((row) => row.key));
    const first = rows.findIndex((row) => keys.has(row.key));
    const previous = rows
      .slice(0, first)
      .reverse()
      .find((row) => model.isNoteRow(row) && !keys.has(row.key));
    const before = selection ?? { kind: "text", key: removable[0]!.key, anchor: 1, head: 1 };
    commit(model.removeEdits(removable), previous ? landing(previous.key) : null, true, before);
    if (previous) focusRow(previous.key);
    else setSelection(null);
  }

  for (const error of loadErrors.values()) if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  return {
    status,
    retrying,
    failure,
    root: root ? (graph.get(root) ?? null) : null,
    latent,
    rows,
    endpoint,
    zoomed: view.current.zoom.length > 0,
    selection,
    focus,
    loading: new Set(loading.keys()),
    loadErrors,
    retryBranch(ref: string) { void loadVisibleOutline(ref, true).catch(() => undefined); publish(); },
    childLinks(ref: string) { return graph.get(ref)?.links ?? []; },
    node(ref: string) {
      const loaded = graph.get(ref)?.source;
      if (loaded) return loaded;
      for (const value of graph.values()) {
        const node = value.links.find((link) => link.target.item.ref === ref)?.target;
        if (node) return node;
      }
      return null;
    },
    reload: read.refetch,
    select(key: string, extend = false) {
      if (extend && selection?.kind === "blocks") {
        const keys = rows.map((row) => row.key);
        const [a, b] = [keys.indexOf(selection.anchor), keys.indexOf(key)];
        const range = keys.slice(Math.min(a, b), Math.max(a, b) + 1);
        setSelection({ kind: "blocks", anchor: selection.anchor, keys: range });
      } else setSelection({ kind: "blocks", anchor: key, keys: [key] });
      boundaryNext.current = true;
    },
    clearSelection: () => setSelection(null),
    focusRow,
    toggle(row: model.Row) {
      view.current.folds.set(row.key, !row.open);
      if (!row.open) void loadVisibleOutline(row.link.target.item.ref, pendingStructure === 0).catch(() => undefined);
      rerender();
    },
    zoom(row: model.Row) {
      if (row.terminal === null) {
        void loadVisibleOutline(row.link.target.item.ref, pendingStructure === 0).catch(() => undefined);
        view.current.zoom = [...row.path];
        setSelection(null);
        focusRow("", "end");
        return rerender();
      }
      // Return to the ancestor already showing this target: unzoom, open its branch.
      view.current.zoom = [];
      const path = row.terminal ? row.terminal.split("/") : [];
      for (let depth = 1; depth < path.length; depth += 1)
        view.current.folds.set(path.slice(0, depth).join("/"), true);
      focusRow(row.terminal);
      rerender();
    },
    zoomOut() {
      view.current.zoom = view.current.zoom.slice(0, -1);
      setSelection(null);
      rerender();
    },
    editText(key: string, ref: string, edit: NoteEdit) {
      if (isDeletedResource(ref)) return;
      const { items, index } = history.current;
      const top = items[index - 1];
      const now = Date.now();
      const selAfter: Selection = { kind: "text", key, ...edit.selectionAfter };
      if (
        !boundaryNext.current &&
        edit.source === "input" &&
        top?.kind === "text" &&
        top.ref === ref &&
        now - top.at < 1000
      ) {
        Object.assign(top, { after: edit.after, at: now, selAfter });
      } else {
        const next = items.slice(0, index);
        const selBefore: Selection = { kind: "text", key, ...edit.selectionBefore };
        next.push({ kind: "text", ref, before: edit.before, after: edit.after, at: now, selBefore, selAfter });
        history.current = { ...history.current, items: next, index: next.length };
      }
      boundaryNext.current = edit.source !== "input";
      store.editText(ref, edit.after);
    },
    boundary: () => void (boundaryNext.current = true),
    undo: () => step(false),
    redo: () => step(true),
    split(row: model.Row, left: NoteBody, right: NoteBody) {
      if (!model.isNoteRow(row)) return;
      const { edits, key } = model.splitEdits(row, left, right);
      const end = docFromBody(left).firstChild!.content.size + 1;
      const before: Selection = { kind: "text", key: row.key, anchor: end, head: end };
      commit(edits, { kind: "text", key, anchor: 1, head: 1 }, true, before);
      focusRow(key, { anchor: 1, head: 1 });
    },
    join(row: model.Row, direction: "backward" | "forward") {
      if (latent) return;
      const joined = model.joinEdits(graph, rows, row, direction, textBody);
      if (!joined) return;
      if ("refused" in joined)
        return feedback.offer({ key: "outline-write", announcement: "Polite", content: { tone: "Neutral", title: joined.refused } });
      const at = { anchor: joined.caret, head: joined.caret };
      const before: Selection = { kind: "text", key: row.key, anchor: 1, head: 1 };
      commit(joined.edits, { kind: "text", key: joined.earlier.key, ...at }, true, before);
      focusRow(joined.earlier.key, at);
    },
    /** `at` is the row editor's selection, kept across the move. */
    indent(row: model.Row, at: FocusSelection = "end") {
      const parent = model.indentParent(rows, row);
      if (!parent || !model.isNoteRow(row) || !root) return;
      void load(parent.link.target.item.ref).then(() => {
        const fresh = model.outlineRows(graph, root, view.current);
        const current = fresh.find((r) => r.key === row.key);
        const edits = current ? model.indentEdits(graph, fresh, current) : null;
        if (!edits || edits[0]?.kind !== "relink") return;
        view.current.folds.set(parent.key, true);
        const key = [...parent.path, edits[0].new_link_id].join("/");
        commit(edits, landing(key));
        follow(key, at);
      }, () => undefined);
    },
    outdent(row: model.Row, at: FocusSelection = "end") {
      const edits = root ? model.outdentEdits(graph, root, row) : null;
      if (!edits || edits[0]?.kind !== "relink") return;
      const key = [...row.path.slice(0, -2), edits[0].new_link_id].join("/");
      commit(edits, landing(key));
      follow(key, at);
    },
    move(row: model.Row, direction: -1 | 1) {
      const edits = model.moveEdits(graph, row, direction);
      if (edits) commit(edits, selection);
    },
    remove: removeRows,
    canInsert(at: InsertAt) { return insertionPosition(at, rowsByKey) !== null; },
    /** insert at the resolved occurrence; only a latent page's start/end focuses its draft. */
    insert(at: InsertAt) {
      const fresh = root ? model.outlineRows(graph, root, view.current) : [];
      const position = insertionPosition(at, new Map(fresh.map((row) => [row.key, row])));
      if (!position) return;
      if (typeof at === "string" && latent && draft.current?.page === position.endpoint)
        return focusRow(draft.current.link);
      const link_id = crypto.randomUUID();
      const key = [...position.parentPath, link_id].join("/");
      const body_pm_json = emptyBody().body_pm_json;
      const note_id = crypto.randomUUID();
      const before: Selection = selection ?? (position.row
        ? { kind: "blocks", anchor: position.row.key, keys: [position.row.key] }
        : { kind: "text", key: "", anchor: 1, head: 1 });
      commit(
        [{ kind: "insert_note", endpoint: position.endpoint, link_id, note_id, after: position.after, body_pm_json }],
        { kind: "text", key, anchor: 1, head: 1 },
        true,
        before,
      );
      focusRow(key, { anchor: 1, head: 1 });
    },
    drop(row: model.Row, target: model.Row, placement: "before" | "after" | "inside") {
      const destination = placement === "inside" ? target.link.target.item.ref : target.endpoint;
      void load(destination).then(() => {
        const edits = model.dropEdits(graph, row, target, placement);
        if (!edits) return;
        if (placement === "inside") view.current.folds.set(target.key, true);
        commit(edits, selection);
      }, () => undefined);
    },
    copy(clipboard: DataTransfer, cut: boolean) {
      if (selection?.kind !== "blocks") return;
      const selected = rows.filter((row) => selection.keys.includes(row.key));
      model.copyRows(selected, textBody, clipboard);
      if (cut) removeRows(selected);
    },
    paste(clipboard: DataTransfer) {
      if (selection?.kind !== "blocks") return false;
      const items = model.readClipboard(clipboard);
      const last = rows.find((row) => row.key === selection.keys.at(-1));
      if (!items || !last) return false;
      const edits = model.pasteEdits(graph, items, last.endpoint, last.link.link_id);
      const refs = items.flatMap((item) => (item.kind === "resource" ? [item.ref] : []));
      void Promise.all(refs.map((ref) => resolveResourceItem(ref))).then(
        (found) => {
          for (const item of found)
            resolved.current.set(item.ref, { item, content: { kind: "resource" } });
          commit(edits, selection);
        },
        (error: unknown) => {
          if (handleUnauthenticatedApiError(error)) return;
          const content = { tone: "Warning", title: "Paste not applied", message: "A copied item couldn’t be found." } as const;
          feedback.offer({ key: "outline-write", announcement: "Polite", content });
        },
      );
      return true;
    },
    setTitle(title: string) {
      if (!root) return;
      if (latent && draft.current) {
        const ref = model.noteRef(draft.current.note);
        const commands = materialize(draft.current);
        store.createText(ref, textBody(draft.current.note), null);
        sendEdits(commands, new Map(), new Set([ref]), editReferences(commands));
        setLatentDate(null);
      }
      store.editText(root, title);
    },
  };
}
