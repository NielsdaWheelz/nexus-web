import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { withNotePageActionSubject, type NotePage } from "@/lib/notes/pageContract";
import { isLocalDate } from "@/lib/localDate";
import { normalizeResourceSurface, type ResourceSurface } from "@/lib/resources/resourceItems";
import { expectCanonicalUuid, expectExactRecord, expectString } from "@/lib/validation";

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
    surface: normalizeResourceSurface(data.surface),
  };
}

export type DailyCaptureInput = Schema<"DailyCaptureRequest">;
export type DailyCaptureResult = Omit<Schema<"DailyCaptureResult">, "surface"> & {
  surface: ResourceSurface;
};

export function decodeDailyCaptureResult(raw: unknown): DailyCaptureResult {
  const result = expectExactRecord(
    raw,
    ["clientMutationId", "localDate", "pageId", "surface"],
    "daily capture result",
  );
  const pageId = expectCanonicalUuid(result.pageId, "daily capture result.pageId");
  const surface = normalizeResourceSurface(result.surface);
  if (surface.source.item.ref !== `page:${pageId}`) {
    throw new TypeError(
      "daily capture result.surface source must match pageId",
    );
  }
  const localDate = expectString(result.localDate, "daily capture result.localDate");
  if (!isLocalDate(localDate)) {
    throw new TypeError("daily capture result.localDate must be a valid YYYY-MM-DD date");
  }
  return {
    clientMutationId: expectString(
      result.clientMutationId,
      "daily capture result.clientMutationId",
    ),
    localDate,
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
  const response = await apiFetch<unknown>(
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
    (raw) => {
      const envelope = expectExactRecord(
        raw,
        ["data"],
        "daily capture response",
      );
      return decodeDailyCaptureResult(envelope.data);
    },
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
