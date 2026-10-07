import type { Schema } from "@/lib/api/wire";

export type ResourceItemCapabilities = Schema<"ResourceItemCapabilitiesOut">;
export type ResourceItem = Schema<"ResourceItemOut">;
export type ResourceSurfaceContent =
  | Schema<"PageTitleSurfaceContent">
  | { kind: "note_body"; bodyPmJson: Record<string, unknown>; bodyText: string }
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
export type SurfacePosition = { kind: "start" } | { kind: "after"; linkId: string };

export function projectResourceSurfaceNode(value: Schema<"ResourceSurfaceNode">): ResourceSurfaceNode {
  return {
    item: value.item,
    content: value.content.kind === "note_body" ? {
      kind: "note_body", bodyPmJson: value.content.body_pm_json, bodyText: value.content.body_text,
    } : value.content,
  };
}

export function projectResourceSurface(value: Schema<"ResourceSurfaceOut">): ResourceSurface {
  return {
    source: projectResourceSurfaceNode(value.source),
    orderedItems: value.ordered_items.map((item) => ({
      linkId: item.link_id, target: projectResourceSurfaceNode(item.target),
      collapsed: item.collapsed, hasLinkNote: item.has_link_note,
    })),
  };
}
