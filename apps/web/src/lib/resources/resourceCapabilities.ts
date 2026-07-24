import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";
import type { ShareMode } from "@/lib/sharing/types";

export type ResourceChatSubjectMode =
  | "none"
  | "label"
  | "scope"
  | "readable"
  | "quote"
  | "generated_output";
export type ResourceReadMode = "none" | "scope" | "body" | "media";
export type ResourceInspectMode = "none" | "media_document_map";
export type ResourcePromptRenderMode =
  | "none"
  | "label"
  | "inline_body"
  | "quote";
export type ResourceExpansionPolicy =
  | "none"
  | "media_owned_reader_children"
  | "page_note_blocks"
  | "note_block_owned_evidence"
  | "artifact_revisions";

// Mirrors backend `ResourceUserRelationPolicy`
// (python/nexus/services/resource_items/capabilities.py). Replaces the scalar
// `linkable` boolean, which could not distinguish a direct durable endpoint
// from raw material a search hit must materialize into a `passage_anchor`
// before it can be linked (universal-link-authoring-hard-cutover.md,
// Invariant 4).
export type UserLinkTargetMode = "none" | "direct" | "materialize_passage";

export interface ResourceUserRelationPolicy {
  userLinkSource: boolean;
  userLinkTarget: UserLinkTargetMode;
}

// Mirrors backend `ResourceInspectorSurfaceRole`/`ResourceInspectorPolicy`
// (python/nexus/services/resource_items/capabilities.py). Closed-code union
// values are PascalCase per docs/rules/naming.md ("Enums are PascalCase
// strings"), matching every other new vocabulary item in
// docs/cutovers/resource-inspector-and-universal-dossiers-hard-cutover.md
// (Capability Contract).
export type ResourceInspectorSurfaceRole =
  | "Contents"
  | "LinkedItems"
  | "Forks"
  | "Dossier";

// Which concrete LinkedItems surface a subject's Inspector resolves to:
// Media -> Evidence, Conversation -> Context, everything else -> Connections.
export type ResourceInspectorLinkedItemsSurface =
  | "MediaEvidence"
  | "ConversationContext"
  | "ResourceConnections";

// Only Conversation ever carries a Forks surface.
export type ResourceInspectorForksSurface = "ConversationForks";

export interface ResourceInspectorResourcePolicy {
  linkedItems: ResourceInspectorLinkedItemsSurface;
  forks: ResourceInspectorForksSurface | null;
  /** Fallback preference order, NOT tab display order. Always ends in the
   * always-published Dossier role. `useResourceInspector` selects the first
   * concrete surface currently published. */
  defaultSurfaceOrder: readonly ResourceInspectorSurfaceRole[];
}

// `None | Resource{...}`: only the 7 Dossier-eligible subjects (media,
// conversation, library, podcast, contributor, page, note_block) carry a
// non-null policy. `Resource` implies Dossier eligibility. Contents
// eligibility is NOT re-modeled here — it derives from the already-owned
// `inspectable` capability below (no `contents_provider` field).
export type ResourceInspectorPolicy = ResourceInspectorResourcePolicy | null;

export interface ResourceCapabilityProjection {
  userRelation: ResourceUserRelationPolicy;
  sharing: ShareMode;
  attachable: boolean;
  chatSubject: ResourceChatSubjectMode;
  readable: ResourceReadMode;
  inspectable: ResourceInspectMode;
  inspectorPolicy: ResourceInspectorPolicy;
  citableResultType: string | null;
  appSearchScope: boolean;
  conversationSearchScope: boolean;
  citationOutputSource: boolean;
  promptRender: ResourcePromptRenderMode;
  expansionPolicy: ResourceExpansionPolicy;
  adjacencySource: boolean;
  adjacencyTarget: boolean;
}

export const SYNAPSE_SOURCE_SCHEMES = [
  "media",
  "page",
  "note_block",
  "highlight",
] as const satisfies readonly ResourceScheme[];

// Static frontend projection of python/nexus/services/resource_items/capabilities.py.
// apps/web/src/lib/resourceGraph/contractParity.test.ts keeps this aligned.
export const RESOURCE_CAPABILITIES = {
  media: {
    userRelation: { userLinkSource: true, userLinkTarget: "direct" },
    sharing: "ResourceGrants",
    attachable: true,
    chatSubject: "readable",
    readable: "media",
    inspectable: "media_document_map",
    inspectorPolicy: {
      linkedItems: "MediaEvidence",
      forks: null,
      defaultSurfaceOrder: ["Contents", "LinkedItems", "Dossier"],
    },
    citableResultType: "media",
    appSearchScope: true,
    conversationSearchScope: false,
    citationOutputSource: false,
    promptRender: "label",
    expansionPolicy: "media_owned_reader_children",
    adjacencySource: false,
    adjacencyTarget: true,
  },
  library: {
    userRelation: { userLinkSource: true, userLinkTarget: "direct" },
    sharing: "LibraryMembership",
    attachable: true,
    chatSubject: "scope",
    readable: "scope",
    inspectable: "none",
    inspectorPolicy: {
      linkedItems: "ResourceConnections",
      forks: null,
      defaultSurfaceOrder: ["Dossier"],
    },
    citableResultType: null,
    appSearchScope: true,
    conversationSearchScope: false,
    citationOutputSource: false,
    promptRender: "label",
    expansionPolicy: "none",
    adjacencySource: false,
    adjacencyTarget: true,
  },
  evidence_span: {
    userRelation: { userLinkSource: false, userLinkTarget: "materialize_passage" },
    sharing: "None",
    attachable: true,
    chatSubject: "readable",
    readable: "body",
    inspectable: "none",
    inspectorPolicy: null,
    citableResultType: "evidence_span",
    appSearchScope: false,
    conversationSearchScope: false,
    citationOutputSource: false,
    promptRender: "inline_body",
    expansionPolicy: "none",
    adjacencySource: false,
    adjacencyTarget: true,
  },
  content_chunk: {
    userRelation: { userLinkSource: false, userLinkTarget: "materialize_passage" },
    sharing: "None",
    attachable: true,
    chatSubject: "readable",
    readable: "body",
    inspectable: "none",
    inspectorPolicy: null,
    citableResultType: "content_chunk",
    appSearchScope: false,
    conversationSearchScope: false,
    citationOutputSource: false,
    promptRender: "inline_body",
    expansionPolicy: "none",
    adjacencySource: false,
    adjacencyTarget: true,
  },
  highlight: {
    userRelation: { userLinkSource: true, userLinkTarget: "direct" },
    sharing: "HighlightGrants",
    attachable: true,
    chatSubject: "quote",
    readable: "body",
    inspectable: "none",
    inspectorPolicy: null,
    citableResultType: "highlight",
    appSearchScope: false,
    conversationSearchScope: true,
    citationOutputSource: false,
    promptRender: "quote",
    expansionPolicy: "none",
    adjacencySource: false,
    adjacencyTarget: true,
  },
  page: {
    userRelation: { userLinkSource: true, userLinkTarget: "direct" },
    sharing: "CopyOnly",
    attachable: true,
    chatSubject: "readable",
    readable: "body",
    inspectable: "none",
    inspectorPolicy: {
      linkedItems: "ResourceConnections",
      forks: null,
      defaultSurfaceOrder: ["Dossier"],
    },
    citableResultType: "page",
    appSearchScope: false,
    conversationSearchScope: true,
    citationOutputSource: false,
    promptRender: "inline_body",
    expansionPolicy: "page_note_blocks",
    adjacencySource: true,
    adjacencyTarget: true,
  },
  note_block: {
    userRelation: { userLinkSource: true, userLinkTarget: "direct" },
    sharing: "CopyOnly",
    attachable: true,
    chatSubject: "readable",
    readable: "body",
    inspectable: "none",
    inspectorPolicy: {
      linkedItems: "ResourceConnections",
      forks: null,
      defaultSurfaceOrder: ["Dossier"],
    },
    citableResultType: "note_block",
    appSearchScope: false,
    conversationSearchScope: true,
    citationOutputSource: false,
    promptRender: "inline_body",
    expansionPolicy: "note_block_owned_evidence",
    adjacencySource: true,
    adjacencyTarget: true,
  },
  fragment: {
    userRelation: { userLinkSource: false, userLinkTarget: "materialize_passage" },
    sharing: "None",
    attachable: true,
    chatSubject: "readable",
    readable: "body",
    inspectable: "none",
    inspectorPolicy: null,
    citableResultType: "fragment",
    appSearchScope: false,
    conversationSearchScope: false,
    citationOutputSource: false,
    promptRender: "inline_body",
    expansionPolicy: "none",
    adjacencySource: false,
    adjacencyTarget: true,
  },
  conversation: {
    userRelation: { userLinkSource: true, userLinkTarget: "direct" },
    sharing: "CopyOnly",
    attachable: true,
    chatSubject: "label",
    readable: "body",
    inspectable: "none",
    inspectorPolicy: {
      linkedItems: "ConversationContext",
      forks: "ConversationForks",
      defaultSurfaceOrder: ["LinkedItems", "Forks", "Dossier"],
    },
    citableResultType: null,
    appSearchScope: false,
    conversationSearchScope: false,
    citationOutputSource: false,
    promptRender: "label",
    expansionPolicy: "none",
    adjacencySource: false,
    adjacencyTarget: true,
  },
  message: {
    userRelation: { userLinkSource: true, userLinkTarget: "direct" },
    sharing: "None",
    attachable: true,
    chatSubject: "readable",
    readable: "body",
    inspectable: "none",
    inspectorPolicy: null,
    citableResultType: "message",
    appSearchScope: false,
    conversationSearchScope: false,
    citationOutputSource: true,
    promptRender: "inline_body",
    expansionPolicy: "none",
    adjacencySource: false,
    adjacencyTarget: true,
  },
  oracle_reading: {
    userRelation: { userLinkSource: true, userLinkTarget: "direct" },
    sharing: "CopyOnly",
    attachable: true,
    chatSubject: "generated_output",
    readable: "body",
    inspectable: "none",
    inspectorPolicy: null,
    citableResultType: null,
    appSearchScope: false,
    conversationSearchScope: false,
    citationOutputSource: true,
    promptRender: "inline_body",
    expansionPolicy: "none",
    adjacencySource: false,
    adjacencyTarget: true,
  },
  oracle_passage_anchor: {
    userRelation: { userLinkSource: false, userLinkTarget: "materialize_passage" },
    sharing: "None",
    attachable: false,
    chatSubject: "none",
    readable: "body",
    inspectable: "none",
    inspectorPolicy: null,
    citableResultType: null,
    appSearchScope: false,
    conversationSearchScope: false,
    citationOutputSource: false,
    promptRender: "inline_body",
    expansionPolicy: "none",
    adjacencySource: false,
    adjacencyTarget: true,
  },
  artifact: {
    userRelation: { userLinkSource: true, userLinkTarget: "direct" },
    sharing: "CopyOnly",
    attachable: true,
    chatSubject: "generated_output",
    readable: "body",
    inspectable: "none",
    inspectorPolicy: null,
    citableResultType: null,
    appSearchScope: false,
    conversationSearchScope: false,
    citationOutputSource: false,
    promptRender: "inline_body",
    expansionPolicy: "artifact_revisions",
    adjacencySource: false,
    adjacencyTarget: true,
  },
  artifact_revision: {
    userRelation: { userLinkSource: true, userLinkTarget: "direct" },
    sharing: "None",
    attachable: true,
    chatSubject: "generated_output",
    readable: "body",
    inspectable: "none",
    inspectorPolicy: null,
    citableResultType: null,
    appSearchScope: false,
    conversationSearchScope: false,
    citationOutputSource: true,
    promptRender: "inline_body",
    expansionPolicy: "none",
    adjacencySource: false,
    adjacencyTarget: true,
  },
  external_snapshot: {
    userRelation: { userLinkSource: false, userLinkTarget: "none" },
    sharing: "None",
    attachable: false,
    chatSubject: "none",
    readable: "none",
    inspectable: "none",
    inspectorPolicy: null,
    citableResultType: "web_result",
    appSearchScope: false,
    conversationSearchScope: false,
    citationOutputSource: false,
    promptRender: "none",
    expansionPolicy: "none",
    adjacencySource: false,
    adjacencyTarget: false,
  },
  contributor: {
    userRelation: { userLinkSource: true, userLinkTarget: "direct" },
    sharing: "CopyOnly",
    attachable: true,
    chatSubject: "label",
    readable: "none",
    inspectable: "none",
    inspectorPolicy: {
      linkedItems: "ResourceConnections",
      forks: null,
      defaultSurfaceOrder: ["Dossier"],
    },
    citableResultType: null,
    appSearchScope: false,
    conversationSearchScope: false,
    citationOutputSource: false,
    promptRender: "label",
    expansionPolicy: "none",
    adjacencySource: false,
    adjacencyTarget: true,
  },
  podcast: {
    userRelation: { userLinkSource: true, userLinkTarget: "direct" },
    sharing: "CopyWithLibraryFiling",
    attachable: true,
    chatSubject: "label",
    readable: "none",
    inspectable: "none",
    inspectorPolicy: {
      linkedItems: "ResourceConnections",
      forks: null,
      defaultSurfaceOrder: ["Dossier"],
    },
    citableResultType: null,
    appSearchScope: false,
    conversationSearchScope: false,
    citationOutputSource: false,
    promptRender: "label",
    expansionPolicy: "none",
    adjacencySource: false,
    adjacencyTarget: true,
  },
  reader_apparatus_item: {
    userRelation: { userLinkSource: false, userLinkTarget: "materialize_passage" },
    sharing: "None",
    attachable: true,
    chatSubject: "readable",
    readable: "body",
    inspectable: "none",
    inspectorPolicy: null,
    citableResultType: "reader_apparatus_item",
    appSearchScope: false,
    conversationSearchScope: false,
    citationOutputSource: false,
    promptRender: "inline_body",
    expansionPolicy: "none",
    adjacencySource: false,
    adjacencyTarget: true,
  },
  passage_anchor: {
    userRelation: { userLinkSource: true, userLinkTarget: "direct" },
    sharing: "None",
    attachable: true,
    chatSubject: "quote",
    readable: "body",
    inspectable: "none",
    inspectorPolicy: null,
    citableResultType: null,
    appSearchScope: false,
    conversationSearchScope: false,
    citationOutputSource: false,
    promptRender: "quote",
    expansionPolicy: "none",
    adjacencySource: false,
    adjacencyTarget: true,
  },
} as const satisfies Record<ResourceScheme, ResourceCapabilityProjection>;

export function resourceCapabilityForScheme(
  scheme: ResourceScheme,
): ResourceCapabilityProjection {
  return RESOURCE_CAPABILITIES[scheme];
}

/** Whether `scheme` can be the target of a durable, direct-endpoint Link or
 * note reference. `materialize_passage` targets are raw material a search hit
 * must convert into a `passage_anchor` first (Invariant 4); they are never
 * themselves a direct edge/reference endpoint. Mirrors backend
 * `resource_can_be_note_reference_target` / the `note_reference_target`
 * property on `ResourceUserRelationPolicy`. */
export function resourceCanBeNoteReferenceTarget(
  scheme: ResourceScheme,
): boolean {
  return RESOURCE_CAPABILITIES[scheme].userRelation.userLinkTarget === "direct";
}

export function resourceSchemeIsAppSearchScope(
  scheme: ResourceScheme,
): boolean {
  return RESOURCE_CAPABILITIES[scheme].appSearchScope;
}
