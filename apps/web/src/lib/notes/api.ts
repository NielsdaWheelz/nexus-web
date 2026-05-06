import { apiFetch } from "@/lib/api/client";
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
  children: NoteBlock[];
  createdAt?: string;
  updatedAt?: string;
}

export interface NotePageSummary {
  id: string;
  title: string;
  description: string | null;
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

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function todayLocalDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isLocalDate(value: string): boolean {
  if (!LOCAL_DATE_RE.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  return (
    parsed.getFullYear() === year &&
    parsed.getMonth() === month - 1 &&
    parsed.getDate() === day
  );
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

export async function deleteNotePage(pageId: string): Promise<void> {
  await apiFetch(`/api/notes/pages/${pageId}`, { method: "DELETE" });
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
    bodyPmJson?: Record<string, unknown>;
    blockKind?: NoteBlockKind;
    collapsed?: boolean;
  }
): Promise<NoteBlock> {
  const response = await apiFetch<NoteBlockResponse>(`/api/notes/blocks/${blockId}`, {
    method: "PATCH",
    body: JSON.stringify({
      body_pm_json: updates.bodyPmJson,
      block_kind: updates.blockKind,
      collapsed: updates.collapsed,
    }),
  });
  return normalizeBlock(response.data as unknown as Record<string, unknown>);
}

export async function deleteNoteBlock(blockId: string): Promise<void> {
  await apiFetch(`/api/notes/blocks/${blockId}`, { method: "DELETE" });
}

export async function splitNoteBlock(blockId: string, input: { offset: number }) {
  const response = await apiFetch<NoteBlockResponse>(`/api/notes/blocks/${blockId}/split`, {
    method: "POST",
    body: JSON.stringify({ offset: input.offset }),
  });
  return normalizeBlock(response.data as unknown as Record<string, unknown>);
}

export async function mergeNoteBlock(blockId: string) {
  const response = await apiFetch<NoteBlockResponse>(`/api/notes/blocks/${blockId}/merge`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  return normalizeBlock(response.data as unknown as Record<string, unknown>);
}

export async function moveNoteBlock(
  blockId: string,
  input: { parentBlockId?: string | null; beforeBlockId?: string | null; afterBlockId?: string | null }
) {
  const response = await apiFetch<NoteBlockResponse>(`/api/notes/blocks/${blockId}/move`, {
    method: "POST",
    body: JSON.stringify({
      parent_block_id: input.parentBlockId ?? null,
      before_block_id: input.beforeBlockId ?? null,
      after_block_id: input.afterBlockId ?? null,
    }),
  });
  return normalizeBlock(response.data as unknown as Record<string, unknown>);
}
