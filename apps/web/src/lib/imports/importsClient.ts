"use client";

import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import { absent, present, type Presence } from "@/lib/api/presence";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import { parseImportRef, type ImportRef } from "@/lib/imports/importRef";
import {
  expectCanonicalRfcUuid,
  expectExactRecord,
  expectNonnegativeInteger,
  expectOneOf,
  expectRecord,
} from "@/lib/validation";

export type ImportState = Schema<"ImportItem">["state"];
export type HistoryEntry = Schema<"HistoryEntry">;
export type ImportStageGroup = Schema<"ImportStageGroup">;
export type ImportSummary = ApiJson<"/imports/summary", "get">["data"];
export type HistoryPage = ApiJson<"/imports/{ref}/history", "get">["data"];
export type ImportItem = Omit<Schema<"ImportItem">, "ref" | "media_ref"> & {
  readonly ref: ImportRef;
  readonly media_ref: Presence<CanonicalResourceRef>;
};
export type ImportPage = Omit<ApiJson<"/imports", "get">["data"], "items"> & {
  readonly items: readonly ImportItem[];
};
export type ImportDetail = Omit<
  ApiJson<"/imports/{ref}", "get">["data"],
  "item"
> & {
  readonly item: ImportItem;
};
export type ReadRecoveryOffer = Extract<
  Schema<"Capabilities">["recovery"],
  { kind: "Present" }
>["value"];
export type ModeledRecoveryRestriction = Extract<
  Schema<"Capabilities">["unavailable_reason"],
  { kind: "Present" }
>["value"];

function acceptImportItem(item: Schema<"ImportItem">): ImportItem {
  const ref = parseImportRef(item.ref);
  if (ref === null)
    throw new TypeError("import ref must be an upload or media import ref");
  let mediaRef: Presence<CanonicalResourceRef> = absent();
  if (item.media_ref.kind === "Present") {
    const parsed = parseResourceRef(item.media_ref.value);
    if (parsed === null || parsed.scheme !== "media") {
      throw new TypeError("media_ref must be a media resource ref");
    }
    mediaRef = present(canonicalResourceRef(parsed));
  }
  return { ...item, ref, media_ref: mediaRef };
}

const SOURCE_RECOVERY_INPUTS = ["StoredSource", "RefetchSource"] as const;

/** The camel-case media action-snapshot contract; read offers use generated wire fields. */
export type MediaRecoveryOffer =
  | {
      readonly kind: "RetrySource";
      readonly expectedAttemptId: string;
      readonly input: "StoredSource" | "RefetchSource";
    }
  | {
      readonly kind: "RepairSource";
      readonly expectedAttemptId: string;
      readonly expectedJobId: string;
      readonly input: "StoredSource" | "RefetchSource";
    }
  | {
      readonly kind: "RepairSearch";
      readonly expectedRevision: number;
      readonly expectedJobId: string;
      readonly input: "PublishedContent";
    };

export interface SourceAdmission {
  readonly mediaId: string;
  readonly sourceAttemptId: string;
  readonly jobId: string;
}

export interface SearchAdmission {
  readonly mediaId: string;
  readonly revision: number;
  readonly jobId: string;
}

export function decodeCamelCaseMediaRecoveryOffer(
  raw: unknown,
  name: string,
): MediaRecoveryOffer {
  const kind = expectOneOf(
    expectRecord(raw, name).kind,
    ["RetryUpload", "RetrySource", "RepairSource", "RepairSearch"] as const,
    `${name}.kind`,
  );
  switch (kind) {
    case "RetryUpload":
      throw new TypeError(`${name} must name a media recovery`);
    case "RetrySource": {
      const offer = expectExactRecord(
        raw,
        ["kind", "expectedAttemptId", "input"],
        name,
      );
      return {
        kind,
        expectedAttemptId: expectCanonicalRfcUuid(
          offer.expectedAttemptId,
          `${name}.expectedAttemptId`,
        ),
        input: expectOneOf(
          offer.input,
          SOURCE_RECOVERY_INPUTS,
          `${name}.input`,
        ),
      };
    }
    case "RepairSource": {
      const offer = expectExactRecord(
        raw,
        ["kind", "expectedAttemptId", "expectedJobId", "input"],
        name,
      );
      return {
        kind,
        expectedAttemptId: expectCanonicalRfcUuid(
          offer.expectedAttemptId,
          `${name}.expectedAttemptId`,
        ),
        expectedJobId: expectCanonicalRfcUuid(
          offer.expectedJobId,
          `${name}.expectedJobId`,
        ),
        input: expectOneOf(
          offer.input,
          SOURCE_RECOVERY_INPUTS,
          `${name}.input`,
        ),
      };
    }
    case "RepairSearch": {
      const offer = expectExactRecord(
        raw,
        ["kind", "expectedRevision", "expectedJobId", "input"],
        name,
      );
      return {
        kind,
        expectedRevision: expectNonnegativeInteger(
          offer.expectedRevision,
          `${name}.expectedRevision`,
        ),
        expectedJobId: expectCanonicalRfcUuid(
          offer.expectedJobId,
          `${name}.expectedJobId`,
        ),
        input: expectOneOf(
          offer.input,
          ["PublishedContent"] as const,
          `${name}.input`,
        ),
      };
    }
  }
}

export function decodeSourceAdmission(
  raw: unknown,
  kind: "SourceRetry" | "SourceRepair",
): SourceAdmission {
  const name = `${kind}Admission`;
  const data = expectExactRecord(
    expectExactRecord(raw, ["data"], name).data,
    ["kind", "media_id", "source_attempt_id", "job_id"],
    `${name}.data`,
  );
  expectOneOf(data.kind, [kind] as const, `${name}.kind`);
  return {
    mediaId: expectCanonicalRfcUuid(data.media_id, `${name}.media_id`),
    sourceAttemptId: expectCanonicalRfcUuid(
      data.source_attempt_id,
      `${name}.source_attempt_id`,
    ),
    jobId: expectCanonicalRfcUuid(data.job_id, `${name}.job_id`),
  };
}

export function decodeSearchAdmission(raw: unknown): SearchAdmission {
  const name = "SearchRepairAdmission";
  const data = expectExactRecord(
    expectExactRecord(raw, ["data"], name).data,
    ["kind", "media_id", "revision", "job_id"],
    `${name}.data`,
  );
  expectOneOf(data.kind, ["SearchRepair"] as const, `${name}.kind`);
  return {
    mediaId: expectCanonicalRfcUuid(data.media_id, `${name}.media_id`),
    revision: expectNonnegativeInteger(data.revision, `${name}.revision`),
    jobId: expectCanonicalRfcUuid(data.job_id, `${name}.job_id`),
  };
}

export async function fetchImportSummary(
  signal?: AbortSignal,
): Promise<ImportSummary> {
  const response = await apiFetch<ApiJson<"/imports/summary", "get">>(
    "/api/imports/summary",
    { cache: "no-store", signal },
  );
  return response.data;
}

export async function fetchImportPage({
  query,
  cursor,
  signal,
}: {
  readonly query: URLSearchParams;
  readonly cursor: Presence<string>;
  readonly signal?: AbortSignal;
}): Promise<ImportPage> {
  const params = new URLSearchParams(query);
  if (cursor.kind === "Present") params.set("cursor", cursor.value);
  const response = await apiFetch<ApiJson<"/imports", "get">>(
    `/api/imports?${params}`,
    { cache: "no-store", signal },
  );
  return decodeApiPayload(
    response,
    () => ({
      ...response.data,
      items: response.data.items.map(acceptImportItem),
    }),
    "GET /api/imports",
  );
}

export async function fetchImportDetail({
  ref,
  signal,
}: {
  readonly ref: ImportRef;
  readonly signal?: AbortSignal;
}): Promise<ImportDetail> {
  const response = await apiFetch<ApiJson<"/imports/{ref}", "get">>(
    `/api/imports/${encodeURIComponent(ref)}`,
    { cache: "no-store", signal },
  );
  return decodeApiPayload(
    response,
    () => ({ ...response.data, item: acceptImportItem(response.data.item) }),
    "GET /api/imports/:ref",
  );
}

export async function fetchImportHistory({
  ref,
  cursor,
  signal,
}: {
  readonly ref: ImportRef;
  readonly cursor: Presence<string>;
  readonly signal?: AbortSignal;
}): Promise<HistoryPage> {
  const query =
    cursor.kind === "Present"
      ? `?cursor=${encodeURIComponent(cursor.value)}`
      : "";
  const response = await apiFetch<ApiJson<"/imports/{ref}/history", "get">>(
    `/api/imports/${encodeURIComponent(ref)}/history${query}`,
    { cache: "no-store", signal },
  );
  return response.data;
}

export async function retrySourceImport({
  mediaId,
  expectedAttemptId,
  clientMutationId,
}: {
  readonly mediaId: string;
  readonly expectedAttemptId: string;
  readonly clientMutationId: string;
}): Promise<SourceAdmission> {
  const body = await apiFetch<unknown>(
    `/api/media/${encodeURIComponent(mediaId)}/retry`,
    {
      method: "POST",
      body: JSON.stringify({
        from_stage: "source",
        client_mutation_id: clientMutationId,
        expected_attempt_id: expectedAttemptId,
      }),
    },
  );
  return decodeApiPayload(
    body,
    (payload) => decodeSourceAdmission(payload, "SourceRetry"),
    "POST /api/media/:id/retry",
  );
}

export async function repairSourceImport({
  mediaId,
  expectedAttemptId,
  expectedJobId,
  clientMutationId,
}: {
  readonly mediaId: string;
  readonly expectedAttemptId: string;
  readonly expectedJobId: string;
  readonly clientMutationId: string;
}): Promise<SourceAdmission> {
  const body = await apiFetch<unknown>(
    `/api/media/${encodeURIComponent(mediaId)}/repair`,
    {
      method: "POST",
      body: JSON.stringify({
        kind: "Source",
        client_mutation_id: clientMutationId,
        expected_attempt_id: expectedAttemptId,
        expected_job_id: expectedJobId,
      }),
    },
  );
  return decodeApiPayload(
    body,
    (payload) => decodeSourceAdmission(payload, "SourceRepair"),
    "POST /api/media/:id/repair",
  );
}

export async function repairSearchImport({
  mediaId,
  expectedRevision,
  expectedJobId,
  clientMutationId,
}: {
  readonly mediaId: string;
  readonly expectedRevision: number;
  readonly expectedJobId: string;
  readonly clientMutationId: string;
}): Promise<SearchAdmission> {
  const body = await apiFetch<unknown>(
    `/api/media/${encodeURIComponent(mediaId)}/repair`,
    {
      method: "POST",
      body: JSON.stringify({
        kind: "Search",
        client_mutation_id: clientMutationId,
        expected_revision: expectedRevision,
        expected_job_id: expectedJobId,
      }),
    },
  );
  return decodeApiPayload(
    body,
    decodeSearchAdmission,
    "POST /api/media/:id/repair",
  );
}

const IMPORTS_INVALIDATED_SIGNAL = "Imports.Invalidated";

let invalidationChannel: BroadcastChannel | null = null;
let invalidationSubscribers = 0;

function acquireInvalidationChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  invalidationChannel ??= new BroadcastChannel(IMPORTS_INVALIDATED_SIGNAL);
  invalidationSubscribers += 1;
  return invalidationChannel;
}

function releaseInvalidationChannel(): void {
  invalidationSubscribers -= 1;
  if (invalidationSubscribers !== 0 || invalidationChannel === null) return;
  invalidationChannel.close();
  invalidationChannel = null;
}

export function publishImportsInvalidation(): void {
  window.dispatchEvent(new Event(IMPORTS_INVALIDATED_SIGNAL));
  if (invalidationChannel !== null) {
    // BroadcastChannel does not echo to the sending channel, so the window
    // event is the one in-tab delivery and this message wakes other tabs.
    invalidationChannel.postMessage(null);
    return;
  }
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(IMPORTS_INVALIDATED_SIGNAL);
  channel.postMessage(null);
  channel.close();
}

export function subscribeImportsInvalidations(handler: () => void): () => void {
  window.addEventListener(IMPORTS_INVALIDATED_SIGNAL, handler);
  const channel = acquireInvalidationChannel();
  channel?.addEventListener("message", handler);
  return () => {
    window.removeEventListener(IMPORTS_INVALIDATED_SIGNAL, handler);
    if (channel === null) return;
    channel.removeEventListener("message", handler);
    releaseInvalidationChannel();
  };
}
