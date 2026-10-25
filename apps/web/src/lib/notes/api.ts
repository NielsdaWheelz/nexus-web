// Notes reads and the two small live actions outside the outline.
// Page deletion is idempotent. Capture retries retain the client note/link ids
// and frozen local date; its accepted insertion alone resolves the daily page.
import { apiFetch, type ApiPath } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { formatLocalDateInTimeZone, isLocalDate } from "@/lib/localDate";
import { admitWriting, type WriteHandle } from "./writes";

export type NotePageSummary = Schema<"NotePageSummaryOut">;

const pageDeletions = new Map<string, WriteHandle>();
/** A live page removal remains hidden while its exact outcome is unknown. */
export function isDeletingPage(pageId: string): boolean {
  const state = pageDeletions.get(pageId)?.read();
  return state?.kind === "queued" || state?.kind === "sending" || state?.kind === "unconfirmed";
}

/** Deletes the page (a missing one too); its notes are kept. */
export function deletePage(pageId: string): WriteHandle {
  const pending = pageDeletions.get(pageId);
  if (pending && isDeletingPage(pageId)) return pending;
  const write = admitWriting({ kind: "resource_delete", resource_kind: "page", resource_id: pageId });
  pageDeletions.set(pageId, write);
  const release = () => { if (pageDeletions.get(pageId) === write) pageDeletions.delete(pageId); };
  void write.settled.then(release, release);
  return write;
}

/** The viewer's complete ordered page index. */
export async function fetchNotePages(
  query: URLSearchParams,
  signal: AbortSignal,
) {
  const { data } = await apiFetch<ApiJson<"/notes/pages", "get">>(
    `/api/notes/pages?${query}`,
    { cache: "no-store", signal },
  );
  return data;
}

/** Appends `text` as one note last on the day's page; a retry with the same note id
 * has landed. Resolves the page's id. */
export function captureToday(
  localDate: string,
  noteId: string,
  text: string,
): { write: WriteHandle; settled: Promise<string> } {
  const linkId = crypto.randomUUID();
  const write = admitWriting({ kind: "capture", local_date: localDate, request: { note_id: noteId, link_id: linkId, text } });
  const settled = write.settled.then(ack => {
    const inserted = ack.insertions.find(item => item.requested_link_id === linkId);
    // justify-defect: the capture endpoint must acknowledge its requested insertion.
    if (!inserted?.source_ref.startsWith("page:")) throw new Error("the accepted capture has no daily page");
    return inserted.source_ref.slice("page:".length);
  });
  return { write, settled };
}

export async function fetchNote(noteId: string, signal?: AbortSignal): Promise<Schema<"NoteBlockOut">> {
  const path = `/api/notes/blocks/${encodeURIComponent(noteId)}` as ApiPath;
  const { data } = await apiFetch<ApiJson<"/notes/blocks/{note_id}", "get">>(path, {
    cache: "no-store",
    signal,
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
