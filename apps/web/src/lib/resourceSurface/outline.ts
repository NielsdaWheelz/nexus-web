import { DOMParser as ProseMirrorDOMParser, Fragment } from "prosemirror-model";
import type { SurfaceHistorySelection } from "@/lib/notes/writingSession";
import type { NoteBodySelection, NoteBodySplit } from "@/components/notes/NoteBodyEditor";
import type { ResourceSurface, ResourceSurfaceNode, SurfacePosition } from "@/lib/resources/resourceItems";
import { createNoteBodyDoc, noteBodySchema, noteBodyValueFromDoc } from "@/lib/notes/prosemirror/schema";
import { copyText } from "@/lib/ui/copyText";
import { expectExactRecord, expectInteger, expectRecord, expectString } from "@/lib/validation";
import { surfacePathKey, surfacePositionAtEnd, type ResourceSurfaceCommand, type SurfaceContext } from "./model";

export class ProtectedSurfaceLinkError extends Error {
  constructor() { super("this link has a note; use link actions"); this.name = "ProtectedSurfaceLinkError"; }
}

export class TerminalSurfaceLinkError extends Error {
  constructor() { super("already shown above; edit the earlier appearance"); this.name = "TerminalSurfaceLinkError"; }
}

export interface OutlineRow {
  occurrenceId: string;
  path: SurfaceContext;
  endpointRef: string;
  linkId: string;
  target: ResourceSurfaceNode;
  depth: number;
  collapsed: boolean;
  hasLinkNote: boolean;
  terminal: string | null;
  neighborhood: "unloaded" | "loading" | "ready" | "error";
}
export type OutlineSelection = SurfaceHistorySelection;
export interface OutlineViewState {
  selection: OutlineSelection;
  folds: Map<string, boolean>;
  focusedPath: SurfaceContext | null;
  focusReturns: Array<{ path: SurfaceContext | null; occurrenceId: string }>;
  focusRequest: { occurrenceId: string; serial: number } | null;
  rootFocusRequest: { serial: number } | null;
}
export function createOutlineViewState(): OutlineViewState {
  return { selection: null, folds: new Map(), focusedPath: null, focusReturns: [], focusRequest: null, rootFocusRequest: null };
}
export interface ResourceOutline {
  activeEndpointRef: string;
  rows: OutlineRow[];
  selection: OutlineSelection;
  focusedPath: SurfaceContext | null;
  focusRequest: { occurrenceId: string; serial: number } | null;
  rootFocusRequest: { serial: number } | null;
  select(occurrenceId: string, extend?: boolean): void;
  clearSelection(): void;
  resume(occurrenceId: string): void;
  fold(occurrenceId: string, collapsed: boolean): Promise<void>;
  focus(occurrenceId: string): Promise<void>;
  returnFocus(): void;
  indent(occurrenceId: string): Promise<void>;
  outdent(occurrenceId: string): Promise<void>;
  move(occurrenceId: string, direction: "up" | "down"): Promise<void>;
  remove(occurrenceIds: readonly string[]): Promise<void>;
  split(occurrenceId: string, split: NoteBodySplit): Promise<void>;
  join(occurrenceId: string, direction: "backward" | "forward"): Promise<void>;
  insert(position: SurfacePosition, context?: SurfaceContext): void;
  reference(targetRef: string, position: SurfacePosition, context?: SurfaceContext): Promise<void>;
  drop(occurrenceId: string, targetId: string, placement: "before" | "after" | "inside"): Promise<void>;
  copy(clipboard: DataTransfer, cut?: boolean): Promise<void>;
  paste(clipboard: DataTransfer): Promise<boolean>;
  copyReference(occurrenceId: string): Promise<void>;
}
export type NeighborhoodLoad = { kind: "loading" } | { kind: "error"; error: unknown };
export function outlineRows(rootRef: string, graph: ReadonlyMap<string, ResourceSurface>, view: OutlineViewState, loads: ReadonlyMap<string, NeighborhoodLoad>): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const rootPath = { rootRef, linkPath: [] };
  const ancestors = new Map<string, string>([[rootRef, rootRef]]);
  let endpoint = rootRef;
  const start = view.focusedPath ?? rootPath;
  for (let index = 0; index < start.linkPath.length; index += 1) {
    const link = graph.get(endpoint)?.orderedItems.find((row) => row.linkId === start.linkPath[index]);
    if (!link) return [];
    endpoint = link.target.item.ref;
    ancestors.set(endpoint, surfacePathKey({ rootRef, linkPath: start.linkPath.slice(0, index + 1) }));
  }
  const visit = (ref: string, path: SurfaceContext, depth: number, branch: ReadonlyMap<string, string>) => {
    const surface = graph.get(ref);
    if (!surface) return;
    for (const link of surface.orderedItems) {
      const next = { rootRef, linkPath: [...path.linkPath, link.linkId] };
      const occurrenceId = surfacePathKey(next);
      const targetRef = link.target.item.ref;
      const terminal = branch.get(targetRef) ?? null;
      const load = loads.get(targetRef);
      const neighborhood = load?.kind ?? (graph.has(targetRef) ? "ready" : "unloaded");
      const collapsed = view.folds.get(occurrenceId) ?? (depth === 0 ? link.collapsed : true);
      rows.push({ occurrenceId, path: next, endpointRef: ref, linkId: link.linkId, target: link.target, depth, collapsed, hasLinkNote: link.hasLinkNote, terminal, neighborhood });
      // Preserve saved root disclosure. Nested cached appearances remain closed
      // until deliberate disclosure/focus opens their exact occurrence path.
      if (!terminal && link.target.content.kind === "note_body" && !collapsed && graph.has(targetRef)) {
        const nextBranch = new Map(branch); nextBranch.set(targetRef, occurrenceId);
        visit(targetRef, next, depth + 1, nextBranch);
      }
    }
  };
  visit(endpoint, start, 0, ancestors);
  return rows;
}
export const OUTLINE_CLIPBOARD_TYPE = "application/x-nexus-outline+json";
const REFERENCE_CLIPBOARD_TYPE = "application/x-nexus-reference+json";
type ClipboardItem = { body: Record<string, unknown>; parentIndex?: number };
function outlineFromHtml(html: string): ClipboardItem[] | null {
  if (!html) return null;
  const document = new DOMParser().parseFromString(html, "text/html");
  const roots = [...document.body.querySelectorAll("ul, ol")].filter((list) => !list.parentElement?.closest("ul, ol"));
  if (!roots.length) return null;
  const remainder = document.body.cloneNode(true) as HTMLElement;
  remainder.querySelectorAll("ul, ol").forEach((list) => list.remove());
  if (remainder.textContent?.trim()) return null;
  const items: ClipboardItem[] = [];
  const visit = (list: Element, parentIndex?: number) => {
    for (const li of list.children) {
      if (li.tagName !== "LI") continue;
      const content = li.cloneNode(true) as HTMLElement;
      content.querySelectorAll("ul, ol").forEach((nested) => nested.remove());
      const slice = ProseMirrorDOMParser.fromSchema(noteBodySchema).parseSlice(content);
      const blocks = [...Array(slice.content.childCount).keys()].map((index) => slice.content.child(index));
      let body;
      if (blocks.length === 1 && blocks[0]!.isBlock) body = blocks[0]!;
      else {
        let inline = Fragment.empty;
        for (const block of blocks) {
          if (block.isInline) { inline = inline.append(Fragment.from(block)); continue; }
          if (block.type !== noteBodySchema.nodes.paragraph) throw new TypeError("An outline item must contain one supported body");
          if (inline.size) inline = inline.append(Fragment.from(noteBodySchema.nodes.hard_break!.create()));
          inline = inline.append(block.content);
        }
        body = noteBodySchema.nodes.paragraph!.create(null, inline);
      }
      const index = items.length;
      items.push({ body: noteBodyValueFromDoc(noteBodySchema.nodes.note_body_doc!.create(null, body)).bodyPmJson, ...(parentIndex === undefined ? {} : { parentIndex }) });
      for (const nested of li.querySelectorAll("ul, ol")) {
        if (nested.parentElement?.closest("li") === li) visit(nested, index);
      }
    }
  };
  roots.forEach((list) => visit(list));
  return items;
}


export function createResourceOutline(input: {
  rootRef: string;
  provisional: OutlineRow | null;
  graph: () => ReadonlyMap<string, ResourceSurface>;
  view: OutlineViewState;
  loads: ReadonlyMap<string, NeighborhoodLoad>;
  load: (ref: string) => Promise<void>;
  resolve: (ref: string) => Promise<void>;
  publish: () => void;
  command: (endpointRef: string, context: SurfaceContext, command: ResourceSurfaceCommand, focusRef?: string, focusContext?: SurfaceContext) => void;
  body: (ref: string) => Record<string, unknown>;
  restore: (occurrenceId: string, selection: NoteBodySelection) => void;
  recordSelection: (selection: OutlineSelection) => void;
}): ResourceOutline {
  const { view } = input;
  const resolveEndpoint = (path: SurfaceContext): string | null => {
    let ref = path.rootRef;
    for (const linkId of path.linkPath) {
      const next = input.graph().get(ref)?.orderedItems.find((link) => link.linkId === linkId);
      if (!next) return null;
      ref = next.target.item.ref;
    }
    return ref;
  };
  const reconcileFocus = () => {
    if (view.focusedPath && resolveEndpoint(view.focusedPath) === null) {
      view.focusedPath = null; view.focusReturns = []; view.selection = null;
      view.focusRequest = null;
      view.rootFocusRequest = { serial: (view.rootFocusRequest?.serial ?? 0) + 1 };
    }
  };
  reconcileFocus();
  const rows = () => [...outlineRows(input.rootRef, input.graph(), view, input.loads), ...(input.provisional ? [input.provisional] : [])];
  const reconcileBlockSelection = () => {
    if (view.selection?.kind !== "blocks") return;
    const visible = new Set(rows().map((value) => value.occurrenceId));
    if (!visible.has(view.selection.anchor) || view.selection.occurrenceIds.some((id) => !visible.has(id))) view.selection = null;
  };
  // Visibility owns block selection validity, including external graph changes.
  reconcileBlockSelection();
  const row = (id: string) => {
    const value = rows().find((candidate) => candidate.occurrenceId === id);
    if (!value) throw new Error("Selected appearance is no longer visible");
    return value;
  };
  const context = (value: OutlineRow): SurfaceContext => ({ rootRef: value.path.rootRef, linkPath: value.path.linkPath.slice(0, -1) });
  const endpointFor = (path: SurfaceContext) => {
    const ref = resolveEndpoint(path);
    if (ref === null) throw new Error("Appearance path is no longer present");
    return ref;
  };
  const focus = (id: string) => {
    view.focusRequest = { occurrenceId: id, serial: (view.focusRequest?.serial ?? 0) + 1 };
    view.selection = { kind: "text", occurrenceId: id, anchor: 1, head: 1 };
    input.publish();
  };
  const assertStructural = (...values: OutlineRow[]) => {
    const selected = view.selection?.kind === "blocks" ? view.selection.occurrenceIds.map(row) : [];
    if ([...selected, ...values].some((value) => value.terminal !== null)) throw new TerminalSurfaceLinkError();
  };
  const checkSingle = () => { assertStructural(); return view.selection?.kind !== "blocks" || view.selection.occurrenceIds.length === 1; };
  const editable = (value: OutlineRow) => !value.terminal && value.target.content.kind === "note_body";
  const protect = (value: OutlineRow) => { if (value.hasLinkNote) throw new ProtectedSurfaceLinkError(); };
  const send = (value: OutlineRow, command: ResourceSurfaceCommand, focusRef?: string, focusContext?: SurfaceContext) => input.command(value.endpointRef, context(value), command, focusRef, focusContext);
  const remove = async (ids: readonly string[]) => {
    const selected = ids.map(row);
    assertStructural(...selected);
    selected.forEach(protect);
    const selectedIds = new Set(ids);
    const all = rows();
    const first = all.findIndex((value) => selectedIds.has(value.occurrenceId));
    const previous = all.slice(0, first).reverse().find((value) => editable(value) && !selectedIds.has(value.occurrenceId));
    const pairs = new Map(selected.map((value) => [value.linkId, { endpointRef: value.endpointRef, linkId: value.linkId, context: context(value) }]));
    input.command(input.rootRef, { rootRef: input.rootRef, linkPath: [] }, { type: "remove_occurrence", entries: [...pairs.values()] });
    view.selection = null;
    if (previous) focus(previous.occurrenceId);
    input.recordSelection(view.selection);
    input.publish();
  };
  const result: ResourceOutline = {
    activeEndpointRef: endpointFor(view.focusedPath ?? { rootRef: input.rootRef, linkPath: [] }),
    rows: rows(), selection: view.selection, focusedPath: view.focusedPath, focusRequest: view.focusRequest, rootFocusRequest: view.rootFocusRequest,
    select(id, extend = false) {
      row(id);
      reconcileBlockSelection();
      if (extend && view.selection?.kind === "blocks") {
        const all = rows();
        const anchor = view.selection.anchor;
        const from = all.findIndex((value) => value.occurrenceId === anchor);
        const to = all.findIndex((value) => value.occurrenceId === id);
        view.selection = { kind: "blocks", anchor: view.selection.anchor, occurrenceIds: all.slice(Math.min(from, to), Math.max(from, to) + 1).map((value) => value.occurrenceId) };
      } else view.selection = { kind: "blocks", anchor: id, occurrenceIds: [id] };
      input.publish();
    },
    clearSelection() { view.selection = null; input.publish(); },
    resume: focus,
    async fold(id, collapsed) {
      const value = row(id);
      if (!editable(value)) return;
      view.folds.set(id, collapsed); reconcileBlockSelection(); input.publish();
      if (!collapsed) await input.load(value.target.item.ref);
      reconcileBlockSelection(); input.publish();
    },
    async focus(id) {
      const value = row(id);
      if (value.terminal) {
        view.focusedPath = null; view.focusReturns = [];
        if (value.terminal === input.rootRef) {
          view.selection = null;
          view.rootFocusRequest = { serial: (view.rootFocusRequest?.serial ?? 0) + 1 };
          input.publish();
        } else {
          const [rootRef, ...links] = JSON.parse(value.terminal) as string[];
          if (!rootRef) throw new Error("Ancestor appearance has no root");
          for (let depth = 1; depth < links.length; depth += 1) view.folds.set(surfacePathKey({ rootRef, linkPath: links.slice(0, depth) }), false);
          focus(value.terminal);
        }
        return;
      }
      if (!editable(value)) return;
      await input.load(value.target.item.ref);
      view.focusReturns.push({ path: view.focusedPath, occurrenceId: id });
      view.focusedPath = value.path; view.selection = null; input.publish();
    },
    returnFocus() {
      const previous = view.focusReturns.pop();
      view.focusedPath = previous?.path ?? null;
      reconcileFocus();
      if (previous && rows().some((value) => value.occurrenceId === previous.occurrenceId)) focus(previous.occurrenceId);
      else view.selection = null;
      reconcileBlockSelection(); input.publish();
    },
    async indent(id) {
      if (!checkSingle()) return;
      const value = row(id); assertStructural(value); if (!editable(value)) return; protect(value);
      const siblings = rows().filter((candidate) => candidate.endpointRef === value.endpointRef && candidate.path.linkPath.slice(0, -1).join() === value.path.linkPath.slice(0, -1).join());
      const index = siblings.findIndex((candidate) => candidate.occurrenceId === id);
      const preceding = siblings.slice(0, index).reverse().find(editable);
      if (!preceding || preceding.target.item.ref === value.target.item.ref) return;
      await input.load(preceding.target.item.ref);
      view.folds.set(preceding.occurrenceId, false);
      send(value, { type: "relink", linkId: value.linkId, destinationRef: preceding.target.item.ref, position: surfacePositionAtEnd(input.graph().get(preceding.target.item.ref)!, value.target.item.ref) }, value.target.item.ref, preceding.path);
    },
    async outdent(id) {
      if (!checkSingle()) return;
      const value = row(id); assertStructural(value); if (!editable(value) || value.path.linkPath.length < 2) return; protect(value);
      const parentPath = { ...value.path, linkPath: value.path.linkPath.slice(0, -2) };
      const destination = endpointFor(parentPath);
      await input.load(destination);
      send(value, { type: "relink", linkId: value.linkId, destinationRef: destination, position: { kind: "after", linkId: value.path.linkPath.at(-2)! } }, value.target.item.ref, parentPath);
    },
    async move(id, direction) {
      if (!checkSingle()) return;
      const value = row(id); assertStructural(value);
      const surface = input.graph().get(value.endpointRef)!;
      const index = surface.orderedItems.findIndex((link) => link.linkId === value.linkId);
      if (direction === "up" && index === 0 || direction === "down" && index === surface.orderedItems.length - 1) return;
      const anchor = surface.orderedItems[direction === "up" ? index - 2 : index + 1];
      send(value, { type: "move_occurrence", linkId: value.linkId, position: anchor ? { kind: "after", linkId: anchor.linkId } : { kind: "start" } });
    },
    remove,
    async split(id, split) {
      const value = row(id); assertStructural(value); if (!editable(value)) return;
      const noteId = crypto.randomUUID();
      send(value, { type: "split_note", linkId: value.linkId, noteId, leftBodyPmJson: split.leftBodyPmJson, rightBodyPmJson: split.rightBodyPmJson }, `note_block:${noteId}`);
    },
    async join(id, direction) {
      const value = row(id); assertStructural(value); if (!editable(value)) return;
      const siblings = input.graph().get(value.endpointRef)!.orderedItems;
      const index = siblings.findIndex((link) => link.linkId === value.linkId);
      const earlier = siblings[direction === "backward" ? index - 1 : index];
      const later = siblings[direction === "backward" ? index : index + 1];
      if (!earlier || !later || earlier.target.content.kind !== "note_body" || later.target.content.kind !== "note_body") return;
      const laterRow = rows().find((candidate) => candidate.endpointRef === value.endpointRef && candidate.linkId === later.linkId && candidate.path.linkPath.slice(0, -1).join() === value.path.linkPath.slice(0, -1).join());
      const earlierRow = rows().find((candidate) => candidate.endpointRef === value.endpointRef && candidate.linkId === earlier.linkId && candidate.path.linkPath.slice(0, -1).join() === value.path.linkPath.slice(0, -1).join());
      if (!earlierRow || earlierRow.terminal || !laterRow || laterRow.terminal) return;
      protect(laterRow);
      const left = createNoteBodyDoc({ bodyPmJson: input.body(earlier.target.item.ref) }).firstChild;
      const right = createNoteBodyDoc({ bodyPmJson: input.body(later.target.item.ref) }).firstChild;
      if (left?.type !== noteBodySchema.nodes.paragraph || right?.type !== noteBodySchema.nodes.paragraph) return;
      const joined = noteBodyValueFromDoc(noteBodySchema.nodes.note_body_doc!.create(null, left.copy(left.content.append(right.content))));
      send(value, { type: "join_notes", earlierLinkId: earlier.linkId, laterLinkId: later.linkId, bodyPmJson: joined.bodyPmJson }, earlier.target.item.ref);
      const selection = { anchor: left.content.size + 1, head: left.content.size + 1 };
      input.restore(earlierRow.occurrenceId, selection);
      view.selection = { kind: "text", occurrenceId: earlierRow.occurrenceId, ...selection };
    },
    insert(position, path = view.focusedPath ?? { rootRef: input.rootRef, linkPath: [] }) {
      assertStructural();
      const noteId = crypto.randomUUID();
      input.command(endpointFor(path), path, { type: "insert_note", noteId, position, bodyPmJson: { type: "paragraph" } }, `note_block:${noteId}`);
    },
    async reference(targetRef, position, path = view.focusedPath ?? { rootRef: input.rootRef, linkPath: [] }) {
      assertStructural();
      await input.resolve(targetRef);
      input.command(endpointFor(path), path, { type: "insert_resource", targetRef, position }, targetRef);
    },
    async drop(id, targetId, placement) {
      if (!checkSingle() || id === targetId) return;
      const value = row(id); const target = row(targetId); assertStructural(value, target);
      let destination = target.endpointRef;
      let position: SurfacePosition;
      if (placement === "inside") {
        if (!editable(target)) return;
        destination = target.target.item.ref; await input.load(destination); view.folds.set(target.occurrenceId, false);
        position = surfacePositionAtEnd(input.graph().get(destination)!, value.target.item.ref);
      } else if (placement === "after") position = { kind: "after", linkId: target.linkId };
      else {
        const siblings = input.graph().get(destination)!.orderedItems;
        const index = siblings.findIndex((link) => link.linkId === target.linkId);
        const preceding = siblings.slice(0, index).filter((link) => link.linkId !== value.linkId).at(-1);
        position = preceding ? { kind: "after", linkId: preceding.linkId } : { kind: "start" };
      }
      const destinationRows = input.graph().get(destination)!.orderedItems;
      const existing = destinationRows.find((link) => link.target.item.ref === value.target.item.ref);
      if (existing && position.kind === "after" && position.linkId === existing.linkId) {
        const preceding = destinationRows[destinationRows.indexOf(existing) - 1];
        position = preceding ? { kind: "after", linkId: preceding.linkId } : { kind: "start" };
      }
      if (destination === value.endpointRef) send(value, { type: "move_occurrence", linkId: value.linkId, position });
      else { protect(value); send(value, { type: "relink", linkId: value.linkId, destinationRef: destination, position }, value.target.item.ref, placement === "inside" ? target.path : context(target)); }
    },
    async copy(clipboard, cut = false) {
      if (view.selection?.kind !== "blocks") return;
      const selectedIds = new Set(view.selection.occurrenceIds);
      const selected = rows().filter((value) => selectedIds.has(value.occurrenceId));
      if (cut) { assertStructural(...selected); selected.forEach(protect); }
      const items: ClipboardItem[] = selected.map((value, index) => {
        let parentIndex: number | undefined;
        for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
          const parent = selected[candidate]!;
          if (parent.path.linkPath.length < value.path.linkPath.length && parent.path.linkPath.every((link, offset) => value.path.linkPath[offset] === link)) { parentIndex = candidate; break; }
        }
        const body = !value.terminal && value.target.content.kind === "note_body" ? input.body(value.target.item.ref) : { type: "paragraph", content: [{ type: "object_ref", attrs: { objectType: value.target.item.scheme, objectId: value.target.item.id, label: value.target.item.label } }] };
        return { body, ...(parentIndex === undefined ? {} : { parentIndex }) };
      });
      clipboard.setData(OUTLINE_CLIPBOARD_TYPE, JSON.stringify({ version: 1, items }));
      const depths: number[] = [];
      clipboard.setData("text/plain", items.map((item, index) => {
        const depth = item.parentIndex === undefined ? 0 : depths[item.parentIndex]! + 1; depths[index] = depth;
        return "  ".repeat(depth) + "- " + noteBodyValueFromDoc(createNoteBodyDoc({ bodyPmJson: item.body })).bodyText;
      }).join("\n"));
      if (cut) await remove(selected.map((value) => value.occurrenceId));
    },
    async paste(clipboard) {
      if (view.selection?.kind !== "blocks") return false;
      assertStructural();
      const selected = row(view.selection.occurrenceIds.at(-1)!);
      const position: SurfacePosition = { kind: "after", linkId: selected.linkId };
      const reference = clipboard.getData(REFERENCE_CLIPBOARD_TYPE);
      if (reference) {
        const decoded = expectExactRecord(JSON.parse(reference), ["ref"], "reference clipboard");
        const targetRef = expectString(decoded.ref, "reference ref"); await input.resolve(targetRef);
        send(selected, { type: "insert_resource", targetRef, position }); return true;
      }
      const plainReference = /^\[\[([a-z_]+:[0-9a-f-]{36})\]\]$/.exec(clipboard.getData("text/plain").trim());
      if (plainReference) { await input.resolve(plainReference[1]!); send(selected, { type: "insert_resource", targetRef: plainReference[1]!, position }); return true; }
      const raw = clipboard.getData(OUTLINE_CLIPBOARD_TYPE);
      let items: ClipboardItem[];
      const htmlItems = raw ? null : outlineFromHtml(clipboard.getData("text/html"));
      if (raw) {
        const decoded = expectExactRecord(JSON.parse(raw), ["version", "items"], "outline clipboard");
        if (decoded.version !== 1 || !Array.isArray(decoded.items)) throw new TypeError("Unsupported outline clipboard");
        items = decoded.items.map((rawItem, index) => {
          const record = expectRecord(rawItem, "outline clipboard item");
          const value = expectExactRecord(record, "parentIndex" in record ? ["body", "parentIndex"] : ["body"], "outline clipboard item");
          const body = expectRecord(value.body, "outline clipboard body");
          createNoteBodyDoc({ bodyPmJson: body });
          if (value.parentIndex === undefined) return { body };
          const parentIndex = expectInteger(value.parentIndex, "outline parent index");
          if (parentIndex < 0 || parentIndex >= index) throw new TypeError("Outline parent must precede child");
          return { body, parentIndex };
        });
      } else if (htmlItems) {
        items = htmlItems;
      } else {
        const text = clipboard.getData("text/plain");
        if (!text) return false;
        const parents: Array<{ indent: number; index: number }> = [];
        items = text.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line, index) => {
          const match = /^(\s*)(?:[-*+]\s+)?(.*)$/.exec(line)!;
          const indent = match[1]!.replaceAll("\t", "  ").length;
          while (parents.length && parents.at(-1)!.indent >= indent) parents.pop();
          const parentIndex = parents.at(-1)?.index; parents.push({ indent, index });
          return { body: { type: "paragraph", ...(match[2] ? { content: [{ type: "text", text: match[2] }] } : {}) }, ...(parentIndex === undefined ? {} : { parentIndex }) };
        });
      }
      if (!items.length) return false;
      send(selected, { type: "paste_outline", position, items: items.map((item) => ({ noteId: crypto.randomUUID(), bodyPmJson: item.body, ...(item.parentIndex === undefined ? {} : { parentIndex: item.parentIndex }) })) });
      return true;
    },
    async copyReference(id) { await copyText(`[[${row(id).target.item.ref}]]`); },
  };
  return result;
}
