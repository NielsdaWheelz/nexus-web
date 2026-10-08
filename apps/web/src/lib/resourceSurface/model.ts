import type { ResourceItem, ResourceSurface, ResourceSurfaceNode, ResourceSurfaceOccurrence, SurfacePosition } from "@/lib/resources/resourceItems";
import type { ResourceSurfaceDraftIntent, ResourceSurfacePendingBody } from "./draftStore";

export type SurfaceContext = { rootRef: string; linkPath: string[] };
export type SurfaceBodyEdit = { ref: string; bodyPmJson: Record<string, unknown> };
export type SurfaceRemoval = { endpointRef: string; linkId: string; context: SurfaceContext };
export type OutlinePasteItem =
  | { kind: "note"; noteId: string; bodyPmJson: Record<string, unknown>; parentIndex?: number }
  | { kind: "resource"; targetRef: string; parentIndex?: number };
export type ResourceSurfaceCommand =
  | { type: "insert_note"; noteId: string; position: SurfacePosition; bodyPmJson: Record<string, unknown> }
  | { type: "split_note"; linkId: string; noteId: string; leftBodyPmJson: Record<string, unknown>; rightBodyPmJson: Record<string, unknown> }
  | { type: "insert_resource"; targetRef: string; position: SurfacePosition }
  | { type: "move_occurrence"; linkId: string; position: SurfacePosition }
  | { type: "remove_occurrence"; entries: SurfaceRemoval[] }
  | { type: "relink"; linkId: string; destinationRef: string; position: SurfacePosition }
  | { type: "join_notes"; earlierLinkId: string; laterLinkId: string; bodyPmJson: Record<string, unknown> }
  | { type: "paste_outline"; position: SurfacePosition; items: OutlinePasteItem[] }
  | { type: "reverse_edit"; receiptId: string };

export function resourceSurfaceLaneVersion(item: ResourceItem, lane: "title" | "body" | "links"): number {
  const value = item.versionByLane[lane];
  if (typeof value !== "number") throw new Error(`Resource surface is missing ${lane} version for ${item.ref}`);
  return value;
}
export function surfaceLinkForTarget(surface: ResourceSurface, ref: string): ResourceSurfaceOccurrence | undefined {
  return surface.orderedItems.find((item) => item.target.item.ref === ref);
}
export function pendingSurfaceLinkId(clientMutationId: string, index = 0): string {
  return `pending:${clientMutationId}:${index}`;
}
export function surfacePathKey(context: SurfaceContext): string {
  return JSON.stringify([context.rootRef, ...context.linkPath]);
}
export function surfacePositionAtEnd(surface: ResourceSurface, excludingTargetRef?: string): SurfacePosition {
  const last = surface.orderedItems.filter((row) => row.target.item.ref !== excludingTargetRef).at(-1);
  return last ? { kind: "after", linkId: last.linkId } : { kind: "start" };
}
function insertionIndex(items: readonly ResourceSurfaceOccurrence[], position: SurfacePosition): number {
  if (position.kind === "start") return 0;
  const index = items.findIndex((item) => item.linkId === position.linkId);
  if (index < 0) throw new Error("Position anchor is not incident to this endpoint");
  return index + 1;
}
function requireLink(surface: ResourceSurface, linkId: string): ResourceSurfaceOccurrence {
  const row = surface.orderedItems.find((item) => item.linkId === linkId);
  if (!row) throw new Error("Link is not incident to this endpoint");
  return row;
}
function createdNode(surface: ResourceSurface, noteId: string, bodyPmJson: Record<string, unknown>): ResourceSurfaceNode {
  const ref = `note_block:${noteId}`;
  return {
    item: { ...surface.source.item, ref, scheme: "note_block", id: noteId, label: "", summary: "", route: `/notes/${noteId}`, activation: { resource_ref: ref, kind: "route", href: `/notes/${noteId}`, unresolved_reason: null }, versionByLane: { body: 0, links: 0 } },
    content: { kind: "note_body", bodyPmJson, bodyText: "" },
  };
}
export function projectSurfaceGraph(surfaces: ReadonlyMap<string, ResourceSurface>, intents: readonly ResourceSurfaceDraftIntent[], bodies: ReadonlyMap<string, ResourceSurfacePendingBody> = new Map()): Map<string, ResourceSurface> {
  const graph = new Map(surfaces);
  const baseNodes = new Map(intents.flatMap((intent) => intent.baseNodes).map((node) => [node.item.ref, node]));
  const node = (ref: string): ResourceSurfaceNode | undefined => graph.get(ref)?.source ?? [...graph.values()].flatMap((surface) => surface.orderedItems).find((row) => row.target.item.ref === ref)?.target ?? baseNodes.get(ref);
  const replaceNode = (next: ResourceSurfaceNode) => {
    for (const [ref, surface] of graph) graph.set(ref, { source: ref === next.item.ref ? next : surface.source, orderedItems: surface.orderedItems.map((row) => row.target.item.ref === next.item.ref ? { ...row, target: next } : row) });
  };
  const writeBody = (ref: string, bodyPmJson: Record<string, unknown>) => {
    const current = node(ref);
    if (!current || current.content.kind !== "note_body") throw new Error("Structural body target is unavailable");
    replaceNode({ ...current, content: { kind: "note_body", bodyPmJson, bodyText: "" } });
  };
  const remove = (linkId: string) => {
    for (const [ref, surface] of graph) graph.set(ref, { ...surface, orderedItems: surface.orderedItems.filter((row) => row.linkId !== linkId) });
  };
  const insert = (endpoint: string, target: ResourceSurfaceNode, linkId: string, position: SurfacePosition) => {
    const surface = graph.get(endpoint);
    if (!surface) throw new Error("Destination neighborhood has not loaded");
    if (endpoint === target.item.ref) throw new Error("A note cannot link to itself");
    const existing = surface.orderedItems.find((row) => row.target.item.ref === target.item.ref);
    const row = existing ?? { linkId, target, collapsed: false, hasLinkNote: false };
    const rows = surface.orderedItems.filter((item) => item !== existing);
    rows.splice(insertionIndex(rows, position), 0, row);
    graph.set(endpoint, { ...surface, orderedItems: rows });
    const reverse = graph.get(target.item.ref);
    if (reverse && !existing) graph.set(target.item.ref, { ...reverse, orderedItems: [...reverse.orderedItems, { ...row, target: surface.source }] });
    return row.linkId;
  };
  for (const intent of intents) {
    const surface = graph.get(intent.endpointRef);
    if (!surface) throw new Error("Command neighborhood has not loaded");
    const command = intent.command;
    for (const edit of intent.bodyEdits) writeBody(edit.ref, edit.bodyPmJson);
    switch (command.type) {
      case "insert_note": {
        const target = createdNode(surface, command.noteId, command.bodyPmJson);
        graph.set(target.item.ref, { source: target, orderedItems: [] });
        insert(intent.endpointRef, target, pendingSurfaceLinkId(intent.clientMutationId), command.position);
        break;
      }
      case "split_note": {
        const row = requireLink(surface, command.linkId);
        writeBody(row.target.item.ref, command.leftBodyPmJson);
        const target = createdNode(surface, command.noteId, command.rightBodyPmJson);
        graph.set(target.item.ref, { source: target, orderedItems: [] });
        insert(intent.endpointRef, target, pendingSurfaceLinkId(intent.clientMutationId), { kind: "after", linkId: command.linkId });
        break;
      }
      case "insert_resource": {
        const existing = surface.orderedItems.find((row) => row.target.item.ref === command.targetRef);
        if (existing) break;
        const target = node(command.targetRef);
        if (!target) throw new Error("Linked resource has not loaded");
        insert(intent.endpointRef, target, pendingSurfaceLinkId(intent.clientMutationId), command.position);
        break;
      }
      case "move_occurrence": {
        const row = requireLink(surface, command.linkId);
        insert(intent.endpointRef, row.target, row.linkId, command.position);
        break;
      }
      case "remove_occurrence":
        for (const entry of command.entries) remove(entry.linkId);
        break;
      case "relink": {
        const row = requireLink(surface, command.linkId);
        remove(row.linkId);
        insert(command.destinationRef, row.target, pendingSurfaceLinkId(intent.clientMutationId), command.position);
        break;
      }
      case "join_notes": {
        writeBody(requireLink(surface, command.earlierLinkId).target.item.ref, command.bodyPmJson);
        remove(command.laterLinkId);
        break;
      }
      case "paste_outline": {
        let rootPosition = command.position;
        const refs: string[] = [];
        command.items.forEach((item, index) => {
          const target = item.kind === "note"
            ? createdNode(surface, item.noteId, item.bodyPmJson)
            : node(item.targetRef);
          if (!target) throw new Error("Pasted resource has not loaded");
          if (item.kind === "note") graph.set(target.item.ref, { source: target, orderedItems: [] });
          refs.push(target.item.ref);
          const parent = item.parentIndex === undefined ? intent.endpointRef : refs[item.parentIndex]!;
          if (item.parentIndex !== undefined && command.items[item.parentIndex]?.kind !== "note") throw new Error("Outline parents must be earlier copied notes");
          const parentSurface = graph.get(parent);
          if (!parentSurface) throw new Error("Pasted parent neighborhood has not loaded");
          const existing = parentSurface.orderedItems.find((row) => row.target.item.ref === target.item.ref);
          const position = item.parentIndex === undefined ? rootPosition : surfacePositionAtEnd(parentSurface);
          const linkId = existing?.linkId ?? insert(parent, target, pendingSurfaceLinkId(intent.clientMutationId, index), position);
          if (item.parentIndex === undefined) rootPosition = { kind: "after", linkId };
        });
        break;
      }
      case "reverse_edit":
        for (const restored of intent.inverseSurfaces ?? []) graph.set(restored.source.item.ref, restored);
        break;
    }
  }
  for (const [ref, body] of bodies) {
    const current = node(ref);
    if (current?.content.kind === "note_body") replaceNode({ ...current, content: { kind: "note_body", bodyPmJson: body.bodyPmJson, bodyText: body.bodyText } });
  }
  return graph;
}
export function createResourceSurfaceIntent(input: { surface: ResourceSurface; command: ResourceSurfaceCommand; clientMutationId: string; context?: SurfaceContext; bodyEdits?: SurfaceBodyEdit[]; baseSurfaces: ResourceSurface[]; baseNodes: ResourceSurfaceNode[] }): ResourceSurfaceDraftIntent {
  return { clientMutationId: input.clientMutationId, endpointRef: input.surface.source.item.ref, context: input.context ?? { rootRef: input.surface.source.item.ref, linkPath: [] }, command: input.command, bodyEdits: input.bodyEdits ?? [], baseSurfaces: input.baseSurfaces, baseNodes: input.baseNodes };
}
export function remapSurfaceIntent(intent: ResourceSurfaceDraftIntent, links: ReadonlyMap<string, string>): ResourceSurfaceDraftIntent {
  const map = (id: string) => links.get(id) ?? id;
  const context = (value: SurfaceContext): SurfaceContext => ({ ...value, linkPath: value.linkPath.map(map) });
  const position = (value: SurfacePosition): SurfacePosition => value.kind === "start" ? value : { kind: "after", linkId: map(value.linkId) };
  let command = intent.command;
  switch (command.type) {
    case "insert_note": case "insert_resource": case "paste_outline": command = { ...command, position: position(command.position) }; break;
    case "split_note": command = { ...command, linkId: map(command.linkId) }; break;
    case "move_occurrence": case "relink": command = { ...command, linkId: map(command.linkId), position: position(command.position) }; break;
    case "remove_occurrence": command = { ...command, entries: command.entries.map((entry) => ({ ...entry, linkId: map(entry.linkId), context: context(entry.context) })) }; break;
    case "join_notes": command = { ...command, earlierLinkId: map(command.earlierLinkId), laterLinkId: map(command.laterLinkId) }; break;
    case "reverse_edit": break;
  }
  const remapSurface = (surface: ResourceSurface): ResourceSurface => ({ ...surface, orderedItems: surface.orderedItems.map((row) => ({ ...row, linkId: map(row.linkId) })) });
  return { ...intent, context: context(intent.context), command, baseSurfaces: intent.baseSurfaces.map(remapSurface), ...(intent.inverseSurfaces ? { inverseSurfaces: intent.inverseSurfaces.map(remapSurface) } : {}) };
}

export function surfaceIntentBodyRefs(intent: ResourceSurfaceDraftIntent): Set<string> {
  const refs = new Set(intent.bodyEdits.map((edit) => edit.ref));
  const surface = intent.baseSurfaces.find((surface) => surface.source.item.ref === intent.endpointRef);
  const command = intent.command;
  switch (command.type) {
    case "insert_note": refs.add(`note_block:${command.noteId}`); break;
    case "split_note": {
      refs.add(`note_block:${command.noteId}`);
      const row = surface?.orderedItems.find((row) => row.linkId === command.linkId);
      if (row) refs.add(row.target.item.ref);
      break;
    }
    case "join_notes": {
      const row = surface?.orderedItems.find((row) => row.linkId === command.earlierLinkId);
      if (row) refs.add(row.target.item.ref);
      break;
    }
    case "paste_outline": for (const item of command.items) if (item.kind === "note") refs.add(`note_block:${item.noteId}`); break;
    case "reverse_edit":
      for (const version of intent.reverseVersions ?? []) if (version.lane === "body") refs.add(version.ref);
      if (!intent.reverseVersions) {
        const before = new Map(intent.baseSurfaces.flatMap((surface) => [surface.source, ...surface.orderedItems.map((row) => row.target)]).map((node) => [node.item.ref, node]));
        for (const node of (intent.inverseSurfaces ?? []).flatMap((surface) => [surface.source, ...surface.orderedItems.map((row) => row.target)])) {
          if (node.content.kind === "note_body" && JSON.stringify(before.get(node.item.ref)?.content) !== JSON.stringify(node.content)) refs.add(node.item.ref);
        }
      }
      break;
    case "insert_resource": case "move_occurrence": case "remove_occurrence": case "relink": break;
  }
  return refs;
}
