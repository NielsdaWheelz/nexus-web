import type { ApiPath } from "@/lib/api/client";
import { apiFetch } from "@/lib/api/client";
import type { MediaHighlight } from "@/lib/highlights/api";
import type { MediaNavigationResponse } from "@/lib/media/readerNavigation";
import type { ConnectionOut } from "@/lib/resourceGraph/connections";
import type { EdgeKind, EdgeOrigin } from "@/lib/resourceGraph/edges";
import type { ReaderApparatusResponse } from "@/lib/reader/apparatus";
import { assertReaderApparatusResponse } from "@/lib/reader/apparatus";

export type ReaderDocumentMapLensId =
  | "contents"
  | "highlights"
  | "citations"
  | "connections"
  | "chat";

export interface ReaderDocumentMapLens {
  id: ReaderDocumentMapLensId;
  label: string;
  status: "ready" | "empty" | "partial" | "unsupported" | "failed";
  item_count: number;
  anchored_count: number;
  unanchored_count: number;
}

export type ReaderDocumentMapTargetStatus =
  | "exact"
  | "container"
  | "missing"
  | "forbidden"
  | "unanchorable"
  | "stale"
  | "unsupported"
  | "partial";

export interface ReaderDocumentMapMarker {
  id: string;
  item_id: string;
  lens_id: ReaderDocumentMapLensId;
  lane: ReaderDocumentMapLensId;
  position: number;
  status: ReaderDocumentMapTargetStatus;
  tone: "neutral" | "highlight" | "citation" | "connection" | "chat" | "warning";
  label: string;
  preview: string | null;
}

export interface ReaderConnectionAnchor {
  ref: string;
  media_id: string;
  locator: Record<string, unknown> | null;
  page_number: number | null;
  fragment_id: string | null;
  highlight_id: string | null;
  evidence_span_id: string | null;
  order_key: string | null;
  precision?: "exact" | "container";
}

export interface ReaderConnectionRow {
  id: string;
  connection: ConnectionOut;
  anchor: ReaderConnectionAnchor | null;
  source_category:
    | "chat"
    | "library_intelligence"
    | "oracle"
    | "note"
    | "highlight_note"
    | "user_link"
    | "synapse"
    | "system"
    | "other";
  title: string;
  subtitle: string | null;
  excerpt: string | null;
  href: string | null;
}

export interface ReaderConnectionPage {
  anchored: ReaderConnectionRow[];
  unanchored: ReaderConnectionRow[];
  next_cursor: string | null;
}

interface ReaderDocumentMapItemBase {
  id: string;
  lens_ids: ReaderDocumentMapLensId[];
  kind: string;
  source_domain: string;
  title: string;
  subtitle: string | null;
  excerpt: string | null;
  href: string | null;
  anchor: ReaderConnectionAnchor | null;
  document_order_key: string | null;
  document_fraction: number | null;
  target_status: ReaderDocumentMapTargetStatus;
  provenance: Record<string, unknown>;
  actions: string[];
}

export interface ReaderDocumentMapSectionItem extends ReaderDocumentMapItemBase {
  kind: "section";
  source_domain: "navigation";
  section_id: string | null;
  level: number | null;
  parent_id: string | null;
}

export interface ReaderDocumentMapHighlightItem extends ReaderDocumentMapItemBase {
  kind: "highlight";
  source_domain: "highlight";
  highlight_id: string;
  color: MediaHighlight["color"];
  exact: string;
  note_block_count: number;
  linked_conversation_count: number;
}

export interface ReaderDocumentMapApparatusItem extends ReaderDocumentMapItemBase {
  kind: "apparatus";
  source_domain: "reader_apparatus";
  stable_key: string;
  apparatus_kind: ReaderApparatusResponse["items"][number]["kind"];
  confidence: ReaderApparatusResponse["items"][number]["confidence"];
  locator_status: ReaderApparatusResponse["items"][number]["locator_status"];
  target_stable_keys: string[];
}

export interface ReaderDocumentMapConnectionItem extends ReaderDocumentMapItemBase {
  kind: "connection";
  source_domain: "resource_graph" | "generated_citation";
  edge_id: string;
  direction: "incoming" | "outgoing";
  origin: EdgeOrigin;
  edge_kind: EdgeKind;
  source_category: ReaderConnectionRow["source_category"];
  other_ref: string;
}

export interface ReaderDocumentMapChatThreadItem extends ReaderDocumentMapItemBase {
  kind: "chat_thread";
  source_domain: "chat";
  conversation_id: string;
  latest_message_at: string | null;
  attached_ref: string | null;
}

export type ReaderDocumentMapItem =
  | ReaderDocumentMapSectionItem
  | ReaderDocumentMapHighlightItem
  | ReaderDocumentMapApparatusItem
  | ReaderDocumentMapConnectionItem
  | ReaderDocumentMapChatThreadItem;

export interface ReaderDocumentMap {
  media_id: string;
  media_kind: string;
  title: string;
  status: "ready" | "empty" | "partial" | "unsupported" | "failed";
  source_version: Record<string, unknown>;
  lenses: ReaderDocumentMapLens[];
  items: ReaderDocumentMapItem[];
  markers: ReaderDocumentMapMarker[];
  navigation: MediaNavigationResponse["data"] | null;
  highlights: MediaHighlight[];
  apparatus: ReaderApparatusResponse;
  connections: ReaderConnectionPage;
  chat_threads: Array<{
    id: string;
    title: string;
    message_count: number;
    updated_at: string;
  }>;
  diagnostics: Record<string, unknown>;
}

interface ReaderDocumentMapResponse {
  data: ReaderDocumentMap;
}

export async function getReaderDocumentMap(
  mediaId: string,
  options: {
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ReaderDocumentMap> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await apiFetch<ReaderDocumentMapResponse>(
    `/api/media/${mediaId}/document-map${suffix}` as ApiPath,
    { signal: options.signal },
  );
  if (!response.data || !Array.isArray(response.data.lenses)) {
    throw new TypeError("Invalid reader document map response");
  }
  response.data.apparatus = assertReaderApparatusResponse(response.data.apparatus);
  if (!Array.isArray(response.data.items) || !Array.isArray(response.data.markers)) {
    throw new TypeError("Invalid reader document map response");
  }
  return response.data;
}
