import { decodePresence, type Presence } from "@/lib/api/presence";
import {
  isMediaRetrievalLocator,
  isRetrievalLocator,
} from "@/lib/api/sse/locators";
import { HIGHLIGHT_COLORS } from "@/lib/highlights/segmenter";
import { decodeDocumentEmbeds } from "@/lib/media/documentEmbeds";
import { decodeMediaNavigation } from "@/lib/media/readerNavigation";
import { EDGE_KINDS, EDGE_ORIGINS } from "@/lib/resourceGraph/edges";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import type { ResourceActivation } from "@/lib/resources/activation";
import {
  expectArray,
  expectBoolean,
  expectExactRecord,
  expectFiniteNumber,
  expectNonnegativeInteger,
  expectNullableString,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";
import type {
  ReaderDocumentMap,
  ReaderDocumentMapMarker,
  ReaderEvidence,
  ReaderEvidenceAlsoReference,
  ReaderEvidenceAnchor,
  ReaderEvidenceAssociation,
  ReaderEvidenceItem,
  ReaderEvidenceObject,
  ReaderEvidencePassageGroup,
  ReaderEvidenceResolution,
  ReaderEvidenceSourceKind,
  ReaderEvidenceSourceTarget,
} from "./documentMap";

interface ReaderEvidenceItemBase {
  id: string;
  label: string;
  excerpt: Presence<string>;
  associations: ReaderEvidenceAssociation[];
}

export function decodeReaderDocumentMapContract(
  raw: unknown,
): ReaderDocumentMap {
  const value = expectExactRecord(
    raw,
    [
      "media_id",
      "media_kind",
      "title",
      "status",
      "source_version",
      "navigation",
      "embeds",
      "evidence",
      "markers",
      "diagnostics",
    ],
    "ReaderDocumentMap",
  );
  const status = expectOneOf(
    value.status,
    ["ready", "empty", "partial"] as const,
    "ReaderDocumentMap.status",
  );
  const sourceVersion = expectExactRecord(
    value.source_version,
    [
      "media_updated_at",
      "apparatus_source_fingerprint",
      "graph_max_updated_at",
      "highlights_max_updated_at",
    ],
    "ReaderDocumentMap.source_version",
  );
  const diagnostics = expectExactRecord(
    value.diagnostics,
    ["omitted_item_counts"],
    "ReaderDocumentMap.diagnostics",
  );
  const omittedCounts = recordOfNonnegativeIntegers(
    diagnostics.omitted_item_counts,
    "ReaderDocumentMap.diagnostics.omitted_item_counts",
  );
  return {
    media_id: expectString(value.media_id, "ReaderDocumentMap.media_id"),
    media_kind: expectString(value.media_kind, "ReaderDocumentMap.media_kind"),
    title: expectString(value.title, "ReaderDocumentMap.title"),
    status,
    source_version: {
      media_updated_at: decodeStringPresence(
        sourceVersion.media_updated_at,
        "ReaderDocumentMap.source_version.media_updated_at",
      ),
      apparatus_source_fingerprint: decodeStringPresence(
        sourceVersion.apparatus_source_fingerprint,
        "ReaderDocumentMap.source_version.apparatus_source_fingerprint",
      ),
      graph_max_updated_at: decodeStringPresence(
        sourceVersion.graph_max_updated_at,
        "ReaderDocumentMap.source_version.graph_max_updated_at",
      ),
      highlights_max_updated_at: decodeStringPresence(
        sourceVersion.highlights_max_updated_at,
        "ReaderDocumentMap.source_version.highlights_max_updated_at",
      ),
    },
    navigation: decodeNavigationPresence(value.navigation),
    embeds: decodeDocumentEmbeds(value.embeds, "ReaderDocumentMap.embeds"),
    evidence: decodeEvidence(value.evidence),
    markers: expectArray(
      value.markers,
      decodeMarker,
      "ReaderDocumentMap.markers",
    ),
    diagnostics: { omitted_item_counts: omittedCounts },
  };
}

function decodeEvidence(raw: unknown): ReaderEvidence {
  const value = expectExactRecord(
    raw,
    ["counts", "passage_groups", "document_items"],
    "Evidence",
  );
  const counts = expectExactRecord(
    value.counts,
    ["highlights", "citations", "links", "synapses", "passages", "document"],
    "Evidence.counts",
  );
  return {
    counts: {
      highlights: expectNonnegativeInteger(
        counts.highlights,
        "Evidence.counts.highlights",
      ),
      citations: expectNonnegativeInteger(
        counts.citations,
        "Evidence.counts.citations",
      ),
      links: expectNonnegativeInteger(counts.links, "Evidence.counts.links"),
      synapses: expectNonnegativeInteger(
        counts.synapses,
        "Evidence.counts.synapses",
      ),
      passages: expectNonnegativeInteger(
        counts.passages,
        "Evidence.counts.passages",
      ),
      document: expectNonnegativeInteger(
        counts.document,
        "Evidence.counts.document",
      ),
    },
    passage_groups: expectArray(
      value.passage_groups,
      decodePassageGroup,
      "Evidence.passage_groups",
    ),
    document_items: expectArray(
      value.document_items,
      decodeEvidenceItem,
      "Evidence.document_items",
    ),
  };
}

function decodePassageGroup(
  raw: unknown,
  index: number,
): ReaderEvidencePassageGroup {
  const name = `Evidence.passage_groups[${index}]`;
  const value = expectExactRecord(
    raw,
    ["locus_ref", "resolution", "target_excerpt", "items", "also_references"],
    name,
  );
  const locusRef = expectResourceRef(value.locus_ref, `${name}.locus_ref`);
  return {
    locus_ref: locusRef,
    resolution: decodeResolution(value.resolution, `${name}.resolution`),
    target_excerpt: decodeStringPresence(
      value.target_excerpt,
      `${name}.target_excerpt`,
    ),
    items: expectArray(value.items, decodeEvidenceItem, `${name}.items`),
    also_references: expectArray(
      value.also_references,
      decodeAlsoReference,
      `${name}.also_references`,
    ),
  };
}

function decodeResolution(
  raw: unknown,
  name: string,
): ReaderEvidenceResolution {
  const value = expectRecord(raw, name);
  if (value.kind === "Resolved") {
    const resolved = expectExactRecord(
      value,
      ["kind", "anchor", "order_key"],
      name,
    );
    return {
      kind: "Resolved",
      anchor: decodeAnchor(resolved.anchor, `${name}.anchor`),
      order_key: expectString(resolved.order_key, `${name}.order_key`),
    };
  }
  if (value.kind === "Unavailable") {
    const unavailable = expectExactRecord(value, ["kind", "reason"], name);
    return {
      kind: "Unavailable",
      reason: expectOneOf(
        unavailable.reason,
        ["Missing", "Unanchorable", "Stale"] as const,
        `${name}.reason`,
      ),
    };
  }
  return defect(`${name}.kind must be Resolved or Unavailable`);
}

function decodeAnchor(raw: unknown, name: string): ReaderEvidenceAnchor {
  const value = expectExactRecord(raw, ["locator"], name);
  if (
    !isRetrievalLocator(value.locator) ||
    !isMediaRetrievalLocator(value.locator)
  ) {
    defect(`${name}.locator is not a supported media reader locator`);
  }
  return {
    locator: value.locator,
  };
}

function decodeEvidenceItem(raw: unknown, index: number): ReaderEvidenceItem {
  const name = `Evidence item[${index}]`;
  const value = expectRecord(raw, name);
  switch (value.kind) {
    case "Highlight": {
      const item = expectExactRecord(
        value,
        [
          "id",
          "kind",
          "label",
          "excerpt",
          "associations",
          "highlight_id",
          "quote",
          "prefix",
          "suffix",
          "color",
          "created_at",
          "updated_at",
          "author_user_id",
          "is_owner",
        ],
        name,
      );
      const color = expectOneOf(item.color, HIGHLIGHT_COLORS, `${name}.color`);
      return {
        ...decodeItemBase(item, name),
        kind: "Highlight",
        highlight_id: expectString(item.highlight_id, `${name}.highlight_id`),
        quote: expectString(item.quote, `${name}.quote`),
        prefix: expectString(item.prefix, `${name}.prefix`),
        suffix: expectString(item.suffix, `${name}.suffix`),
        color,
        created_at: expectString(item.created_at, `${name}.created_at`),
        updated_at: expectString(item.updated_at, `${name}.updated_at`),
        author_user_id: expectString(
          item.author_user_id,
          `${name}.author_user_id`,
        ),
        is_owner: expectBoolean(item.is_owner, `${name}.is_owner`),
      };
    }
    case "SourceReference": {
      const item = expectExactRecord(
        value,
        [
          "id",
          "kind",
          "label",
          "excerpt",
          "associations",
          "stable_key",
          "apparatus_kind",
          "confidence",
          "targets",
        ],
        name,
      );
      return {
        ...decodeItemBase(item, name),
        kind: "SourceReference",
        stable_key: expectString(item.stable_key, `${name}.stable_key`),
        apparatus_kind: decodeApparatusKind(
          item.apparatus_kind,
          `${name}.apparatus_kind`,
        ),
        confidence: expectOneOf(
          item.confidence,
          ["exact", "strong", "probable"] as const,
          `${name}.confidence`,
        ),
        targets: expectArray(
          item.targets,
          decodeSourceTarget,
          `${name}.targets`,
        ),
      };
    }
    case "GeneratedCitation": {
      const item = expectExactRecord(
        value,
        ["id", "kind", "label", "excerpt", "associations", "edge_id", "role"],
        name,
      );
      return {
        ...decodeItemBase(item, name),
        kind: "GeneratedCitation",
        edge_id: expectString(item.edge_id, `${name}.edge_id`),
        role: expectOneOf(item.role, EDGE_KINDS, `${name}.role`),
      };
    }
    case "Link": {
      const item = expectExactRecord(
        value,
        [
          "id",
          "kind",
          "label",
          "excerpt",
          "associations",
          "edge_id",
          "role",
          "origin",
          "object",
        ],
        name,
      );
      return {
        ...decodeItemBase(item, name),
        kind: "Link",
        edge_id: expectString(item.edge_id, `${name}.edge_id`),
        role: expectOneOf(item.role, EDGE_KINDS, `${name}.role`),
        origin: expectOneOf(item.origin, EDGE_ORIGINS, `${name}.origin`),
        object: decodeEvidenceObject(item.object, `${name}.object`),
      };
    }
    case "Synapse": {
      const item = expectExactRecord(
        value,
        [
          "id",
          "kind",
          "label",
          "excerpt",
          "associations",
          "edge_id",
          "role",
          "rationale",
          "object",
        ],
        name,
      );
      return {
        ...decodeItemBase(item, name),
        kind: "Synapse",
        edge_id: expectString(item.edge_id, `${name}.edge_id`),
        role: expectOneOf(item.role, EDGE_KINDS, `${name}.role`),
        rationale: expectString(item.rationale, `${name}.rationale`),
        object: decodeEvidenceObject(item.object, `${name}.object`),
      };
    }
    default:
      return defect(`${name}.kind is not a supported Evidence fact kind`);
  }
}

function decodeItemBase(
  value: Record<string, unknown>,
  name: string,
): ReaderEvidenceItemBase {
  return {
    id: expectString(value.id, `${name}.id`),
    label: expectString(value.label, `${name}.label`),
    excerpt: decodeStringPresence(value.excerpt, `${name}.excerpt`),
    associations: expectArray(
      value.associations,
      decodeAssociation,
      `${name}.associations`,
    ),
  };
}

function decodeSourceTarget(
  raw: unknown,
  index: number,
): ReaderEvidenceSourceTarget {
  const name = `Source target[${index}]`;
  const value = expectExactRecord(
    raw,
    [
      "ref",
      "stable_key",
      "apparatus_kind",
      "label",
      "body",
      "activation",
      "resolution",
    ],
    name,
  );
  return {
    ref: expectResourceRef(value.ref, `${name}.ref`),
    stable_key: expectString(value.stable_key, `${name}.stable_key`),
    apparatus_kind: decodeApparatusKind(
      value.apparatus_kind,
      `${name}.apparatus_kind`,
    ),
    label: decodeStringPresence(value.label, `${name}.label`),
    body: decodeStringPresence(value.body, `${name}.body`),
    activation: decodeActivation(value.activation, `${name}.activation`),
    resolution: decodeResolution(value.resolution, `${name}.resolution`),
  };
}

function decodeAssociation(
  raw: unknown,
  index: number,
): ReaderEvidenceAssociation {
  const name = `Evidence association[${index}]`;
  const value = expectRecord(raw, name);
  if (value.relationship === "AuthoredIn") {
    const association = expectExactRecord(
      value,
      ["relationship", "object"],
      name,
    );
    return {
      relationship: "AuthoredIn",
      object: decodeEvidenceObject(association.object, `${name}.object`),
    };
  }
  if (value.relationship === "DirectlyAttached") {
    const association = expectExactRecord(
      value,
      ["relationship", "object", "edge_id", "role", "origin", "direction"],
      name,
    );
    return {
      relationship: "DirectlyAttached",
      object: decodeEvidenceObject(association.object, `${name}.object`),
      edge_id: expectString(association.edge_id, `${name}.edge_id`),
      role: expectOneOf(association.role, EDGE_KINDS, `${name}.role`),
      origin: expectOneOf(association.origin, EDGE_ORIGINS, `${name}.origin`),
      direction: expectOneOf(
        association.direction,
        ["Outgoing", "Incoming"] as const,
        `${name}.direction`,
      ),
    };
  }
  return defect(`${name}.relationship is not supported`);
}

function decodeAlsoReference(
  raw: unknown,
  index: number,
): ReaderEvidenceAlsoReference {
  const name = `Also-reference association[${index}]`;
  const value = expectExactRecord(raw, ["relationship", "object"], name);
  if (value.relationship !== "AlsoReferences") {
    defect(`${name}.relationship must be AlsoReferences`);
  }
  return {
    relationship: "AlsoReferences",
    object: decodeEvidenceObject(value.object, `${name}.object`),
  };
}

function decodeEvidenceObject(
  raw: unknown,
  name: string,
): ReaderEvidenceObject {
  const value = expectRecord(raw, name);
  const commonKeys = ["ref", "kind", "label", "excerpt", "activation"];
  const base = () => ({
    ref: expectResourceRef(value.ref, `${name}.ref`),
    label: expectString(value.label, `${name}.label`),
    excerpt: decodeStringPresence(value.excerpt, `${name}.excerpt`),
    activation: decodeActivation(value.activation, `${name}.activation`),
  });
  switch (value.kind) {
    case "Chat":
      expectExactRecord(
        value,
        [...commonKeys, "conversation_id", "message_ref"],
        name,
      );
      return {
        ...base(),
        kind: "Chat",
        conversation_id: expectString(
          value.conversation_id,
          `${name}.conversation_id`,
        ),
        message_ref: decodeStringPresence(
          value.message_ref,
          `${name}.message_ref`,
        ),
      };
    case "Note":
      expectExactRecord(
        value,
        [...commonKeys, "note_block_id", "body_pm_json"],
        name,
      );
      return {
        ...base(),
        kind: "Note",
        note_block_id: expectString(
          value.note_block_id,
          `${name}.note_block_id`,
        ),
        body_pm_json: expectRecord(value.body_pm_json, `${name}.body_pm_json`),
      };
    case "Dossier":
    case "Oracle":
    case "Media":
    case "Other":
      expectExactRecord(value, commonKeys, name);
      return { ...base(), kind: value.kind };
    default:
      return defect(`${name}.kind is not supported`);
  }
}

function decodeActivation(raw: unknown, name: string): ResourceActivation {
  const value = expectExactRecord(
    raw,
    ["resource_ref", "kind", "href", "unresolved_reason"],
    name,
  );
  const kind = expectOneOf(
    value.kind,
    ["route", "external", "none"] as const,
    `${name}.kind`,
  );
  const href = expectNullableString(value.href, `${name}.href`);
  if ((kind === "route" || kind === "external") && href === null) {
    defect(`${name}.href is required for ${kind} activation`);
  }
  return {
    resourceRef: expectResourceRef(value.resource_ref, `${name}.resource_ref`),
    kind,
    href,
    unresolvedReason: expectNullableString(
      value.unresolved_reason,
      `${name}.unresolved_reason`,
    ),
  };
}

function decodeMarker(raw: unknown, index: number): ReaderDocumentMapMarker {
  const name = `ReaderDocumentMap.markers[${index}]`;
  const value = expectExactRecord(
    raw,
    ["id", "kind", "item_id", "position", "tone", "label", "preview"],
    name,
  );
  const position = expectFiniteNumber(value.position, `${name}.position`);
  if (position < 0 || position > 1)
    defect(`${name}.position must be between 0 and 1`);
  return {
    id: expectString(value.id, `${name}.id`),
    kind: expectOneOf(
      value.kind,
      [
        "Contents",
        "Embed",
        "Highlight",
        "SourceReference",
        "GeneratedCitation",
        "Link",
        "Synapse",
      ] as const,
      `${name}.kind`,
    ),
    item_id: expectString(value.item_id, `${name}.item_id`),
    position,
    tone: expectOneOf(
      value.tone,
      [
        "Neutral",
        "Highlight",
        "Citation",
        "Link",
        "Synapse",
        "Warning",
      ] as const,
      `${name}.tone`,
    ),
    label: expectString(value.label, `${name}.label`),
    preview: decodeStringPresence(value.preview, `${name}.preview`),
  };
}

const APPARATUS_KINDS: readonly ReaderEvidenceSourceKind[] = [
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
];

function decodeApparatusKind(
  raw: unknown,
  name: string,
): ReaderEvidenceSourceKind {
  return expectOneOf(raw, APPARATUS_KINDS, name);
}

function decodeNavigationPresence(
  raw: unknown,
): ReaderDocumentMap["navigation"] {
  try {
    return decodePresence(raw, (value) =>
      decodeMediaNavigation(value, "ReaderDocumentMap.navigation.value"),
    );
  } catch (error) {
    throw new TypeError("ReaderDocumentMap.navigation is invalid", {
      cause: error,
    });
  }
}

function decodeStringPresence(raw: unknown, name: string): Presence<string> {
  try {
    return decodePresence(raw, (value) => expectString(value, `${name}.value`));
  } catch (error) {
    throw new TypeError(`${name} is invalid`, { cause: error });
  }
}

function recordOfNonnegativeIntegers(
  raw: unknown,
  name: string,
): Record<string, number> {
  const value = expectRecord(raw, name);
  return Object.fromEntries(
    Object.entries(value).map(([key, count]) => [
      key,
      expectNonnegativeInteger(count, `${name}.${key}`),
    ]),
  );
}

function expectResourceRef(raw: unknown, name: string): string {
  const value = expectString(raw, name);
  if (!parseResourceRef(value))
    defect(`${name} must be a canonical ResourceRef`);
  return value;
}

function defect(message: string): never {
  throw new TypeError(`Invalid reader document map response: ${message}`);
}
