import { apiFetch, type ApiPath } from "@/lib/api/client";
import {
  normalizeNoteContent,
  normalizePageSummary,
  requiredRecord,
  type NoteContent,
  type NotePageSummary,
} from "@/lib/notes/normalize";
import { todayLocalDate } from "@/lib/localDate";
import { browserTimeZone } from "@/lib/time/browserTimeZone";
import { isRecord } from "@/lib/validation";

export interface NotePage extends NotePageSummary {
  dailyNote: { localDate: string } | null;
}

export interface SaveNoteBodyInput {
  clientMutationId: string;
  baseVersion: number | null;
  bodyPmJson: Record<string, unknown>;
}

interface ApiResponse {
  data: unknown;
}

function normalizePage(raw: Record<string, unknown>): NotePage {
  const rawDailyNote = raw.dailyNote ?? raw.daily_note;
  const dailyNote =
    isRecord(rawDailyNote) &&
    typeof (rawDailyNote.localDate ?? rawDailyNote.local_date) === "string"
      ? { localDate: String(rawDailyNote.localDate ?? rawDailyNote.local_date) }
      : null;
  return { ...normalizePageSummary(raw), dailyNote };
}

export async function createNotePage(input: {
  pageId: string;
  title: string;
}): Promise<NotePage> {
  const response = await apiFetch<ApiResponse>("/api/notes/pages", {
    method: "POST",
    body: JSON.stringify({ page_id: input.pageId, title: input.title }),
  });
  const page = normalizePage(requiredRecord(response.data, "note page"));
  if (page.id !== input.pageId) {
    throw new Error(
      `Notes API create response id ${page.id} does not match requested page ${input.pageId}`,
    );
  }
  return page;
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
    { cache: "no-store" },
  );
  const data = requiredRecord(response.data, "daily note response");
  return normalizePage(requiredRecord(data.page, "daily note page"));
}

export async function quickCaptureDailyNote(input: {
  blockId: string;
  clientMutationId: string;
  bodyPmJson: Record<string, unknown>;
  localDate?: string;
}): Promise<NoteContent> {
  const body: Record<string, unknown> = {
    id: input.blockId,
    client_mutation_id: input.clientMutationId,
    body_pm_json: input.bodyPmJson,
  };
  if (input.localDate !== undefined) body.local_date = input.localDate;
  const response = await apiFetch<ApiResponse>(
    `/api/notes/quick-capture?${new URLSearchParams({ time_zone: browserTimeZone() })}`,
    { method: "POST", body: JSON.stringify(body) },
  );
  return normalizeNoteContent(requiredRecord(response.data, "note content"));
}

export async function fetchNotePage(pageId: string): Promise<NotePage> {
  const response = await apiFetch<ApiResponse>(`/api/notes/pages/${pageId}`, {
    cache: "no-store",
  });
  return normalizePage(requiredRecord(response.data, "note page"));
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

/** Kept for quick-capture and highlight flows, never for surface persistence. */
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
