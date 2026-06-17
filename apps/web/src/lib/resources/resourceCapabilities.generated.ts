import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";

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
  | "library_intelligence_artifact_revisions";

export interface ResourceCapabilityProjection {
  linkable: boolean;
  attachable: boolean;
  chatSubject: ResourceChatSubjectMode;
  readable: ResourceReadMode;
  inspectable: ResourceInspectMode;
  citableResultType: string | null;
  appSearchScope: boolean;
  conversationSearchScope: boolean;
  citationOutputSource: boolean;
  promptRender: ResourcePromptRenderMode;
  expansionPolicy: ResourceExpansionPolicy;
  adjacencySource: boolean;
  adjacencyTarget: boolean;
}

// Static frontend projection of python/nexus/services/resource_items/capabilities.py.
// apps/web/src/lib/resourceGraph/contractParity.test.ts keeps this aligned.
export const RESOURCE_CAPABILITIES = {
  media: {
    linkable: true,
    attachable: true,
    chatSubject: "readable",
    readable: "media",
    inspectable: "media_document_map",
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
    linkable: true,
    attachable: true,
    chatSubject: "scope",
    readable: "scope",
    inspectable: "none",
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
    linkable: true,
    attachable: true,
    chatSubject: "readable",
    readable: "body",
    inspectable: "none",
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
    linkable: true,
    attachable: true,
    chatSubject: "readable",
    readable: "body",
    inspectable: "none",
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
    linkable: true,
    attachable: true,
    chatSubject: "quote",
    readable: "body",
    inspectable: "none",
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
    linkable: true,
    attachable: true,
    chatSubject: "readable",
    readable: "body",
    inspectable: "none",
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
    linkable: true,
    attachable: true,
    chatSubject: "readable",
    readable: "body",
    inspectable: "none",
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
    linkable: true,
    attachable: true,
    chatSubject: "readable",
    readable: "body",
    inspectable: "none",
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
    linkable: true,
    attachable: true,
    chatSubject: "label",
    readable: "body",
    inspectable: "none",
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
    linkable: true,
    attachable: true,
    chatSubject: "readable",
    readable: "body",
    inspectable: "none",
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
    linkable: true,
    attachable: true,
    chatSubject: "generated_output",
    readable: "body",
    inspectable: "none",
    citableResultType: null,
    appSearchScope: false,
    conversationSearchScope: false,
    citationOutputSource: true,
    promptRender: "inline_body",
    expansionPolicy: "none",
    adjacencySource: false,
    adjacencyTarget: true,
  },
  oracle_corpus_passage: {
    linkable: false,
    attachable: false,
    chatSubject: "none",
    readable: "none",
    inspectable: "none",
    citableResultType: null,
    appSearchScope: false,
    conversationSearchScope: false,
    citationOutputSource: false,
    promptRender: "none",
    expansionPolicy: "none",
    adjacencySource: false,
    adjacencyTarget: false,
  },
  library_intelligence_artifact: {
    linkable: true,
    attachable: true,
    chatSubject: "generated_output",
    readable: "body",
    inspectable: "none",
    citableResultType: null,
    appSearchScope: false,
    conversationSearchScope: false,
    citationOutputSource: false,
    promptRender: "inline_body",
    expansionPolicy: "library_intelligence_artifact_revisions",
    adjacencySource: false,
    adjacencyTarget: true,
  },
  library_intelligence_revision: {
    linkable: true,
    attachable: true,
    chatSubject: "generated_output",
    readable: "body",
    inspectable: "none",
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
    linkable: false,
    attachable: false,
    chatSubject: "none",
    readable: "none",
    inspectable: "none",
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
    linkable: true,
    attachable: true,
    chatSubject: "label",
    readable: "none",
    inspectable: "none",
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
    linkable: true,
    attachable: true,
    chatSubject: "label",
    readable: "none",
    inspectable: "none",
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
    linkable: true,
    attachable: true,
    chatSubject: "readable",
    readable: "body",
    inspectable: "none",
    citableResultType: "reader_apparatus_item",
    appSearchScope: false,
    conversationSearchScope: false,
    citationOutputSource: false,
    promptRender: "inline_body",
    expansionPolicy: "none",
    adjacencySource: false,
    adjacencyTarget: true,
  },
} as const satisfies Record<ResourceScheme, ResourceCapabilityProjection>;

export type LinkableResourceScheme = {
  [Scheme in ResourceScheme]: (typeof RESOURCE_CAPABILITIES)[Scheme]["linkable"] extends true
    ? Scheme
    : never;
}[ResourceScheme];

export function resourceCapabilityForScheme(
  scheme: ResourceScheme,
): ResourceCapabilityProjection {
  return RESOURCE_CAPABILITIES[scheme];
}

export function resourceSchemeIsLinkable(
  scheme: ResourceScheme,
): scheme is LinkableResourceScheme {
  return RESOURCE_CAPABILITIES[scheme].linkable;
}

export function resourceSchemeIsAppSearchScope(
  scheme: ResourceScheme,
): boolean {
  return RESOURCE_CAPABILITIES[scheme].appSearchScope;
}
