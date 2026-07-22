import { requiredRecord, requiredString } from "@/lib/notes/normalize";
import type {
  ResourceChatSubjectMode,
  ResourceExpansionPolicy,
  ResourceInspectMode,
  ResourcePromptRenderMode,
  ResourceReadMode,
  UserLinkTargetMode,
} from "@/lib/resources/resourceCapabilities.generated";
import {
  normalizeResourceActivation,
  type ResourceActivation,
} from "@/lib/resources/activation";
import { isRecord } from "@/lib/validation";

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
  scheme: string;
  id: string;
  label: string;
  summary: string;
  route: string | null;
  activation: ResourceActivation;
  missing: boolean;
  capabilities: ResourceItemCapabilities;
  versionByLane: Record<string, number>;
}

export interface ResourceSurfaceItem {
  edgeId: string;
  target: ResourceItem;
  sourceOrderKey: string;
  viewState: Record<string, unknown> | null;
}

export interface ResourceSurface {
  source: ResourceItem;
  orderedItems: ResourceSurfaceItem[];
}

function normalizeUserRelation(raw: unknown): ResourceUserRelation {
  const record = requiredRecord(raw, "resource user relation");
  return {
    userLinkSource: Boolean(
      record.userLinkSource ?? record.user_link_source,
    ),
    userLinkTarget: String(
      record.userLinkTarget ?? record.user_link_target ?? "none",
    ) as UserLinkTargetMode,
    noteReferenceTarget: Boolean(
      record.noteReferenceTarget ?? record.note_reference_target,
    ),
  };
}

export function normalizeResourceItem(raw: Record<string, unknown>): ResourceItem {
  const capabilities = requiredRecord(
    raw.capabilities,
    "resource capabilities",
  );
  const activation = normalizeResourceActivation(raw.activation);
  if (!activation) {
    throw new Error("Invalid resource activation");
  }
  const versionByLane = isRecord(raw.versionByLane)
    ? raw.versionByLane
    : isRecord(raw.version_by_lane)
      ? raw.version_by_lane
      : {};
  return {
    ref: requiredString(raw.ref, "resource ref"),
    scheme: String(raw.scheme ?? ""),
    id: requiredString(raw.id, "resource id"),
    label: String(raw.label ?? ""),
    summary: String(raw.summary ?? ""),
    route: typeof raw.route === "string" ? raw.route : null,
    activation,
    missing: Boolean(raw.missing),
    capabilities: {
      userRelation: normalizeUserRelation(
        capabilities.userRelation ?? capabilities.user_relation,
      ),
      attachable: Boolean(capabilities.attachable),
      chatSubject: String(
        capabilities.chatSubject ?? capabilities.chat_subject ?? "none",
      ) as ResourceChatSubjectMode,
      readable: String(capabilities.readable ?? "none") as ResourceReadMode,
      inspectable: String(
        capabilities.inspectable ?? "none",
      ) as ResourceInspectMode,
      citableResultType:
        typeof capabilities.citableResultType === "string"
          ? capabilities.citableResultType
          : typeof capabilities.citable_result_type === "string"
            ? capabilities.citable_result_type
            : null,
      citationOutputSource: Boolean(
        capabilities.citationOutputSource ??
        capabilities.citation_output_source,
      ),
      appSearchScope: Boolean(
        capabilities.appSearchScope ?? capabilities.app_search_scope,
      ),
      conversationSearchScope: Boolean(
        capabilities.conversationSearchScope ??
        capabilities.conversation_search_scope,
      ),
      promptRender: String(
        capabilities.promptRender ?? capabilities.prompt_render ?? "none",
      ) as ResourcePromptRenderMode,
      expansionPolicy: String(
        capabilities.expansionPolicy ?? capabilities.expansion_policy ?? "none",
      ) as ResourceExpansionPolicy,
      expandable: Boolean(capabilities.expandable),
      adjacencySource: Boolean(
        capabilities.adjacencySource ?? capabilities.adjacency_source,
      ),
      adjacencyTarget: Boolean(
        capabilities.adjacencyTarget ?? capabilities.adjacency_target,
      ),
    },
    versionByLane: Object.fromEntries(
      Object.entries(versionByLane).map(([lane, version]) => [
        lane,
        Number(version),
      ]),
    ),
  };
}
