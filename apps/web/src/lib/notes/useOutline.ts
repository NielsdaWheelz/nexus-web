"use client";

// One pane's view and history over the shared outline projection. The canonical
// resource reader fences superseded reads; this owner overlays structural edits.
// Generic unlink retains pending rows until acknowledgement, carries no drafts,
// and retires exact edge-dependent history. Pure creation undo atomically unlinks
// only unannotated edges; redo requires creating those same links to retained
// resources. Refused structural batches keep their latest drafts in the initiating
// visit and require explicit placement review before replaying the atomic intent.
import { useCallback, useEffect, useReducer, useRef, useState, useLayoutEffect } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import { assertNever } from "@/lib/assertNever";
import { apiFetch, ApiError, isApiError, isSameSystemApiDefect, isStaleBuild, STALE_BUILD_COPY, type ApiPath } from "@/lib/api/client";
import { publishChange, useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { docFromBody, emptyBody, parseBody, sameBody, type NoteBody } from "@/lib/notes/noteBody";
import * as model from "@/lib/notes/outline";
import * as store from "@/lib/notes/texts";
import { enqueueWrite, captureWriteSerial, advanceLinksVersion } from "@/lib/notes/writes";
import { isDeletedResource, subscribeLinkMutations, acknowledgeGraphCommands, endpointForResource, announceLinkDeletions, type Position, type InsertionOut } from "@/lib/resourceGraph/links";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useResourceOutline, captureResourceOutlineRead, isResourceOutlineReadCurrent, invalidateResourceOutlines, refreshResourceOutline } from "@/lib/resourceGraph/useResourceOutline";
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter, usePaneVisitIdentity } from "@/lib/workspace/paneReturnMemento";
import { resolveResourceItem } from "@/lib/resources/items";
import type { OutlineTarget } from "@/lib/resources/outlineProjection";

const OUTLINE_VIEW = definePaneVisitDataKey<model.View>("Notes.OutlineView");

type Reply = Schema<"OutlineCommandsOut">;

// ---- the tab-wide graph ------------------------------------------------------------

const graph: model.Graph = new Map();
const latest = new Map<string, model.OutlineData>();
const reviewedRefs = new Set<string>();
type Invalidation =
  | { kind: "resources"; refs: ReadonlySet<string> }
  | { kind: "links"; ids: ReadonlySet<string>; preserve: Item | null };
const listeners = new Set<(invalidated: Invalidation | null) => void>();
const pendingUnlinks = new Set<string>();
/** The texts and resource dependencies of each unsettled structure write. */
const carried = new Map<number, { texts: ReadonlySet<string>; refs: ReadonlySet<string>; refused: () => void }>();
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

/** Snapshot endpoints before removal, including an unloaded reverse endpoint. */
function linkedEndpoints(ids: ReadonlySet<string>): Set<string> {
  const endpoints = new Set<string>();
  for (const entries of [graph, latest]) {
    for (const [ref, outline] of entries) {
      for (const link of outline.links) {
        if (!ids.has(link.link_id)) continue;
        endpoints.add(ref);
        endpoints.add(link.target.item.ref);
      }
    }
  }
  return endpoints;
}

/** An acknowledged edge removal invalidates old reads and their retained replies. */
function dropLinks(ids: ReadonlySet<string>, endpoints: ReadonlySet<string>) {
  invalidateResourceOutlines(endpoints);
  for (const ref of endpoints) reviewedRefs.delete(ref);
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
      const endpoints = linkedEndpoints(ids);
      dropLinks(ids, endpoints);
      publish({ kind: "links", ids, preserve: null });
      return;
    }
    if (mutation.kind === "created" || mutation.kind === "context_detached") return;
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
  const prior = graph.get(live.source.item.ref);
  // A daily envelope or an already-running branch read can finish after a newer
  // write reply. Older adjacency cannot remove acknowledged links or their undo.
  if (!prior || live.links_version >= prior.links_version) {
    const removed = prior && live.complete && pendingStructure === 0
      ? new Set(prior.links.filter((link) => !live.links.some((next) => next.link_id === link.link_id)).map((link) => link.link_id))
      : new Set<string>();
    graph.set(live.source.item.ref, live);
    reviewedRefs.add(live.source.item.ref);
    if (removed.size) publish({ kind: "links", ids: removed, preserve: null });
  }
  for (const node of [live.source, ...live.links.map((l) => l.target)]) {
    const body = bodyOf(node);
    if (body && node.content.kind === "note")
      store.adoptText(node.item.ref, body, node.content.body_version);
    else if (node.content.kind === "page" && node === live.source)
      store.adoptText(
        node.item.ref,
        node.content.title,
        node.content.title_version,
      );
  }
}

function adoptBranch(
  source: model.OutlineNode,
  items: readonly Schema<"OutlineOccurrenceOut">[],
  version: number,
  complete: boolean,
  generation: number,
) {
  if (!isResourceOutlineReadCurrent(source.item.ref, generation)) return;
  const links = items.map(({ connection, content }) => ({
    link_id: connection.edge_id,
    has_link_note: connection.link_note !== null,
    target: { item: connection.other, content },
    connection,
  }));
  if (pendingStructure === 0) {
    adopt({ source, links, links_version: version, complete });
    publish();
  }
}

/** Keep a reply's outlines until no structure write is pending, then adopt them all. */
function receive(outlines: readonly model.WireOutline[]) {
  for (const wire of outlines) {
    const outline = model.projectOutline(wire);
    const live = liveOutline(outline);
    if (live) latest.set(live.source.item.ref, live);
    else latest.delete(outline.source.item.ref);
  }
  if (pendingStructure > 0) return;
  for (const outline of latest.values()) adopt(outline);
  latest.clear();
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
    if (edit.kind === "insert_link") refs.add(edit.target);
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

/** The single adapter from local structural intent to graph commands. */
function wireEdits(
  edits: readonly model.Edit[],
  checked: (ref: string) => number,
  removed: ReadonlyMap<string, string> = new Map(),
  bodyBases: Map<string, number | null> = new Map(),
  removalBodies: ReadonlyMap<string, NoteBody> = new Map(),
): Schema<"OutlineCommandsRequest">["commands"] {
  return edits.map((edit) => {
    switch (edit.kind) {
      case "insert_note":
        return {
          kind: "insert_note",
          link_id: edit.link_id,
          note_id: edit.note_id,
          source: { kind: "resource", ref: edit.endpoint },
          body_pm_json: edit.body_pm_json,
          position: {
            after: edit.after,
            expected_links_version: checked(edit.endpoint),
          },
        };
      case "insert_link": {
        const target = endpointForResource(edit.target);
        if (target === null)
          throw new ApiError(
            400,
            "E_LINK_CAPABILITY",
            "this resource cannot be linked",
          );
        return {
          kind: "insert_link",
          require_created: edit.require_created,
          link_id: edit.link_id,
          source: { kind: "resource", ref: edit.endpoint },
          target,
          position: edit.append
            ? null
            : {
                after: edit.after,
                expected_links_version: checked(edit.endpoint),
              },
        };
      }
      case "move":
        return {
          kind: "move",
          endpoint: edit.endpoint,
          edge_id: edit.link_id,
          after: edit.after,
          expected_links_version: checked(edit.endpoint),
        };
      case "relink":
        return {
          ...edit,
          expected_source_links_version: checked(edit.endpoint),
          expected_destination_links_version: checked(edit.destination),
        };
      case "set_body": {
        const ref = model.noteRef(edit.note_id);
        const expected_version = version(ref);
        bodyBases.set(ref, expected_version);
        return { ...edit, expected_version };
      }
      case "set_title":
        return { ...edit, expected_version: version(`page:${edit.page_id}`) };
      case "remove": {
        const note = removed.get(edit.link_id);
        const acknowledged = note ? store.readText(note)?.acked : null;
        const capturedBody = note ? removalBodies.get(note) : null;
        const sameAcknowledgedBody =
          capturedBody &&
          acknowledged &&
          typeof acknowledged.value !== "string" &&
          sameBody(capturedBody, acknowledged.value);
        const expected_body_version = sameAcknowledgedBody
          ? acknowledged.version
          : note
            ? (bodyBases.get(note) ?? null)
            : null;
        return { ...edit, expected_body_version };
      }
      case "ensure_daily":
        return edit;
    }
  });
}

/**
 * Send one structure batch. Captured adjacency versions advance only through
 * acknowledged predecessor proof. Removed bodies retain their captured base;
 * `removed` names the note each remove's link pointed at.
 */
function sendEdits(
  edits: readonly model.Edit[],
  removed: ReadonlyMap<string, string>,
  texts: ReadonlySet<string>,
  refs: ReadonlySet<string>,
  captured: ReadonlyMap<string, number> = new Map(
    [...graph].map(([ref, value]) => [ref, value.links_version]),
  ),
  dependency = captureWriteSerial(),
  onRefused: () => void = () => undefined,
  bodyBases: Map<string, number | null> = new Map(),
  removalBodies: ReadonlyMap<string, NoteBody> = new Map(),
  onAcknowledged: (reply: Reply) => void = () => undefined,
) {
  const serial = ++jobSerial;
  pendingStructure += 1;
  carried.set(serial, { texts, refs, refused: onRefused });
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
      const checked = (ref: string) => {
        const minted = edits.some(
          (edit) =>
            edit.kind === "insert_note" && model.noteRef(edit.note_id) === ref,
        );
        const base = captured.get(ref) ?? (minted ? 1 : null);
        if (base === null)
          throw new ApiError(
            409,
            "E_RESOURCE_CONFLICT",
            "the insertion position is no longer loaded",
          );
        const advanced = advanceLinksVersion(ref, base, dependency);
        if (advanced === null)
          throw new ApiError(
            409,
            "E_RESOURCE_CONFLICT",
            "placement changed; refresh before trying this edit again",
          );
        return advanced;
      };
      const commands = wireEdits(
        edits,
        checked,
        removed,
        bodyBases,
        removalBodies,
      );
      return {
        path: "/api/resource-graph/commands",
        method: "POST",
        body: { commands },
      };
    },
    settle(reply) {
      release();
      acknowledge(reply, edits);
      onAcknowledged(reply);
      acknowledgeGraphCommands(reply);
      receive(reply.outlines);
      publishChange("Notes");
      publish();
    },
    fail(error) {
      if (handleUnauthenticatedApiError(error)) return;
      // The queue calls fail only after an unsent build failure or a definitive
      // rejection. Uncertain writes stay queued and retain their projection.
      refuse(error, serial);
    },
    finalize() {
      release();
      receive([]);
      publish();
    },
  });
}

/** Only carried body writes are acknowledged. Canonical nodes merely read or reused
 * by an insertion are adopted, preserving dirty drafts and opening unopened texts.
 * Deleted notes stop saving unless a later queued write recreates them. */
function acknowledge(reply: Reply, edits: readonly model.Edit[]) {
  const later = [...carried.values()];
  for (const ref of reply.deleted) if (!later.some((entry) => entry.texts.has(ref))) store.setGone(ref);
  const inserted = new Set(
    edits.flatMap((e) => (e.kind === "insert_note" ? [model.noteRef(e.note_id)] : [])),
  );
  const written = new Set(edits.flatMap((edit) => edit.kind === "set_body" || edit.kind === "insert_note" ? [model.noteRef(edit.note_id)] : []));
  const targets = reply.outlines.flatMap((outline) => outline.items.map(({connection,content}) => ({item: connection.other,content})));
  for (const node of [...reply.nodes, ...targets.filter((t) => inserted.has(t.item.ref))]) {
    if (isDeletedResource(node.item.ref)) continue;
    const body = bodyOf(node);
    if (body && node.content.kind === "note") {
      if (written.has(node.item.ref)) store.acknowledgeText(node.item.ref, body, node.content.body_version);
      else store.adoptText(node.item.ref, body, node.content.body_version);
    }
  }
}

/** Cancel this write and every queued structure write; reload; reset their texts. */
function refuse(
  error: unknown,
  serial: number,
  history: "all" | "affected" = "all",
) {
  const texts = new Set<string>();
  const refs = new Set<string>();
  for (const [at, entry] of carried) {
    if (at < serial) continue;
    entry.refused();
    entry.texts.forEach((ref) => texts.add(ref));
    entry.refs.forEach((ref) => refs.add(ref));
  }
  carried.clear();
  reviewedRefs.clear();
  cancelledBefore = jobSerial;
  pendingStructure = 0;
  if (history === "all") refusals += 1;
  latest.clear();
  for (const ref of texts) store.resetText(ref);
  reportRefusal(error);
  publishChange("Notes");
  publish(history === "affected" ? { kind: "resources", refs } : null);
}

// ---- one pane ---------------------------------------------------------------------

export type Selection =
  | { kind: "text"; key: string; anchor: number; head: number }
  | { kind: "blocks"; anchor: string; keys: readonly string[] }
  | null;

export type InsertAt = "start" | "end" | {afterRowKey:string};

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
  referenceBase?: store.ReferenceBase;
  before: NoteBody;
  after: NoteBody;
  selectionBefore: { anchor: number; head: number };
  selectionAfter: { anchor: number; head: number };
  source: "input" | "composition" | "paste" | "format" | "attachment";
}

type Item = { selBefore: Selection; selAfter: Selection } & (
  | { kind: "text"; ref: string; before: NoteBody; after: NoteBody; at: number }
  | { kind: "structure"; forward: readonly model.Edit[]; inverse: readonly model.Edit[]; refs: ReadonlySet<string> }
  | { kind: "creation"; forward: readonly Extract<model.Edit, { kind: "insert_link" }>[]; inverse: readonly model.Unlink[]; refs: ReadonlySet<string> }
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

function dependsOnEdges(item: Item, edges: ReadonlySet<string>): boolean {
  switch (item.kind) {
    case "text": return false;
    case "structure":
    case "creation": return [...linkDependencies([...item.forward, ...item.inverse])].some((id) => edges.has(id));
    default: return assertNever(item);
  }
}

type FailedIntent = {
  edits: readonly model.Edit[];
  drafts: readonly { ref: string; body: NoteBody }[];
  materialization: readonly model.Edit[];
  bodyBases: ReadonlyMap<string, number | null>;
  removalBodies: ReadonlyMap<string, NoteBody>;
  before: Selection;
  after: Selection;
};

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
  const link = { link_id: draft.link, has_link_note: false, target: node, connection: null };
  graph.set(draft.page, { ...outline, links: [link] });
  graph.set(node.item.ref, { source: node, links: [{ ...link, target: outline.source }], links_version: 1, complete: true });
  store.createText(node.item.ref, emptyBody(), {
    request: () => ({
      path: "/api/resource-graph/commands",
      method: "POST",
      body: { commands: [{ kind: "insert_note", source: {kind: "daily_page", local_date: draft.date}, link_id: draft.link, note_id: draft.note, body_pm_json: textBody(draft.note).body_pm_json, position: { after: null, expected_links_version: 1 } }] },
    }),
    settle(reply) {
      // justify-type-assertion: the commands route answers OutlineCommandsOut.
      const { outlines } = reply as Reply;
      receive(outlines);
      onMade();
      publishChange("Notes");
      publish();
      const made = outlines.flatMap((o) => o.items).find((l) => l.connection.other.ref === node.item.ref);
      return made?.content.kind === "note" ? made.content.body_version : 1;
    },
  });
}

/** A page (`root`) or a day (`dailyDate`, latent until its first write). */
export function useOutline(input: { root: string | null; dailyDate: string | null }) {
  const { dailyDate } = input;
  const dailyStamp=useChangeStamp("Notes","Metadata");
  const visitId = usePaneVisitIdentity();
  const currentVisit = useRef(visitId);
  currentVisit.current = visitId;
  const feedback = useFeedback();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [latentDate, setLatentDate] = useState<string | null>(null);
  const latent = dailyDate !== null && latentDate === dailyDate;
  const [selection, setSelection] = useState<Selection>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [activeReference,setActiveReference]=useState<string | null>(null);
  const capture = useRef<model.View | null>(null);
  const saved = usePaneVisitData(OUTLINE_VIEW, useCallback(() => capture.current, []));
  const writeView = usePaneVisitDataWriter(OUTLINE_VIEW);
  const view = useRef({ visitId, folds: new Map(saved?.folds ?? []), zoom: [...(saved?.zoom ?? [])] });
  if (view.current.visitId !== visitId) {
    view.current = { visitId, folds: new Map(saved?.folds ?? []), zoom: [...(saved?.zoom ?? [])] };
    setSelection(null);
    setFocus(null);
    setActiveReference(null);
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
  const historyVisit = useRef(visitId);
  if (historyVisit.current !== visitId) {
    history.current = { items: [], index: 0, refusals };
    historyVisit.current = visitId;
  }
  const failed = useResourceDraft<readonly FailedIntent[]>("Notes.FailedStructure", () => []);
  const boundaryNext = useRef(true);
  const draft = useRef<Draft | null>(null);
  const resolved = useRef(new Map<string, model.OutlineNode>());

  const read = usePaneFreeServerValue({
    key: dailyDate ? `outline:daily:${dailyDate}` : null,
    stale: `${refusals}:${dailyStamp}`,
    load: async (signal) => {
      if (dailyDate) {
        const started = captureResourceOutlineRead();
        const path = `/api/notes/daily/${dailyDate}` as ApiPath;
        const { data } = await apiFetch<ApiJson<"/notes/daily/{local_date}", "get">>(path, {
          cache: "no-store",
          signal,
        });
        signal.throwIfAborted();
        const page = data.outline.source.item.ref;
        if (!isResourceOutlineReadCurrent(page, started)) return { ...data, read_generation: started };
        if (!graph.has(page) || pendingStructure === 0) adopt(model.projectOutline(data.outline));
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
        return { ...data, read_generation: started };
      }
      throw new Error("a daily read requires its local date");
    },
  });
  const root = input.root ?? (read.status === "ready" ? read.data.outline.source.item.ref : null);
  const pendingRoot = input.root !== null && graph.has(input.root) && store.readText(input.root)?.acked === null && [...carried.values()].some((entry) => entry.texts.has(input.root!));
  const sharedRead = useResourceOutline(pendingRoot ? null : input.root, dailyDate && read.status === "ready" && isResourceOutlineReadCurrent(read.data.outline.source.item.ref, read.data.read_generation) ? read.data.outline : null);
  useEffect(() => {
    if (!latent && sharedRead.status === "ready" && sharedRead.source && sharedRead.version !== null && pendingStructure === 0 &&
      isResourceOutlineReadCurrent(sharedRead.source.item.ref, sharedRead.generation)) {
      const value: model.OutlineData = {source:sharedRead.source, links_version:sharedRead.version, complete:sharedRead.complete,
        links:sharedRead.items.map(({connection,content})=>({link_id:connection.edge_id,has_link_note:connection.link_note!==null,target:{item:connection.other,content},connection}))};
      adopt(value);
      publish();
    }
  }, [latent,sharedRead.status,sharedRead.source,sharedRead.version,sharedRead.complete,sharedRead.items,sharedRead.generation]);
  const failure = dailyDate ? (read.status === "loading" ? null : read.error) : sharedRead.error;
  const status = failure !== null ? "failed" : pendingRoot ? "ready" : dailyDate && read.status!=="ready" ? read.status : sharedRead.status;
  const retrying = dailyDate ? read.status === "failed" ? read.retrying : read.status === "ready" && read.refreshing : sharedRead.status === "loading";

  useEffect(() => {
    observeLinks();
    const changed = (invalidated: Invalidation | null) => {
      if (invalidated !== null) {
        switch (invalidated.kind) {
          case "links":
            history.current = retainHistory(history.current, (item) => item === invalidated.preserve || !dependsOnEdges(item, invalidated.ids));
            boundaryNext.current = true;
            break;
          case "resources":
            history.current = retainHistory(history.current, (item) => {
              switch (item.kind) {
                case "text": return !invalidated.refs.has(item.ref);
                case "structure":
                case "creation": return ![...item.refs].some((ref) => invalidated.refs.has(ref));
                default: return assertNever(item);
              }
            });
            boundaryNext.current = true;
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
    // The refusal stays visible; the visit retains each stopped batch and its latest drafts.
    reportRefusal = (error) =>
      feedback.offer({ key: "notes-outline-refused", announcement: "Assertive", content: {
          tone: "Danger",
          title: "that change couldn’t be saved",
          message: "your drafts are kept in the original outline. review its refreshed source and position before retrying.",
          requestId: (error as { requestId?: string } | null)?.requestId,
        } });
  }, [feedback]);

  const rows = root && graph.has(root) ? model.outlineRows(graph, root, view.current) : [];
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  const endpoint = (root && model.zoomEndpoint(graph, root, view.current.zoom)) ?? root ?? "";
  function insertionPosition(
    at: InsertAt,
    occurrences: ReadonlyMap<string, model.Row>,
  ) {
    if (
      !root ||
      activeReference !== null ||
      !graph.has(root) ||
      isDeletedResource(root) ||
      isStaleBuild(failure) ||
      failure?.status === 403 ||
      failure?.status === 404
    )
      return null;
    const current = model.zoomEndpoint(graph, root, view.current.zoom);
    if (!current || !graph.has(current) || isDeletedResource(current))
      return null;
    const row = typeof at === "object" ? occurrences.get(at.afterRowKey) : null;
    if (typeof at === "object" && !row) return null;
    const target = row?.endpoint ?? current;
    const outline = graph.get(target);
    if (
      !outline ||
      isDeletedResource(target) ||
      (at === "end" && !outline.complete)
    )
      return null;
    if (
      row &&
      (!outline.links.some((link) => link.link_id === row.link.link_id) ||
        model.zoomEndpoint(graph, root, row.path.slice(0, -1)) !== target)
    )
      return null;
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
  function commit(
    edits: readonly model.Edit[],
    after: Selection,
    record = true,
    before = selection,
    prelude: readonly model.Edit[] | null = null,
  ) {
    if (!edits.length && !prelude?.length) return false;
    const refs = editReferences(edits);
    if ([...refs].some(isDeletedResource)) {
      feedback.offer({
        key: "outline-write",
        announcement: "Polite",
        content: {
          tone: "Neutral",
          title: "a note used by this change was deleted",
        },
      });
      return false;
    }
    const removed = new Map<string, string>();
    for (const edit of edits) {
      if (edit.kind !== "remove") continue;
      const link = graph
        .get(edit.endpoint)
        ?.links.find((l) => l.link_id === edit.link_id);
      if (link?.target.content.kind === "note")
        removed.set(edit.link_id, link.target.item.ref);
    }
    const removalBodies = new Map(
      [...removed.values()].map((ref) => [
        ref,
        structuredClone(textBody(model.noteIdOf(ref))),
      ]),
    );
    const captured = new Map(
      [...graph].map(([ref, value]) => [ref, value.links_version]),
    );
    const dependency = captureWriteSerial();
    const made = prelude === null && latent ? draft.current : null;
    const materialization = prelude ?? (made ? materialize(made) : []);
    const next = new Map(graph);
    model.applyEdits(next, materialization, textBody);
    const inverse = model.applyEdits(
      next,
      edits,
      textBody,
      (ref) => resolved.current.get(ref) ?? null,
    );
    if ([...linkDependencies([...materialization, ...edits, ...inverse])].some((id) => pendingUnlinks.has(id))) {
      feedback.receipt({ tone: "Neutral", title: "wait for the link removal to finish" });
      return false;
    }
    graph.clear();
    for (const [ref, value] of next) graph.set(ref, value);
    const texts = new Set<string>();
    for (const edit of [...materialization, ...edits]) {
      if (edit.kind === "set_body" || edit.kind === "insert_note") {
        const ref = model.noteRef(edit.note_id);
        const body = parseBody(edit.body_pm_json);
        if (edit.kind === "set_body") store.carryText(ref, body);
        else store.createText(ref, body, null);
        texts.add(ref);
      }
    }
    const commands = [...materialization, ...edits];
    editReferences(materialization).forEach((ref) => refs.add(ref));
    const bodyBases = new Map(
      edits.flatMap((edit) =>
        edit.kind === "set_body"
          ? [
              [
                model.noteRef(edit.note_id),
                store.readText(model.noteRef(edit.note_id))?.acked?.version ??
                  null,
              ] as const,
            ]
          : [],
      ),
    );
    for (const ref of removed.values())
      bodyBases.set(ref, store.readText(ref)?.acked?.version ?? null);
    let recorded: Exclude<Item, { kind: "text" }> | null = null;
    sendEdits(
      commands,
      removed,
      texts,
      refs,
      captured,
      dependency,
      () => {
        const drafts = [...texts].flatMap((ref) => {
          const value = store.readText(ref)?.value;
          return value && typeof value !== "string"
            ? [{ ref, body: structuredClone(value) }]
            : [];
        });
        failed.set((prior) => [
          ...prior,
          {
            edits: structuredClone(edits),
            materialization: structuredClone(materialization),
            drafts,
            bodyBases: new Map(bodyBases),
            removalBodies,
            before,
            after,
          },
        ]);
      },
      bodyBases,
      removalBodies,
      (reply) => {
        const insertions = commands.filter(
          (edit) => edit.kind === "insert_note" || edit.kind === "insert_link",
        );
        const reused = new Set<string>();
        reply.insertions.forEach((result, index) => {
          const edit = insertions[index];
          if (!edit) return;
          if (!result.created) reused.add(edit.link_id);
          if (edit.kind === "insert_link") {
            const { source, target } = result.connection;
            edit.target = source.ref === edit.endpoint ? target.ref : source.ref;
          }
          if (recorded) recorded.refs = new Set([...recorded.refs, result.connection.source.ref, result.connection.target.ref]);
          if (recorded?.kind === "creation") {
            const { source, target } = result.connection;
            recorded.forward = recorded.forward.map((forward) => forward.link_id === edit.link_id
              ? { ...forward, target: source.ref === forward.endpoint ? target.ref : source.ref }
              : forward);
          }
        });
        if (!recorded || reused.size === 0) return;
        const keep = (edit: model.Edit | model.Unlink) => !("link_id" in edit && reused.has(edit.link_id));
        switch (recorded.kind) {
          case "structure":
            recorded.forward = recorded.forward.filter(keep);
            recorded.inverse = recorded.inverse.filter(keep);
            break;
          case "creation":
            recorded.forward = recorded.forward.filter(keep);
            recorded.inverse = recorded.inverse.filter(keep);
            break;
          default: assertNever(recorded);
        }
        if (recorded.forward.length === 0 && recorded.inverse.length === 0) {
          const prior = history.current;
          const at = prior.items.indexOf(recorded);
          history.current = {
            ...prior,
            items: prior.items.filter((item) => item !== recorded),
            index: prior.index - (at >= 0 && at < prior.index ? 1 : 0),
          };
        }
      },
    );
    if (materialization.length) setLatentDate(null);
    if (record) {
      const items = history.current.items.slice(0, history.current.index);
      const context = { refs: new Set([...refs, ...editReferences(inverse)]), selBefore: before, selAfter: after };
      recorded = edits.length > 0 && edits.every((edit) => edit.kind === "insert_note" || edit.kind === "insert_link")
        ? {
            kind: "creation",
            forward: edits.map((edit) => edit.kind === "insert_link" ? { ...edit, require_created: true } : {
              kind: "insert_link", endpoint: edit.endpoint, link_id: edit.link_id,
              target: model.noteRef(edit.note_id), after: edit.after, require_created: true,
            }),
            inverse: edits.map((edit) => ({ kind: "unlink", link_id: edit.link_id, require_unannotated: true })),
            ...context,
          }
        : { kind: "structure", forward: edits, inverse, ...context };
      items.push(recorded);
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
    const endpoints = linkedEndpoints(ids);
    const loaded = new Map([...endpoints].flatMap((ref) => {
      const value = graph.get(ref);
      return value ? [[ref, value.links.length] as const] : [];
    }));
    const refresh = (ref: string, loadedItemCount: number) => {
      void refreshResourceOutline(ref, loadedItemCount).then((outline) => {
        if (!isResourceOutlineReadCurrent(ref, outline.read_generation)) return;
        if (pendingStructure > 0) latest.set(ref, model.projectOutline(outline));
        else adopt(model.projectOutline(outline));
        publish();
      }).catch((error: unknown) => {
        if (handleUnauthenticatedApiError(error)) return;
        if (!isApiError(error) || isSameSystemApiDefect(error)) { reportError(error); return; }
        feedback.offer({ key: `outline-refresh:${ref}`, announcement: "Polite", content: {
          tone: "Warning", title: "couldn’t refresh linked resources", requestId: error.requestId,
        }, actions: [{ label: "retry", onClick: () => refresh(ref, loadedItemCount) }] });
      });
    };
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
      build() {
        linkedEndpoints(ids).forEach((ref) => {
          endpoints.add(ref);
          const value = graph.get(ref);
          if (value && !loaded.has(ref)) loaded.set(ref, value.links.length);
        });
        return { path: "/api/resource-graph/commands", method: "POST", body: { commands }, link_refs: [...endpoints] };
      },
      settle() {
        dropLinks(ids, endpoints);
        release();
        publish({ kind: "links", ids, preserve });
        announceLinkDeletions({ linkIds: [...ids], origin: graph });
        publishChange("Notes");
        for (const [ref, loadedItemCount] of loaded) refresh(ref, loadedItemCount);
        if (selectedNow.current === before && interaction.current === generation && view.current === ownerView && currentVisit.current === visitId) {
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
          : { tone: "Warning", requestId: error.requestId, title: commands.some((command) => command.require_unannotated) && error.code === "E_RESOURCE_CONFLICT"
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
        if (item.forward.some((edit) => !edit.append && !reviewedRefs.has(edit.endpoint))) {
          feedback.receipt({ tone: "Neutral", title: "wait for the linked resources to refresh" });
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
    if (latent || !root || activeReference !== null || isStaleBuild(failure) || failure?.status === 403 || failure?.status === 404 ||
      row.terminal !== null || pendingUnlinks.has(row.link.link_id)) return false;
    const current = model.outlineRows(graph, root, view.current).find((candidate) => candidate.key === row.key);
    return current?.terminal === null && current.endpoint === row.endpoint &&
      current.link.link_id === row.link.link_id && current.link.connection?.origin === "user" &&
      current.link.connection.mutation?.kind === "unlink" &&
      model.zoomEndpoint(graph, root, row.path.slice(0, -1)) === row.endpoint;
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

  function retryProblem(intent: FailedIntent): string | null {
    if (pendingStructure > 0 || status !== "ready")
      return "wait for the current outline to load";
    const made = new Set(
      [...intent.materialization, ...intent.edits].flatMap((edit) =>
        edit.kind === "insert_note" ? [model.noteRef(edit.note_id)] : [],
      ),
    );
    for (const [ref, base] of intent.bodyBases) {
      const acknowledged = store.readText(ref)?.acked;
      const captured = intent.removalBodies.get(ref);
      const unchangedBody =
        captured &&
        acknowledged &&
        typeof acknowledged.value !== "string" &&
        sameBody(captured, acknowledged.value);
      if (acknowledged?.version !== base && !unchangedBody)
        return "a note changed; copy the kept text and resolve its body conflict first";
    }
    for (const edit of intent.edits) {
      if (!("endpoint" in edit)) continue;
      if (!made.has(edit.endpoint) && !reviewedRefs.has(edit.endpoint))
        return "open the original source and wait for its refreshed items";
      const source = graph.get(edit.endpoint);
      if (
        (!source && !made.has(edit.endpoint)) ||
        (store.readTextTitle(edit.endpoint)?.gone && !made.has(edit.endpoint))
      )
        return "the original source is not loaded";
      const owner = edit.kind === "relink" ? edit.destination : edit.endpoint;
      if (!made.has(owner) && !reviewedRefs.has(owner))
        return "open the original destination and wait for its refreshed items";
      const placement = graph.get(owner);
      if (!placement && !made.has(owner))
        return "the original destination is not loaded";
      if (
        "after" in edit &&
        edit.after !== null &&
        !placement?.links.some((link) => link.link_id === edit.after) &&
        ![...intent.materialization, ...intent.edits].some(
          (prior) =>
            "link_id" in prior &&
            prior.link_id === edit.after &&
            prior.kind === "insert_note",
        )
      )
        return "the original predecessor is not loaded; the change cannot move to another slot";
      if (
        (edit.kind === "move" ||
          edit.kind === "remove" ||
          edit.kind === "relink") &&
        !source?.links.some((link) => link.link_id === edit.link_id)
      )
        return "the original connection is no longer loaded";
    }
    return null;
  }

  return {
    status,
    failedIntents: failed.value.map((intent) => ({
      drafts: intent.drafts,
      placements: intent.edits.flatMap((edit) => "endpoint" in edit ? [{
        source: graph.get(edit.endpoint)?.source.item.label ?? "original item (not loaded)",
        after: "after" in edit && edit.after !== null
          ? graph.get(edit.kind === "relink" ? edit.destination : edit.endpoint)?.links.find((link) => link.link_id === edit.after)?.target.item.label ?? "original predecessor (not loaded)"
          : "the start",
      }] : []),
      problem: retryProblem(intent),
    })),
    retryFailed() {
      const intent = failed.read()[0];
      if (!intent || retryProblem(intent) !== null) return;
      const drafts = new Map(
        intent.drafts.map((draft) => [draft.ref, draft.body]),
      );
      const edits = intent.edits.map((edit) => {
        if (edit.kind !== "insert_note" && edit.kind !== "set_body") return edit;
        return {
          ...edit,
          body_pm_json:
            drafts.get(model.noteRef(edit.note_id))?.body_pm_json ??
            edit.body_pm_json,
        };
      });
      failed.set((prior) => prior.slice(1));
      const materialization = intent.materialization.map((edit) =>
        edit.kind === "insert_note"
          ? {
              ...edit,
              body_pm_json:
                drafts.get(model.noteRef(edit.note_id))?.body_pm_json ??
                edit.body_pm_json,
            }
          : edit,
      );
      commit(edits, intent.after, true, intent.before, materialization);
    },
    retrying,
    failure,
    root: root ? (graph.get(root) ?? null) : null,
    complete: graph.get(endpoint)?.complete ?? false,
    more: sharedRead.more,
    position(row?: model.Row) {
      const owner = row?.endpoint ?? endpoint;
      const data = graph.get(owner);
      if (!data) return null;
      const index = row
        ? data.links.findIndex((link) => link.link_id === row.link.link_id)
        : data.links.length;
      if (index < 0 || (row && pendingUnlinks.has(row.link.link_id))) return null;
      const after = data.links[index - 1]?.link_id ?? null;
      if (after !== null && pendingUnlinks.has(after)) return null;
      return {
        after,
        expected_links_version: data.links_version,
      };
    },
    insertionSource(row?: model.Row) {
      const owner = row?.endpoint ?? endpoint;
      return latent && dailyDate && owner === draft.current?.page
        ? { kind: "daily_page" as const, local_date: dailyDate }
        : { kind: "resource" as const, ref: owner };
    },
    referencePrelude(row?: model.Row) {
      const owner = row?.endpoint ?? endpoint;
      if (
        !latent ||
        !draft.current ||
        owner !== model.noteRef(draft.current.note)
      )
        return [];
      return wireEdits(materialize(draft.current), (ref) => {
        const captured = graph.get(ref)?.links_version;
        if (captured === undefined)
          throw new Error(
            "a latent reference requires its captured daily source",
          );
        return captured;
      });
    },
    undoCreated(result: InsertionOut) {
      const edge = result.connection.edge_id;
      if (currentVisit.current !== visitId) {
        sendUnlink({ commands: [{ kind: "unlink", link_id: edge, require_unannotated: true }], preserve: null, occurrence: null });
        return;
      }
      const prior = history.current;
      const applied = prior.items.slice(0, prior.index);
      const created = applied.find((item) => item.kind === "creation" && item.forward.length === 1 && item.forward[0]?.link_id === edge);
      if (!created || created.kind !== "creation") return;
      const edges = new Set([edge]);
      const kept = applied.filter((item) => item !== created && !dependsOnEdges(item, edges));
      const redo = prior.items.slice(prior.index).filter((item) => !dependsOnEdges(item, edges));
      history.current = { ...prior, items: [...kept, created, ...redo], index: kept.length };
      const occurrence = rows.find((row) => row.link.link_id === edge)?.key ?? null;
      if (!sendUnlink({ commands: created.inverse, preserve: created, occurrence })) history.current = prior;
    },
    inserted(result: InsertionOut, owner: string, position: Position | null) {
      if (currentVisit.current !== visitId) return;
      setActiveReference(null);
      const source = result.connection.source.ref;
      const target = result.connection.target.ref;
      if (latent) {
        // Keep the local draft projection until the daily read confirms its
        // materialized row; the old empty envelope must not erase its zoom path.
        read.refetch();
      }
      if (result.created) {
        const forward: model.Edit = {
          kind: "insert_link",
          endpoint: owner,
          target: source === owner ? target : source,
          link_id: result.connection.edge_id,
          after: position?.after ?? null,
          append: position === null,
          require_created: true,
        };
        const items = history.current.items.slice(0, history.current.index);
        items.push({
          kind: "creation",
          forward: [forward],
          inverse: [{ kind: "unlink", link_id: result.connection.edge_id, require_unannotated: true }],
          refs: new Set([source, target]),
          selBefore: selection,
          selAfter: selection,
        });
        history.current = { ...history.current, items, index: items.length };
      }
    },
    latent,
    rows,
    projectRows(focused: string) {
      return root ? model.outlineRows(graph, root, view.current, focused) : [];
    },
    endpoint,
    zoomed: view.current.zoom.length > 0,
    selection,
    activeReference,
    setReferenceActive(key: string, active: boolean) {
      if (currentVisit.current !== visitId) return;
      setActiveReference((current) =>
        active ? key : current === key ? null : current,
      );
    },
    focus,
    pendingUnlinks: new Set(pendingUnlinks),
    canUnlink,
    markInteraction,
    node(ref: string) {
      const loaded = graph.get(ref)?.source;
      if (loaded) return loaded;
      for (const value of graph.values()) {
        const node = value.links.find((link) => link.target.item.ref === ref)?.target;
        if (node) return node;
      }
      return null;
    },
    reload: dailyDate ? read.refetch : sharedRead.refetch,
    adoptBranch,
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
      rerender();
    },
    zoom(row: model.Row) {
      if (!model.isNoteRow(row)) return;
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
      store.editText(ref, edit.after, edit.referenceBase);
    },
    boundary: () => void (boundaryNext.current = true),
    undo: () => step(false),
    redo: () => step(true),
    split(row: model.Row, left: NoteBody, right: NoteBody) {
      if (!model.structuralRow(row)) return;
      const { edits, key } = model.splitEdits(row, left, right);
      const end = docFromBody(left).firstChild!.content.size + 1;
      const before: Selection = { kind: "text", key: row.key, anchor: end, head: end };
      if (commit(edits, { kind: "text", key, anchor: 1, head: 1 }, true, before)) focusRow(key, { anchor: 1, head: 1 });
    },
    join(row: model.Row, direction: "backward" | "forward") {
      if (latent) return;
      const joined = model.joinEdits(graph, rows, row, direction, textBody);
      if (!joined) return;
      if ("refused" in joined)
        return feedback.offer({ key: "outline-write", announcement: "Polite", content: { tone: "Neutral", title: joined.refused } });
      const at = { anchor: joined.caret, head: joined.caret };
      const before: Selection = { kind: "text", key: row.key, anchor: 1, head: 1 };
      if (commit(joined.edits, { kind: "text", key: joined.earlier.key, ...at }, true, before)) focusRow(joined.earlier.key, at);
    },
    /** `at` is the row editor's selection, kept across the move. */
    indent(row: model.Row, at: FocusSelection = "end") {
      const parent = model.indentParent(rows, row);
      if (!parent || !model.structuralRow(row) || !root) return;
      if (!graph.get(parent.link.target.item.ref)?.complete) {
        view.current.folds.set(parent.key, true);
        rerender();
        feedback.offer({ key: "outline-placement", announcement: "Polite", content: { tone: "Neutral", title: "show the linked resources before indenting here" } });
        return;
      }
      const edits = model.indentEdits(graph, model.outlineRows(graph, root, view.current), row);
      if (!edits || edits[0]?.kind !== "relink") return;
      view.current.folds.set(parent.key, true);
      const key = [...parent.path, edits[0].new_link_id].join("/");
      if (commit(edits, landing(key))) follow(key, at);
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
    canInsert(at: InsertAt) {
      return insertionPosition(at, rowsByKey) !== null;
    },
    insert(at: InsertAt) {
      const fresh = root ? model.outlineRows(graph, root, view.current) : [];
      const position = insertionPosition(
        at,
        new Map(fresh.map((row) => [row.key, row])),
      );
      if (!position) return;
      if (
        typeof at === "string" &&
        latent &&
        draft.current?.page === position.endpoint
      )
        return focusRow(draft.current.link);
      const link_id = crypto.randomUUID();
      const key = [...position.parentPath, link_id].join("/");
      const before: Selection =
        selection ??
        (position.row
          ? { kind: "blocks", anchor: position.row.key, keys: [position.row.key] }
          : { kind: "text", key: "", anchor: 1, head: 1 });
      if (commit(
        [
          {
            kind: "insert_note",
            endpoint: position.endpoint,
            link_id,
            note_id: crypto.randomUUID(),
            after: position.after,
            body_pm_json: emptyBody().body_pm_json,
          },
        ],
        { kind: "text", key, anchor: 1, head: 1 },
        true,
        before,
      )) focusRow(key, { anchor: 1, head: 1 });
    },
    persisted(ref: string) {
      return store.readText(ref)?.acked !== null;
    },
    drop(
      row: model.Row,
      target: model.Row,
      placement: "before" | "after" | "inside",
    ) {
      if (
        placement === "inside" &&
        !graph.get(target.link.target.item.ref)?.complete
      ) {
        view.current.folds.set(target.key, true);
        rerender();
        feedback.offer({
          key: "outline-placement",
          announcement: "Polite",
          content: {
            tone: "Neutral",
            title: "show the linked resources before moving inside this item",
          },
        });
        return;
      }
      const edits = model.dropEdits(graph, row, target, placement);
      if (!edits) return;
      if (placement === "inside") view.current.folds.set(target.key, true);
      commit(edits, selection);
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
        commit([], selection, false, selection, commands);
      }
      store.editText(root, title);
    },
  };
}
