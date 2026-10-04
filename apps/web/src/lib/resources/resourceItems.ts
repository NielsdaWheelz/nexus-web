import type { Schema } from "@/lib/api/wire";
import { decodeNoteBodyValue, type NoteBodyValue } from "@/lib/notes/prosemirror/schema";

export type ResourceItem = Schema<"ResourceItemOut">;

export type ResourceSurfaceContent =
  | Schema<"PageTitleSurfaceContent">
  | ({ kind: "note_body" } & NoteBodyValue)
  | Schema<"ResourceSummarySurfaceContent">;

export interface ResourceSurfaceNode {
  item: ResourceItem;
  content: ResourceSurfaceContent;
}

export interface ResourceSurfaceOccurrence {
  linkId: string;
  collapsed: boolean;
  hasLinkNote: boolean;
  target: ResourceSurfaceNode;
}

export interface ResourceSurface {
  source: ResourceSurfaceNode;
  orderedItems: ResourceSurfaceOccurrence[];
}

export type SurfacePosition =
  | { kind: "start" }
  | { kind: "after"; linkId: string };

export function normalizeResourceSurfaceNode(
  node: Schema<"ResourceSurfaceNode">,
): ResourceSurfaceNode {
  const content = node.content;
  return {
    item: node.item,
    content: content.kind === "note_body"
      ? {
          kind: "note_body",
          ...decodeNoteBodyValue(
            content.body_pm_json,
            content.body_text,
            "note body surface content",
          ),
        }
      : content,
  };
}

/** Projects the typed surface wire into camel-case fields and canonical note bodies. */
export function normalizeResourceSurface(
  surface: Schema<"ResourceSurfaceOut">,
): ResourceSurface {
  return {
    source: normalizeResourceSurfaceNode(surface.source),
    orderedItems: surface.ordered_items.map((occurrence) => ({
      linkId: occurrence.link_id,
      target: normalizeResourceSurfaceNode(occurrence.target),
      collapsed: occurrence.collapsed,
      hasLinkNote: occurrence.has_link_note,
    })),
  };
}
