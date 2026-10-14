import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { notePagesResource } from "@/lib/api/resource";
import type { ListPage } from "@/lib/api/useServerList";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { UpdatedTitleIndexView } from "@/lib/collections/updatedTitleIndexView";
import { withNotePageActionSubject, type NotePage } from "@/lib/notes/pageContract";
import { isLocalDate } from "@/lib/localDate";
import { projectResourceSurface, type ResourceSurface } from "@/lib/resources/resourceItems";

export type NotePageSummary = Schema<"NotePageSummaryOut">;

/** Creates a page by its client id (a retry returns it). Publishes "Notes". */
export async function createPage(
  id: string,
  title: string,
): Promise<NotePageSummary> {
  const { data } = await apiFetch<ApiJson<"/notes/pages", "post">>(
    "/api/notes/pages",
    { method: "POST", body: JSON.stringify({ id, title }) },
  );
  publishChange("Notes");
  return data;
}

/** One keyset page of the viewer's pages in `view`. */
export async function fetchNotePages(input: {
  view: UpdatedTitleIndexView;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<ListPage<NotePageSummary>> {
  const { signal, ...params } = input;
  const { data } = await apiFetch<ApiJson<"/notes/pages", "get">>(
    notePagesResource.clientPath(params),
    { cache: "no-store", signal },
  );
  return data;
}

export type DailyPageDescriptor =
  | Schema<"LatentDailyPageDescriptor">
  | (Omit<Schema<"MaterializedDailyPageDescriptor">, "page" | "surface"> & {
      page: NotePage;
      surface: ResourceSurface;
    });

export async function readDailyPage(
  localDate: string,
): Promise<DailyPageDescriptor> {
  if (!isLocalDate(localDate)) {
    throw new TypeError("localDate must be a valid YYYY-MM-DD date");
  }
  const { data } = await apiFetch<ApiJson<"/notes/daily/{local_date}", "get">>(
    `/api/notes/daily/${localDate}`,
    { cache: "no-store" },
  );
  if (data.kind === "Latent") return data;
  return {
    ...data,
    page: withNotePageActionSubject(data.page),
    surface: projectResourceSurface(data.surface),
  };
}

export type DailyCaptureInput = Schema<"DailyCaptureRequest">;
export type DailyCaptureResult = Omit<Schema<"DailyCaptureResult">, "surface"> & {
  surface: ResourceSurface;
};

export function acceptDailyCaptureResult(result: Schema<"DailyCaptureResult">): DailyCaptureResult {
  const surface = projectResourceSurface(result.surface);
  if (surface.source.item.ref !== `page:${result.page_id}`) {
    throw new TypeError("daily capture result.surface source must match pageId");
  }
  return { ...result, surface };
}

export async function captureDailyPageNote(
  localDate: string,
  input: DailyCaptureInput,
): Promise<DailyCaptureResult> {
  if (!isLocalDate(localDate)) {
    throw new TypeError("localDate must be a valid YYYY-MM-DD date");
  }
  const response = await apiFetch<ApiJson<"/notes/daily/{local_date}/captures", "post">>(
    `/api/notes/daily/${localDate}/captures`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  const result = decodeApiPayload(
    response,
    () => acceptDailyCaptureResult(response.data),
    "Capture daily page note",
  );
  if (
    result.client_mutation_id !== input.client_mutation_id ||
    result.local_date !== localDate
  ) {
    throw new TypeError("daily capture response identity does not match request");
  }
  return result;
}

export async function fetchNotePage(pageId: string): Promise<NotePage> {
  const { data } = await apiFetch<ApiJson<"/notes/pages/{page_id}", "get">>(
    `/api/notes/pages/${pageId}`,
    { cache: "no-store" },
  );
  return withNotePageActionSubject(data);
}

/** Deletes the page; its note blocks are kept. Publishes "Notes". */
export async function deletePage(pageId: string): Promise<void> {
  await apiFetch(`/api/notes/pages/${encodeURIComponent(pageId)}`, {
    method: "DELETE",
  });
  publishChange("Notes");
}
