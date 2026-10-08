import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { withNotePageActionSubject, type NotePage } from "@/lib/notes/pageContract";
import { isLocalDate } from "@/lib/localDate";
import { projectResourceSurface, type ResourceSurface } from "@/lib/resources/resourceItems";

export async function createNotePage(input: {
  pageId: string;
  title: string;
}): Promise<NotePage> {
  const response = await apiFetch<ApiJson<"/notes/pages", "post">>(
    "/api/notes/pages",
    {
      method: "POST",
      body: JSON.stringify({ page_id: input.pageId, title: input.title }),
    },
  );
  const page = withNotePageActionSubject(response.data);
  if (page.id !== input.pageId) {
    throw new Error(
      `Notes API create response id ${page.id} does not match requested page ${input.pageId}`,
    );
  }
  return page;
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
  if (surface.source.item.ref !== `page:${result.pageId}`) {
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
      body: JSON.stringify({
        clientMutationId: input.clientMutationId,
        noteId: input.noteId,
        bodyPmJson: input.bodyPmJson,
      }),
    },
  );
  const result = decodeApiPayload(
    response,
    () => acceptDailyCaptureResult(response.data),
    "Capture daily page note",
  );
  if (
    result.clientMutationId !== input.clientMutationId ||
    result.localDate !== localDate
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
