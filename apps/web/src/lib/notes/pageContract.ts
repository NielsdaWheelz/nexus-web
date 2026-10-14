import type { Schema } from "@/lib/api/wire";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { canonicalResourceRef } from "@/lib/sharing/targets";

export type DailyPageSummary = Schema<"DailyPageSummaryOut">;
export type NotePage = Schema<"NotePageOut"> & {
  readonly actionSubject: ResourceActionSubject;
};

export function withNotePageActionSubject<T extends Schema<"NotePageSummaryOut">>(
  page: T,
): T & { readonly actionSubject: ResourceActionSubject } {
  return {
    ...page,
    actionSubject: { ref: canonicalResourceRef({ scheme: "page", id: page.id }) },
  };
}
