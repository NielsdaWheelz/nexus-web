// The outline model: pure functions over a graph of loaded endpoint outlines. Rows are
// the root's (or the zoomed endpoint's) links, expanded through open, loaded notes; a
// row's identity is its path of link ids. Traversed edges are omitted; another edge
// to a branch ancestor is terminal. Zoom starts a fresh branch while preserving the
// path used to address edits. Edits are the server's primitives minus their
// expected versions and preserving unlink (which has its own acknowledgement-only
// sender). The queue reads versions when it sends. Applying a structural edit returns
// its inverse, so undo is one more edit. A new link is mirrored into its other
// endpoint's outline when that one is loaded (the server ranks it last there).
import { DOMParser as PMParser, Fragment } from "prosemirror-model";
import type { Schema } from "@/lib/api/wire";
import {
  bodyFromNode,
  bodyText,
  docFromBody,
  noteBodySchema,
  parseBody,
  type NoteBody,
} from "@/lib/notes/noteBody";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { classifyOutlineOccurrence, enterOutlineOccurrence, type OutlineBranch, type OutlineTarget } from "@/lib/resources/outlineProjection";
import { RESOURCE_CLIPBOARD_TYPE } from "@/lib/ui/copyText";
import { expectRecord, expectString } from "@/lib/validation";

export type WireOutline = Schema<"OutlineOut">;
export type OutlineNode = Schema<"OutlineNodeOut">;
export type OutlineLink = {
  link_id: string;
  has_link_note: boolean;
  target: OutlineNode;
  connection: Schema<"ConnectionOut"> | null;
};
export type OutlineData = {
  source: OutlineNode;
  links: OutlineLink[];
  links_version: number;
  complete: boolean;
};
/** Pure projection of mixed occurrences. Content identity is always connection.other. */
export function projectOutline(value: WireOutline): OutlineData {
  return {
    source: value.source,
    links_version: value.links_version,
    complete: value.next_cursor === null,
    links: value.items.map(({ connection, content }) => ({
      link_id: connection.edge_id,
      has_link_note: connection.link_note !== null,
      target: { item: connection.other, content },
      connection,
    })),
  };
}
export type Unlink = Schema<"Unlink">;
export type Edit =
  | {
      kind: "insert_note";
      endpoint: string;
      link_id: string;
      note_id: string;
      after: string | null;
      body_pm_json: Schema<"InsertNote">["body_pm_json"];
    }
  | {
      kind: "insert_link";
      endpoint: string;
      link_id: string;
      target: string;
      after: string | null;
      append?: boolean;
      require_created: boolean;
    }
  | { kind: "move"; endpoint: string; link_id: string; after: string | null }
  | {
      kind: "relink";
      endpoint: string;
      link_id: string;
      destination: string;
      new_link_id: string;
      after: string | null;
    }
  | { kind: "remove" | "consume_note"; endpoint: string; link_id: string }
  | {
      kind: "set_body";
      note_id: string;
      body_pm_json: Schema<"SetBody">["body_pm_json"];
    }
  | { kind: "set_title"; page_id: string; title: string }
  | { kind: "ensure_daily"; local_date: string; page_id: string };
export type Graph = Map<string, OutlineData>;

export interface Row {
  readonly key: string;
  readonly path: readonly string[];
  readonly endpoint: string;
  readonly link: OutlineLink;
  readonly depth: number;
  readonly terminal: OutlineTarget | null;
  readonly open: boolean;
  readonly loaded: boolean;
}

export interface View {
  readonly folds: ReadonlyMap<string, boolean>;
  readonly zoom: readonly string[];
}

export type ClipItem =
  | { kind: "note"; body: NoteBody; parent: number | null }
  | { kind: "resource"; ref: string; label: string; parent: number | null };

export const OUTLINE_CLIPBOARD_TYPE = "application/x-nexus-outline+json";
export const noteRef = (id: string) => `note_block:${id}`;
export const noteIdOf = (ref: string) => ref.slice("note_block:".length);
export const isNoteRow = (row: Row) =>
  row.terminal === null && row.link.target.content.kind === "note";
export const structuralRow = (row: Row) => isNoteRow(row) && !row.link.has_link_note && (row.link.connection === null || row.link.connection.origin === "user");
const uuid = () => crypto.randomUUID();

/** The zoomed endpoint, or null when the zoom path no longer resolves. */
export function zoomEndpoint(
  graph: Graph,
  root: string,
  zoom: readonly string[],
): string | null {
  let ref: string | null = root;
  for (const id of zoom) {
    ref = graph.get(ref)?.links.find((l) => l.link_id === id)?.target.item.ref ?? null;
    if (ref === null) return null;
  }
  return ref;
}

export function outlineRows(graph: Graph, root: string, view: View, focused: string | null = null): Row[] {
  const rows: Row[] = [];
  const start = zoomEndpoint(graph, root, view.zoom);
  if (start === null) return rows;
  const visit = (
    endpoint: string,
    path: readonly string[],
    depth: number,
    branch: OutlineBranch,
  ) => {
    for (const link of graph.get(endpoint)?.links ?? []) {
      const target = link.target.item.ref;
      const projection = classifyOutlineOccurrence({ branch, targetRef: target, edgeId: link.link_id });
      if (projection.kind === "omit") continue;
      const next = [...path, link.link_id];
      const key = next.join("/");
      const terminal = projection.kind === "reference" ? projection.target : null;
      const loaded = graph.has(target);
      const open =
        terminal === null && (view.folds.get(key) ?? false);
      rows.push({ key, path: next, endpoint, link, depth, terminal, open, loaded });
      if (open && loaded) visit(target, next, depth + 1, key === focused ? {
        ancestors: new Map([[target, { kind: "root" }]]), traversedEdgeIds: new Set(),
      } : enterOutlineOccurrence({
        branch, ref: target, target: { kind: "occurrence", key }, edgeIds: [link.link_id],
      }));
    }
  };
  visit(start, view.zoom, 0, {
    ancestors: new Map([[start, { kind: "root" }]]), traversedEdgeIds: new Set(),
  });
  return rows;
}

/** The note's places as far as this tab knows: the server's count, or more if it has
 * linked notes into it since. */
export function placesOf(graph: Graph, node: OutlineNode): number {
  if (node.content.kind !== "note") return 0;
  const places = graph.get(node.item.ref)?.links.filter((link) => {
    const connection = link.connection;
    if (connection === null || connection.origin === "user") return true;
    if (connection.target.ref === node.item.ref)
      return connection.origin === "highlight_note" || connection.origin === "citation";
    return connection.source.ref === node.item.ref && connection.origin === "link_note";
  }).length ?? 0;
  return Math.max(node.content.places, places);
}

export function newNoteNode(id: string, body: NoteBody): OutlineNode {
  const ref = noteRef(id);
  return {
    item: {
      ref, action_ref: ref, label: body.body_text.split("\n")[0] || "Note", missing: false,
      activation: { resource_ref: ref, kind: "route", href: `/notes/${id}`, unavailable_reason: null },
      preview: { body: { kind: "prose", excerpt: { text: body.body_text, truncated_before: false, truncated_after: false }, role: null, format: "plain", image_count: 0 }, source: null, annotation: null },
    },
    content: { kind: "note", ...body, body_version: 1, places: 1, embedded_item: null },
  };
}

function nodeOf(graph: Graph, ref: string): OutlineNode | null {
  for (const outline of graph.values()) {
    if (outline.source.item.ref === ref) return outline.source;
    const link = outline.links.find((l) => l.target.item.ref === ref);
    if (link) return link.target;
  }
  return null;
}

function afterOf(links: readonly OutlineLink[], linkId: string): string | null {
  const index = links.findIndex((l) => l.link_id === linkId);
  return index > 0 ? links[index - 1]!.link_id : null;
}

function insertLink(
  graph: Graph,
  endpoint: string,
  link: OutlineLink,
  after: string | null,
) {
  const outline = graph.get(endpoint);
  // justify-defect: edits are built from loaded endpoints only.
  if (!outline) throw new Error(`Outline ${endpoint} is not loaded`);
  const links = outline.links.filter((l) => l.link_id !== link.link_id);
  const at = after === null ? 0 : links.findIndex((l) => l.link_id === after) + 1;
  links.splice(at, 0, link);
  graph.set(endpoint, { ...outline, links });
  const other = graph.get(link.target.item.ref);
  if (other && !other.links.some((l) => l.link_id === link.link_id)) {
    const mirror = { ...link, target: outline.source };
    graph.set(link.target.item.ref, { ...other, links: [...other.links, mirror] });
  }
}

function dropLink(graph: Graph, linkId: string) {
  for (const [ref, outline] of graph) {
    if (!outline.links.some((l) => l.link_id === linkId)) continue;
    graph.set(ref, {
      ...outline,
      links: outline.links.filter((l) => l.link_id !== linkId),
    });
  }
}

/**
 * Apply one edit to `graph` and return the edits that undo it. `body` reads a note's
 * current text (for undoing a removal or a body write); `node` places a resource the
 * graph has not seen (a paste).
 */
export function applyEdit(
  graph: Graph,
  edit: Edit,
  body: (noteId: string) => NoteBody,
  node: (ref: string) => OutlineNode | null = () => null,
): Edit[] {
  switch (edit.kind) {
    case "set_body": {
      const before = body(edit.note_id).body_pm_json;
      return [{ kind: "set_body", note_id: edit.note_id, body_pm_json: before }];
    }
    case "set_title":
    case "ensure_daily":
      return [];
    case "insert_note":
    case "insert_link": {
      const ref = edit.kind === "insert_note" ? noteRef(edit.note_id) : edit.target;
      let target = nodeOf(graph, ref) ?? node(ref);
      if (!target && edit.kind === "insert_note") {
        target = newNoteNode(edit.note_id, parseBody(edit.body_pm_json));
        graph.set(ref, { source: target, links: [], links_version: 1, complete: true });
      }
      // justify-defect: a pasted resource is resolved before it is inserted.
      if (!target) throw new Error(`Outline target ${ref} is unknown`);
      const link = { link_id: edit.link_id, has_link_note: false, target, connection: null };
      if (edit.kind === "insert_link" && edit.append && !graph.get(edit.endpoint)?.complete) return [];
      insertLink(graph, edit.endpoint, link, edit.kind === "insert_link" && edit.append ? graph.get(edit.endpoint)?.links.at(-1)?.link_id ?? null : edit.after);
      return [{ kind: "remove", endpoint: edit.endpoint, link_id: edit.link_id }];
    }
    case "move": {
      const links = graph.get(edit.endpoint)!.links;
      const link = links.find((l) => l.link_id === edit.link_id)!;
      const after = afterOf(links, edit.link_id);
      insertLink(graph, edit.endpoint, link, edit.after);
      return [{ ...edit, after }];
    }
    case "relink": {
      const links = graph.get(edit.endpoint)!.links;
      const link = links.find((l) => l.link_id === edit.link_id)!;
      const after = afterOf(links, edit.link_id);
      dropLink(graph, edit.link_id);
      insertLink(graph, edit.destination, { ...link, link_id: edit.new_link_id }, edit.after);
      return [
        {
          kind: "relink",
          endpoint: edit.destination,
          link_id: edit.new_link_id,
          destination: edit.endpoint,
          new_link_id: edit.link_id,
          after,
        },
      ];
    }
    case "consume_note":
    case "remove": {
      const links = graph.get(edit.endpoint)?.links ?? [];
      const link = links.find((l) => l.link_id === edit.link_id);
      if (!link) return [];
      const after = afterOf(links, edit.link_id);
      dropLink(graph, edit.link_id);
      const { endpoint, link_id } = edit;
      const target = link.target.item.ref;
      if (link.target.content.kind !== "note")
        return [{ kind: "insert_link", endpoint, link_id, target, after, require_created: false }];
      const note_id = noteIdOf(target);
      const { body_pm_json } = body(note_id);
      return [{ kind: "insert_note", endpoint, link_id, note_id, after, body_pm_json }];
    }
  }
}

/** Apply a batch in order; its inverse is the single inverses in reverse. */
export function applyEdits(
  graph: Graph,
  edits: readonly Edit[],
  body: (noteId: string) => NoteBody,
  node?: (ref: string) => OutlineNode | null,
): Edit[] {
  return edits.flatMap((edit) => applyEdit(graph, edit, body, node)).reverse();
}

const parentKey = (row: Row) => row.path.slice(0, -1).join("/");

export function siblingsOf(rows: readonly Row[], row: Row): Row[] {
  return rows.filter(
    (r) => r.depth === row.depth && parentKey(r) === parentKey(row),
  );
}

/** The nearest editable note above `row` among its siblings: where Tab indents it. */
export function indentParent(rows: readonly Row[], row: Row): Row | null {
  const siblings = siblingsOf(rows, row);
  const at = siblings.findIndex((r) => r.key === row.key);
  return at < 0 ? null : (siblings.slice(0, at).reverse().find(isNoteRow) ?? null);
}

/** Relink `row` to the end of its preceding sibling note (whose outline is loaded). */
export function indentEdits(graph: Graph, rows: readonly Row[], row: Row): Edit[] | null {
  const parent = indentParent(rows, row);
  if (!structuralRow(row) || !parent || !graph.get(row.endpoint)?.complete) return null;
  const destination = parent.link.target.item.ref;
  const links = graph.get(destination)?.links;
  const target = row.link.target.item.ref;
  if (!links || (destination===null || !graph.get(destination)?.complete) || destination === target || links.some((l) => l.target.item.ref === target))
    return null;
  const after = links.at(-1)?.link_id ?? null;
  return [relink(row, destination, after)];
}

/** Relink `row` to its grandparent, right after its parent. */
export function outdentEdits(graph: Graph, root: string, row: Row): Edit[] | null {
  if (!structuralRow(row) || row.path.length < 2 || !graph.get(row.endpoint)?.complete) return null;
  const destination = zoomEndpoint(graph, root, row.path.slice(0, -2));
  const target = row.link.target.item.ref;
  const links = destination === null ? undefined : graph.get(destination)?.links;
  if (!links || (destination===null || !graph.get(destination)?.complete) || destination === target || links.some((l) => l.target.item.ref === target))
    return null;
  return [relink(row, destination!, row.path.at(-2)!)];
}

function relink(row: Row, destination: string, after: string | null): Edit {
  return {
    kind: "relink",
    endpoint: row.endpoint,
    link_id: row.link.link_id,
    destination,
    new_link_id: uuid(),
    after,
  };
}

export function moveEdits(
  graph: Graph,
  rows: readonly Row[],
  row: Row,
  direction: -1 | 1,
): Edit[] | null {
  const siblings = siblingsOf(rows, row);
  const index = siblings.findIndex((sibling) => sibling.key === row.key);
  if (index < 0) return null;
  const neighbour = siblings[index + direction];
  if (!neighbour) return null;
  const current = graph.get(row.endpoint)?.links;
  if (!current?.some((link) => link.link_id === row.link.link_id)) return null;
  const links = current.filter((link) => link.link_id !== row.link.link_id);
  const at = links.findIndex((link) => link.link_id === neighbour.link.link_id);
  if (at < 0) return null;
  const after =
    direction < 0 ? (links[at - 1]?.link_id ?? null) : neighbour.link.link_id;
  return [
    { kind: "move", endpoint: row.endpoint, link_id: row.link.link_id, after },
  ];
}

/** Enter: `row` keeps `left`; a new note with `right` is linked right after it. */
export function splitEdits(
  row: Row,
  left: NoteBody,
  right: NoteBody,
): { edits: Edit[]; key: string } {
  const link_id = uuid();
  return {
    key: [...row.path.slice(0, -1), link_id].join("/"),
    edits: [
      {
        kind: "set_body",
        note_id: noteIdOf(row.link.target.item.ref),
        body_pm_json: left.body_pm_json,
      },
      {
        kind: "insert_note",
        endpoint: row.endpoint,
        link_id,
        note_id: uuid(),
        after: row.link.link_id,
        body_pm_json: right.body_pm_json,
      },
    ],
  };
}

/**
 * Merge the later of two adjacent sibling paragraph notes into the earlier, removing
 * the later (the place rule then deletes it). Refused, with a reason, when the later
 * note has another place or its link carries a note: the merge would orphan them.
 */
export function joinEdits(
  graph: Graph,
  rows: readonly Row[],
  row: Row,
  direction: "backward" | "forward",
  body: (noteId: string) => NoteBody,
): { edits: Edit[]; earlier: Row; caret: number } | { refused: string } | null {
  const siblings = siblingsOf(rows, row);
  const index = siblings.findIndex((r) => r.key === row.key);
  const [earlier, later] =
    direction === "backward" ? [siblings[index - 1], row] : [row, siblings[index + 1]];
  if (!earlier || !later || !isNoteRow(earlier) || !isNoteRow(later)) return null;
  const left = docFromBody(body(noteIdOf(earlier.link.target.item.ref))).firstChild!;
  const right = docFromBody(body(noteIdOf(later.link.target.item.ref))).firstChild!;
  if (left.type.name !== "paragraph" || right.type.name !== "paragraph") return null;
  if (!structuralRow(later))
    return { refused: "this connection cannot be joined; its note is kept" };
  if (placesOf(graph, later.link.target) > 1)
    return { refused: "This note has its own links, so it can't be joined." };
  const merged = bodyFromNode(left.copy(left.content.append(right.content)));
  return {
    earlier,
    caret: left.content.size + 1,
    edits: [
      {
        kind: "set_body",
        note_id: noteIdOf(earlier.link.target.item.ref),
        body_pm_json: merged.body_pm_json,
      },
      { kind: "consume_note", endpoint: later.endpoint, link_id: later.link.link_id },
    ],
  };
}

/** Drag `row` before, after or inside `target` (a note whose outline is loaded). */
export function dropEdits(
  graph: Graph,
  row: Row,
  target: Row,
  placement: "before" | "after" | "inside",
): Edit[] | null {
  if (row.key === target.key)
    return null;
  if (placement === "inside" && !isNoteRow(target)) return null;
  const destination =
    placement === "inside" ? target.link.target.item.ref : target.endpoint;
  const moved = row.link.target.item.ref;
  const links = graph
    .get(destination)
    ?.links.filter((l) => l.link_id !== row.link.link_id);
  if (!links || (placement === "inside" && !graph.get(destination)?.complete) || destination === moved) return null;
  const index = links.findIndex((l) => l.link_id === target.link.link_id);
  const after =
    placement === "inside"
      ? (links.at(-1)?.link_id ?? null)
      : placement === "after"
        ? target.link.link_id
        : (links[index - 1]?.link_id ?? null);
  if (destination === row.endpoint)
    return [{ kind: "move", endpoint: row.endpoint, link_id: row.link.link_id, after }];
  if (!structuralRow(row) || !graph.get(row.endpoint)?.complete || !graph.get(destination)?.complete || links.some((l) => l.target.item.ref === moved)) return null;
  return [relink(row, destination, after)];
}

// the clipboard: own json (version 3), html lists, indented "- " text, a copied
// resource reference.

export function copyRows(
  selected: readonly Row[],
  body: (noteId: string) => NoteBody,
  clipboard: DataTransfer,
): void {
  const items: ClipItem[] = selected.map((row, index) => {
    const parent = selected.findLastIndex(
      (other, at) =>
        at < index &&
        other.path.length < row.path.length &&
        other.path.every((id, i) => row.path[i] === id),
    );
    const at = parent < 0 ? null : parent;
    const target = row.link.target;
    return isNoteRow(row)
      ? { kind: "note", body: body(noteIdOf(target.item.ref)), parent: at }
      : { kind: "resource", ref: target.item.ref, label: target.item.label, parent: at };
  });
  const depths: number[] = [];
  const lines = items.map((item, index) => {
    depths[index] = item.parent === null ? 0 : depths[item.parent]! + 1;
    const text = item.kind === "note" ? item.body.body_text : item.label;
    return `${"  ".repeat(depths[index]!)}- ${text}`;
  });
  clipboard.setData(OUTLINE_CLIPBOARD_TYPE, JSON.stringify({ version: 3, items }));
  clipboard.setData("text/plain", lines.join("\n"));
}

/** The clipboard as outline items; null when it holds none. TypeError when malformed. */
export function readClipboard(clipboard: DataTransfer): ClipItem[] | null {
  const reference = clipboard.getData(RESOURCE_CLIPBOARD_TYPE);
  if (reference) {
    const ref = expectString(expectRecord(JSON.parse(reference), "reference").ref, "ref");
    if (!parseResourceRef(ref)) throw new TypeError("The copied reference is invalid.");
    return [{ kind: "resource", ref, label: "", parent: null }];
  }
  const own = clipboard.getData(OUTLINE_CLIPBOARD_TYPE);
  const value = own ? expectRecord(JSON.parse(own), "outline clipboard") : null;
  if (value?.version === 3 && Array.isArray(value.items)) {
    return value.items.map((raw: unknown, index: number): ClipItem => {
      const item = expectRecord(raw, "outline item");
      const parent = item.parent === null ? null : Number(item.parent);
      if (parent !== null && !(Number.isInteger(parent) && parent >= 0 && parent < index))
        throw new TypeError("Copied outline parents must precede their children.");
      if (item.kind === "note") {
        const body = parseBody(expectRecord(item.body, "outline body").body_pm_json);
        return { kind: "note", body, parent };
      }
      const ref = expectString(item.ref, "outline item ref");
      if (!parseResourceRef(ref)) throw new TypeError("A copied item is invalid.");
      return { kind: "resource", ref, label: expectString(item.label, "label"), parent };
    });
  }
  return (
    htmlItems(clipboard.getData("text/html")) ??
    textItems(clipboard.getData("text/plain"))
  );
}

function htmlItems(html: string): ClipItem[] | null {
  if (!html) return null;
  const body = new DOMParser().parseFromString(html, "text/html").body;
  const roots = [...body.querySelectorAll("ul, ol")].filter(
    (list) => !list.parentElement?.closest("ul, ol"),
  );
  const rest = body.cloneNode(true) as HTMLElement;
  rest.querySelectorAll("ul, ol").forEach((list) => list.remove());
  if (!roots.length || rest.textContent?.trim()) return null;
  const items: ClipItem[] = [];
  const visit = (list: Element, parent: number | null) => {
    for (const li of list.children) {
      if (li.tagName !== "LI") continue;
      const own = li.cloneNode(true) as HTMLElement;
      own.querySelectorAll("ul, ol").forEach((nested) => nested.remove());
      const slice = PMParser.fromSchema(noteBodySchema).parseSlice(own);
      const blocks: PMNode[] = [];
      slice.content.forEach((node) => void blocks.push(node));
      items.push({ kind: "note", body: listItemBody(blocks), parent });
      const index = items.length - 1;
      for (const nested of li.querySelectorAll(":scope > ul, :scope > ol"))
        visit(nested, index);
    }
  };
  roots.forEach((list) => visit(list, null));
  return items;
}

type PMNode = Parameters<typeof bodyFromNode>[0];

/** One list item as one body: a lone block as is, else paragraphs joined by breaks. */
function listItemBody(blocks: readonly PMNode[]): NoteBody {
  if (blocks.length === 1 && blocks[0]!.isBlock) return bodyFromNode(blocks[0]!);
  let inline = Fragment.empty;
  for (const block of blocks) {
    if (block.isInline) {
      inline = inline.append(Fragment.from(block));
      continue;
    }
    if (block.type !== noteBodySchema.nodes.paragraph)
      throw new TypeError("A pasted list item must hold one supported body.");
    if (inline.size)
      inline = inline.addToEnd(noteBodySchema.nodes.hard_break!.create());
    inline = inline.append(block.content);
  }
  return bodyFromNode(noteBodySchema.nodes.paragraph!.create(null, inline));
}

function textItems(text: string): ClipItem[] | null {
  const parents: { indent: number; index: number }[] = [];
  const items = text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index): ClipItem => {
      const [, space = "", rest = ""] = /^(\s*)(?:[-*+]\s+)?(.*)$/.exec(line)!;
      const indent = space.replaceAll("\t", "  ").length;
      while (parents.length && parents.at(-1)!.indent >= indent) parents.pop();
      const parent = parents.at(-1)?.index ?? null;
      parents.push({ indent, index });
      return { kind: "note", body: bodyText(rest), parent };
    });
  return items.length ? items : null;
}

/**
 * Paste `items` after `after` at `endpoint`; a child goes last under its pasted parent.
 * TypeError when an item cannot be linked there (a resource holding children, a
 * resource the endpoint already links, or the endpoint itself).
 */
export function pasteEdits(
  graph: Graph,
  items: readonly ClipItem[],
  endpoint: string,
  after: string | null,
): Edit[] {
  const refs: string[] = [];
  const last = new Map<string, string | null>([[endpoint, after]]);
  const linked = new Set(
    (graph.get(endpoint)?.links ?? []).map((l) => `${endpoint} ${l.target.item.ref}`),
  );
  return items.map((item, index) => {
    const parent = item.parent === null ? endpoint : refs[item.parent]!;
    if (item.parent !== null && items[item.parent]!.kind !== "note")
      throw new TypeError("Only notes can hold pasted items.");
    const link_id = uuid();
    const position = last.get(parent) ?? null;
    last.set(parent, link_id);
    if (item.kind === "resource") {
      const pair = `${parent} ${item.ref}`;
      if (item.ref === parent || linked.has(pair))
        throw new TypeError("That item is already linked here.");
      linked.add(pair);
      refs[index] = item.ref;
      return { kind: "insert_link", endpoint: parent, link_id, target: item.ref, after: position, require_created: false };
    }
    const note_id = uuid();
    refs[index] = noteRef(note_id);
    const body_pm_json = item.body.body_pm_json;
    return { kind: "insert_note", endpoint: parent, link_id, note_id, after: position, body_pm_json };
  });
}
