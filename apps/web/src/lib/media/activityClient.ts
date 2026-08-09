"use client";

import {
  apiFetch,
  decodeApiPayload,
  type ApiPath,
} from "@/lib/api/client";
import { decodePresence, type Presence } from "@/lib/api/presence";
import {
  LIBRARY_MEDIA_KINDS,
  type LibraryMediaKind,
} from "@/lib/libraries/mediaKind";
import {
  expectArray,
  expectBoolean,
  expectExactRecord,
  expectIsoInstant,
  expectNonnegativeInteger,
  expectOneOf,
  expectString,
} from "@/lib/validation";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type MediaActivityStatus =
  | "Queued"
  | "Processing"
  | "Ready"
  | "NeedsAttention";
export type MediaActivityStage =
  | "Validate"
  | "Extract"
  | "Finalize"
  | "Index";
export type MediaActivityWaitingReason =
  | "Queue"
  | "Capacity"
  | "RetryBackoff";
export type MediaRepairScope = "Source" | "Search";

export type SourceProgress =
  | {
      readonly kind: "Stage";
      readonly stage: Exclude<MediaActivityStage, "Index">;
      readonly runCount: number;
      readonly updatedAt: string;
    }
  | {
      readonly kind: "Counted";
      readonly stage: "Extract";
      readonly completed: number;
      readonly total: number;
      readonly unit: "Page" | "Chapter";
      readonly runCount: number;
      readonly updatedAt: string;
    };

export interface MediaActivityItem {
  readonly mediaId: string;
  readonly title: string;
  readonly mediaKind: LibraryMediaKind;
  readonly sourceAttemptId: string;
  readonly status: MediaActivityStatus;
  readonly stage: Presence<MediaActivityStage>;
  readonly waitingReason: Presence<MediaActivityWaitingReason>;
  readonly failureCode: Presence<string>;
  readonly requestId: Presence<string>;
  readonly progress: Presence<SourceProgress>;
  readonly runCount: number;
  readonly queueAttempts: number;
  readonly queueMaxAttempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly capabilities: {
    readonly canOpen: boolean;
    readonly canRepairSource: boolean;
    readonly canRepairSearch: boolean;
    readonly canRemove: boolean;
  };
}

export interface MediaActivityResponse {
  readonly nonterminalCount: number;
  readonly items: readonly MediaActivityItem[];
}

export interface MediaRepairResult {
  readonly mediaId: string;
  readonly scope: MediaRepairScope;
  readonly jobId: string;
}

function canonicalUuid(raw: unknown, name: string): string {
  const value = expectString(raw, name);
  if (!UUID_RE.test(value)) {
    throw new TypeError(`${name} must be a canonical lowercase UUID`);
  }
  return value;
}

function nonemptyString(raw: unknown, name: string): string {
  const value = expectString(raw, name);
  if (value.length === 0) throw new TypeError(`${name} must not be empty`);
  return value;
}

function sourceProgress(raw: unknown): SourceProgress {
  const base = expectExactRecord(
    raw,
    (() => {
      if (
        typeof raw === "object" &&
        raw !== null &&
        !Array.isArray(raw) &&
        (raw as Record<string, unknown>).kind === "Counted"
      ) {
        return [
          "kind",
          "stage",
          "completed",
          "total",
          "unit",
          "run_count",
          "updated_at",
        ];
      }
      return ["kind", "stage", "run_count", "updated_at"];
    })(),
    "media Activity progress",
  );
  const kind = expectOneOf(
    base.kind,
    ["Stage", "Counted"] as const,
    "media Activity progress.kind",
  );
  const runCount = expectNonnegativeInteger(
    base.run_count,
    "media Activity progress.run_count",
  );
  const updatedAt = expectIsoInstant(
    base.updated_at,
    "media Activity progress.updated_at",
  );
  if (kind === "Stage") {
    return {
      kind,
      stage: expectOneOf(
        base.stage,
        ["Validate", "Extract", "Finalize"] as const,
        "media Activity progress.stage",
      ),
      runCount,
      updatedAt,
    };
  }
  if (base.stage !== "Extract") {
    throw new TypeError("counted media Activity progress must be Extract");
  }
  const completed = expectNonnegativeInteger(
    base.completed,
    "media Activity progress.completed",
  );
  const total = expectNonnegativeInteger(
    base.total,
    "media Activity progress.total",
  );
  if (total === 0 || completed > total) {
    throw new TypeError(
      "counted media Activity progress must satisfy 0 <= completed <= total",
    );
  }
  return {
    kind,
    stage: "Extract",
    completed,
    total,
    unit: expectOneOf(
      base.unit,
      ["Page", "Chapter"] as const,
      "media Activity progress.unit",
    ),
    runCount,
    updatedAt,
  };
}

function activityItem(raw: unknown, index: number): MediaActivityItem {
  const name = `media Activity items[${index}]`;
  const item = expectExactRecord(
    raw,
    [
      "media_id",
      "title",
      "media_kind",
      "source_attempt_id",
      "status",
      "stage",
      "waiting_reason",
      "failure_code",
      "request_id",
      "progress",
      "run_count",
      "queue_attempts",
      "queue_max_attempts",
      "created_at",
      "updated_at",
      "capabilities",
    ],
    name,
  );
  const capabilities = expectExactRecord(
    item.capabilities,
    ["can_open", "can_repair_source", "can_repair_search", "can_remove"],
    `${name}.capabilities`,
  );
  return {
    mediaId: canonicalUuid(item.media_id, `${name}.media_id`),
    title: nonemptyString(item.title, `${name}.title`),
    mediaKind: expectOneOf(
      item.media_kind,
      LIBRARY_MEDIA_KINDS,
      `${name}.media_kind`,
    ),
    sourceAttemptId: canonicalUuid(
      item.source_attempt_id,
      `${name}.source_attempt_id`,
    ),
    status: expectOneOf(
      item.status,
      ["Queued", "Processing", "Ready", "NeedsAttention"] as const,
      `${name}.status`,
    ),
    stage: decodePresence(item.stage, (value) =>
      expectOneOf(
        value,
        ["Validate", "Extract", "Finalize", "Index"] as const,
        `${name}.stage.value`,
      ),
    ),
    waitingReason: decodePresence(item.waiting_reason, (value) =>
      expectOneOf(
        value,
        ["Queue", "Capacity", "RetryBackoff"] as const,
        `${name}.waiting_reason.value`,
      ),
    ),
    failureCode: decodePresence(item.failure_code, (value) =>
      nonemptyString(value, `${name}.failure_code.value`),
    ),
    requestId: decodePresence(item.request_id, (value) =>
      nonemptyString(value, `${name}.request_id.value`),
    ),
    progress: decodePresence(item.progress, sourceProgress),
    runCount: expectNonnegativeInteger(item.run_count, `${name}.run_count`),
    queueAttempts: expectNonnegativeInteger(
      item.queue_attempts,
      `${name}.queue_attempts`,
    ),
    queueMaxAttempts: expectNonnegativeInteger(
      item.queue_max_attempts,
      `${name}.queue_max_attempts`,
    ),
    createdAt: expectIsoInstant(item.created_at, `${name}.created_at`),
    updatedAt: expectIsoInstant(item.updated_at, `${name}.updated_at`),
    capabilities: {
      canOpen: expectBoolean(capabilities.can_open, `${name}.can_open`),
      canRepairSource: expectBoolean(
        capabilities.can_repair_source,
        `${name}.can_repair_source`,
      ),
      canRepairSearch: expectBoolean(
        capabilities.can_repair_search,
        `${name}.can_repair_search`,
      ),
      canRemove: expectBoolean(capabilities.can_remove, `${name}.can_remove`),
    },
  };
}

export function decodeMediaActivityResponse(
  raw: unknown,
): MediaActivityResponse {
  const envelope = expectExactRecord(raw, ["data"], "GET /api/media/activity");
  const data = expectExactRecord(
    envelope.data,
    ["nonterminal_count", "items"],
    "GET /api/media/activity.data",
  );
  return {
    nonterminalCount: expectNonnegativeInteger(
      data.nonterminal_count,
      "GET /api/media/activity.data.nonterminal_count",
    ),
    items: expectArray(data.items, activityItem, "media Activity items"),
  };
}

function decodeMediaRepairResponse(raw: unknown): MediaRepairResult {
  const envelope = expectExactRecord(raw, ["data"], "media Activity repair");
  const data = expectExactRecord(
    envelope.data,
    ["media_id", "scope", "job_id"],
    "media Activity repair.data",
  );
  return {
    mediaId: canonicalUuid(data.media_id, "media Activity repair.media_id"),
    scope: expectOneOf(
      data.scope,
      ["Source", "Search"] as const,
      "media Activity repair.scope",
    ),
    jobId: canonicalUuid(data.job_id, "media Activity repair.job_id"),
  };
}

export async function fetchMediaActivity(
  signal?: AbortSignal,
): Promise<MediaActivityResponse> {
  const path = "/api/media/activity?limit=20" as ApiPath;
  const body = await apiFetch<unknown>(path, { cache: "no-store", signal });
  return decodeApiPayload(
    body,
    decodeMediaActivityResponse,
    "GET /api/media/activity",
  );
}

export async function repairMediaActivity(
  mediaId: string,
  scope: MediaRepairScope,
): Promise<MediaRepairResult> {
  const body = await apiFetch<unknown>(
    `/api/media/${encodeURIComponent(mediaId)}/repair`,
    { method: "POST", body: JSON.stringify({ scope }) },
  );
  const result = decodeApiPayload(
    body,
    decodeMediaRepairResponse,
    "POST /api/media/:id/repair",
  );
  if (result.mediaId !== mediaId || result.scope !== scope) {
    throw new TypeError("media Activity repair changed the requested identity");
  }
  return result;
}

const MEDIA_ACTIVITY_CHANGED_EVENT = "Media.ActivityChanged";

export function publishAcceptedMediaActivity(): void {
  window.dispatchEvent(new Event(MEDIA_ACTIVITY_CHANGED_EVENT));
}

export function subscribeMediaActivityChanges(handler: () => void): () => void {
  window.addEventListener(MEDIA_ACTIVITY_CHANGED_EVENT, handler);
  return () => window.removeEventListener(MEDIA_ACTIVITY_CHANGED_EVENT, handler);
}
