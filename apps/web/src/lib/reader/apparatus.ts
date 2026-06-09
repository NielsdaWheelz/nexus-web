import {
  isRetrievalLocator,
  type RetrievalLocator,
} from "@/lib/api/sse/locators";
import { hasOnlyKeys, isOptionalString } from "@/lib/api/sse/guards";
import { parseRawPdfQuads } from "@/lib/highlights/pdfTypes";
import { isRecord } from "@/lib/validation";

export type ReaderApparatusStatus =
  | "ready"
  | "empty"
  | "partial"
  | "unsupported"
  | "failed";

export type ReaderApparatusItemKind =
  | "footnote_ref"
  | "endnote_ref"
  | "bibliography_ref"
  | "sidenote_ref"
  | "margin_note_ref"
  | "footnote"
  | "endnote"
  | "bibliography_entry"
  | "sidenote"
  | "margin_note"
  | "reference_section";

export type ReaderApparatusRelation =
  | "points_to_note"
  | "points_to_endnote"
  | "points_to_sidenote"
  | "points_to_margin_note"
  | "cites_bibliography_entry"
  | "backlink_to_marker"
  | "contains_reference";

export type ReaderApparatusConfidence = "exact" | "strong" | "probable";
export type ReaderApparatusLocatorStatus = "exact" | "container" | "missing";

export interface ReaderApparatusCapabilities {
  has_inline_markers: boolean;
  has_sidecar_items: boolean;
  supports_hover_preview: boolean;
  supports_jump_to_marker: boolean;
  supports_jump_to_target: boolean;
  has_probable_items: boolean;
}

export interface ReaderApparatusItem {
  stable_key: string;
  kind: ReaderApparatusItemKind;
  label: string | null;
  body_text: string | null;
  body_html_sanitized: string | null;
  locator: RetrievalLocator | null;
  locator_status: ReaderApparatusLocatorStatus;
  confidence: ReaderApparatusConfidence;
  extraction_method: string;
  source_ref: Record<string, unknown>;
  sort_key: string;
}

export interface ReaderApparatusEdge {
  stable_key: string;
  from_stable_key: string;
  to_stable_key: string;
  relation: ReaderApparatusRelation;
  confidence: ReaderApparatusConfidence;
  extraction_method: string;
  source_ref: Record<string, unknown>;
  sort_key: string;
}

export interface ReaderApparatusResponse {
  media_id: string;
  media_kind: string;
  status: ReaderApparatusStatus;
  extractor_version: string;
  source_fingerprint: string;
  capabilities: ReaderApparatusCapabilities;
  items: ReaderApparatusItem[];
  edges: ReaderApparatusEdge[];
  diagnostics: Record<string, unknown>;
}

export interface ReaderApparatusRow {
  id: string;
  marker: ReaderApparatusItem;
  targets: ReaderApparatusItem[];
  edges: ReaderApparatusEdge[];
  target: ReaderApparatusItem | null;
  edge: ReaderApparatusEdge | null;
  sort_key: string;
}

export interface ReaderApparatusRowPresentation {
  markerOnly: boolean;
  resolvedTargets: boolean;
  canPreview: boolean;
  canActivateMarker: boolean;
  canActivateTarget: boolean;
  targetStatusText: string;
}

const STATUS = new Set<ReaderApparatusStatus>([
  "ready",
  "empty",
  "partial",
  "unsupported",
  "failed",
]);
const ITEM_KINDS = new Set<ReaderApparatusItemKind>([
  "footnote_ref",
  "endnote_ref",
  "bibliography_ref",
  "sidenote_ref",
  "margin_note_ref",
  "footnote",
  "endnote",
  "bibliography_entry",
  "sidenote",
  "margin_note",
  "reference_section",
]);
const MARKER_KINDS = new Set<ReaderApparatusItemKind>([
  "footnote_ref",
  "endnote_ref",
  "bibliography_ref",
  "sidenote_ref",
  "margin_note_ref",
]);
const TARGET_KINDS = new Set<ReaderApparatusItemKind>([
  "footnote",
  "endnote",
  "bibliography_entry",
  "sidenote",
  "margin_note",
  "reference_section",
]);
const RELATIONS = new Set<ReaderApparatusRelation>([
  "points_to_note",
  "points_to_endnote",
  "points_to_sidenote",
  "points_to_margin_note",
  "cites_bibliography_entry",
  "backlink_to_marker",
  "contains_reference",
]);
const CONFIDENCE = new Set<ReaderApparatusConfidence>([
  "exact",
  "strong",
  "probable",
]);
const LOCATOR_STATUS = new Set<ReaderApparatusLocatorStatus>([
  "exact",
  "container",
  "missing",
]);

export function assertReaderApparatusResponse(
  value: unknown,
): ReaderApparatusResponse {
  if (!isReaderApparatusResponse(value)) {
    throw new TypeError("Invalid reader apparatus response");
  }
  return value;
}

export function isReaderApparatusResponse(
  value: unknown,
): value is ReaderApparatusResponse {
  if (
    !(
      isRecord(value) &&
      hasOnlyKeys(value, [
        "media_id",
        "media_kind",
        "status",
        "extractor_version",
        "source_fingerprint",
        "capabilities",
        "items",
        "edges",
        "diagnostics",
      ]) &&
      typeof value.media_id === "string" &&
      typeof value.media_kind === "string" &&
      typeof value.status === "string" &&
      STATUS.has(value.status as ReaderApparatusStatus) &&
      typeof value.extractor_version === "string" &&
      typeof value.source_fingerprint === "string" &&
      isReaderApparatusCapabilities(value.capabilities) &&
      Array.isArray(value.items) &&
      value.items.every(isReaderApparatusItem) &&
      Array.isArray(value.edges) &&
      value.edges.every(isReaderApparatusEdge) &&
      isRecord(value.diagnostics)
    )
  ) {
    return false;
  }
  const apparatus = value as unknown as ReaderApparatusResponse;
  return (
    hasValidApparatusGraph(apparatus.items, apparatus.edges) &&
    hasValidApparatusState(apparatus)
  );
}

function hasValidApparatusGraph(
  items: ReaderApparatusItem[],
  edges: ReaderApparatusEdge[],
): boolean {
  const itemKeys = new Set<string>();
  for (const item of items) {
    if (itemKeys.has(item.stable_key)) {
      return false;
    }
    itemKeys.add(item.stable_key);
  }

  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    if (edgeKeys.has(edge.stable_key)) {
      return false;
    }
    if (
      !itemKeys.has(edge.from_stable_key) ||
      !itemKeys.has(edge.to_stable_key)
    ) {
      return false;
    }
    edgeKeys.add(edge.stable_key);
  }
  return true;
}

function hasValidApparatusState(apparatus: ReaderApparatusResponse): boolean {
  const hasItems = apparatus.items.length > 0;
  const hasEdges = apparatus.edges.length > 0;
  if (
    (apparatus.status === "empty" ||
      apparatus.status === "unsupported" ||
      apparatus.status === "failed") &&
    (hasItems || hasEdges)
  ) {
    return false;
  }
  if (
    (apparatus.status === "ready" || apparatus.status === "partial") &&
    !hasItems
  ) {
    return false;
  }

  const locatedItems = apparatus.items.filter((item) => item.locator !== null);
  const capabilities = apparatus.capabilities;
  return (
    capabilities.has_sidecar_items === hasItems &&
    capabilities.supports_hover_preview === hasEdges &&
    capabilities.has_inline_markers ===
      apparatus.items.some(
        (item) => MARKER_KINDS.has(item.kind) && item.locator !== null,
      ) &&
    capabilities.supports_jump_to_marker ===
      locatedItems.some((item) => MARKER_KINDS.has(item.kind)) &&
    capabilities.supports_jump_to_target ===
      locatedItems.some((item) => TARGET_KINDS.has(item.kind)) &&
    capabilities.has_probable_items ===
      (apparatus.items.some((item) => item.confidence === "probable") ||
        apparatus.edges.some((edge) => edge.confidence === "probable"))
  );
}

function isReaderApparatusCapabilities(
  value: unknown,
): value is ReaderApparatusCapabilities {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "has_inline_markers",
      "has_sidecar_items",
      "supports_hover_preview",
      "supports_jump_to_marker",
      "supports_jump_to_target",
      "has_probable_items",
    ]) &&
    typeof value.has_inline_markers === "boolean" &&
    typeof value.has_sidecar_items === "boolean" &&
    typeof value.supports_hover_preview === "boolean" &&
    typeof value.supports_jump_to_marker === "boolean" &&
    typeof value.supports_jump_to_target === "boolean" &&
    typeof value.has_probable_items === "boolean"
  );
}

export function buildReaderApparatusRows(
  apparatus: ReaderApparatusResponse,
): ReaderApparatusRow[] {
  const itemsByKey = new Map(
    apparatus.items.map((item) => [item.stable_key, item]),
  );
  const edgesByMarkerId = new Map<string, ReaderApparatusEdge[]>();
  const linkedTargetIds = new Set<string>();
  for (const edge of apparatus.edges) {
    linkedTargetIds.add(edge.to_stable_key);
    const existing = edgesByMarkerId.get(edge.from_stable_key);
    if (existing) {
      existing.push(edge);
    } else {
      edgesByMarkerId.set(edge.from_stable_key, [edge]);
    }
  }
  const rows: ReaderApparatusRow[] = [];

  for (const marker of apparatus.items) {
    if (!MARKER_KINDS.has(marker.kind)) {
      continue;
    }
    const edges = [...(edgesByMarkerId.get(marker.stable_key) ?? [])].sort(
      (left, right) =>
        left.sort_key === right.sort_key
          ? left.stable_key.localeCompare(right.stable_key)
          : left.sort_key.localeCompare(right.sort_key),
    );
    const targets = edges
      .map((edge) => itemsByKey.get(edge.to_stable_key) ?? null)
      .filter((item): item is ReaderApparatusItem => item !== null);
    const edge = edges[0] ?? null;
    const target = targets[0] ?? null;
    rows.push({
      id: marker.stable_key,
      marker,
      targets,
      edges,
      target,
      edge,
      sort_key: marker.sort_key,
    });
  }

  for (const target of apparatus.items) {
    if (!TARGET_KINDS.has(target.kind) || linkedTargetIds.has(target.stable_key)) {
      continue;
    }
    rows.push({
      id: target.stable_key,
      marker: target,
      targets: [target],
      edges: [],
      target,
      edge: null,
      sort_key: target.sort_key,
    });
  }

  rows.sort((left, right) =>
    left.sort_key === right.sort_key
      ? left.id.localeCompare(right.id)
      : left.sort_key.localeCompare(right.sort_key),
  );
  return rows;
}

export function readerApparatusRowPresentation(
  row: ReaderApparatusRow,
  capabilities: ReaderApparatusCapabilities,
): ReaderApparatusRowPresentation {
  const markerKind = MARKER_KINDS.has(row.marker.kind);
  const targetOnly = !markerKind;
  const resolvedTargets =
    row.targets.length > 0 && (row.edges.length > 0 || targetOnly);
  const markerOnly = markerKind && !resolvedTargets;
  const hasPreviewText = row.targets.some((target) =>
    Boolean(target.body_text?.trim()),
  );
  return {
    markerOnly,
    resolvedTargets,
    canPreview:
      capabilities.supports_hover_preview &&
      row.edges.length > 0 &&
      hasPreviewText,
    canActivateMarker:
      markerKind &&
      capabilities.supports_jump_to_marker &&
      supportsFrontendApparatusActivation(row.marker.locator),
    canActivateTarget:
      capabilities.supports_jump_to_target &&
      row.targets.some((target) =>
        supportsFrontendApparatusActivation(target.locator),
      ),
    targetStatusText: markerOnly
      ? "Citation marker detected; target not resolved."
      : targetOnly
        ? targetOnlyStatusText(row.marker.kind)
        : "Reference target has no preview text.",
  };
}

function targetOnlyStatusText(kind: ReaderApparatusItemKind): string {
  switch (kind) {
    case "footnote":
      return "Footnote has no preview text.";
    case "endnote":
      return "Endnote has no preview text.";
    case "bibliography_entry":
      return "Reference has no preview text.";
    case "sidenote":
      return "Sidenote has no preview text.";
    case "margin_note":
      return "Margin note has no preview text.";
    case "reference_section":
      return "Reference section has no preview text.";
    default:
      return "Citation has no preview text.";
  }
}

function supportsFrontendApparatusActivation(
  locator: RetrievalLocator | null,
): boolean {
  if (
    locator?.type === "web_text_offsets" ||
    locator?.type === "epub_fragment_offsets"
  ) {
    return true;
  }
  if (locator?.type === "pdf_page_geometry") {
    return parseRawPdfQuads(locator.quads).length > 0;
  }
  return false;
}

function isReaderApparatusItem(value: unknown): value is ReaderApparatusItem {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "stable_key",
      "kind",
      "label",
      "body_text",
      "body_html_sanitized",
      "locator",
      "locator_status",
      "confidence",
      "extraction_method",
      "source_ref",
      "sort_key",
    ]) ||
    typeof value.stable_key !== "string" ||
    typeof value.kind !== "string" ||
    !ITEM_KINDS.has(value.kind as ReaderApparatusItemKind) ||
    !isOptionalString(value.label) ||
    !isOptionalString(value.body_text) ||
    !isOptionalString(value.body_html_sanitized) ||
    typeof value.locator_status !== "string" ||
    !LOCATOR_STATUS.has(value.locator_status as ReaderApparatusLocatorStatus) ||
    typeof value.confidence !== "string" ||
    !CONFIDENCE.has(value.confidence as ReaderApparatusConfidence) ||
    typeof value.extraction_method !== "string" ||
    !isRecord(value.source_ref) ||
    typeof value.sort_key !== "string"
  ) {
    return false;
  }
  if (value.locator === null) {
    return value.locator_status === "missing";
  }
  return (
    isRetrievalLocator(value.locator) && value.locator_status !== "missing"
  );
}

function isReaderApparatusEdge(value: unknown): value is ReaderApparatusEdge {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "stable_key",
      "from_stable_key",
      "to_stable_key",
      "relation",
      "confidence",
      "extraction_method",
      "source_ref",
      "sort_key",
    ]) &&
    typeof value.stable_key === "string" &&
    typeof value.from_stable_key === "string" &&
    typeof value.to_stable_key === "string" &&
    typeof value.relation === "string" &&
    RELATIONS.has(value.relation as ReaderApparatusRelation) &&
    typeof value.confidence === "string" &&
    CONFIDENCE.has(value.confidence as ReaderApparatusConfidence) &&
    typeof value.extraction_method === "string" &&
    isRecord(value.source_ref) &&
    typeof value.sort_key === "string"
  );
}
