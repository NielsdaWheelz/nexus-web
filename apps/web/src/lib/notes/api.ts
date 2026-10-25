/** Local note gestures. Captures freeze their date/id/body and commit the page,
 * independent note and first relationship together. Retry uses LocalCommitError,
 * never a second create. Deletion observes only the addressed page's liveness. */
import { bodyText } from "@nexus/authored/body";
import { isVisible } from "@nexus/authored/merge";
import { dailyId } from "@nexus/authored/identity";
import type { Intent } from "@nexus/authored/commands";
import { formatLocalDateInTimeZone, isLocalDate } from "@/lib/localDate";
import { createLink, deleteResource } from "@/lib/resourceGraph/links";
import type { WritingRuntime } from "./runtime";
import { selectStates } from "./runtime";
export interface NotePageSummary { id: string; title: string }
export async function deletePage(runtime: WritingRuntime, pageId: string): Promise<void> {
  await deleteResource(runtime, { ref: `page:${pageId}` });
}
export async function dailyPage(runtime: WritingRuntime, local_date: string): Promise<{ ref: string; prelude: Intent[] }> {
  if (!isLocalDate(local_date)) throw new TypeError("A daily date must be YYYY-MM-DD");
  const store = await runtime.store;
  const replica = await store.readReplica();
  const binding = await store.query({ kind: "binding", key: { kind: "daily", local_date } });
  const ref = binding.binding_id ?? `page:${dailyId(replica.account_id, local_date)}`;
  const states = await store.readStates(selectStates({ refs: [ref] }));
  const existing = states.resources.find(resource => resource.ref === ref);
  return { ref, prelude: existing ? isVisible(existing.touch_vv, existing.delete_vv) ? [] : [{ kind: "restore_resource", ref }] : [{ kind: "create_page", ref, title: "", local_date }] };
}
export async function captureToday(runtime: WritingRuntime, localDate: string, noteId: string, text: string): Promise<string> {
  const page = await dailyPage(runtime, localDate);
  const ref = `note_block:${noteId}`;
  await createLink(runtime, { source_ref: page.ref, target_ref: ref, source_label: null, target_label: null, after: null, prelude: [...page.prelude, { kind: "create_note", ref, body: bodyText(text) }] });
  return page.ref.slice("page:".length);
}
export type DailyLocator = { readonly kind: "Today" } | { readonly kind: "LocalDate"; readonly value: string };
export function dailyDateFor(locator: DailyLocator, calendarTimeZone: string): string {
  const date = locator.kind === "Today" ? formatLocalDateInTimeZone(new Date(), calendarTimeZone) : locator.value;
  if (!isLocalDate(date)) throw new TypeError("A daily page date is YYYY-MM-DD");
  return date;
}
