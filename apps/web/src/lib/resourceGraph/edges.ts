/**
 * Read-side shapes + URL for the `/resource-graph/edges` connections surface
 * (spec §10.2). The edge shape mirrors the backend `EdgeOut`
 * (`nexus/schemas/resource_graph.py`); refs travel as `<scheme>:<uuid>` strings.
 *
 * The only frontend consumer is the read-only Connections panel
 * (`NoteBacklinks`), so this module owns just the GET read-model and its URL.
 * The POST/DELETE/resolve endpoints exist on the backend (AC10 + P4) but have
 * no frontend client yet.
 */

import type { ApiPath } from "@/lib/api/client";

export type EdgeKind = "context" | "supports" | "contradicts";
export type EdgeOrigin =
  | "user"
  | "citation"
  | "system"
  | "note_body"
  | "highlight_note";

export interface EdgeOut {
  id: string;
  kind: EdgeKind;
  origin: EdgeOrigin;
  source_ref: string;
  target_ref: string;
  ordinal: number | null;
  snapshot: Record<string, unknown> | null;
  source_label: string;
  source_missing: boolean;
  target_label: string;
  target_missing: boolean;
  created_at: string;
}

/**
 * The GET URL for every edge touching `ref` on either endpoint (backlinks,
 * cited-by, refs). One source of truth for the read path; `ref` is a
 * pre-formatted `<scheme>:<uuid>` string (see `formatResourceRef`).
 */
export function edgesForRefPath(ref: string): ApiPath {
  return `/api/resource-graph/edges?ref=${encodeURIComponent(ref)}` as ApiPath;
}
