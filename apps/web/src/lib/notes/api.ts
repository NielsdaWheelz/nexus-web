import { apiFetch, type ApiPath } from "@/lib/api/client";
import { noteBlockResource } from "@/lib/api/resource";
import {
  normalizeBlock,
  normalizePageSummary,
  requiredRecord,
  requiredString,
  type NoteBlock,
  type NotePageSummary,
} from "@/lib/notes/normalize";
import { todayLocalDate } from "@/lib/localDate";
import {
  normalizeResourceItem,
  type ResourceSurface,
} from "@/lib/resources/resourceItems";
import { isRecord } from "@/lib/validation";

export interface NotePage extends NotePageSummary {
  surface: ResourceSurface | null;
  blocks: NoteBlock[];
  dailyNote: { localDate: string } | null;
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
  const rawDailyNote = raw.dailyNote ?? raw.daily_note;
  const dailyNote =
    isRecord(rawDailyNote) && typeof (rawDailyNote.localDate ?? rawDailyNote.local_date) === "string"
      ? { localDate: String(rawDailyNote.localDate ?? rawDailyNote.local_date) }
      : null;
  return {
    ...normalizePageSummary(raw),
    surface: normalizeSurface(raw.surface),
    blocks: blocks.map((block) =>
      normalizeBlock(requiredRecord(block, "note page block")),
    ),
    dailyNote,
  };
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
  options: { timeZone?: string } = {},
): Promise<NotePage> {
  const params = new URLSearchParams({
    time_zone: options.timeZone ?? browserTimeZone(),
  });
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

export interface DawnWrite {
  id: string;
  body_md: string;
  generated_at: string;
  dismissed_at: string | null;
}

// GET /api/notes/dawn-write?local_date=... → { write: DawnWrite | null }
export async function fetchDawnWrite(localDate: string): Promise<DawnWrite | null> {
  const params = new URLSearchParams({ local_date: localDate });
  const response = await apiFetch<{ write: DawnWrite | null }>(
    `/api/notes/dawn-write?${params}`,
    { cache: "no-store" },
  );
  return response.write;
}

export async function dismissDawnWrite(writeId: string): Promise<void> {
  await apiFetch(`/api/notes/dawn-write/${writeId}/dismiss` as ApiPath, {
    method: "POST",
  });
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
