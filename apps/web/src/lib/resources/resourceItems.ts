import type {
  LibraryPlacementMode,
  ResourceChatSubjectMode,
  ResourceExpansionPolicy,
  ResourceInspectMode,
  ResourcePromptRenderMode,
  ResourceReadMode,
  UserLinkTargetMode,
} from "@/lib/resources/resourceCapabilities";
import { isLibraryPlacementMode } from "@/lib/resources/resourceCapabilities";
import { isShareMode, type ShareMode } from "@/lib/sharing/types";
import {
  decodeCamelCaseResourceActivation,
  type ResourceActivation,
} from "@/lib/resources/activation";
import {
  isResourceScheme,
  parseResourceRef,
  type ResourceScheme,
} from "@/lib/resourceGraph/resourceRef";
import {
  expectBoolean,
  expectCanonicalUuid,
  expectExactRecord,
  expectInteger,
  expectNullableString,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";

// Wire shape of `ResourceUserRelationPolicyOut`
// (python/nexus/schemas/resource_items.py) — replaces the scalar `linkable`
// boolean (universal-link-authoring-hard-cutover.md, Capability Contract).
export interface ResourceUserRelation {
  userLinkSource: boolean;
  userLinkTarget: UserLinkTargetMode;
  noteReferenceTarget: boolean;
}

export interface ResourceItemCapabilities {
  userRelation: ResourceUserRelation;
  sharing: ShareMode;
  libraryPlacement: LibraryPlacementMode;
  attachable: boolean;
  chatSubject: ResourceChatSubjectMode;
  readable: ResourceReadMode;
  inspectable: ResourceInspectMode;
  citableResultType: string | null;
  citationOutputSource: boolean;
  appSearchScope: boolean;
  conversationSearchScope: boolean;
  promptRender: ResourcePromptRenderMode;
  expansionPolicy: ResourceExpansionPolicy;
  expandable: boolean;
  adjacencySource: boolean;
  adjacencyTarget: boolean;
}

export interface ResourceItem {
  ref: string;
  scheme: ResourceScheme;
  id: string;
  label: string;
  summary: string;
  route: string | null;
  activation: ResourceActivation;
  missing: boolean;
  capabilities: ResourceItemCapabilities;
  versionByLane: Record<string, number>;
}

export type ResourceSurfaceContent =
  | { kind: "page_title"; title: string }
  | {
      kind: "note_body";
      bodyPmJson: Record<string, unknown>;
      bodyText: string;
    }
  | { kind: "resource_summary" };

export interface ResourceSurfaceNode {
  item: ResourceItem;
  content: ResourceSurfaceContent;
}

export interface ResourceSurfaceOccurrence {
  occurrenceId: string;
  target: ResourceSurfaceNode;
}

export interface ResourceSurface {
  source: ResourceSurfaceNode;
  orderedItems: ResourceSurfaceOccurrence[];
}

export type SurfacePosition =
  | { kind: "start" }
  | { kind: "after"; occurrenceId: string };

const RESOURCE_ITEM_KEYS = [
  "ref",
  "scheme",
  "id",
  "label",
  "summary",
  "route",
  "activation",
  "missing",
  "capabilities",
  "versionByLane",
] as const;
const RESOURCE_CAPABILITY_KEYS = [
  "userRelation",
  "sharing",
  "libraryPlacement",
  "attachable",
  "chatSubject",
  "readable",
  "inspectable",
  "citableResultType",
  "citationOutputSource",
  "appSearchScope",
  "conversationSearchScope",
  "promptRender",
  "expansionPolicy",
  "expandable",
  "adjacencySource",
  "adjacencyTarget",
] as const;
const RESOURCE_USER_RELATION_KEYS = [
  "userLinkSource",
  "userLinkTarget",
  "noteReferenceTarget",
] as const;

function decodeUserRelation(raw: unknown): ResourceUserRelation {
  const record = expectExactRecord(
    raw,
    RESOURCE_USER_RELATION_KEYS,
    "resource user relation",
  );
  return {
    userLinkSource: expectBoolean(
      record.userLinkSource,
      "resource user relation.userLinkSource",
    ),
    userLinkTarget: expectOneOf(
      record.userLinkTarget,
      ["none", "direct", "materialize_passage"] as const,
      "resource user relation.userLinkTarget",
    ),
    noteReferenceTarget: expectBoolean(
      record.noteReferenceTarget,
      "resource user relation.noteReferenceTarget",
    ),
  };
}

/**
 * Sole strict decoder for the canonical by-alias camel-case ResourceItemOut
 * wire. Same-system shape drift is a defect: alternate casing, missing/defaulted
 * fields, extra fields, and identity mismatches all throw at this boundary.
 */
export function decodeResourceItem(raw: unknown): ResourceItem {
  const item = expectExactRecord(raw, RESOURCE_ITEM_KEYS, "resource item");
  const ref = expectString(item.ref, "resource item.ref");
  const parsedRef = parseResourceRef(ref);
  if (parsedRef === null) {
    throw new TypeError("resource item.ref must be a canonical ResourceRef");
  }
  const scheme = expectString(item.scheme, "resource item.scheme");
  if (!isResourceScheme(scheme) || scheme !== parsedRef.scheme) {
    throw new TypeError("resource item.scheme must match resource item.ref");
  }
  const id = expectString(item.id, "resource item.id");
  if (id !== parsedRef.id) {
    throw new TypeError("resource item.id must match resource item.ref");
  }
  const capabilities = expectExactRecord(
    item.capabilities,
    RESOURCE_CAPABILITY_KEYS,
    "resource capabilities",
  );
  if (!isShareMode(capabilities.sharing)) {
    throw new TypeError("resource capabilities.sharing is invalid");
  }
  const libraryPlacement = capabilities.libraryPlacement;
  if (!isLibraryPlacementMode(libraryPlacement)) {
    throw new TypeError("resource capabilities.libraryPlacement is invalid");
  }
  const versionRecord = expectRecord(
    item.versionByLane,
    "resource item.versionByLane",
  );
  const versionByLane = Object.fromEntries(
    Object.entries(versionRecord).map(([lane, rawVersion]) => {
      const version = expectInteger(
        rawVersion,
        `resource item.versionByLane.${lane}`,
      );
      if (version < 1) {
        throw new TypeError(
          `resource item.versionByLane.${lane} must be positive`,
        );
      }
      return [lane, version];
    }),
  );
  const route = expectNullableString(item.route, "resource item.route");
  const activation = decodeCamelCaseResourceActivation(
    item.activation,
    "resource item.activation",
  );
  if (activation.resourceRef !== ref) {
    throw new TypeError(
      "resource item.activation.resourceRef must match resource item.ref",
    );
  }
  if (
    (activation.kind === "route" && route !== activation.href) ||
    (activation.kind !== "route" && route !== null)
  ) {
    throw new TypeError("resource item.route must match route activation");
  }
  return {
    ref,
    scheme,
    id,
    label: expectString(item.label, "resource item.label"),
    summary: expectString(item.summary, "resource item.summary"),
    route,
    activation,
    missing: expectBoolean(item.missing, "resource item.missing"),
    capabilities: {
      userRelation: decodeUserRelation(capabilities.userRelation),
      sharing: capabilities.sharing,
      libraryPlacement,
      attachable: expectBoolean(
        capabilities.attachable,
        "resource capabilities.attachable",
      ),
      chatSubject: expectOneOf(
        capabilities.chatSubject,
        [
          "none",
          "label",
          "scope",
          "readable",
          "quote",
          "generated_output",
        ] as const,
        "resource capabilities.chatSubject",
      ),
      readable: expectOneOf(
        capabilities.readable,
        ["none", "scope", "body", "media"] as const,
        "resource capabilities.readable",
      ),
      inspectable: expectOneOf(
        capabilities.inspectable,
        ["none", "media_document_map"] as const,
        "resource capabilities.inspectable",
      ),
      citableResultType: expectNullableString(
        capabilities.citableResultType,
        "resource capabilities.citableResultType",
      ),
      citationOutputSource: expectBoolean(
        capabilities.citationOutputSource,
        "resource capabilities.citationOutputSource",
      ),
      appSearchScope: expectBoolean(
        capabilities.appSearchScope,
        "resource capabilities.appSearchScope",
      ),
      conversationSearchScope: expectBoolean(
        capabilities.conversationSearchScope,
        "resource capabilities.conversationSearchScope",
      ),
      promptRender: expectOneOf(
        capabilities.promptRender,
        ["none", "label", "inline_body", "quote"] as const,
        "resource capabilities.promptRender",
      ),
      expansionPolicy: expectOneOf(
        capabilities.expansionPolicy,
        [
          "none",
          "media_owned_reader_children",
          "page_note_blocks",
          "note_block_owned_evidence",
          "artifact_revisions",
        ] as const,
        "resource capabilities.expansionPolicy",
      ),
      expandable: expectBoolean(
        capabilities.expandable,
        "resource capabilities.expandable",
      ),
      adjacencySource: expectBoolean(
        capabilities.adjacencySource,
        "resource capabilities.adjacencySource",
      ),
      adjacencyTarget: expectBoolean(
        capabilities.adjacencyTarget,
        "resource capabilities.adjacencyTarget",
      ),
    },
    versionByLane,
  };
}

function normalizeResourceSurfaceContent(raw: unknown): ResourceSurfaceContent {
  const record = expectRecord(raw, "surface content");
  switch (expectString(record.kind, "surface content.kind")) {
    case "page_title":
      return {
        kind: "page_title",
        title: expectString(
          expectExactRecord(
            raw,
            ["kind", "title"],
            "page title surface content",
          ).title,
          "page title surface content.title",
        ),
      };
    case "note_body": {
      const content = expectExactRecord(
        raw,
        ["kind", "body_pm_json", "body_text"],
        "note body surface content",
      );
      return {
        kind: "note_body",
        bodyPmJson: expectRecord(
          content.body_pm_json,
          "note body surface content.body_pm_json",
        ),
        bodyText: expectString(
          content.body_text,
          "note body surface content.body_text",
        ),
      };
    }
    case "resource_summary":
      expectExactRecord(raw, ["kind"], "resource summary surface content");
      return { kind: "resource_summary" };
    default:
      throw new TypeError("surface content.kind is invalid");
  }
}

function normalizeResourceSurfaceNode(raw: unknown): ResourceSurfaceNode {
  const node = expectExactRecord(raw, ["item", "content"], "surface node");
  return {
    item: decodeResourceItem(node.item),
    content: normalizeResourceSurfaceContent(node.content),
  };
}

/** Decodes only the canonical snake_case resource-surface wire contract. */
export function normalizeResourceSurface(raw: unknown): ResourceSurface {
  const surface = expectExactRecord(
    raw,
    ["source", "ordered_items"],
    "resource surface",
  );
  if (!Array.isArray(surface.ordered_items)) {
    throw new Error("Resource surface is missing ordered_items");
  }
  return {
    source: normalizeResourceSurfaceNode(surface.source),
    orderedItems: surface.ordered_items.map((rawOccurrence) => {
      const occurrence = expectExactRecord(
        rawOccurrence,
        ["occurrence_id", "target"],
        "surface occurrence",
      );
      return {
        occurrenceId: expectCanonicalUuid(
          occurrence.occurrence_id,
          "surface occurrence.occurrence_id",
        ),
        target: normalizeResourceSurfaceNode(occurrence.target),
      };
    }),
  };
}

function decodeResourceSurfaceSnapshotContent(
  raw: unknown,
): ResourceSurfaceContent {
  const record = expectRecord(raw, "resource surface snapshot content");
  switch (expectString(record.kind, "resource surface snapshot content.kind")) {
    case "page_title": {
      const content = expectExactRecord(
        raw,
        ["kind", "title"],
        "page title resource surface snapshot content",
      );
      return {
        kind: "page_title",
        title: expectString(
          content.title,
          "page title resource surface snapshot content.title",
        ),
      };
    }
    case "note_body": {
      const content = expectExactRecord(
        raw,
        ["kind", "bodyPmJson", "bodyText"],
        "note body resource surface snapshot content",
      );
      return {
        kind: "note_body",
        bodyPmJson: expectRecord(
          content.bodyPmJson,
          "note body resource surface snapshot content.bodyPmJson",
        ),
        bodyText: expectString(
          content.bodyText,
          "note body resource surface snapshot content.bodyText",
        ),
      };
    }
    case "resource_summary":
      expectExactRecord(
        raw,
        ["kind"],
        "resource summary resource surface snapshot content",
      );
      return { kind: "resource_summary" };
    default:
      throw new TypeError("resource surface snapshot content.kind is invalid");
  }
}

function decodeResourceSurfaceSnapshotNode(raw: unknown): ResourceSurfaceNode {
  const node = expectExactRecord(
    raw,
    ["item", "content"],
    "resource surface snapshot node",
  );
  return {
    item: decodeResourceItem(node.item),
    content: decodeResourceSurfaceSnapshotContent(node.content),
  };
}

/** Exact decoder for the camel-case browser-persisted surface snapshot. */
export function decodeResourceSurfaceSnapshot(raw: unknown): ResourceSurface {
  const surface = expectExactRecord(
    raw,
    ["source", "orderedItems"],
    "resource surface snapshot",
  );
  if (!Array.isArray(surface.orderedItems)) {
    throw new TypeError("resource surface snapshot.orderedItems must be an array");
  }
  return {
    source: decodeResourceSurfaceSnapshotNode(surface.source),
    orderedItems: surface.orderedItems.map((rawOccurrence) => {
      const occurrence = expectExactRecord(
        rawOccurrence,
        ["occurrenceId", "target"],
        "resource surface snapshot occurrence",
      );
      return {
        occurrenceId: expectCanonicalUuid(
          occurrence.occurrenceId,
          "resource surface snapshot occurrence.occurrenceId",
        ),
        target: decodeResourceSurfaceSnapshotNode(occurrence.target),
      };
    }),
  };
}
