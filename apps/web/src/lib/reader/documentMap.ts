import type { ApiPath } from "@/lib/api/client";
import { apiFetch } from "@/lib/api/client";
import type { Presence } from "@/lib/api/presence";
import type { MediaRetrievalLocator } from "@/lib/api/sse/locators";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import type { DocumentEmbed } from "@/lib/media/documentEmbeds";
import type { MediaNavigationResponse } from "@/lib/media/readerNavigation";
import type { EdgeKind, EdgeOrigin } from "@/lib/resourceGraph/connections";
import type { ResourceActivation } from "@/lib/resources/activation";
import { decodeReaderDocumentMapContract } from "./documentMapContract";

export type ReaderEvidenceFactKind =
  "Highlight" | "SourceReference" | "GeneratedCitation" | "Link" | "Synapse";

export type ReaderEvidenceSemanticKind =
  "highlight" | "citation" | "link" | "synapse";

export type ReaderEvidenceSourceKind =
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

export type ReaderEvidenceConfidence = "exact" | "strong" | "probable";

export interface ReaderEvidenceAnchor {
  locator: MediaRetrievalLocator;
  // Present when the resolved locus is a durable passage anchor, so a mutation
  // can key off the anchor rather than the edge. Null for every other locus.
  passage_anchor_id: string | null;
}

export type ReaderEvidenceResolution =
  | {
      kind: "Resolved";
      anchor: ReaderEvidenceAnchor;
      order_key: string;
    }
  | {
      kind: "Unavailable";
      reason: "Missing" | "Unanchorable" | "Stale";
    };

interface ReaderEvidenceObjectBase {
  ref: string;
  label: string;
  excerpt: Presence<string>;
  activation: ResourceActivation;
}

export interface ReaderEvidenceChatObject extends ReaderEvidenceObjectBase {
  kind: "Chat";
  conversation_id: string;
  message_ref: Presence<string>;
}

export interface ReaderEvidenceNoteObject extends ReaderEvidenceObjectBase {
  kind: "Note";
  note_block_id: string;
  body_pm_json: Record<string, unknown>;
}

export interface ReaderEvidenceDossierObject extends ReaderEvidenceObjectBase {
  kind: "Dossier";
}

export interface ReaderEvidenceOracleObject extends ReaderEvidenceObjectBase {
  kind: "Oracle";
}

export interface ReaderEvidenceMediaObject extends ReaderEvidenceObjectBase {
  kind: "Media";
}

export interface ReaderEvidenceOtherObject extends ReaderEvidenceObjectBase {
  kind: "Other";
}

export type ReaderEvidenceObject =
  | ReaderEvidenceChatObject
  | ReaderEvidenceNoteObject
  | ReaderEvidenceDossierObject
  | ReaderEvidenceOracleObject
  | ReaderEvidenceMediaObject
  | ReaderEvidenceOtherObject;

export interface ReaderEvidenceAuthoredInAssociation {
  relationship: "AuthoredIn";
  object: ReaderEvidenceObject;
}

export interface ReaderEvidenceDirectlyAttachedAssociation {
  relationship: "DirectlyAttached";
  object: ReaderEvidenceObject;
  edge_id: string;
  role: EdgeKind;
  origin: EdgeOrigin;
  direction: "Outgoing" | "Incoming";
}

export type ReaderEvidenceHighlightNoteAssociation =
  ReaderEvidenceDirectlyAttachedAssociation & {
    origin: "highlight_note";
    direction: "Outgoing";
    object: ReaderEvidenceNoteObject;
  };

export type ReaderEvidenceUserStanceAssociation =
  ReaderEvidenceDirectlyAttachedAssociation & {
    origin: "user";
    direction: "Outgoing";
    role: "supports" | "contradicts";
  };

export type ReaderEvidenceAssociation =
  | ReaderEvidenceAuthoredInAssociation
  | ReaderEvidenceDirectlyAttachedAssociation;

export interface ReaderEvidenceAlsoReference {
  relationship: "AlsoReferences";
  object: ReaderEvidenceObject;
}

interface ReaderEvidenceItemBase {
  id: string;
  label: string;
  excerpt: Presence<string>;
  associations: ReaderEvidenceAssociation[];
}

export interface ReaderEvidenceHighlight extends ReaderEvidenceItemBase {
  kind: "Highlight";
  highlight_id: string;
  quote: string;
  prefix: string;
  suffix: string;
  color: HighlightColor;
  created_at: string;
  updated_at: string;
  author_user_id: string;
  is_owner: boolean;
}

export interface ReaderEvidenceSourceTarget {
  ref: string;
  stable_key: string;
  apparatus_kind: ReaderEvidenceSourceKind;
  label: Presence<string>;
  body: Presence<string>;
  activation: ResourceActivation;
  resolution: ReaderEvidenceResolution;
}

export interface ReaderEvidenceSourceReference extends ReaderEvidenceItemBase {
  kind: "SourceReference";
  stable_key: string;
  apparatus_kind: ReaderEvidenceSourceKind;
  confidence: ReaderEvidenceConfidence;
  targets: ReaderEvidenceSourceTarget[];
}

export interface ReaderEvidenceGeneratedCitation extends ReaderEvidenceItemBase {
  kind: "GeneratedCitation";
  edge_id: string;
  role: EdgeKind;
}

export interface ReaderEvidenceLink extends ReaderEvidenceItemBase {
  kind: "Link";
  edge_id: string;
  role: EdgeKind;
  origin: EdgeOrigin;
  object: ReaderEvidenceObject;
}

/** Explicit user-authored graph facts that the Evidence presenter may remove.
 * A fact can arrive either as a top-level Link row or folded onto another fact
 * as a DirectlyAttached association; both carry the authoritative mutation key
 * and relation role. */
export type ReaderEvidenceUserLink = ReaderEvidenceLink & {
  origin: "user";
};
export type ReaderEvidenceUserAssociation =
  ReaderEvidenceDirectlyAttachedAssociation & {
    origin: "user";
  };
export type ReaderEvidenceUserEdge =
  ReaderEvidenceUserLink | ReaderEvidenceUserAssociation;

export interface ReaderEvidenceSynapse extends ReaderEvidenceItemBase {
  kind: "Synapse";
  edge_id: string;
  role: EdgeKind;
  rationale: string;
  object: ReaderEvidenceObject;
}

export type ReaderEvidenceItem =
  | ReaderEvidenceHighlight
  | ReaderEvidenceSourceReference
  | ReaderEvidenceGeneratedCitation
  | ReaderEvidenceLink
  | ReaderEvidenceSynapse;

export interface ReaderEvidencePassageGroup {
  locus_ref: string;
  resolution: ReaderEvidenceResolution;
  target_excerpt: Presence<string>;
  items: ReaderEvidenceItem[];
  also_references: ReaderEvidenceAlsoReference[];
}

export interface ReaderEvidenceCounts {
  highlights: number;
  citations: number;
  links: number;
  synapses: number;
  passages: number;
  document: number;
}

export interface ReaderEvidence {
  counts: ReaderEvidenceCounts;
  passage_groups: ReaderEvidencePassageGroup[];
  document_items: ReaderEvidenceItem[];
}

export type ReaderDocumentMapMarkerKind =
  "Contents" | "Embed" | ReaderEvidenceFactKind;

export interface ReaderDocumentMapMarker {
  id: string;
  kind: ReaderDocumentMapMarkerKind;
  item_id: string;
  position: number;
  tone: "Neutral" | "Highlight" | "Citation" | "Link" | "Synapse" | "Warning";
  label: string;
  preview: Presence<string>;
}

export interface ReaderDocumentMap {
  media_id: string;
  media_kind: string;
  title: string;
  status: "ready" | "empty" | "partial";
  source_version: {
    media_updated_at: Presence<string>;
    apparatus_source_fingerprint: Presence<string>;
    graph_max_updated_at: Presence<string>;
    highlights_max_updated_at: Presence<string>;
  };
  navigation: Presence<MediaNavigationResponse["data"]>;
  embeds: DocumentEmbed[];
  evidence: ReaderEvidence;
  markers: ReaderDocumentMapMarker[];
  diagnostics: {
    omitted_item_counts: Record<string, number>;
  };
}

interface ReaderDocumentMapResponse {
  data: unknown;
}

export type ReaderEvidenceItemLocation =
  | {
      scope: "passage";
      item: ReaderEvidenceItem;
      group: ReaderEvidencePassageGroup;
    }
  | {
      scope: "document";
      item: ReaderEvidenceItem;
    };

export function semanticKindForEvidenceItem(
  item: ReaderEvidenceItem,
): ReaderEvidenceSemanticKind {
  switch (item.kind) {
    case "Highlight":
      return "highlight";
    case "SourceReference":
    case "GeneratedCitation":
      return "citation";
    case "Link":
      return "link";
    case "Synapse":
      return "synapse";
  }
}

export function highlightNoteAssociations(
  item: ReaderEvidenceHighlight,
): ReaderEvidenceHighlightNoteAssociation[] {
  return item.associations.filter(
    (association): association is ReaderEvidenceHighlightNoteAssociation =>
      association.relationship === "DirectlyAttached" &&
      association.origin === "highlight_note" &&
      association.direction === "Outgoing" &&
      association.object.kind === "Note",
  );
}

export function userStanceAssociations(
  item: ReaderEvidenceHighlight,
): ReaderEvidenceUserStanceAssociation[] {
  return item.associations.filter(
    (association): association is ReaderEvidenceUserStanceAssociation =>
      association.relationship === "DirectlyAttached" &&
      association.origin === "user" &&
      association.direction === "Outgoing" &&
      (association.role === "supports" || association.role === "contradicts"),
  );
}

export function isReaderEvidenceUserLink(
  item: ReaderEvidenceItem,
): item is ReaderEvidenceUserLink {
  return item.kind === "Link" && item.origin === "user";
}

export function isReaderEvidenceUserAssociation(
  association: ReaderEvidenceAssociation | ReaderEvidenceAlsoReference,
): association is ReaderEvidenceUserAssociation {
  return (
    association.relationship === "DirectlyAttached" &&
    association.origin === "user"
  );
}

export function findEvidenceItem(
  evidence: ReaderEvidence,
  itemId: string,
): ReaderEvidenceItemLocation | null {
  for (const group of evidence.passage_groups) {
    const item = group.items.find((candidate) => candidate.id === itemId);
    if (item) return { scope: "passage", item, group };
  }
  const item = evidence.document_items.find(
    (candidate) => candidate.id === itemId,
  );
  return item ? { scope: "document", item } : null;
}

export function readerSurfaceForMarkerKind(
  kind: ReaderDocumentMapMarkerKind,
): "resource-contents" | "resource-evidence" | null {
  switch (kind) {
    case "Contents":
      return "resource-contents";
    case "Embed":
      return null;
    case "Highlight":
    case "SourceReference":
    case "GeneratedCitation":
    case "Link":
    case "Synapse":
      return "resource-evidence";
  }
}

export async function getReaderDocumentMap(
  mediaId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ReaderDocumentMap> {
  const response = await apiFetch<ReaderDocumentMapResponse>(
    `/api/media/${mediaId}/document-map` as ApiPath,
    { signal: options.signal },
  );
  return decodeReaderDocumentMap(response.data);
}

export function decodeReaderDocumentMap(raw: unknown): ReaderDocumentMap {
  return decodeReaderDocumentMapContract(raw);
}
