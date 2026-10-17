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
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import { apiFetch, type ApiPath } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { docFromBody, emptyBody, parseBody, type NoteBody } from "@/lib/notes/noteBody";
import * as model from "@/lib/notes/outline";
import * as store from "@/lib/notes/texts";
import { enqueueWrite } from "@/lib/notes/writes";
import { subscribeLinkMutations } from "@/lib/resourceGraph/links";
import { resolveResourceItem } from "@/lib/resources/items";

type Reply = Schema<"OutlineCommandsOut">;

// ---- the tab-wide graph ------------------------------------------------------------

const graph: model.Graph = new Map();
const latest = new Map<string, model.OutlineData>();
const loading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
/** The texts each unsettled structure write carries, by its serial. */
const carried = new Map<number, ReadonlySet<string>>();
let pendingStructure = 0;
let jobSerial = 0;
let cancelledBefore = 0;
let refusals = 0;
let reportRefusal: (error: unknown) => void = () => undefined;

function publish() {
  for (const listener of listeners) listener();
}

function adopt(outline: model.OutlineData) {
  graph.set(outline.source.ref, outline);
  for (const node of [outline.source, ...outline.links.map((l) => l.target)]) {
    const body = bodyOf(node);
    if (body && node.content.kind === "note")
      store.adoptText(node.ref, body, node.content.body_version);
    else if (node.content.kind === "page" && node === outline.source)
      store.adoptText(node.ref, node.content.title, node.content.title_version);
  }
}

/** Keep a reply's outlines until no structure write is pending, then adopt them all. */
function receive(outlines: readonly model.OutlineData[]) {
  for (const outline of outlines) latest.set(outline.source.ref, outline);
  if (pendingStructure > 0) return;
  for (const outline of latest.values()) adopt(outline);
  latest.clear();
}

/** Read `ref`'s outline (again when `force`); a loaded outline keeps its optimistic
 * state while structure writes are pending. */
function load(ref: string, force = false): Promise<void> {
  if (!force && graph.has(ref)) return Promise.resolve();
  const inflight = loading.get(ref);
  if (inflight) return inflight;
  const path = `/api/notes/outline/${encodeURIComponent(ref)}` as ApiPath;
  const request = apiFetch<ApiJson<"/notes/outline/{ref}", "get">>(path, {
    cache: "no-store",
  })
    .then(({ data }) => {
      if (!graph.has(ref) || pendingStructure === 0) adopt(data);
    })
    .finally(() => {
      loading.delete(ref);
      publish();
    });
  loading.set(ref, request);
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

/**
 * Send one structure batch. Expected versions are read when it is sent, after every
 * earlier write settled; `removed` names the note each remove's link pointed at.
 */
function sendEdits(
  edits: readonly model.Edit[],
  removed: ReadonlyMap<string, string>,
  texts: ReadonlySet<string>,
) {
  const serial = ++jobSerial;
  pendingStructure += 1;
  carried.set(serial, texts);
  enqueueWrite<Reply>({
    build() {
      if (serial <= cancelledBefore) return null;
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
      if (edits.some((edit) => edit.kind === "ensure_daily")) publishChange("Notes");
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
  for (const ref of reply.deleted) if (!later.some((refs) => refs.has(ref))) store.setGone(ref);
  const inserted = new Set(
    edits.flatMap((e) => (e.kind === "insert_note" ? [model.noteRef(e.note_id)] : [])),
  );
  const targets = reply.outlines.flatMap((outline) => outline.links.map((l) => l.target));
  for (const node of [...reply.nodes, ...targets.filter((t) => inserted.has(t.ref))]) {
    const body = bodyOf(node);
    if (body && node.content.kind === "note")
      store.acknowledgeText(node.ref, body, node.content.body_version);
  }
}

/** Cancel this write and every queued structure write; reload; reset their texts. */
function refuse(error: unknown, serial: number) {
  const texts = new Set<string>();
  for (const [at, refs] of carried) if (at >= serial) refs.forEach((r) => texts.add(r));
  carried.clear();
  cancelledBefore = jobSerial;
  pendingStructure = 0;
  refusals += 1;
  latest.clear();
  for (const ref of texts) store.resetText(ref);
  for (const ref of graph.keys()) void load(ref, true).catch(() => undefined);
  reportRefusal(error);
  publish();
}

// ---- one pane ---------------------------------------------------------------------

export type Selection =
  | { kind: "text"; key: string; anchor: number; head: number }
  | { kind: "blocks"; anchor: string; keys: readonly string[] }
  | null;

export interface NoteEdit {
  before: NoteBody;
  after: NoteBody;
  selectionBefore: { anchor: number; head: number };
  selectionAfter: { anchor: number; head: number };
  source: "input" | "composition" | "paste" | "format" | "attachment";
}

type Item = { selBefore: Selection; selAfter: Selection } & (
  | { kind: "text"; ref: string; before: NoteBody; after: NoteBody; at: number }
  | { kind: "structure"; forward: readonly model.Edit[]; inverse: readonly model.Edit[] }
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
  graph.set(node.ref, { source: node, links: [{ ...link, target: outline.source }] });
  store.createText(node.ref, emptyBody(), {
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
      const made = outlines.flatMap((o) => o.links).find((l) => l.target.ref === node.ref);
      return made?.target.content.kind === "note" ? made.target.content.body_version : 1;
    },
  });
}

/** A page (`root`) or a day (`dailyDate`, latent until its first write). */
export function useOutline(input: { root: string | null; dailyDate: string | null }) {
  const { dailyDate } = input;
  const feedback = useFeedback();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [latentDate, setLatentDate] = useState<string | null>(null);
  const latent = dailyDate !== null && latentDate === dailyDate;
  const [selection, setSelection] = useState<Selection>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const view = useRef({ folds: new Map<string, boolean>(), zoom: [] as string[] });
  const history = useRef({ items: [] as Item[], index: 0, refusals });
  const boundaryNext = useRef(true);
  const draft = useRef<Draft | null>(null);
  const resolved = useRef(new Map<string, model.OutlineNode>());

  useEffect(() => {
    listeners.add(rerender);
    return () => void listeners.delete(rerender);
  }, []);
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
        const page = data.outline.source.ref;
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
      await load(input.root, true);
      signal.throwIfAborted();
      return input.root;
    },
  });
  const root = input.root ?? (read.status === "ready" ? read.data : null);
  const failure = read.status === "loading" ? null : read.error;
  // Entry commands wait for the refreshed outline; retained editors stay mounted.
  const status = failure !== null ? "failed" : read.status === "ready" && read.refreshing ? "loading" : read.status;
  const retrying = read.status === "failed" ? read.retrying : read.status === "ready" && read.refreshing;

  useEffect(
    () =>
      subscribeLinkMutations((mutation) => {
        const refs =
          mutation.kind === "created"
            ? [mutation.sourceRef, mutation.targetRef].filter((ref) => graph.has(ref))
            : [...graph].flatMap(([ref, o]) =>
                o.links.some((l) => l.link_id === mutation.linkId) ? [ref] : [],
              );
        for (const ref of refs) void load(ref, true).catch(() => undefined);
      }),
    [],
  );

  const rows = root && graph.has(root) ? model.outlineRows(graph, root, view.current) : [];
  const endpoint = (root && model.zoomEndpoint(graph, root, view.current.zoom)) ?? root ?? "";

  const focusRow = useCallback((key: string, at: FocusSelection = "end") => {
    setFocus((current) => ({ key, selection: at, serial: (current?.serial ?? 0) + 1 }));
    setSelection(null);
  }, []);

  /** Apply, send and (unless replaying history) record one structure batch. */
  function commit(edits: readonly model.Edit[], after: Selection, record = true, before = selection) {
    if (!edits.length) return;
    const removed = new Map<string, string>();
    for (const edit of edits) {
      if (edit.kind !== "remove") continue;
      const link = graph.get(edit.endpoint)?.links.find((l) => l.link_id === edit.link_id);
      if (link?.target.content.kind === "note") removed.set(edit.link_id, link.target.ref);
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
      store.createText(model.noteRef(made.note), textBody(made.note), null);
      setLatentDate(null);
    }
    sendEdits(made ? [...materialize(made), ...edits] : edits, removed, texts);
    if (record) {
      const items = history.current.items.slice(0, history.current.index);
      items.push({ kind: "structure", forward: edits, inverse, selBefore: before, selAfter: after });
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
      if (!row.open) void load(row.link.target.ref, pendingStructure === 0).catch(() => undefined);
      rerender();
    },
    zoom(row: model.Row) {
      if (row.terminal === null) {
        void load(row.link.target.ref).catch(() => undefined);
        view.current.zoom = [...row.path];
        setSelection(null);
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
      void load(parent.link.target.ref).then(() => {
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
    /** An empty row first or last, focused; a latent day focuses its draft instead. */
    insert(at: "start" | "end") {
      if (latent && draft.current) return focusRow(draft.current.link);
      const link_id = crypto.randomUUID();
      const key = [...view.current.zoom, link_id].join("/");
      const after = at === "start" ? null : (graph.get(endpoint)?.links.at(-1)?.link_id ?? null);
      const body_pm_json = emptyBody().body_pm_json;
      const note_id = crypto.randomUUID();
      commit(
        [{ kind: "insert_note", endpoint, link_id, note_id, after, body_pm_json }],
        { kind: "text", key, anchor: 1, head: 1 },
      );
      focusRow(key, { anchor: 1, head: 1 });
    },
    drop(row: model.Row, target: model.Row, placement: "before" | "after" | "inside") {
      const destination = placement === "inside" ? target.link.target.ref : target.endpoint;
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
          for (const { ref, label, summary, missing, activation } of found)
            resolved.current.set(ref, { ref, label, summary, missing, activation, content: { kind: "resource" } });
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
      if (latent && dailyDate) {
        sendEdits([{ kind: "ensure_daily", local_date: dailyDate }], new Map(), new Set());
        setLatentDate(null);
      }
      store.editText(root, title);
    },
  };
}
