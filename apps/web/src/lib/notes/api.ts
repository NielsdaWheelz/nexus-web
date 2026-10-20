// The notes requests outside the outline: pages (create, delete, the index), quick
// capture into a day, one note's row, and which day a locator names. Writers of pages
// publish "Notes".
import { apiFetch, type ApiPath } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import type { ListPage } from "@/lib/api/useServerList";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { announceResourceDeletion } from "@/lib/resourceGraph/links";
import { formatLocalDateInTimeZone, isLocalDate } from "@/lib/localDate";

export type NotePageSummary = Schema<"NotePageSummaryOut">;

/** Deletes the page (a missing one too); its notes are kept. */
export async function deletePage(pageId: string): Promise<void> {
  await apiFetch(`/api/notes/pages/${encodeURIComponent(pageId)}` as ApiPath, {
    method: "DELETE",
  });
  announceResourceDeletion(`page:${pageId}`);
  publishChange("Notes");
}

/** One keyset page of the viewer's pages; `query` holds the view's keys, `limit` and `cursor`. */
export async function fetchNotePages(
  query: URLSearchParams,
  signal: AbortSignal,
): Promise<ListPage<NotePageSummary>> {
  const { data } = await apiFetch<ApiJson<"/notes/pages", "get">>(
    `/api/notes/pages?${query}`,
    { cache: "no-store", signal },
  );
  return data;
}

/** Appends `text` as one note last on the day's page; a retry with the same note id
 * has landed. Resolves the page's id. */
export async function captureToday(
  localDate: string,
  noteId: string,
  text: string,
): Promise<string> {
  const path = `/api/notes/daily/${localDate}/captures` as ApiPath;
  const { data } = await apiFetch<ApiJson<"/notes/daily/{local_date}/captures", "post">>(path, {
    method: "POST",
    body: JSON.stringify({ note_id: noteId, text }),
  });
  publishChange("Notes");
  return data.page_id;
}

export async function fetchNote(noteId: string): Promise<Schema<"NoteBlockOut">> {
  const path = `/api/notes/blocks/${encodeURIComponent(noteId)}` as ApiPath;
  const { data } = await apiFetch<ApiJson<"/notes/blocks/{note_id}", "get">>(path, {
    cache: "no-store",
  });
  return data;
}

export type DailyLocator = { readonly kind: "Today" } | { readonly kind: "LocalDate"; readonly value: string };

/** The YYYY-MM-DD a locator names in the account's calendar time zone. */
export function dailyDateFor(locator: DailyLocator, calendarTimeZone: string): string {
  const date =
    locator.kind === "Today"
      ? formatLocalDateInTimeZone(new Date(), calendarTimeZone)
      : locator.value;
  // justify-defect: locators come from the launcher's parser and the daily route.
  if (!isLocalDate(date)) throw new TypeError("A daily page date is YYYY-MM-DD");
  return date;
}
