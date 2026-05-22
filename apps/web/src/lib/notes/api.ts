import { apiFetch } from "@/lib/api/client";
import { todayLocalDate } from "@/lib/localDate";
import type { ObjectRef } from "@/lib/objectRefs";

export type NoteBlockKind =
  | "bullet"
  | "heading"
  | "todo"
  | "quote"
  | "code"
  | "image"
  | "embed";

export interface NoteBlock {
  id: string;
  pageId: string;
  parentBlockId: string | null;
  orderKey: string;
  blockKind: NoteBlockKind;
  bodyPmJson: Record<string, unknown>;
  bodyMarkdown: string;
  bodyText: string;
  collapsed: boolean;
  revision: number;
  children: NoteBlock[];
  createdAt?: string;
  updatedAt?: string;
}

export interface NotePageSummary {
  id: string;
  title: string;
  description: string | null;
  revision: number;
  updatedAt?: string;
}

export interface NotePage extends NotePageSummary {
  blocks: NoteBlock[];
}

interface NotePagesResponse {
  data: {
    pages: NotePageSummary[];
  };
}

interface NotePageResponse {
  data: NotePage;
}

interface DailyNotePageResponse {
  data: {
    localDate?: string;
    local_date?: string;
    page: NotePage;
  };
}

interface NoteBlockResponse {
  data: NoteBlock;
}

interface NotePageDocumentResponse {
  data: {
    page: NotePage;
    clientMutationId: string;
  };
}

export interface SaveNotePageDocumentBlock {
  id: string;
  parentBlockId: string | null;
  beforeBlockId: string | null;
  afterBlockId: string | null;
  blockKind: NoteBlockKind;
  bodyPmJson: Record<string, unknown>;
  collapsed: boolean;
  baseRevision: number | null;
}

export interface SaveNotePageDocumentDeletedBlock {
  id: string;
  baseRevision: number;
}

export interface SaveNotePageDocumentInput {
  clientMutationId: string;
  basePageRevision: number;
  focusBlockId?: string | null;
  topLevelParentBlockId?: string | null;
  blocks: SaveNotePageDocumentBlock[];
  deletedBlocks: SaveNotePageDocumentDeletedBlock[];
}

export interface SaveNotePageDocumentResult {
  page: NotePage;
  clientMutationId: string;
}

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function normalizeBlock(raw: Record<string, unknown>): NoteBlock {
  return {
    id: String(raw.id ?? ""),
    pageId: String(raw.pageId ?? raw.page_id ?? ""),
    parentBlockId:
      typeof raw.parentBlockId === "string"
        ? raw.parentBlockId
        : typeof raw.parent_block_id === "string"
          ? raw.parent_block_id
          : null,
    orderKey: String(raw.orderKey ?? raw.order_key ?? ""),
    blockKind: (raw.blockKind ?? raw.block_kind ?? "bullet") as NoteBlockKind,
    bodyPmJson:
      typeof raw.bodyPmJson === "object" && raw.bodyPmJson !== null
        ? (raw.bodyPmJson as Record<string, unknown>)
        : typeof raw.body_pm_json === "object" && raw.body_pm_json !== null
          ? (raw.body_pm_json as Record<string, unknown>)
          : { type: "paragraph" },
    bodyMarkdown: String(raw.bodyMarkdown ?? raw.body_markdown ?? ""),
    bodyText: String(raw.bodyText ?? raw.body_text ?? ""),
    collapsed: Boolean(raw.collapsed),
    revision: requiredNumber(raw.revision, "note block revision"),
    children: Array.isArray(raw.children)
      ? raw.children.map((child) => normalizeBlock(child as Record<string, unknown>))
      : [],
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
  };
}

function normalizePage(raw: Record<string, unknown>): NotePage {
  return {
    id: String(raw.id ?? ""),
    title: String(raw.title ?? "Untitled"),
    description:
      typeof raw.description === "string" && raw.description.trim()
        ? raw.description
        : null,
    revision: requiredNumber(raw.revision, "note page revision"),
    updatedAt:
      typeof raw.updatedAt === "string"
        ? raw.updatedAt
        : typeof raw.updated_at === "string"
          ? raw.updated_at
          : undefined,
    blocks: Array.isArray(raw.blocks)
      ? raw.blocks.map((block) => normalizeBlock(block as Record<string, unknown>))
      : [],
  };
}

function requiredNumber(value: unknown, label: string): number {
  const numberValue =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numberValue)) {
    throw new Error(`Notes API response is missing ${label}`);
  }
  return numberValue;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Notes API response is missing ${label}`);
  }
  return value;
}

export async function fetchNotePages(): Promise<NotePageSummary[]> {
  const response = await apiFetch<NotePagesResponse>("/api/notes/pages", {
    cache: "no-store",
  });
  return response.data.pages;
}

export async function createNotePage(input: {
  title: string;
  description?: string | null;
}): Promise<NotePage> {
  const response = await apiFetch<NotePageResponse>("/api/notes/pages", {
    method: "POST",
    body: JSON.stringify({
      title: input.title,
      description: input.description ?? null,
    }),
  });
  return normalizePage(response.data as unknown as Record<string, unknown>);
}

export async function fetchDailyNotePage(localDate = todayLocalDate()): Promise<NotePage> {
  const params = new URLSearchParams({ time_zone: browserTimeZone() });
  const response = await apiFetch<DailyNotePageResponse>(
    `/api/notes/daily/${localDate}?${params.toString()}`,
    { cache: "no-store" }
  );
  return normalizePage(response.data.page as unknown as Record<string, unknown>);
}

export async function quickCaptureDailyNote(input: {
  bodyMarkdown: string;
  localDate?: string;
}): Promise<NoteBlock> {
  const response = await apiFetch<NoteBlockResponse>(
    `/api/notes/daily/${input.localDate ?? todayLocalDate()}/quick-capture?${new URLSearchParams({
      time_zone: browserTimeZone(),
    }).toString()}`,
    {
      method: "POST",
      body: JSON.stringify({
        body_markdown: input.bodyMarkdown,
      }),
    }
  );
  return normalizeBlock(response.data as unknown as Record<string, unknown>);
}

export async function fetchNotePage(pageId: string): Promise<NotePage> {
  const response = await apiFetch<NotePageResponse>(`/api/notes/pages/${pageId}`, {
    cache: "no-store",
  });
  return normalizePage(response.data as unknown as Record<string, unknown>);
}

export async function updateNotePage(
  pageId: string,
  updates: { title?: string; description?: string | null }
): Promise<NotePage> {
  const response = await apiFetch<NotePageResponse>(`/api/notes/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
  return normalizePage(response.data as unknown as Record<string, unknown>);
}

export async function saveNotePageDocument(
  pageId: string,
  input: SaveNotePageDocumentInput
): Promise<SaveNotePageDocumentResult> {
  const response = await apiFetch<NotePageDocumentResponse>(
    `/api/notes/pages/${pageId}/document`,
    {
      method: "PATCH",
      body: JSON.stringify({
        client_mutation_id: input.clientMutationId,
        base_page_revision: input.basePageRevision,
        focus_block_id: input.focusBlockId ?? null,
        top_level_parent_block_id: input.topLevelParentBlockId ?? null,
        blocks: input.blocks.map((block) => ({
          id: block.id,
          parent_block_id: block.parentBlockId,
          before_block_id: block.beforeBlockId,
          after_block_id: block.afterBlockId,
          block_kind: block.blockKind,
          body_pm_json: block.bodyPmJson,
          collapsed: block.collapsed,
          base_revision: block.baseRevision ?? null,
        })),
        deleted_blocks: input.deletedBlocks.map((block) => ({
          id: block.id,
          base_revision: block.baseRevision,
        })),
      }),
    }
  );
  const data = response.data as unknown as Record<string, unknown>;
  if (typeof data.page !== "object" || data.page === null) {
    throw new Error("Notes API response is missing document page");
  }
  return {
    page: normalizePage(data.page as Record<string, unknown>),
    clientMutationId: requiredString(data.clientMutationId, "document client mutation id"),
  };
}

export async function fetchNoteBlock(blockId: string): Promise<NoteBlock> {
  const response = await apiFetch<NoteBlockResponse>(`/api/notes/blocks/${blockId}`, {
    cache: "no-store",
  });
  return normalizeBlock(response.data as unknown as Record<string, unknown>);
}

export async function createNoteBlock(input: {
  id?: string;
  pageId?: string | null;
  parentBlockId?: string | null;
  afterBlockId?: string | null;
  blockKind?: NoteBlockKind;
  bodyPmJson?: Record<string, unknown>;
  bodyMarkdown?: string;
  linkedObject?: ObjectRef;
  relationType?: "note_about" | "references" | "related";
}): Promise<NoteBlock> {
  const response = await apiFetch<NoteBlockResponse>("/api/notes/blocks", {
    method: "POST",
    body: JSON.stringify({
      page_id: input.pageId ?? null,
      id: input.id,
      parent_block_id: input.parentBlockId ?? null,
      after_block_id: input.afterBlockId ?? null,
      block_kind: input.blockKind ?? "bullet",
      body_pm_json: input.bodyPmJson ?? null,
      body_markdown: input.bodyMarkdown,
      linked_object: input.linkedObject
        ? {
            object_type: input.linkedObject.objectType,
            object_id: input.linkedObject.objectId,
            relation_type: input.relationType ?? "note_about",
          }
        : null,
    }),
  });
  return normalizeBlock(response.data as unknown as Record<string, unknown>);
}

export async function updateNoteBlock(
  blockId: string,
  updates: {
    baseRevision: number;
    bodyPmJson?: Record<string, unknown>;
    blockKind?: NoteBlockKind;
    collapsed?: boolean;
  }
): Promise<NoteBlock> {
  const response = await apiFetch<NoteBlockResponse>(`/api/notes/blocks/${blockId}`, {
    method: "PATCH",
    body: JSON.stringify({
      base_revision: updates.baseRevision,
      body_pm_json: updates.bodyPmJson,
      block_kind: updates.blockKind,
      collapsed: updates.collapsed,
    }),
  });
  return normalizeBlock(response.data as unknown as Record<string, unknown>);
}

export async function deleteNoteBlock(
  blockId: string,
  input: { baseRevision: number }
): Promise<void> {
  await apiFetch(`/api/notes/blocks/${blockId}`, {
    method: "DELETE",
    body: JSON.stringify({ base_revision: input.baseRevision }),
  });
}
