import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import {
  decodeNoteLocalDate,
  decodeNotePage,
  decodeNotePageEnvelope,
  decodeNotePageId,
  type NotePage,
} from "@/lib/notes/pageContract";
import { isLocalDate } from "@/lib/localDate";
import { normalizeResourceSurface, type ResourceSurface } from "@/lib/resources/resourceItems";
import { expectExactRecord, expectString, expectRecord } from "@/lib/validation";

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

export function decodeDailyPageDescriptor(raw: unknown): DailyPageDescriptor {
  const record = expectRecord(raw, "daily page descriptor");
  const kind = expectString(record.kind, "daily page descriptor.kind");
  switch (kind) {
    case "Latent": {
      const latent = expectExactRecord(
        record,
        ["kind", "localDate", "defaultTitle"],
        "latent daily page descriptor",
      );
      return {
        kind,
        localDate: decodeNoteLocalDate(
          latent.localDate,
          "latent daily page descriptor.localDate",
        ),
        defaultTitle: expectString(
          latent.defaultTitle,
          "latent daily page descriptor.defaultTitle",
        ),
      };
    }
    case "Materialized": {
      const materialized = expectExactRecord(
        record,
        ["kind", "localDate", "page", "surface"],
        "materialized daily page descriptor",
      );
      const localDate = decodeNoteLocalDate(
        materialized.localDate,
        "materialized daily page descriptor.localDate",
      );
      const page = decodeNotePage(materialized.page);
      if (
        page.dailyPage.kind !== "Present" ||
        page.dailyPage.value.localDate !== localDate
      ) {
        throw new TypeError(
          "materialized daily page descriptor page must match localDate",
        );
      }
      return {
        kind,
        localDate,
        page,
        surface: normalizeResourceSurface(materialized.surface),
      };
    }
    default:
      throw new TypeError(
        "daily page descriptor.kind must be Latent or Materialized",
      );
  }
}

export async function readDailyPage(
  localDate: string,
): Promise<DailyPageDescriptor> {
  if (!isLocalDate(localDate)) {
    throw new TypeError("localDate must be a valid YYYY-MM-DD date");
  }
  const response = await apiFetch<unknown>(
    `/api/notes/daily/${localDate}`,
    { cache: "no-store" },
  );
  return decodeApiPayload(
    response,
    (raw) => {
      const envelope = expectExactRecord(raw, ["data"], "daily page response");
      return decodeDailyPageDescriptor(envelope.data);
    },
    "Read daily page",
  );
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

export function decodeDailyCaptureResult(raw: unknown): DailyCaptureResult {
  const result = expectExactRecord(
    raw,
    ["clientMutationId", "localDate", "pageId", "surface"],
    "daily capture result",
  );
  const pageId = decodeNotePageId(
    result.pageId,
    "daily capture result.pageId",
  );
  const surface = normalizeResourceSurface(result.surface);
  if (surface.source.item.ref !== `page:${pageId}`) {
    throw new TypeError(
      "daily capture result.surface source must match pageId",
    );
  }
  return {
    clientMutationId: expectString(
      result.clientMutationId,
      "daily capture result.clientMutationId",
    ),
    localDate: decodeNoteLocalDate(
      result.localDate,
      "daily capture result.localDate",
    ),
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
  const response = await apiFetch<unknown>(`/api/notes/pages/${pageId}`, {
    cache: "no-store",
  });
  return decodeApiPayload(response, decodeNotePageEnvelope, "Read page");
}

