import {
  notePagesResource,
  type NotePagesResourceParams,
} from "@/lib/api/resource";
import type { ResourceFetcher } from "@/lib/api/resourceTransport";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { canonicalResourceRef } from "@/lib/sharing/targets";

export type NotePageSummary = Schema<"NotePageSummaryOut"> & {
  readonly actionSubject: ResourceActionSubject;
};
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

export async function loadNotePages(
  request: ResourceFetcher,
  params: NotePagesResourceParams,
): Promise<readonly NotePageSummary[]> {
  const response = await request<NotePagesResourceParams, ApiJson<"/notes/pages", "get">>(
    notePagesResource,
    params,
  );
  return response.data.pages.map(withNotePageActionSubject);
}
