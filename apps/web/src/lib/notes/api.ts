import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import {
  decodeNotePageEnvelope,
  type NotePage,
} from "@/lib/notes/pageContract";
import { isLocalDate } from "@/lib/localDate";
import { projectResourceSurface, type ResourceSurface } from "@/lib/resources/resourceItems";
import { canonicalResourceRef } from "@/lib/sharing/targets";

export async function createNotePage(input: {
  pageId: string;
  title: string;
}): Promise<NotePage> {
  const response = await apiFetch<unknown>("/api/notes/pages", {
    method: "POST",
    body: JSON.stringify({ page_id: input.pageId, title: input.title }),
  });
  const page = decodeApiPayload(
    response,
    decodeNotePageEnvelope,
    "Create page",
  );
  if (page.id !== input.pageId) {
    throw new Error(
      `Notes API create response id ${page.id} does not match requested page ${input.pageId}`,
    );
  }
  return page;
}

export type DailyPageDescriptor =
  | {
      kind: "Latent";
      localDate: string;
      defaultTitle: string;
    }
  | {
      kind: "Materialized";
      localDate: string;
      page: NotePage;
      surface: ResourceSurface;
    };

function projectDailyPageDescriptor(value: ApiJson<"/notes/daily/{local_date}", "get">["data"]): DailyPageDescriptor {
  if (value.kind === "Latent") return value;
  return {
    ...value,
    page: {
      ...value.page,
      actionSubject: { ref: canonicalResourceRef({ scheme: "page", id: value.page.id }) },
    },
    surface: projectResourceSurface(value.surface),
  };
}

export async function readDailyPage(
  localDate: string,
): Promise<DailyPageDescriptor> {
  if (!isLocalDate(localDate)) {
    throw new TypeError("localDate must be a valid YYYY-MM-DD date");
  }
  const response = await apiFetch<ApiJson<"/notes/daily/{local_date}", "get">>(
    `/api/notes/daily/${localDate}`,
    { cache: "no-store" },
  );
  return projectDailyPageDescriptor(response.data);
}

export interface DailyCaptureInput {
  clientMutationId: string;
  noteId: string;
  bodyPmJson: Record<string, unknown>;
}

export interface DailyCaptureResult {
  clientMutationId: string;
  localDate: string;
  pageId: string;
  surface: ResourceSurface;
}

export function projectDailyCaptureResult(value: Schema<"DailyCaptureResult">): DailyCaptureResult {
  return {
    ...value,
    surface: projectResourceSurface(value.surface),
  };
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
  const result = projectDailyCaptureResult(response.data);
  if (
    result.clientMutationId !== input.clientMutationId ||
    result.localDate !== localDate
  ) {
    throw new TypeError("daily capture response identity does not match request");
  }
  return result;
}

export async function fetchNotePage(pageId: string): Promise<NotePage> {
  const response = await apiFetch<unknown>(`/api/notes/pages/${pageId}`, {
    cache: "no-store",
  });
  return decodeApiPayload(response, decodeNotePageEnvelope, "Read page");
}
