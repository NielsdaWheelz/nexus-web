"use client";

// One outline pane's session over the tab-wide outline graph. The graph is module
// state shared by every outline pane (a note shown twice shows one state, and a pane
// that unmounts mid-queue loses nothing); each pane owns its view (zoom, folds,
// selection, focus request) and its undo history: one list of text items (from the row
// editors), structural edits and creations. Structure applies optimistically; pure
// creation undo instead unlinks its exact edges and redo links the retained resources.
// Generic unlink has no undo, retains pending rows until acknowledgement, and fences
// old reads before retiring dependent history in every mounted pane. It carries no
// text. Unlink requests contain only exact ids and retry unchanged; creation undo
// additionally refuses annotated edges atomically. Structure replies are adopted
// once no structure write is pending. A refused write cancels the structure writes queued
// after it, reloads every loaded outline, resets the texts those writes carried, clears
// every pane's history and reports the refusal.
import { useCallback, useEffect, useReducer, useRef, useState, useLayoutEffect } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import { assertNever } from "@/lib/assertNever";
import { apiFetch, isApiError, isSameSystemApiDefect, isStaleBuild, STALE_BUILD_COPY, type ApiPath } from "@/lib/api/client";
import { publishChange, useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { docFromBody, emptyBody, parseBody, type NoteBody } from "@/lib/notes/noteBody";
import * as model from "@/lib/notes/outline";
import * as store from "@/lib/notes/texts";
import { enqueueWrite } from "@/lib/notes/writes";
import { announceLinkDeletions, isDeletedResource, subscribeLinkMutations } from "@/lib/resourceGraph/links";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";
import { resolveResourceItem } from "@/lib/resources/items";
import type { OutlineTarget } from "@/lib/resources/outlineProjection";

const OUTLINE_VIEW = definePaneVisitDataKey<model.View>("Notes.OutlineView");

type Reply = Schema<"OutlineCommandsOut">;

// ---- the tab-wide graph ------------------------------------------------------------

const graph: model.Graph = new Map();
const latest = new Map<string, model.OutlineData>();
const loading = new Map<string, Promise<void>>();
const reloadAfterFlight = new Set<string>();
const readGenerations = new Map<string, number>();
let readSerial = 0;
const loadErrors = new Map<string, unknown>();
type Invalidation =
  | { kind: "resources"; refs: ReadonlySet<string> }
  | { kind: "links"; ids: ReadonlySet<string>; preserve: Item | null };
const listeners = new Set<(invalidated: Invalidation | null) => void>();
const pendingUnlinks = new Set<string>();
/** The texts and resource dependencies of each unsettled structure write. */
const carried = new Map<number, { texts: ReadonlySet<string>; refs: ReadonlySet<string> }>();
let observingLinks = false;
let pendingStructure = 0;
let jobSerial = 0;
let cancelledBefore = 0;
let refusals = 0;
let reportRefusal: (error: unknown) => void = () => undefined;

function publish(invalidated: Invalidation | null = null) {
  const defects: unknown[] = [];
  for (const listener of listeners) {
    try { listener(invalidated); } catch (error) { defects.push(error); }
  }
  if (defects.length) queueMicrotask(() => { throw new AggregateError(defects, "outline observers failed"); });
}

/** Snapshot both endpoints before removal; refresh only owners already loaded here. */
function linkedOutlines(ids: ReadonlySet<string>): { refs: Set<string>; endpoints: Set<string> } {
  const refs = new Set<string>();
  const endpoints = new Set<string>();
  for (const entries of [graph, latest]) {
    for (const [ref, outline] of entries) {
      for (const link of outline.links) {
        if (!ids.has(link.link_id)) continue;
        endpoints.add(ref);
        endpoints.add(link.target.item.ref);
        refs.add(ref);
        if (graph.has(link.target.item.ref) || latest.has(link.target.item.ref)) refs.add(link.target.item.ref);
      }
    }
  }
  return { refs, endpoints };
}

/** An acknowledged edge removal invalidates old reads and their retained replies. */
function dropLinks(ids: ReadonlySet<string>, endpoints: ReadonlySet<string>) {
  for (const ref of endpoints) readGenerations.set(ref, ++readSerial);
  for (const entries of [graph, latest]) {
    for (const [ref, outline] of entries) {
      if (outline.links.some((link) => ids.has(link.link_id)))
        entries.set(ref, { ...outline, links: outline.links.filter((link) => !ids.has(link.link_id)) });
    }
  }
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
      publish({ kind: "resources", refs: new Set([mutation.ref]) });
      return;
    }
    if (mutation.kind === "deleted") {
      if (mutation.origin === graph) return;
      const ids = new Set([mutation.linkId]);
      const { refs, endpoints } = linkedOutlines(ids);
      dropLinks(ids, endpoints);
      publish({ kind: "links", ids, preserve: null });
      for (const ref of refs) void load(ref, true).catch(() => undefined);
      return;
    }
    if (mutation.kind === "created" || mutation.kind === "context_detached") {
      const refs = [mutation.sourceRef, mutation.targetRef].filter((ref) => graph.has(ref));
      for (const ref of refs) void load(ref, true).catch(() => undefined);
      return;
    }
    assertNever(mutation);
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
  const generation = readGenerations.get(ref) ?? 0;
  const path = `/api/notes/outline/${encodeURIComponent(ref)}` as ApiPath;
  const request = apiFetch<ApiJson<"/notes/outline/{ref}", "get">>(path, {
    cache: "no-store",
  })
    .then(({ data }) => {
      if ((readGenerations.get(ref) ?? 0) !== generation) return;
      loadErrors.delete(ref);
      if (!graph.has(ref)) adopt(data);
      else receive([data]);
    })
    .catch((error: unknown) => {
      if ((readGenerations.get(ref) ?? 0) !== generation) return;
      loadErrors.set(ref, error);
      throw error;
    })
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
  const release = () => {
    if (carried.delete(serial)) pendingStructure -= 1;
  };
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
      release();
      acknowledge(reply, edits);
      receive(reply.outlines);
      publishChange("Notes");
      publish();
    },
    fail(error) {
      if (!handleUnauthenticatedApiError(error)) refuse(error, serial);
    },
    finalize() {
      release();
      receive([]);
      publish();
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
  publish(history === "affected" ? { kind: "resources", refs } : null);
}

// ---- one pane ---------------------------------------------------------------------

export type Selection =
  | { kind: "text"; key: string; anchor: number; head: number }
  | { kind: "blocks"; anchor: string; keys: readonly string[] }
  | null;

export type InsertAt = "start" | "end" | { afterRowKey: string };

const blocksInsertion = (error: unknown): boolean =>
  isStaleBuild(error) || (isApiError(error) && (error.status === 403 || error.status === 404));

/** History and graph refreshes cannot select an occurrence hidden by projection. */
function visibleSelection(selection: Selection, rows: readonly model.Row[]): Selection {
  if (selection === null) return null;
  if (selection.kind === "text")
    return selection.key === "" || rows.some((row) => row.key === selection.key && model.isNoteRow(row)) ? selection : null;
  const keys = selection.keys.filter((key) => rows.some((row) => row.key === key));
  if (!keys.length) return null;
  const anchor = keys.includes(selection.anchor) ? selection.anchor : keys[0]!;
  return keys.length === selection.keys.length && anchor === selection.anchor ? selection : { kind: "blocks", anchor, keys };
}

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
  | { kind: "creation"; forward: readonly Extract<model.Edit, { kind: "insert_resource" }>[]; inverse: readonly model.Unlink[]; refs: ReadonlySet<string> }
);
type History = { items: Item[]; index: number; refusals: number };

function linkDependencies(commands: readonly (model.Edit | model.Unlink)[]): Set<string> {
  const ids = new Set<string>();
  for (const command of commands) {
    if ("link_id" in command) ids.add(command.link_id);
    if ("new_link_id" in command) ids.add(command.new_link_id);
    if ("after" in command && command.after !== null) ids.add(command.after);
  }
  return ids;
}

function retainHistory(history: History, retain: (item: Item) => boolean): History {
  return {
    ...history,
    items: history.items.filter(retain),
    index: history.items.slice(0, history.index).filter(retain).length,
  };
}

export type FocusSelection = { anchor: number; head: number } | "end";
export interface FocusRequest {
  readonly key: string;
  readonly target: "text" | "control";
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
  const history = useRef<History>({ items: [], index: 0, refusals });
  const selectedNow = useRef(selection);
  selectedNow.current = selection;
  const interaction = useRef(0);
  const markInteraction = useCallback(() => { interaction.current += 1; }, []);
  const boundaryNext = useRef(true);
  const draft = useRef<Draft | null>(null);
  const resolved = useRef(new Map<string, model.OutlineNode>());

  const canRead = useCallback((ref: string): boolean => {
    const owned = draft.current?.date === dailyDate ? draft.current : null;
    const draftRef = owned ? model.noteRef(owned.note) : null;
    const textRef = ref === owned?.page ? draftRef : ref;
    // local outlines exist before their resources do. reads resume on acknowledgement,
    // not queue submission; refusal recovery deliberately uses `load` directly.
    return !(graph.has(ref) && textRef !== null && store.readText(textRef)?.acked === null && (
      (latent && (ref === owned?.page || ref === draftRef)) ||
      [...carried.values()].some((entry) => entry.texts.has(textRef))
    ));
  }, [dailyDate, latent]);
  const loadVisibleOutline = useCallback((ref: string, force: boolean): Promise<void> =>
    canRead(ref) ? load(ref, force) : Promise.resolve(), [canRead]);

  const read = usePaneFreeServerValue({
    key: dailyDate ? `outline:daily:${dailyDate}` : input.root ? `outline:${input.root}` : null,
    stale: String(refusals),
    load: async (signal) => {
      if (dailyDate) {
        const started = readSerial;
        const path = `/api/notes/daily/${dailyDate}` as ApiPath;
        const { data } = await apiFetch<ApiJson<"/notes/daily/{local_date}", "get">>(path, {
          cache: "no-store",
          signal,
        });
        signal.throwIfAborted();
        const page = data.outline.source.item.ref;
        if ((readGenerations.get(page) ?? 0) > started) {
          void load(page, true).catch(() => undefined);
          return page;
        }
        if (!graph.has(page)) adopt(data.outline);
        else receive([data.outline]);
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
    const changed = (invalidated: Invalidation | null) => {
      if (invalidated !== null) {
        switch (invalidated.kind) {
          case "links":
            history.current = retainHistory(history.current, (item) => {
              if (item === invalidated.preserve) return true;
              switch (item.kind) {
                case "text": return true;
                case "structure":
                case "creation":
                  return ![...linkDependencies([...item.forward, ...item.inverse])].some((id) => invalidated.ids.has(id));
                default: return assertNever(item);
              }
            });
            boundaryNext.current = true;
            break;
          case "resources":
            if (history.current.items.some((item) =>
              item.kind === "text" ? invalidated.refs.has(item.ref) : [...item.refs].some((ref) => invalidated.refs.has(ref)),
            )) {
              history.current = { items: [], index: 0, refusals };
              boundaryNext.current = true;
            }
            break;
          default: assertNever(invalidated);
        }
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
    const after = row ? row.link.link_id : at === "start" ? null : outline.links.at(-1)?.link_id ?? null;
    if (after !== null && pendingUnlinks.has(after)) return null;
    return {
      endpoint: target,
      after,
      parentPath: row ? row.path.slice(0, -1) : view.current.zoom,
      row,
    };
  }

  const focusRow = useCallback((key: string, at: FocusSelection = "end") => {
    setFocus((current) => ({ key, target: "text", selection: at, serial: (current?.serial ?? 0) + 1 }));
    setSelection(null);
  }, []);

  const validatedSelection = visibleSelection(selection, rows);
  const validatedFocus = focus !== null && focus.key !== "" && !rows.some((row) => row.key === focus.key && (focus.target === "control" || model.isNoteRow(row))) ? null : focus;
  useLayoutEffect(() => {
    setSelection(validatedSelection);
    setFocus(validatedFocus);
  }, [validatedSelection, validatedFocus]);

  /** Apply, send and (unless replaying history) record one structure batch. */
  function commit(edits: readonly model.Edit[], after: Selection, record = true, before = selection) {
    if (!edits.length) return false;
    const refs = editReferences(edits);
    if ([...refs].some(isDeletedResource)) {
      feedback.offer({ key: "outline-write", announcement: "Polite", content: { tone: "Neutral", title: "a note used by this change was deleted" } });
      return false;
    }
    const removed = new Map<string, string>();
    for (const edit of edits) {
      if (edit.kind !== "remove") continue;
      const link = graph.get(edit.endpoint)?.links.find((l) => l.link_id === edit.link_id);
      if (link?.target.content.kind === "note") removed.set(edit.link_id, link.target.item.ref);
    }
    const next = new Map(graph);
    const inverse = model.applyEdits(next, edits, textBody, (ref) => resolved.current.get(ref) ?? null);
    if ([...linkDependencies([...edits, ...inverse])].some((id) => pendingUnlinks.has(id))) {
      feedback.receipt({ tone: "Neutral", title: "wait for the link removal to finish" });
      return false;
    }
    graph.clear();
    for (const [ref, outline] of next) graph.set(ref, outline);
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
      const context = { refs: new Set([...refs, ...editReferences(inverse)]), selBefore: before, selAfter: after };
      if (edits.every((edit) => edit.kind === "insert_note" || edit.kind === "insert_resource")) {
        items.push({
          kind: "creation",
          forward: edits.map((edit) => edit.kind === "insert_resource" ? edit : {
            kind: "insert_resource", endpoint: edit.endpoint, link_id: edit.link_id,
            target: model.noteRef(edit.note_id), after: edit.after,
          }),
          inverse: edits.map((edit) => ({ kind: "unlink", link_id: edit.link_id, require_unannotated: true })),
          ...context,
        });
      } else items.push({ kind: "structure", forward: edits, inverse, ...context });
      history.current = { ...history.current, items, index: items.length };
    }
    boundaryNext.current = true;
    publish();
    return true;
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

  function restoreSelection(sel: Selection) {
    const projected = visibleSelection(sel, root ? model.outlineRows(graph, root, view.current) : []);
    if (projected?.kind === "text") focusRow(projected.key, { anchor: projected.anchor, head: projected.head });
    else if (sel?.kind === "text") focusRow("");
    else setSelection(projected);
  }

  /** Rows stay live until acknowledgement. This sender never carries or resets text. */
  function sendUnlink({ commands, preserve, occurrence }: {
    commands: readonly model.Unlink[];
    preserve: Item | null;
    occurrence: string | null;
  }): boolean {
    const ids = new Set(commands.map((command) => command.link_id));
    if (!ids.size || ids.size > 1000 || [...ids].some((id) => pendingUnlinks.has(id))) return false;
    const { refs, endpoints } = linkedOutlines(ids);
    const before = selectedNow.current;
    const generation = interaction.current;
    const ownerView = view.current;
    const first = rows.findIndex((row) => occurrence === null ? ids.has(row.link.link_id) : row.key === occurrence);
    const neighbours = [...rows.slice(Math.max(0, first)), ...rows.slice(0, Math.max(0, first)).reverse()]
      .filter((row) => !ids.has(row.link.link_id)).map((row) => row.key);
    ids.forEach((id) => pendingUnlinks.add(id));
    let pending = true;
    const release = () => {
      if (!pending) return;
      pending = false;
      ids.forEach((id) => pendingUnlinks.delete(id));
    };
    enqueueWrite<Reply>({
      build: () => ({ path: "/api/notes/outline/commands", method: "POST", body: { commands } }),
      settle() {
        dropLinks(ids, endpoints);
        release();
        publish({ kind: "links", ids, preserve });
        announceLinkDeletions({ linkIds: [...ids], origin: graph });
        for (const ref of refs) void load(ref, true).catch(() => undefined);
        publishChange("Notes");
        if (selectedNow.current === before && interaction.current === generation && view.current === ownerView) {
          const surviving = new Set(root ? model.outlineRows(graph, root, view.current).map((row) => row.key) : []);
          const key = neighbours.find((key) => surviving.has(key)) ?? "";
          setSelection(null);
          setFocus((current) => ({ key, target: key === "" ? "text" : "control", selection: "end", serial: (current?.serial ?? 0) + 1 }));
        }
        feedback.receipt({ tone: "Success", title: ids.size === 1 ? "link removed" : `${ids.size} links removed` });
      },
      fail(error) {
        if (preserve)
          history.current = retainHistory(history.current, (item) => item !== preserve);
        if (handleUnauthenticatedApiError(error)) return;
        if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
        if (!isStaleBuild(error) && !["E_RESOURCE_CONFLICT", "E_FORBIDDEN", "E_NOT_FOUND", "E_INVALID_REQUEST"].includes(error.code)) throw error;
        const content = isStaleBuild(error)
          ? { tone: "Warning", title: "the app needs to reload", message: STALE_BUILD_COPY, requestId: error.requestId } as const
          : { tone: "Warning", requestId: error.requestId, title: preserve && error.code === "E_RESOURCE_CONFLICT"
              ? "this link has a note. use remove link to disconnect it."
              : "some selected items cannot be unlinked. nothing was removed." } as const;
        feedback.offer({ key: "outline-unlink", announcement: "Polite", content });
      },
      finalize() {
        release();
        publish();
      },
    });
    boundaryNext.current = true;
    publish();
    return true;
  }

  function step(redo: boolean) {
    const { items, index } = history.current;
    const item = redo ? items[index] : items[index - 1];
    if (!item) return;
    if (item.kind !== "text" && [...linkDependencies([...item.forward, ...item.inverse])].some((id) => pendingUnlinks.has(id))) {
      feedback.receipt({ tone: "Neutral", title: "wait for the link removal to finish" });
      return;
    }
    const sel = redo ? item.selAfter : item.selBefore;
    switch (item.kind) {
      case "text":
        store.replaceText(item.ref, redo ? item.after : item.before);
        break;
      case "structure":
        if (!commit(redo ? item.forward : item.inverse, sel, false)) return;
        break;
      case "creation": {
        if (!redo) {
          // admission moves the cursor once. acknowledgement may preserve only this live item.
          history.current = { ...history.current, index: index - 1 };
          const key = item.selAfter?.kind === "blocks" ? item.selAfter.anchor : item.selAfter?.key ?? null;
          const occurrence = rows.some((row) => row.key === key && item.inverse.some((command) => command.link_id === row.link.link_id)) ? key : null;
          if (!sendUnlink({ commands: item.inverse, preserve: item, occurrence }))
            history.current = { ...history.current, index };
          return;
        }
        if (!commit(item.forward, sel, false)) return;
        break;
      }
      default: assertNever(item);
    }
    history.current = { ...history.current, index: index + (redo ? 1 : -1) };
    restoreSelection(sel);
    boundaryNext.current = true;
  }

  function canUnlink(row: model.Row): boolean {
    if (latent || !root || blocksInsertion(failure) || blocksInsertion(loadErrors.get(root)) ||
      row.terminal !== null || pendingUnlinks.has(row.link.link_id) || blocksInsertion(loadErrors.get(row.endpoint))) return false;
    const current = model.outlineRows(graph, root, view.current).find((candidate) => candidate.key === row.key);
    return current?.terminal === null && current.endpoint === row.endpoint &&
      current.link.link_id === row.link.link_id && model.zoomEndpoint(graph, root, row.path.slice(0, -1)) === row.endpoint &&
      canRead(row.endpoint);
  }

  function unlinkRows(selected: readonly model.Row[]): boolean {
    if (!selected.length) return false;
    const ids = new Set(selected.map((row) => row.link.link_id));
    if (ids.size > 1000 || !selected.every(canUnlink)) {
      feedback.offer({ key: "outline-unlink", announcement: "Polite", content: {
        tone: "Warning", title: "some selected items cannot be unlinked. nothing was removed.",
      } });
      return false;
    }
    const anchor = selectedNow.current?.kind === "blocks" ? selectedNow.current.anchor : null;
    return sendUnlink({
      commands: [...ids].map((link_id) => ({ kind: "unlink", link_id, require_unannotated: false })),
      preserve: null,
      occurrence: selected.some((row) => row.key === anchor) ? anchor : selected[0]!.key,
    });
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
    pendingUnlinks: new Set(pendingUnlinks),
    canUnlink,
    markInteraction,
    loading: new Set(loading.keys()),
    loadErrors,
    canRead,
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
    clearSelection: () => { setSelection(null); setFocus(null); },
    focusRow,
    reveal(target: OutlineTarget) {
      focusRow(target.kind === "root" ? "" : target.key);
    },
    toggle(row: model.Row) {
      view.current.folds.set(row.key, !row.open);
      if (!row.open) void loadVisibleOutline(row.link.target.item.ref, pendingStructure === 0).catch(() => undefined);
      rerender();
    },
    zoom(row: model.Row) {
      if (!model.isNoteRow(row)) return;
      void loadVisibleOutline(row.link.target.item.ref, pendingStructure === 0).catch(() => undefined);
      view.current.zoom = [...row.path];
      focusRow("");
      rerender();
    },
    zoomOut() {
      view.current.zoom = view.current.zoom.slice(0, -1);
      focusRow("");
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
      if (commit(edits, { kind: "text", key, anchor: 1, head: 1 }, true, before))
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
      if (commit(joined.edits, { kind: "text", key: joined.earlier.key, ...at }, true, before))
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
        if (commit(edits, landing(key))) follow(key, at);
      }, () => undefined);
    },
    outdent(row: model.Row, at: FocusSelection = "end") {
      const edits = root ? model.outdentEdits(graph, root, row) : null;
      if (!edits || edits[0]?.kind !== "relink") return;
      const key = [...row.path.slice(0, -2), edits[0].new_link_id].join("/");
      if (commit(edits, landing(key))) follow(key, at);
    },
    move(row: model.Row, direction: -1 | 1) {
      const edits = model.moveEdits(graph, rows, row, direction);
      if (edits) commit(edits, selection);
    },
    unlinkRows,
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
      if (commit(
        [{ kind: "insert_note", endpoint: position.endpoint, link_id, note_id, after: position.after, body_pm_json }],
        { kind: "text", key, anchor: 1, head: 1 },
        true,
        before,
      )) focusRow(key, { anchor: 1, head: 1 });
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
      if (cut && (!selected.length || selected.length !== selection.keys.length || new Set(selected.map((row) => row.link.link_id)).size > 1000 || !selected.every(canUnlink))) {
        feedback.offer({ key: "outline-unlink", announcement: "Polite", content: {
          tone: "Warning", title: "some selected items cannot be unlinked. nothing was removed.",
        } });
        return;
      }
      model.copyRows(selected, textBody, clipboard);
      if (cut) unlinkRows(selected);
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
