import { apiFetch, type ApiPath } from "@/lib/api/client";
import {
  normalizeNoteContent,
  requiredRecord,
  type NoteContent,
  type NotePageSummary,
} from "@/lib/notes/normalize";
import { isLocalDate } from "@/lib/localDate";
import { normalizeResourceSurface, type ResourceSurface } from "@/lib/resources/resourceItems";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import {
  expectExactRecord,
  expectNullableString,
  expectString,
  isRecord,
} from "@/lib/validation";

export interface NotePage extends NotePageSummary {
  dailyPage: { localDate: string } | null;
}

export interface SaveNoteBodyInput {
  clientMutationId: string;
  baseVersion: number | null;
  bodyPmJson: Record<string, unknown>;
}

interface ApiResponse {
  data: unknown;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function decodeUuid(raw: unknown, name: string): string {
  const value = expectString(raw, name);
  if (!UUID_RE.test(value)) {
    throw new TypeError(`${name} must be a canonical UUID`);
  }
  return value;
}

function decodeLocalDate(raw: unknown, name: string): string {
  const localDate = expectString(raw, name);
  if (!isLocalDate(localDate)) {
    throw new TypeError(`${name} must be a valid YYYY-MM-DD date`);
  }
  return localDate;
}

export function decodeNotePage(raw: unknown): NotePage {
  const page = expectExactRecord(
    raw,
    ["id", "title", "updatedAt", "dailyPage"],
    "note page",
  );
  const id = decodeUuid(page.id, "note page.id");
  const updatedAt = expectNullableString(page.updatedAt, "note page.updatedAt");
  let dailyPage: NotePage["dailyPage"] = null;
  if (page.dailyPage !== null) {
    const daily = expectExactRecord(
      page.dailyPage,
      ["localDate"],
      "note page.dailyPage",
    );
    dailyPage = {
      localDate: decodeLocalDate(
        daily.localDate,
        "note page.dailyPage.localDate",
      ),
    };
  }
  return {
    id,
    title: expectString(page.title, "note page.title"),
    ...(updatedAt === null ? {} : { updatedAt }),
    actionSubject: { ref: canonicalResourceRef({ scheme: "page", id }) },
    dailyPage,
  };
}

export async function createNotePage(input: {
  pageId: string;
  title: string;
}): Promise<NotePage> {
  const response = await apiFetch<ApiResponse>("/api/notes/pages", {
    method: "POST",
    body: JSON.stringify({ page_id: input.pageId, title: input.title }),
  });
  const page = decodeNotePage(response.data);
  if (page.id !== input.pageId) {
    throw new Error(
      `Notes API create response id ${page.id} does not match requested page ${input.pageId}`,
    );
  }
  return page;
}

export type DailyPageDescriptor =
  | {
      kind: "Latent";
      localDate: string;
      defaultTitle: string;
    }
  | {
      kind: "Materialized";
      localDate: string;
      page: NotePage;
      surface: ResourceSurface;
    };

export function decodeDailyPageDescriptor(raw: unknown): DailyPageDescriptor {
  const record = requiredRecord(raw, "daily page descriptor");
  const kind = expectString(record.kind, "daily page descriptor.kind");
  switch (kind) {
    case "Latent": {
      const latent = expectExactRecord(
        record,
        ["kind", "localDate", "defaultTitle"],
        "latent daily page descriptor",
      );
      return {
        kind,
        localDate: decodeLocalDate(
          latent.localDate,
          "latent daily page descriptor.localDate",
        ),
        defaultTitle: expectString(
          latent.defaultTitle,
          "latent daily page descriptor.defaultTitle",
        ),
      };
    }
    case "Materialized": {
      const materialized = expectExactRecord(
        record,
        ["kind", "localDate", "page", "surface"],
        "materialized daily page descriptor",
      );
      const localDate = decodeLocalDate(
        materialized.localDate,
        "materialized daily page descriptor.localDate",
      );
      const page = decodeNotePage(materialized.page);
      if (page.dailyPage?.localDate !== localDate) {
        throw new TypeError(
          "materialized daily page descriptor page must match localDate",
        );
      }
      return {
        kind,
        localDate,
        page,
        surface: normalizeResourceSurface(materialized.surface),
      };
    }
    default:
      throw new TypeError(
        "daily page descriptor.kind must be Latent or Materialized",
      );
  }
}

export async function readDailyPage(
  localDate: string,
): Promise<DailyPageDescriptor> {
  if (!isLocalDate(localDate)) {
    throw new TypeError("localDate must be a valid YYYY-MM-DD date");
  }
  const response = await apiFetch<ApiResponse>(
    `/api/notes/daily/${localDate}`,
    { cache: "no-store" },
  );
  return decodeDailyPageDescriptor(response.data);
}

export interface DailyCaptureInput {
  clientMutationId: string;
  noteId: string;
  bodyPmJson: Record<string, unknown>;
}

export interface DailyCaptureResult {
  clientMutationId: string;
  localDate: string;
  pageId: string;
  surface: ResourceSurface;
}

export function decodeDailyCaptureResult(raw: unknown): DailyCaptureResult {
  const result = expectExactRecord(
    raw,
    ["clientMutationId", "localDate", "pageId", "surface"],
    "daily capture result",
  );
  const pageId = decodeUuid(result.pageId, "daily capture result.pageId");
  const surface = normalizeResourceSurface(result.surface);
  if (surface.source.item.ref !== `page:${pageId}`) {
    throw new TypeError(
      "daily capture result.surface source must match pageId",
    );
  }
  return {
    clientMutationId: expectString(
      result.clientMutationId,
      "daily capture result.clientMutationId",
    ),
    localDate: decodeLocalDate(
      result.localDate,
      "daily capture result.localDate",
    ),
    pageId,
    surface,
  };
}

export async function captureDailyPageNote(
  localDate: string,
  input: DailyCaptureInput,
): Promise<DailyCaptureResult> {
  if (!isLocalDate(localDate)) {
    throw new TypeError("localDate must be a valid YYYY-MM-DD date");
  }
  const response = await apiFetch<ApiResponse>(
    `/api/notes/daily/${localDate}/captures`,
    {
      method: "POST",
      body: JSON.stringify({
        clientMutationId: input.clientMutationId,
        noteId: input.noteId,
        bodyPmJson: input.bodyPmJson,
      }),
    },
  );
  const result = decodeDailyCaptureResult(response.data);
  if (
    result.clientMutationId !== input.clientMutationId ||
    result.localDate !== localDate
  ) {
    throw new TypeError("daily capture response identity does not match request");
  }
  return result;
}

export async function fetchNotePage(pageId: string): Promise<NotePage> {
  const response = await apiFetch<ApiResponse>(`/api/notes/pages/${pageId}`, {
    cache: "no-store",
  });
  return decodeNotePage(response.data);
}

export async function fetchNoteContent(blockId: string): Promise<NoteContent> {
  const response = await apiFetch<ApiResponse>(`/api/notes/blocks/${blockId}`, {
    cache: "no-store",
  });
  return normalizeNoteContent(requiredRecord(response.data, "note content"));
}

export interface DawnWrite {
  id: string;
  body_md: string;
  generated_at: string;
  dismissed_at: string | null;
}

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
): Promise<NoteContent> {
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
  const data = requiredRecord(response.data, "note body response");
  return normalizeNoteContent({
    id: blockId,
    body_pm_json: data.body_pm_json ?? data.bodyPmJson,
    body_text: data.body_text ?? data.bodyText,
    version_by_lane:
      isRecord(data.versions) && isRecord(data.versions[ref])
        ? data.versions[ref]
        : {},
  });
}
