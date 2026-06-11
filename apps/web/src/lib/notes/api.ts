import { apiFetch } from "@/lib/api/client";
import { noteBlockResource, notePagesResource } from "@/lib/api/resource";
import { assertNoTopLevelLegacyArtifactIdentityKey } from "@/lib/currentArtifactIdentity";
import { todayLocalDate } from "@/lib/localDate";
import { isRecord } from "@/lib/validation";

export type NoteBlockKind =
  | "bullet"
  | "heading"
  | "todo"
  | "quote"
  | "code"
  | "image"
  | "embed";

const NOTE_BLOCK_KINDS = new Set<string>([
  "bullet",
  "heading",
  "todo",
  "quote",
  "code",
  "image",
  "embed",
]);

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
  documentVersion: number;
  updatedAt?: string;
}

export interface NotePage extends NotePageSummary {
  blocks: NoteBlock[];
}

interface NotePagesResponse {
  data: unknown;
}

interface NotePageResponse {
  data: unknown;
}

interface DailyNotePageResponse {
  data: unknown;
}

interface NoteBlockResponse {
  data: unknown;
}

interface NotePageDocumentResponse {
  data: unknown;
}

export interface SaveNotePageDocumentBlock {
  id: string;
  blockKind: NoteBlockKind;
  bodyPmJson: Record<string, unknown>;
}

interface SaveNotePageDocumentParent {
  scheme: "page" | "note_block";
  id: string;
}

export interface SaveNotePageDocumentChild {
  blockId: string;
  sourceOrderKey: string;
  collapsed: boolean;
}

export interface SaveNotePageDocumentContainment {
  parent: SaveNotePageDocumentParent;
  children: SaveNotePageDocumentChild[];
}

export interface SaveNotePageDocumentInput {
  clientMutationId: string;
  baseDocumentVersion: number;
  title?: string | null;
  focusBlockId?: string | null;
  blocks: SaveNotePageDocumentBlock[];
  containment: SaveNotePageDocumentContainment[];
  deletedBlockIds: string[];
}

export interface SaveNotePageDocumentResult {
  page: NotePage;
  clientMutationId: string;
  documentVersion: number;
  changedBlockIds: string[];
  changedEdgeIds: string[];
  reindexJobId: string | null;
}

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Notes API response is missing ${label}`);
  }
  return value;
}

export function isNoteBlockKind(value: unknown): value is NoteBlockKind {
  return typeof value === "string" && NOTE_BLOCK_KINDS.has(value);
}

function normalizeBlockKind(value: unknown): NoteBlockKind {
  if (!isNoteBlockKind(value)) {
    throw new Error("Notes API response has invalid note block kind");
  }
  return value;
}

export function normalizeBlock(raw: Record<string, unknown>): NoteBlock {
  assertNoTopLevelLegacyArtifactIdentityKey(raw, "note block");
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
    blockKind: normalizeBlockKind(raw.blockKind ?? raw.block_kind ?? "bullet"),
    bodyPmJson:
      isRecord(raw.bodyPmJson)
        ? raw.bodyPmJson
        : isRecord(raw.body_pm_json)
          ? raw.body_pm_json
          : { type: "paragraph" },
    bodyMarkdown: String(raw.bodyMarkdown ?? raw.body_markdown ?? ""),
    bodyText: String(raw.bodyText ?? raw.body_text ?? ""),
    collapsed: Boolean(raw.collapsed),
    children: Array.isArray(raw.children)
      ? raw.children.map((child) =>
          normalizeBlock(requiredRecord(child, "note block child"))
        )
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

export function normalizePageSummary(raw: Record<string, unknown>): NotePageSummary {
  assertNoTopLevelLegacyArtifactIdentityKey(raw, "note page");
  return {
    id: String(raw.id ?? ""),
    title: String(raw.title ?? "Untitled"),
    description:
      typeof raw.description === "string" && raw.description.trim()
        ? raw.description
        : null,
    documentVersion: requiredPositiveInteger(
      raw.documentVersion ?? raw.document_version,
      "document version"
    ),
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
    ...normalizePageSummary(raw),
    blocks: Array.isArray(raw.blocks)
      ? raw.blocks.map((block) =>
          normalizeBlock(requiredRecord(block, "note page block"))
        )
      : [],
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Notes API response is missing ${label}`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Notes API response is missing ${label}`);
  }
  return parsed;
}

export async function fetchNotePages(): Promise<NotePageSummary[]> {
  const response = await apiFetch<NotePagesResponse>(
    notePagesResource.clientPath({}),
    { cache: "no-store" },
  );
  const data = requiredRecord(response.data, "note pages response");
  if (!Array.isArray(data.pages)) {
    throw new Error("Notes API response is missing note pages");
  }
  return data.pages.map((page) =>
    normalizePageSummary(requiredRecord(page, "note page summary"))
  );
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
  return normalizePage(requiredRecord(response.data, "note page"));
}

export async function fetchDailyNotePage(localDate = todayLocalDate()): Promise<NotePage> {
  const params = new URLSearchParams({ time_zone: browserTimeZone() });
  const response = await apiFetch<DailyNotePageResponse>(
    `/api/notes/daily/${localDate}?${params.toString()}`,
    { cache: "no-store" }
  );
  const data = requiredRecord(response.data, "daily note response");
  return normalizePage(requiredRecord(data.page, "daily note page"));
}

export async function quickCaptureDailyNote(input: {
  blockId: string;
  clientMutationId: string;
  bodyMarkdown?: string;
  bodyPmJson?: Record<string, unknown>;
  localDate?: string;
}): Promise<NoteBlock> {
  const body: Record<string, unknown> = {
    id: input.blockId,
    client_mutation_id: input.clientMutationId,
  };
  if (input.bodyMarkdown !== undefined) {
    body.body_markdown = input.bodyMarkdown;
  }
  if (input.bodyPmJson !== undefined) {
    body.body_pm_json = input.bodyPmJson;
  }
  if (input.localDate !== undefined) {
    body.local_date = input.localDate;
  }
  const response = await apiFetch<NoteBlockResponse>(
    `/api/notes/quick-capture?${new URLSearchParams({
      time_zone: browserTimeZone(),
    }).toString()}`,
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  );
  return normalizeBlock(requiredRecord(response.data, "note block"));
}

export async function fetchNotePage(pageId: string): Promise<NotePage> {
  const response = await apiFetch<NotePageResponse>(`/api/notes/pages/${pageId}/document`, {
    cache: "no-store",
  });
  return normalizePage(requiredRecord(response.data, "note page"));
}

export async function updateNotePage(
  pageId: string,
  updates: { title?: string; description?: string | null }
): Promise<NotePage> {
  const response = await apiFetch<NotePageResponse>(`/api/notes/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
  return normalizePage(requiredRecord(response.data, "note page"));
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
        base_document_version: input.baseDocumentVersion,
        title: input.title ?? null,
        focus_block_id: input.focusBlockId ?? null,
        blocks: input.blocks.map((block) => ({
          id: block.id,
          block_kind: block.blockKind,
          body_pm_json: block.bodyPmJson,
        })),
        containment: input.containment.map((group) => ({
          parent: group.parent,
          children: group.children.map((child) => ({
            block_id: child.blockId,
            source_order_key: child.sourceOrderKey,
            collapsed: child.collapsed,
          })),
        })),
        deleted_block_ids: input.deletedBlockIds,
      }),
    }
  );
  const data = requiredRecord(response.data, "note document response");
  return {
    page: normalizePage(requiredRecord(data.page, "document page")),
    clientMutationId: requiredString(data.clientMutationId, "document client mutation id"),
    documentVersion: requiredPositiveInteger(data.documentVersion, "document version"),
    changedBlockIds: Array.isArray(data.changedBlockIds)
      ? data.changedBlockIds.map((blockId) => String(blockId))
      : [],
    changedEdgeIds: Array.isArray(data.changedEdgeIds)
      ? data.changedEdgeIds.map((edgeId) => String(edgeId))
      : [],
    reindexJobId: typeof data.reindexJobId === "string" ? data.reindexJobId : null,
  };
}

export async function fetchNoteBlock(blockId: string): Promise<NoteBlock> {
  const response = await apiFetch<NoteBlockResponse>(
    noteBlockResource.clientPath({ blockId }),
    { cache: "no-store" },
  );
  return normalizeBlock(requiredRecord(response.data, "note block"));
}
