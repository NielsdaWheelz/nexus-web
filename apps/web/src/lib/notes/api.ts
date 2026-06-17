import { apiFetch } from "@/lib/api/client";
import { noteBlockResource, notePagesResource } from "@/lib/api/resource";
import { assertNoTopLevelLegacyArtifactIdentityKey } from "@/lib/currentArtifactIdentity";
import { todayLocalDate } from "@/lib/localDate";
import type {
  ResourceChatSubjectMode,
  ResourceExpansionPolicy,
  ResourceInspectMode,
  ResourcePromptRenderMode,
  ResourceReadMode,
} from "@/lib/resources/resourceCapabilities.generated";
import { isRecord } from "@/lib/validation";

export interface NoteBlock {
  id: string;
  parentBlockId: string | null;
  orderKey: string | null;
  bodyPmJson: Record<string, unknown>;
  bodyText: string;
  collapsed: boolean;
  children: NoteBlock[];
  createdAt?: string;
  updatedAt?: string;
  versionByLane?: Record<string, number>;
}

export interface NotePageSummary {
  id: string;
  title: string;
  updatedAt?: string;
}

export interface ResourceItemCapabilities {
  linkable: boolean;
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

export interface NotePage extends NotePageSummary {
  surface: ResourceSurface | null;
  blocks: NoteBlock[];
}

export interface SaveResourceSurfaceInput {
  clientMutationId: string;
  baseVersions: Array<{
    ref: string;
    lane: "title" | "body" | "outgoing_edges";
    version: number;
  }>;
  title?: string | null;
  focusBlockId?: string | null;
  blocks: Array<{ id: string; bodyPmJson: Record<string, unknown> }>;
  adjacency: Array<{
    parent: { scheme: "page" | "note_block"; id: string };
    children: Array<{
      blockId: string;
      sourceOrderKey: string;
      collapsed: boolean;
    }>;
  }>;
  deletedBlockIds: string[];
}

export interface SaveResourceSurfaceResult {
  page: NotePage;
  versions: Record<string, Record<string, number>>;
  clientMutationId: string;
  changedBlockIds: string[];
  changedEdgeIds: string[];
  reindexJobId: string | null;
}

export interface SaveNoteBodyInput {
  clientMutationId: string;
  baseVersion: number | null;
  bodyPmJson: Record<string, unknown>;
}

interface ApiResponse {
  data: unknown;
}

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function requiredRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Notes API response is missing ${label}`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Notes API response is missing ${label}`);
  }
  return value;
}

export function normalizeBlock(raw: Record<string, unknown>): NoteBlock {
  assertNoTopLevelLegacyArtifactIdentityKey(raw, "note block");
  const children = Array.isArray(raw.children) ? raw.children : [];
  const versionByLane = isRecord(raw.versionByLane)
    ? raw.versionByLane
    : isRecord(raw.version_by_lane)
      ? raw.version_by_lane
      : {};
  return {
    id: requiredString(raw.id, "note block id"),
    parentBlockId:
      typeof raw.parentBlockId === "string"
        ? raw.parentBlockId
        : typeof raw.parent_block_id === "string"
          ? raw.parent_block_id
          : null,
    orderKey:
      typeof raw.orderKey === "string"
        ? raw.orderKey
        : typeof raw.order_key === "string"
          ? raw.order_key
          : null,
    bodyPmJson: isRecord(raw.bodyPmJson)
      ? raw.bodyPmJson
      : isRecord(raw.body_pm_json)
        ? raw.body_pm_json
        : { type: "paragraph" },
    bodyText: String(raw.bodyText ?? raw.body_text ?? ""),
    collapsed: Boolean(raw.collapsed),
    children: children.map((child) =>
      normalizeBlock(requiredRecord(child, "note block child")),
    ),
    createdAt:
      typeof raw.createdAt === "string"
        ? raw.createdAt
        : typeof raw.created_at === "string"
          ? raw.created_at
          : undefined,
    updatedAt:
      typeof raw.updatedAt === "string"
        ? raw.updatedAt
        : typeof raw.updated_at === "string"
          ? raw.updated_at
          : undefined,
    versionByLane: Object.fromEntries(
      Object.entries(versionByLane).map(([lane, version]) => [
        lane,
        Number(version),
      ]),
    ),
  };
}

export function normalizePageSummary(
  raw: Record<string, unknown>,
): NotePageSummary {
  assertNoTopLevelLegacyArtifactIdentityKey(raw, "note page");
  return {
    id: requiredString(raw.id, "note page id"),
    title: String(raw.title ?? "Untitled"),
    updatedAt:
      typeof raw.updatedAt === "string"
        ? raw.updatedAt
        : typeof raw.updated_at === "string"
          ? raw.updated_at
          : undefined,
  };
}

function normalizeResourceItem(raw: Record<string, unknown>): ResourceItem {
  const capabilities = requiredRecord(
    raw.capabilities,
    "resource capabilities",
  );
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
    missing: Boolean(raw.missing),
    capabilities: {
      linkable: Boolean(capabilities.linkable),
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

export function normalizeSurface(raw: unknown): ResourceSurface | null {
  if (!isRecord(raw)) return null;
  const items = Array.isArray(raw.orderedItems)
    ? raw.orderedItems
    : Array.isArray(raw.ordered_items)
      ? raw.ordered_items
      : [];
  return {
    source: normalizeResourceItem(requiredRecord(raw.source, "surface source")),
    orderedItems: items.map((item) => {
      const row = requiredRecord(item, "surface item");
      return {
        edgeId: requiredString(row.edgeId ?? row.edge_id, "surface edge id"),
        target: normalizeResourceItem(
          requiredRecord(row.target, "surface target"),
        ),
        sourceOrderKey: requiredString(
          row.sourceOrderKey ?? row.source_order_key,
          "surface order key",
        ),
        viewState: isRecord(row.viewState)
          ? row.viewState
          : isRecord(row.view_state)
            ? row.view_state
            : null,
      };
    }),
  };
}

function normalizePage(raw: Record<string, unknown>): NotePage {
  const blocks = Array.isArray(raw.blocks) ? raw.blocks : [];
  return {
    ...normalizePageSummary(raw),
    surface: normalizeSurface(raw.surface),
    blocks: blocks.map((block) =>
      normalizeBlock(requiredRecord(block, "note page block")),
    ),
  };
}

export async function fetchNotePages(): Promise<NotePageSummary[]> {
  const response = await apiFetch<ApiResponse>(
    notePagesResource.clientPath({}),
    {
      cache: "no-store",
    },
  );
  const data = requiredRecord(response.data, "note pages response");
  if (!Array.isArray(data.pages)) {
    throw new Error("Notes API response is missing note pages");
  }
  return data.pages.map((page) =>
    normalizePageSummary(requiredRecord(page, "note page summary")),
  );
}

export async function createNotePage(input: {
  title: string;
}): Promise<NotePage> {
  const response = await apiFetch<ApiResponse>("/api/notes/pages", {
    method: "POST",
    body: JSON.stringify({ title: input.title }),
  });
  return normalizePage(requiredRecord(response.data, "note page"));
}

export async function fetchDailyNotePage(
  localDate = todayLocalDate(),
): Promise<NotePage> {
  const params = new URLSearchParams({ time_zone: browserTimeZone() });
  const response = await apiFetch<ApiResponse>(
    `/api/notes/daily/${localDate}?${params}`,
    {
      cache: "no-store",
    },
  );
  const data = requiredRecord(response.data, "daily note response");
  return normalizePage(requiredRecord(data.page, "daily note page"));
}

export async function quickCaptureDailyNote(input: {
  blockId: string;
  clientMutationId: string;
  bodyPmJson: Record<string, unknown>;
  localDate?: string;
}): Promise<NoteBlock> {
  const body: Record<string, unknown> = {
    id: input.blockId,
    client_mutation_id: input.clientMutationId,
    body_pm_json: input.bodyPmJson,
  };
  if (input.localDate !== undefined) {
    body.local_date = input.localDate;
  }
  const response = await apiFetch<ApiResponse>(
    `/api/notes/quick-capture?${new URLSearchParams({ time_zone: browserTimeZone() })}`,
    { method: "POST", body: JSON.stringify(body) },
  );
  return normalizeBlock(requiredRecord(response.data, "note block"));
}

export async function fetchNotePage(pageId: string): Promise<NotePage> {
  const response = await apiFetch<ApiResponse>(`/api/notes/pages/${pageId}`, {
    cache: "no-store",
  });
  return normalizePage(requiredRecord(response.data, "note page"));
}

export async function updateNotePage(
  pageId: string,
  updates: { title: string },
): Promise<NotePage> {
  const ref = `page:${pageId}`;
  await apiFetch<ApiResponse>(
    `/api/resource-items/${encodeURIComponent(ref)}/title`,
    {
      method: "PATCH",
      body: JSON.stringify({
        client_mutation_id: createClientMutationId(),
        base_versions: [],
        title: updates.title,
      }),
    },
  );
  return fetchNotePage(pageId);
}

function createClientMutationId(): string {
  return crypto.randomUUID();
}

function baseVersion(
  input: SaveResourceSurfaceInput,
  ref: string,
  lane: "title" | "body" | "outgoing_edges",
): number | null {
  return (
    input.baseVersions.find((base) => base.ref === ref && base.lane === lane)
      ?.version ?? null
  );
}

async function patchResourceTitle(
  ref: string,
  title: string,
  clientMutationId: string,
  version: number | null,
): Promise<void> {
  await apiFetch<ApiResponse>(
    `/api/resource-items/${encodeURIComponent(ref)}/title`,
    {
      method: "PATCH",
      body: JSON.stringify({
        client_mutation_id: clientMutationId,
        base_versions:
          version === null ? [] : [{ ref, lane: "title", version }],
        title,
      }),
    },
  );
}

async function replaceResourceAdjacency(
  ref: string,
  input: SaveResourceSurfaceInput,
  orderedTargets: Array<{ ref: string; sourceOrderKey: string }>,
): Promise<string[]> {
  const version = baseVersion(input, ref, "outgoing_edges");
  const response = await apiFetch<ApiResponse>(
    `/api/resource-items/${encodeURIComponent(ref)}/adjacency`,
    {
      method: "PUT",
      body: JSON.stringify({
        client_mutation_id: input.clientMutationId,
        base_versions:
          version === null ? [] : [{ ref, lane: "outgoing_edges", version }],
        ordered_targets: orderedTargets.map((target) => ({
          ref: target.ref,
          source_order_key: target.sourceOrderKey,
        })),
      }),
    },
  );
  const data = requiredRecord(response.data, "resource adjacency response");
  return Array.isArray(data.changedEdgeIds)
    ? data.changedEdgeIds.map((edgeId) => String(edgeId))
    : [];
}

export async function saveResourceSurface(
  pageId: string,
  input: SaveResourceSurfaceInput,
): Promise<SaveResourceSurfaceResult> {
  const pageRef = `page:${pageId}`;
  if (input.title !== undefined && input.title !== null) {
    await patchResourceTitle(
      pageRef,
      input.title,
      input.clientMutationId,
      baseVersion(input, pageRef, "title"),
    );
  }

  const changedBlockIds: string[] = [];
  for (const block of input.blocks) {
    const ref = `note_block:${block.id}`;
    await saveNoteBody(block.id, {
      clientMutationId: input.clientMutationId,
      baseVersion: baseVersion(input, ref, "body"),
      bodyPmJson: block.bodyPmJson,
    });
    changedBlockIds.push(block.id);
  }

  const changedEdgeIds = (
    await Promise.all(
      input.adjacency.map((group) =>
        replaceResourceAdjacency(
          `${group.parent.scheme}:${group.parent.id}`,
          input,
          group.children.map((child) => ({
            ref: `note_block:${child.blockId}`,
            sourceOrderKey: child.sourceOrderKey,
          })),
        ),
      ),
    )
  ).flat();
  const page = await fetchNotePage(pageId);
  return {
    page,
    versions: Object.fromEntries(
      input.baseVersions.map((base) => [
        base.ref,
        { [base.lane]: base.version },
      ]),
    ),
    clientMutationId: input.clientMutationId,
    changedBlockIds,
    changedEdgeIds,
    reindexJobId: null,
  };
}

export async function fetchNoteBlock(blockId: string): Promise<NoteBlock> {
  const response = await apiFetch<ApiResponse>(
    noteBlockResource.clientPath({ blockId }),
    {
      cache: "no-store",
    },
  );
  return normalizeBlock(requiredRecord(response.data, "note block"));
}

export async function saveNoteBody(
  blockId: string,
  input: SaveNoteBodyInput,
): Promise<NoteBlock> {
  const ref = `note_block:${blockId}`;
  const response = await apiFetch<ApiResponse>(
    `/api/resource-items/${encodeURIComponent(ref)}/body`,
    {
      method: "PATCH",
      body: JSON.stringify({
        client_mutation_id: input.clientMutationId,
        base_versions:
          input.baseVersion === null
            ? []
            : [{ ref, lane: "body", version: input.baseVersion }],
        body_pm_json: input.bodyPmJson,
      }),
    },
  );
  const data = requiredRecord(response.data, "resource body response");
  return {
    id: blockId,
    parentBlockId: null,
    orderKey: null,
    bodyPmJson: requiredRecord(data.bodyPmJson, "note body"),
    bodyText: String(data.bodyText ?? ""),
    collapsed: false,
    children: [],
    versionByLane: Object.fromEntries(
      Object.entries(
        isRecord(data.versions) && isRecord(data.versions[ref])
          ? data.versions[ref]
          : {},
      ).map(([lane, version]) => [lane, Number(version)]),
    ),
  };
}
