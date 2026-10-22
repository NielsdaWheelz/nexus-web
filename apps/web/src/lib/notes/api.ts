// Notes reads and the two small journal-backed actions outside the outline.
// Page deletion is idempotent. Capture retries retain the client note/link ids
// and frozen local date; its accepted insertion alone resolves the daily page.
import { apiFetch, type ApiPath } from "@/lib/api/client";
import type { ListPage } from "@/lib/api/useServerList";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { formatLocalDateInTimeZone, isLocalDate } from "@/lib/localDate";
import { admitWriting, openDraft, readDraft, readWriting, releaseDraft, retryWriting, stageDraft, subscribeWriting, WritingDecisionError, type DraftHandle, type WritingAck } from "./journal";

export type NotePageSummary = Schema<"NotePageSummaryOut">;

/** Deletes the page (a missing one too); its notes are kept. */
export async function deletePage(pageId: string): Promise<{ intent_id: string; settled: Promise<WritingAck> }> {
  const admitted = admitWriting({ kind: "resource_delete", resource_kind: "page", resource_id: pageId }, []);
  await admitted.durable; return { intent_id: admitted.intent_id, settled: admitted.settled };
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
): Promise<{ intent_id: string; settled: Promise<string> }> {
  const existing = readWriting().drafts.find(draft => draft.context.kind === "capture" && draft.context.note_id === noteId);
  const linkId = existing?.context.kind === "capture" ? existing.context.link_id : crypto.randomUUID();
  const capturedDate = existing?.context.kind === "capture" ? existing.context.local_date : localDate;
  const handle = await openDraft({ kind: "capture", local_date: capturedDate, note_id: noteId, link_id: linkId }, { kind: "capture", text }, null, existing?.draft_id ?? null);
  let intent_id: string;
  try {
    const pending = readWriting().outbox.find(row => row.intent.kind === "capture" && row.intent.request.note_id === noteId);
    if (pending) {
      if (pending.intent.kind !== "capture" || pending.intent.request.text !== text)
        throw new WritingDecisionError("resolve the earlier capture before submitting changed text");
      await retryWriting(pending.intent_id);
      intent_id = pending.intent_id;
    } else if (readDraft(handle.draft_id)?.base === null) {
      const authored = stageDraft(handle, { kind: "capture", text }, null);
      const admitted = admitWriting({ kind: "capture", local_date: capturedDate, request: { note_id: noteId, link_id: linkId, text } }, [authored]);
      await admitted.durable;
      intent_id = admitted.intent_id;
    } else {
      const accepted = existing?.results.at(-1);
      if (!accepted) throw new WritingDecisionError("review the captured page before submitting this capture again");
      intent_id = accepted.intent_id;
    }
    const settled = capturePage(handle, linkId).finally(() => releaseDraft(handle));
    void settled.catch(() => undefined);
    return { intent_id, settled };
  } catch (error) { await releaseDraft(handle); throw error; }
}
function capturePage(handle: DraftHandle, linkId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const accountId = readWriting().account_id;
    const inspect = () => {
      if (readWriting().account_id !== accountId) { unsubscribe(); reject(new WritingDecisionError("writing account changed")); return; }
      const draft = readDraft(handle.draft_id);
      if (draft?.conflict !== null && draft?.conflict !== undefined) { unsubscribe(); reject(new WritingDecisionError(draft.conflict.reason)); return; }
      const inserted = draft?.results.flatMap(result => result.ack.insertions).find(item => item.requested_link_id === linkId);
      if (inserted?.source_ref.startsWith("page:")) { unsubscribe(); resolve(inserted.source_ref.slice("page:".length)); return; }
      const blocked = readWriting().outbox.find(row => row.blocked !== null && row.authored.some(item => item.draft_id === handle.draft_id));
      if (blocked) { unsubscribe(); reject(new WritingDecisionError(blocked.blocked!.code)); }
    };
    unsubscribe = subscribeWriting(inspect); inspect();
  });
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
