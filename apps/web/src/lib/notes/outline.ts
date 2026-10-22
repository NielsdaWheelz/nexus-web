// Pure projection of one exact endpoint branch and inversion of structural edits.
// Display prefixes distinguish placements while Row.path contains only edge ids.
// Read owners compose recursive branches; canonical body knowledge never proves
// complete adjacency. Explicit positions preserve first, append and source fences.
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
import {
  endpointForResource,
  type InsertionSource,
  type Position,
} from "@/lib/resourceGraph/links";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import {
  classifyOutlineOccurrence,
  type OutlineBranch,
  type OutlineTarget,
} from "@/lib/resources/outlineProjection";
import { RESOURCE_CLIPBOARD_TYPE } from "@/lib/ui/copyText";
import { expectRecord, expectString } from "@/lib/validation";
export type WireOutline = Schema<"OutlineOut">;
export type OutlineNode = Schema<"OutlineNodeOut">;
export type NoteAuthority = "current" | "local" | null;
export type OutlineLink = {
  noteAuthority?: NoteAuthority;
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
/** A pending predecessor is an exact queued insertion; its version is supplied
 * only by that write's acknowledgement before a dependent request is sealed. */
export interface PendingPositionProof {
  intent_id: string;
  draft_id: string | null;
  requested_link_id: string;
  source_ref: string;
  version: number;
}
export type OutlinePosition =
  | Position
  | {
      after: string;
      expected_links_version: null;
      proof: PendingPositionProof;
    };
export type Edit =
  | {
      kind: "insert_note";
      endpoint: string;
      source: InsertionSource;
      link_id: string;
      note_id: string;
      position: OutlinePosition | null;
      body_pm_json: Schema<"InsertNote">["body_pm_json"];
    }
  | {
      kind: "insert_link";
      endpoint: string;
      source: InsertionSource;
      link_id: string;
      target: string;
      position: OutlinePosition | null;
      require_created: boolean;
    }
  | {
      kind: "move";
      endpoint: string;
      link_id: string;
      after: string | null;
    }
  | {
      kind: "relink";
      endpoint: string;
      link_id: string;
      destination: string;
      new_link_id: string;
      position: OutlinePosition | null;
    }
  | {
      kind: "remove" | "consume_note";
      endpoint: string;
      link_id: string;
    }
  | {
      kind: "set_body";
      note_id: string;
      body_pm_json: Schema<"SetBody">["body_pm_json"];
    }
  | {
      kind: "set_title";
      page_id: string;
      title: string;
    }
  | {
      kind: "ensure_daily";
      local_date: string;
      page_id: string;
    };
export type Graph = Map<string, OutlineData>;
export interface Row {
  readonly key: string;
  readonly occurrencePrefix: string;
  readonly path: readonly string[];
  readonly endpoint: string;
  readonly noteAuthority: NoteAuthority;
  readonly link: OutlineLink;
  readonly depth: number;
  readonly terminal: OutlineTarget | null;
  readonly open: boolean;
  readonly loaded: boolean;
}
export interface View {
  readonly folds: ReadonlyMap<string, boolean>;
  readonly zoom: readonly string[];
  readonly focused: string | null;
}
export type ClipItem =
  | {
      kind: "note";
      body: NoteBody;
      parent: number | null;
    }
  | {
      kind: "resource";
      ref: string;
      label: string;
      parent: number | null;
    };
export const OUTLINE_CLIPBOARD_TYPE = "application/x-nexus-outline+json";
export const noteRef = (id: string) => `note_block:${id}`;
export const noteIdOf = (ref: string) => ref.slice("note_block:".length);
export const isNoteRow = (row: Row) =>
  row.terminal === null && row.link.target.content.kind === "note";
export const structuralRow = (row: Row) =>
  isNoteRow(row) && arrangementRow(row);
export const arrangementRow = (row: Row) =>
  row.terminal === null &&
  endpointForResource(row.endpoint)?.kind === "resource" &&
  !row.link.has_link_note &&
  (row.link.connection === null || row.link.connection.origin === "user") &&
  endpointForResource(row.link.target.item.ref)?.kind === "resource";
/** Display identity is separate from the edge-only relationship path. */
export const resourceOccurrenceKey = (prefix: string, ref: string) =>
  `${prefix}/${ref}`;
export const occurrenceKey = (prefix: string, path: readonly string[]) =>
  path.length ? `${prefix}/${path.join("/")}` : prefix;
const uuid = () => crypto.randomUUID();
/** The zoomed endpoint, or null when the zoom path no longer resolves. */
export function zoomEndpoint(
  graph: Graph,
  root: string,
  zoom: readonly string[],
): string | null {
  let ref: string | null = root;
  for (const id of zoom) {
    ref =
      graph.get(ref)?.links.find((l) => l.link_id === id)?.target.item.ref ??
      null;
    if (ref === null) return null;
  }
  return ref;
}
export function outlineRows({
  graph,
  endpoint,
  occurrencePrefix,
  path,
  view,
  branch,
}: {
  graph: ReadonlyMap<string, Pick<OutlineData, "links">>;
  endpoint: string;
  occurrencePrefix: string;
  path: readonly string[];
  view: View;
  branch: OutlineBranch;
}): Row[] {
  const rows: Row[] = [];
  for (const link of graph.get(endpoint)?.links ?? []) {
    const projection = classifyOutlineOccurrence({
      branch,
      targetRef: link.target.item.ref,
      edgeId: link.link_id,
    });
    if (projection.kind === "omit") continue;
    const next = [...path, link.link_id];
    const key = occurrenceKey(occurrencePrefix, next);
    const terminal = projection.kind === "reference" ? projection.target : null;
    rows.push({
      key,
      occurrencePrefix,
      path: next,
      endpoint,
      noteAuthority:
        link.connection !== null && link.connection.ordinal !== null
          ? null
          : link.noteAuthority !== undefined
            ? link.noteAuthority
            : link.target.content.kind === "note"
              ? "current"
              : null,
      link,
      depth: path.length,
      terminal,
      open: terminal === null && (view.folds.get(key) ?? false),
      loaded: graph.has(link.target.item.ref),
    });
  }
  return rows;
}
/** The note's places as far as this tab knows: the server's count, or more if it has
 * linked notes into it since. */
export function placesOf(graph: Graph, node: OutlineNode): number {
  if (node.content.kind !== "note") return 0;
  const places =
    graph.get(node.item.ref)?.links.filter((link) => {
      const connection = link.connection;
      if (connection === null || connection.origin === "user") return true;
      if (connection.target.ref === node.item.ref)
        return (
          connection.origin === "highlight_note" ||
          connection.origin === "citation"
        );
      return (
        connection.source.ref === node.item.ref &&
        connection.origin === "link_note"
      );
    }).length ?? 0;
  return Math.max(node.content.places, places);
}
export function newNoteNode(id: string, body: NoteBody): OutlineNode {
  const ref = noteRef(id);
  return {
    item: {
      ref,
      action_ref: ref,
      label: body.body_text.split("\n")[0] || "Note",
      missing: false,
      activation: {
        resource_ref: ref,
        kind: "route",
        href: `/notes/${id}`,
        unavailable_reason: null,
      },
      preview: {
        body: {
          kind: "prose",
          excerpt: {
            text: body.body_text,
            truncated_before: false,
            truncated_after: false,
          },
          role: null,
          format: "plain",
          image_count: 0,
        },
        source: null,
        annotation: null,
      },
    },
    content: {
      kind: "note",
      ...body,
      body_version: 1,
      places: 1,
      embedded_item: null,
    },
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
  if (!outline) return;
  const links = outline.links.filter((l) => l.link_id !== link.link_id);
  if (after !== null && !links.some((link) => link.link_id === after)) return;
  const at =
    after === null ? 0 : links.findIndex((link) => link.link_id === after) + 1;
  links.splice(at, 0, link);
  graph.set(endpoint, { ...outline, links });
  const other = graph.get(link.target.item.ref);
  if (other && !other.links.some((l) => l.link_id === link.link_id)) {
    const mirror = { ...link, target: outline.source };
    graph.set(link.target.item.ref, {
      ...other,
      links: [...other.links, mirror],
    });
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
      return [
        { kind: "set_body", note_id: edit.note_id, body_pm_json: before },
      ];
    }
    case "set_title":
    case "ensure_daily":
      return [];
    case "insert_note":
    case "insert_link": {
      const ref =
        edit.kind === "insert_note" ? noteRef(edit.note_id) : edit.target;
      let target = nodeOf(graph, ref) ?? node(ref);
      if (!target && edit.kind === "insert_note") {
        target = newNoteNode(edit.note_id, parseBody(edit.body_pm_json));
        graph.set(ref, {
          source: target,
          links: [],
          links_version: 1,
          complete: false,
        });
      }
      // justify-defect: a pasted resource is resolved before it is inserted.
      if (!target) throw new Error(`Outline target ${ref} is unknown`);
      const link = {
        link_id: edit.link_id,
        has_link_note: false,
        target,
        connection: null,
      };
      const known = graph.get(edit.endpoint);
      insertLink(
        graph,
        edit.endpoint,
        link,
        edit.position === null
          ? (known?.links.at(-1)?.link_id ?? null)
          : edit.position.after,
      );
      return [
        { kind: "remove", endpoint: edit.endpoint, link_id: edit.link_id },
      ];
    }
    case "move": {
      const links = graph.get(edit.endpoint)?.links;
      const link = links?.find((l) => l.link_id === edit.link_id);
      if (!links || !link) return [];
      const after = afterOf(links, edit.link_id);
      insertLink(graph, edit.endpoint, link, edit.after);
      return [{ ...edit, after }];
    }
    case "relink": {
      const source = graph.get(edit.endpoint);
      const link = source?.links.find((l) => l.link_id === edit.link_id);
      if (!source || !link) return [];
      const after = afterOf(source.links, edit.link_id);
      dropLink(graph, edit.link_id);
      insertLink(
        graph,
        edit.destination,
        { ...link, link_id: edit.new_link_id },
        edit.position === null
          ? (graph.get(edit.destination)?.links.at(-1)?.link_id ?? null)
          : edit.position.after,
      );
      return [
        {
          kind: "relink",
          endpoint: edit.destination,
          link_id: edit.new_link_id,
          destination: edit.endpoint,
          new_link_id: edit.link_id,
          position: { after, expected_links_version: source.links_version },
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
        return [
          {
            kind: "insert_link",
            endpoint,
            source: { kind: "resource", ref: endpoint },
            link_id,
            target,
            position: {
              after,
              expected_links_version: graph.get(endpoint)!.links_version,
            },
            require_created: false,
          },
        ];
      const note_id = noteIdOf(target);
      const { body_pm_json } = body(note_id);
      return [
        {
          kind: "insert_note",
          endpoint,
          source: { kind: "resource", ref: endpoint },
          link_id,
          note_id,
          position: {
            after,
            expected_links_version: graph.get(endpoint)!.links_version,
          },
          body_pm_json,
        },
      ];
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
const parentKey = (row: Row) =>
  occurrenceKey(row.occurrencePrefix, row.path.slice(0, -1));
export function siblingsOf(rows: readonly Row[], row: Row): Row[] {
  return rows.filter(
    (r) => r.depth === row.depth && parentKey(r) === parentKey(row),
  );
}
/** The nearest editable note above `row` among its siblings: where Tab indents it. */
export function indentParent(rows: readonly Row[], row: Row): Row | null {
  const siblings = siblingsOf(rows, row);
  const at = siblings.findIndex((r) => r.key === row.key);
  return at < 0
    ? null
    : (siblings
        .slice(0, at)
        .reverse()
        .find(
          (candidate) =>
            candidate.terminal === null &&
            endpointForResource(candidate.link.target.item.ref)?.kind ===
              "resource",
        ) ?? null);
}
/** Outdent only through the explicit edge path within this structural root. */
export function outdentEdits(
  graph: Graph,
  root: string,
  row: Row,
): Edit[] | null {
  if (!arrangementRow(row) || row.path.length < 2) return null;
  const destination = zoomEndpoint(graph, root, row.path.slice(0, -2));
  if (destination === null || destination === row.link.target.item.ref)
    return null;
  const outline = graph.get(destination);
  if (!outline) return null;
  return [
    relink(row, destination, {
      after: row.path.at(-2)!,
      expected_links_version: outline.links_version,
    }),
  ];
}
function relink(
  row: Row,
  destination: string,
  position: Position | null,
): Edit {
  return {
    kind: "relink",
    endpoint: row.endpoint,
    link_id: row.link.link_id,
    destination,
    new_link_id: uuid(),
    position,
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
):
  | {
      edits: Edit[];
      earlier: Row;
      caret: number;
    }
  | {
      refused: string;
    }
  | null {
  const siblings = siblingsOf(rows, row);
  const index = siblings.findIndex((r) => r.key === row.key);
  const [earlier, later] =
    direction === "backward"
      ? [siblings[index - 1], row]
      : [row, siblings[index + 1]];
  if (!earlier || !later || !isNoteRow(earlier) || !isNoteRow(later))
    return null;
  const left = docFromBody(
    body(noteIdOf(earlier.link.target.item.ref)),
  ).firstChild!;
  const right = docFromBody(
    body(noteIdOf(later.link.target.item.ref)),
  ).firstChild!;
  if (left.type.name !== "paragraph" || right.type.name !== "paragraph")
    return null;
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
      {
        kind: "consume_note",
        endpoint: later.endpoint,
        link_id: later.link.link_id,
      },
    ],
  };
}
/** Move one admitted fact; append nesting requires no destination tail read. */
export function dropEdits(
  graph: Graph,
  row: Row,
  target: Row,
  placement: "before" | "after" | "inside",
): Edit[] | null {
  if (row.key === target.key || !arrangementRow(row)) return null;
  const destination =
    placement === "inside" ? target.link.target.item.ref : target.endpoint;
  if (
    endpointForResource(destination)?.kind !== "resource" ||
    destination === row.link.target.item.ref
  )
    return null;
  const outline = graph.get(destination);
  if (placement !== "inside" && !outline) return null;
  const links =
    outline?.links.filter((link) => link.link_id !== row.link.link_id) ?? [];
  const index = links.findIndex((link) => link.link_id === target.link.link_id);
  if (placement !== "inside" && index < 0) return null;
  const after =
    placement === "after"
      ? target.link.link_id
      : (links[index - 1]?.link_id ?? null);
  if (destination === row.endpoint && placement !== "inside")
    return [
      {
        kind: "move",
        endpoint: row.endpoint,
        link_id: row.link.link_id,
        after,
      },
    ];
  return [
    relink(
      row,
      destination,
      placement === "inside"
        ? null
        : { after, expected_links_version: outline!.links_version },
    ),
  ];
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
      : {
          kind: "resource",
          ref: target.item.ref,
          label: target.item.label,
          parent: at,
        };
  });
  const depths: number[] = [];
  const lines = items.map((item, index) => {
    depths[index] = item.parent === null ? 0 : depths[item.parent]! + 1;
    const text = item.kind === "note" ? item.body.body_text : item.label;
    return `${"  ".repeat(depths[index]!)}- ${text}`;
  });
  clipboard.setData(
    OUTLINE_CLIPBOARD_TYPE,
    JSON.stringify({ version: 3, items }),
  );
  clipboard.setData("text/plain", lines.join("\n"));
}
/** The clipboard as outline items; null when it holds none. TypeError when malformed. */
export function readClipboard(clipboard: DataTransfer): ClipItem[] | null {
  const reference = clipboard.getData(RESOURCE_CLIPBOARD_TYPE);
  if (reference) {
    const ref = expectString(
      expectRecord(JSON.parse(reference), "reference").ref,
      "ref",
    );
    if (!parseResourceRef(ref))
      throw new TypeError("The copied reference is invalid.");
    return [{ kind: "resource", ref, label: "", parent: null }];
  }
  const own = clipboard.getData(OUTLINE_CLIPBOARD_TYPE);
  const value = own ? expectRecord(JSON.parse(own), "outline clipboard") : null;
  if (value?.version === 3 && Array.isArray(value.items)) {
    return value.items.map((raw: unknown, index: number): ClipItem => {
      const item = expectRecord(raw, "outline item");
      const parent = item.parent === null ? null : Number(item.parent);
      if (
        parent !== null &&
        !(Number.isInteger(parent) && parent >= 0 && parent < index)
      )
        throw new TypeError(
          "Copied outline parents must precede their children.",
        );
      if (item.kind === "note") {
        const body = parseBody(
          expectRecord(item.body, "outline body").body_pm_json,
        );
        return { kind: "note", body, parent };
      }
      const ref = expectString(item.ref, "outline item ref");
      if (!parseResourceRef(ref))
        throw new TypeError("A copied item is invalid.");
      return {
        kind: "resource",
        ref,
        label: expectString(item.label, "label"),
        parent,
      };
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
  if (blocks.length === 1 && blocks[0]!.isBlock)
    return bodyFromNode(blocks[0]!);
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
  const parents: {
    indent: number;
    index: number;
  }[] = [];
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
  source: InsertionSource,
  position: OutlinePosition | null,
): Edit[] {
  const refs: string[] = [];
  const last = new Map<string, string | null>([
    [endpoint, position?.after ?? null],
  ]);
  const linked = new Set(
    (graph.get(endpoint)?.links ?? []).map(
      (link) => `${endpoint} ${link.target.item.ref}`,
    ),
  );
  return items.map((item, index) => {
    const parent = item.parent === null ? endpoint : refs[item.parent]!;
    if (
      item.parent !== null &&
      items[item.parent]!.kind === "resource" &&
      endpointForResource(parent)?.kind !== "resource"
    )
      throw new TypeError("That resource cannot hold pasted items.");
    const link_id = uuid();
    const after = last.get(parent) ?? null;
    last.set(parent, link_id);
    // An append sequence remains in clipboard order inside this one transaction;
    // it does not need to know the old destination tail or its version.
    const captured =
      parent === endpoint
        ? position === null
          ? null
          : position.expected_links_version === null
            ? { ...position, after: after ?? position.after }
            : { ...position, after }
        : null;
    const origin =
      parent === endpoint ? source : { kind: "resource" as const, ref: parent };
    if (item.kind === "resource") {
      const pair = `${parent} ${item.ref}`;
      if (item.ref === parent || linked.has(pair))
        throw new TypeError("That item is already linked here.");
      linked.add(pair);
      refs[index] = item.ref;
      return {
        kind: "insert_link",
        endpoint: parent,
        source: origin,
        link_id,
        target: item.ref,
        position: captured,
        require_created: false,
      };
    }
    const note_id = uuid();
    refs[index] = noteRef(note_id);
    return {
      kind: "insert_note",
      endpoint: parent,
      source: origin,
      link_id,
      note_id,
      position: captured,
      body_pm_json: item.body.body_pm_json,
    };
  });
}
