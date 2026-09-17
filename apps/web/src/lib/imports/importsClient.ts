"use client";

/**
 * The browser boundary for the Imports workspace: the wire DTOs of the Imports
 * API (cutover contract §4), the recorded history facts they carry (§2), the
 * strict decoders that turn them into owned data, and the reads and commands
 * the pane issues. Everything below the decoders is owned typed data; nothing
 * above them re-validates it.
 */

import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import { decodePresence, type Presence } from "@/lib/api/presence";
import { MEDIA_KINDS, type MediaKind } from "@/lib/media/kind";
import {
  decodeMediaSourceProgress,
  type MediaSourceProgress,
} from "@/lib/media/sourceProgress";
import {
  decodeUploadTransportFailure,
  type UploadTransportFailure,
} from "@/lib/media/uploadVerification";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import {
  IMPORT_STAGES,
  IMPORT_STATE_KINDS,
  SAFE_FAILURE_CODES,
  parseImportRef,
  type ImportRef,
  type ImportStage,
  type SafeFailureCode,
} from "@/lib/imports/importRef";
import {
  expectArray,
  expectBoolean,
  expectCanonicalRfcUuid,
  expectExactRecord,
  expectIsoInstant,
  expectNonemptyString,
  expectNonnegativeInteger,
  expectOneOf,
  expectPositiveInteger,
  expectRecord,
} from "@/lib/validation";

const IMPORT_WAITING_REASONS = ["Queue", "Capacity", "RetryBackoff"] as const;
export type ImportWaitingReason = (typeof IMPORT_WAITING_REASONS)[number];

const RECOVERY_RESTRICTIONS = [
  "NotOwner",
  "SameSourceTerminal",
  "SourceNotReacquirable",
  "UploadRejected",
] as const;
export type ModeledRecoveryRestriction = (typeof RECOVERY_RESTRICTIONS)[number];

const SOURCE_RECOVERY_INPUTS = ["StoredSource", "RefetchSource"] as const;
const FAILURE_ORIGINS = ["Execution", "Domain"] as const;

export type ImportState =
  | {
      readonly kind: "Active";
      readonly status: "Queued" | "Processing";
      readonly stage: ImportStage;
      readonly waitingReason: Presence<ImportWaitingReason>;
      readonly progress: Presence<MediaSourceProgress>;
      readonly nextRetryAt: Presence<string>;
    }
  | {
      readonly kind: "NeedsAttention";
      readonly stage: ImportStage;
      readonly failureCode: Presence<SafeFailureCode>;
    }
  | { readonly kind: "Complete" };

export type RecoveryOffer =
  | {
      readonly kind: "RetryUpload";
      readonly expectedGeneration: number;
      readonly input: "ChooseOriginalFile";
    }
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

/**
 * The offers that name a media resource, so the resource-action runtime plans
 * from exactly these three; the upload offer is dispatched by the Imports
 * provider instead (contract D7).
 */
export type MediaRecoveryOffer = Exclude<RecoveryOffer, { kind: "RetryUpload" }>;

export interface ImportCapabilities {
  readonly canOpen: boolean;
  readonly canRemove: boolean;
  readonly recovery: Presence<RecoveryOffer>;
  readonly unavailableReason: Presence<ModeledRecoveryRestriction>;
}

export type FailureOrigin = (typeof FAILURE_ORIGINS)[number];

export type UploadHistoryFacts =
  | {
      readonly kind:
        | "UploadAccepted"
        | "UploadExecutionStarted"
        | "UploadRecoveryAccepted"
        | "UploadHistoryBaseline";
      readonly generation: number;
    }
  | {
      readonly kind: "UploadFailed";
      readonly generation: number;
      readonly transport: Presence<UploadTransportFailure>;
    }
  | {
      readonly kind: "UploadPublished";
      readonly generation: number;
      readonly mediaId: string;
      readonly sourceAttemptId: string;
    };

export type SourceHistoryFacts =
  | {
      readonly kind: "SourceAccepted";
      readonly sourceAttemptId: string;
      readonly attemptNo: number;
    }
  | {
      readonly kind: "SourceExecutionStarted" | "SourceStageChanged";
      readonly sourceAttemptId: string;
      readonly executionId: string;
    }
  | {
      readonly kind: "SourceRetryScheduled";
      readonly sourceAttemptId: string;
      readonly executionId: Presence<string>;
      readonly nextAttemptAt: string;
    }
  | {
      readonly kind: "SourceFailed";
      readonly sourceAttemptId: string;
      readonly executionId: Presence<string>;
      readonly origin: FailureOrigin;
      readonly terminal: boolean;
      readonly progress: Presence<{
        readonly completed: number;
        readonly total: Presence<number>;
        readonly unit: Presence<string>;
      }>;
    }
  | {
      readonly kind: "SourceRecoveryAccepted";
      readonly sourceAttemptId: string;
      readonly recovery:
        | { readonly kind: "RetrySource"; readonly newSourceAttemptId: string }
        | { readonly kind: "RepairSource"; readonly jobId: string };
    }
  | {
      readonly kind: "SourceSucceeded";
      readonly sourceAttemptId: string;
      readonly executionId: Presence<string>;
    }
  | {
      readonly kind: "SourceSuperseded";
      readonly sourceAttemptId: string;
      readonly winnerMediaId: string;
    }
  | {
      readonly kind: "SourceHistoryBaseline";
      readonly sourceAttemptId: string;
      readonly attemptNo: number;
      readonly outcome:
        | { readonly kind: "Succeeded" }
        | { readonly kind: "Failed"; readonly failureCode: SafeFailureCode }
        | { readonly kind: "InFlight" };
    };

export type IndexHistoryFacts =
  | {
      readonly kind: "IndexAccepted" | "IndexRecoveryAccepted";
      readonly revision: number;
      readonly jobId: string;
    }
  | {
      readonly kind:
        | "IndexExecutionStarted"
        | "IndexSucceeded"
        | "IndexSuperseded";
      readonly revision: number;
      readonly jobId: string;
      readonly executionId: string;
    }
  | {
      readonly kind: "IndexRetryScheduled";
      readonly revision: number;
      readonly jobId: string;
      readonly executionId: Presence<string>;
      readonly nextAttemptAt: string;
    }
  | {
      readonly kind: "IndexFailed";
      readonly revision: number;
      readonly jobId: string;
      readonly executionId: Presence<string>;
      readonly origin: "Execution";
      readonly terminal: boolean;
    };

export type HistoryFacts =
  | UploadHistoryFacts
  | SourceHistoryFacts
  | IndexHistoryFacts;

export interface HistoryEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly stage: Presence<ImportStage>;
  readonly failureCode: Presence<SafeFailureCode>;
  readonly facts: HistoryFacts;
}

export interface ImportItem {
  readonly ref: ImportRef;
  readonly title: string;
  readonly mediaKind: MediaKind;
  readonly sourceLabel: Presence<string>;
  readonly mediaRef: Presence<CanonicalResourceRef>;
  readonly state: ImportState;
  readonly acceptedAt: string;
  readonly updatedAt: string;
  readonly matchedEvent: Presence<HistoryEntry>;
  readonly capabilities: ImportCapabilities;
}

export interface ImportStageGroup {
  readonly stage: ImportStage;
  readonly count: number;
}

export interface ImportPage {
  readonly observedAt: string;
  readonly matchedCount: number;
  readonly groups: readonly ImportStageGroup[];
  readonly items: readonly ImportItem[];
  readonly nextCursor: Presence<string>;
}

export interface ImportSummary {
  readonly observedAt: string;
  readonly needsAttentionCount: number;
  readonly activeCount: number;
}

export type HistoryCoverage =
  | { readonly kind: "Full" }
  | { readonly kind: "Partial"; readonly recordedSince: string };

export interface ImportDetail {
  readonly item: ImportItem;
  readonly readiness: {
    readonly canRead: boolean;
    readonly canSearch: boolean;
    readonly canPlay: boolean;
  };
  readonly historyCoverage: HistoryCoverage;
}

export interface HistoryPage {
  readonly entries: readonly HistoryEntry[];
  readonly nextCursor: Presence<string>;
}

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

function mediaResourceRef(raw: unknown, name: string): CanonicalResourceRef {
  const parsed = parseResourceRef(expectNonemptyString(raw, name));
  if (parsed === null || parsed.scheme !== "media") {
    throw new TypeError(`${name} must be a media resource ref`);
  }
  return canonicalResourceRef(parsed);
}

function importRef(raw: unknown, name: string): ImportRef {
  const parsed = parseImportRef(expectNonemptyString(raw, name));
  if (parsed === null) {
    throw new TypeError(`${name} must be an upload or media import ref`);
  }
  return parsed;
}

function importState(raw: unknown, name: string): ImportState {
  const kind = expectOneOf(
    expectRecord(raw, name).kind,
    IMPORT_STATE_KINDS,
    `${name}.kind`,
  );
  if (kind === "Active") {
    const state = expectExactRecord(
      raw,
      ["kind", "status", "stage", "waiting_reason", "progress", "next_retry_at"],
      name,
    );
    return {
      kind,
      status: expectOneOf(
        state.status,
        ["Queued", "Processing"] as const,
        `${name}.status`,
      ),
      stage: expectOneOf(state.stage, IMPORT_STAGES, `${name}.stage`),
      waitingReason: decodePresence(state.waiting_reason, (value) =>
        expectOneOf(
          value,
          IMPORT_WAITING_REASONS,
          `${name}.waiting_reason.value`,
        ),
      ),
      progress: decodePresence(state.progress, decodeMediaSourceProgress),
      nextRetryAt: decodePresence(state.next_retry_at, (value) =>
        expectIsoInstant(value, `${name}.next_retry_at.value`),
      ),
    };
  }
  if (kind === "NeedsAttention") {
    const state = expectExactRecord(raw, ["kind", "stage", "failure_code"], name);
    return {
      kind,
      stage: expectOneOf(state.stage, IMPORT_STAGES, `${name}.stage`),
      failureCode: decodePresence(state.failure_code, (value) =>
        expectOneOf(value, SAFE_FAILURE_CODES, `${name}.failure_code.value`),
      ),
    };
  }
  expectExactRecord(raw, ["kind"], name);
  return { kind };
}

/**
 * The wire key for each offer field, so the same offer type decodes at both
 * boundaries it crosses: the Imports API, which is snake_case like every other
 * `/api/imports` payload, and the media action snapshot, which is camelCase for
 * its whole payload (`resourceActionSnapshot.ts`). Neither payload mixes the
 * two conventions, so `lib/resources/activation.ts` is the precedent followed
 * here rather than a second offer type.
 */
interface RecoveryOfferKeys {
  readonly expectedGeneration: string;
  readonly expectedAttemptId: string;
  readonly expectedJobId: string;
  readonly expectedRevision: string;
}

const SNAKE_CASE_OFFER_KEYS: RecoveryOfferKeys = {
  expectedGeneration: "expected_generation",
  expectedAttemptId: "expected_attempt_id",
  expectedJobId: "expected_job_id",
  expectedRevision: "expected_revision",
};

const CAMEL_CASE_OFFER_KEYS: RecoveryOfferKeys = {
  expectedGeneration: "expectedGeneration",
  expectedAttemptId: "expectedAttemptId",
  expectedJobId: "expectedJobId",
  expectedRevision: "expectedRevision",
};

function recoveryOffer(
  raw: unknown,
  name: string,
  keys: RecoveryOfferKeys,
): RecoveryOffer {
  const kind = expectOneOf(
    expectRecord(raw, name).kind,
    ["RetryUpload", "RetrySource", "RepairSource", "RepairSearch"] as const,
    `${name}.kind`,
  );
  switch (kind) {
    case "RetryUpload": {
      const offer = expectExactRecord(
        raw,
        ["kind", keys.expectedGeneration, "input"],
        name,
      );
      return {
        kind,
        expectedGeneration: expectPositiveInteger(
          offer[keys.expectedGeneration],
          `${name}.${keys.expectedGeneration}`,
        ),
        input: expectOneOf(
          offer.input,
          ["ChooseOriginalFile"] as const,
          `${name}.input`,
        ),
      };
    }
    case "RetrySource": {
      const offer = expectExactRecord(
        raw,
        ["kind", keys.expectedAttemptId, "input"],
        name,
      );
      return {
        kind,
        expectedAttemptId: expectCanonicalRfcUuid(
          offer[keys.expectedAttemptId],
          `${name}.${keys.expectedAttemptId}`,
        ),
        input: expectOneOf(offer.input, SOURCE_RECOVERY_INPUTS, `${name}.input`),
      };
    }
    case "RepairSource": {
      const offer = expectExactRecord(
        raw,
        ["kind", keys.expectedAttemptId, keys.expectedJobId, "input"],
        name,
      );
      return {
        kind,
        expectedAttemptId: expectCanonicalRfcUuid(
          offer[keys.expectedAttemptId],
          `${name}.${keys.expectedAttemptId}`,
        ),
        expectedJobId: expectCanonicalRfcUuid(
          offer[keys.expectedJobId],
          `${name}.${keys.expectedJobId}`,
        ),
        input: expectOneOf(offer.input, SOURCE_RECOVERY_INPUTS, `${name}.input`),
      };
    }
    case "RepairSearch": {
      const offer = expectExactRecord(
        raw,
        ["kind", keys.expectedRevision, keys.expectedJobId, "input"],
        name,
      );
      return {
        kind,
        expectedRevision: expectNonnegativeInteger(
          offer[keys.expectedRevision],
          `${name}.${keys.expectedRevision}`,
        ),
        expectedJobId: expectCanonicalRfcUuid(
          offer[keys.expectedJobId],
          `${name}.${keys.expectedJobId}`,
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

/** Strict decoder for the snake_case `/api/imports` wire. */
export function decodeRecoveryOffer(raw: unknown, name: string): RecoveryOffer {
  return recoveryOffer(raw, name, SNAKE_CASE_OFFER_KEYS);
}

/**
 * Strict decoder for the camelCase media action snapshot. An upload session is
 * not a resource, so its offer is refused here rather than guarded downstream:
 * the snapshot's capability can only carry a media recovery.
 */
export function decodeCamelCaseMediaRecoveryOffer(
  raw: unknown,
  name: string,
): MediaRecoveryOffer {
  const offer = recoveryOffer(raw, name, CAMEL_CASE_OFFER_KEYS);
  if (offer.kind === "RetryUpload") {
    throw new TypeError(`${name} must name a media recovery`);
  }
  return offer;
}

function importCapabilities(raw: unknown, name: string): ImportCapabilities {
  const value = expectExactRecord(
    raw,
    ["can_open", "can_remove", "recovery", "unavailable_reason"],
    name,
  );
  const recovery = decodePresence(value.recovery, (offer) =>
    decodeRecoveryOffer(offer, `${name}.recovery.value`),
  );
  const unavailableReason = decodePresence(value.unavailable_reason, (reason) =>
    expectOneOf(
      reason,
      RECOVERY_RESTRICTIONS,
      `${name}.unavailable_reason.value`,
    ),
  );
  return {
    canOpen: expectBoolean(value.can_open, `${name}.can_open`),
    canRemove: expectBoolean(value.can_remove, `${name}.can_remove`),
    recovery,
    unavailableReason,
  };
}

function acceptedSourceRecovery(
  raw: unknown,
  name: string,
): Extract<SourceHistoryFacts, { kind: "SourceRecoveryAccepted" }>["recovery"] {
  const kind = expectOneOf(
    expectRecord(raw, name).kind,
    ["RetrySource", "RepairSource"] as const,
    `${name}.kind`,
  );
  if (kind === "RetrySource") {
    const recovery = expectExactRecord(
      raw,
      ["kind", "new_source_attempt_id"],
      name,
    );
    return {
      kind,
      newSourceAttemptId: expectCanonicalRfcUuid(
        recovery.new_source_attempt_id,
        `${name}.new_source_attempt_id`,
      ),
    };
  }
  const recovery = expectExactRecord(raw, ["kind", "job_id"], name);
  return {
    kind,
    jobId: expectCanonicalRfcUuid(recovery.job_id, `${name}.job_id`),
  };
}

function baselineOutcome(
  raw: unknown,
  name: string,
): Extract<SourceHistoryFacts, { kind: "SourceHistoryBaseline" }>["outcome"] {
  const kind = expectOneOf(
    expectRecord(raw, name).kind,
    ["Succeeded", "Failed", "InFlight"] as const,
    `${name}.kind`,
  );
  if (kind === "Failed") {
    const outcome = expectExactRecord(raw, ["kind", "failure_code"], name);
    return {
      kind,
      failureCode: expectOneOf(
        outcome.failure_code,
        SAFE_FAILURE_CODES,
        `${name}.failure_code`,
      ),
    };
  }
  expectExactRecord(raw, ["kind"], name);
  return { kind };
}

function historyCoverage(raw: unknown, name: string): HistoryCoverage {
  const kind = expectOneOf(
    expectRecord(raw, name).kind,
    ["Full", "Partial"] as const,
    `${name}.kind`,
  );
  if (kind === "Partial") {
    const coverage = expectExactRecord(raw, ["kind", "recorded_since"], name);
    return {
      kind,
      recordedSince: expectIsoInstant(
        coverage.recorded_since,
        `${name}.recorded_since`,
      ),
    };
  }
  expectExactRecord(raw, ["kind"], name);
  return { kind };
}

function historyFacts(raw: unknown, name: string): HistoryFacts {
  const kind = expectOneOf(
    expectRecord(raw, name).kind,
    [
      "UploadAccepted",
      "UploadExecutionStarted",
      "UploadRecoveryAccepted",
      "UploadHistoryBaseline",
      "UploadFailed",
      "UploadPublished",
      "SourceAccepted",
      "SourceExecutionStarted",
      "SourceStageChanged",
      "SourceRetryScheduled",
      "SourceFailed",
      "SourceRecoveryAccepted",
      "SourceSucceeded",
      "SourceSuperseded",
      "SourceHistoryBaseline",
      "IndexAccepted",
      "IndexRecoveryAccepted",
      "IndexExecutionStarted",
      "IndexSucceeded",
      "IndexSuperseded",
      "IndexRetryScheduled",
      "IndexFailed",
    ] as const,
    `${name}.kind`,
  );
  switch (kind) {
    case "UploadAccepted":
    case "UploadExecutionStarted":
    case "UploadRecoveryAccepted":
    case "UploadHistoryBaseline": {
      const facts = expectExactRecord(raw, ["kind", "generation"], name);
      return {
        kind,
        generation: expectNonnegativeInteger(
          facts.generation,
          `${name}.generation`,
        ),
      };
    }
    case "UploadFailed": {
      const facts = expectExactRecord(
        raw,
        ["kind", "generation", "transport"],
        name,
      );
      return {
        kind,
        generation: expectNonnegativeInteger(
          facts.generation,
          `${name}.generation`,
        ),
        transport: decodePresence(facts.transport, (value) =>
          decodeUploadTransportFailure(value, `${name}.transport.value`),
        ),
      };
    }
    case "UploadPublished": {
      const facts = expectExactRecord(
        raw,
        ["kind", "generation", "media_id", "source_attempt_id"],
        name,
      );
      return {
        kind,
        generation: expectNonnegativeInteger(
          facts.generation,
          `${name}.generation`,
        ),
        mediaId: expectCanonicalRfcUuid(facts.media_id, `${name}.media_id`),
        sourceAttemptId: expectCanonicalRfcUuid(
          facts.source_attempt_id,
          `${name}.source_attempt_id`,
        ),
      };
    }
    case "SourceAccepted": {
      const facts = expectExactRecord(
        raw,
        ["kind", "source_attempt_id", "attempt_no"],
        name,
      );
      return {
        kind,
        sourceAttemptId: expectCanonicalRfcUuid(
          facts.source_attempt_id,
          `${name}.source_attempt_id`,
        ),
        attemptNo: expectNonnegativeInteger(
          facts.attempt_no,
          `${name}.attempt_no`,
        ),
      };
    }
    case "SourceExecutionStarted":
    case "SourceStageChanged": {
      const facts = expectExactRecord(
        raw,
        ["kind", "source_attempt_id", "execution_id"],
        name,
      );
      return {
        kind,
        sourceAttemptId: expectCanonicalRfcUuid(
          facts.source_attempt_id,
          `${name}.source_attempt_id`,
        ),
        executionId: expectCanonicalRfcUuid(
          facts.execution_id,
          `${name}.execution_id`,
        ),
      };
    }
    case "SourceRetryScheduled": {
      const facts = expectExactRecord(
        raw,
        ["kind", "source_attempt_id", "execution_id", "next_attempt_at"],
        name,
      );
      return {
        kind,
        sourceAttemptId: expectCanonicalRfcUuid(
          facts.source_attempt_id,
          `${name}.source_attempt_id`,
        ),
        executionId: decodePresence(facts.execution_id, (value) =>
          expectCanonicalRfcUuid(value, `${name}.execution_id.value`),
        ),
        nextAttemptAt: expectIsoInstant(
          facts.next_attempt_at,
          `${name}.next_attempt_at`,
        ),
      };
    }
    case "SourceFailed": {
      const facts = expectExactRecord(
        raw,
        [
          "kind",
          "source_attempt_id",
          "execution_id",
          "origin",
          "terminal",
          "progress",
        ],
        name,
      );
      return {
        kind,
        sourceAttemptId: expectCanonicalRfcUuid(
          facts.source_attempt_id,
          `${name}.source_attempt_id`,
        ),
        executionId: decodePresence(facts.execution_id, (value) =>
          expectCanonicalRfcUuid(value, `${name}.execution_id.value`),
        ),
        origin: expectOneOf(facts.origin, FAILURE_ORIGINS, `${name}.origin`),
        terminal: expectBoolean(facts.terminal, `${name}.terminal`),
        progress: decodePresence(facts.progress, (value) => {
          const progress = expectExactRecord(
            value,
            ["completed", "total", "unit"],
            `${name}.progress.value`,
          );
          return {
            completed: expectNonnegativeInteger(
              progress.completed,
              `${name}.progress.value.completed`,
            ),
            total: decodePresence(progress.total, (total) =>
              expectNonnegativeInteger(
                total,
                `${name}.progress.value.total.value`,
              ),
            ),
            unit: decodePresence(progress.unit, (unit) =>
              expectNonemptyString(unit, `${name}.progress.value.unit.value`),
            ),
          };
        }),
      };
    }
    case "SourceRecoveryAccepted": {
      const facts = expectExactRecord(
        raw,
        ["kind", "source_attempt_id", "recovery"],
        name,
      );
      return {
        kind,
        sourceAttemptId: expectCanonicalRfcUuid(
          facts.source_attempt_id,
          `${name}.source_attempt_id`,
        ),
        recovery: acceptedSourceRecovery(
          facts.recovery,
          `${name}.recovery`,
        ),
      };
    }
    case "SourceSucceeded": {
      const facts = expectExactRecord(
        raw,
        ["kind", "source_attempt_id", "execution_id"],
        name,
      );
      return {
        kind,
        sourceAttemptId: expectCanonicalRfcUuid(
          facts.source_attempt_id,
          `${name}.source_attempt_id`,
        ),
        executionId: decodePresence(facts.execution_id, (value) =>
          expectCanonicalRfcUuid(value, `${name}.execution_id.value`),
        ),
      };
    }
    case "SourceSuperseded": {
      const facts = expectExactRecord(
        raw,
        ["kind", "source_attempt_id", "winner_media_id"],
        name,
      );
      return {
        kind,
        sourceAttemptId: expectCanonicalRfcUuid(
          facts.source_attempt_id,
          `${name}.source_attempt_id`,
        ),
        winnerMediaId: expectCanonicalRfcUuid(
          facts.winner_media_id,
          `${name}.winner_media_id`,
        ),
      };
    }
    case "SourceHistoryBaseline": {
      const facts = expectExactRecord(
        raw,
        ["kind", "source_attempt_id", "attempt_no", "outcome"],
        name,
      );
      return {
        kind,
        sourceAttemptId: expectCanonicalRfcUuid(
          facts.source_attempt_id,
          `${name}.source_attempt_id`,
        ),
        attemptNo: expectNonnegativeInteger(
          facts.attempt_no,
          `${name}.attempt_no`,
        ),
        outcome: baselineOutcome(facts.outcome, `${name}.outcome`),
      };
    }
    case "IndexAccepted":
    case "IndexRecoveryAccepted": {
      const facts = expectExactRecord(raw, ["kind", "revision", "job_id"], name);
      return {
        kind,
        revision: expectNonnegativeInteger(facts.revision, `${name}.revision`),
        jobId: expectCanonicalRfcUuid(facts.job_id, `${name}.job_id`),
      };
    }
    case "IndexExecutionStarted":
    case "IndexSucceeded":
    case "IndexSuperseded": {
      const facts = expectExactRecord(
        raw,
        ["kind", "revision", "job_id", "execution_id"],
        name,
      );
      return {
        kind,
        revision: expectNonnegativeInteger(facts.revision, `${name}.revision`),
        jobId: expectCanonicalRfcUuid(facts.job_id, `${name}.job_id`),
        executionId: expectCanonicalRfcUuid(
          facts.execution_id,
          `${name}.execution_id`,
        ),
      };
    }
    case "IndexRetryScheduled": {
      const facts = expectExactRecord(
        raw,
        ["kind", "revision", "job_id", "execution_id", "next_attempt_at"],
        name,
      );
      return {
        kind,
        revision: expectNonnegativeInteger(facts.revision, `${name}.revision`),
        jobId: expectCanonicalRfcUuid(facts.job_id, `${name}.job_id`),
        executionId: decodePresence(facts.execution_id, (value) =>
          expectCanonicalRfcUuid(value, `${name}.execution_id.value`),
        ),
        nextAttemptAt: expectIsoInstant(
          facts.next_attempt_at,
          `${name}.next_attempt_at`,
        ),
      };
    }
    case "IndexFailed": {
      const facts = expectExactRecord(
        raw,
        ["kind", "revision", "job_id", "execution_id", "origin", "terminal"],
        name,
      );
      return {
        kind,
        revision: expectNonnegativeInteger(facts.revision, `${name}.revision`),
        jobId: expectCanonicalRfcUuid(facts.job_id, `${name}.job_id`),
        executionId: decodePresence(facts.execution_id, (value) =>
          expectCanonicalRfcUuid(value, `${name}.execution_id.value`),
        ),
        origin: expectOneOf(
          facts.origin,
          ["Execution"] as const,
          `${name}.origin`,
        ),
        terminal: expectBoolean(facts.terminal, `${name}.terminal`),
      };
    }
  }
}

function historyEntry(raw: unknown, name: string): HistoryEntry {
  const entry = expectExactRecord(
    raw,
    ["id", "occurred_at", "stage", "failure_code", "facts"],
    name,
  );
  return {
    id: expectCanonicalRfcUuid(entry.id, `${name}.id`),
    occurredAt: expectIsoInstant(entry.occurred_at, `${name}.occurred_at`),
    stage: decodePresence(entry.stage, (value) =>
      expectOneOf(value, IMPORT_STAGES, `${name}.stage.value`),
    ),
    failureCode: decodePresence(entry.failure_code, (value) =>
      expectOneOf(value, SAFE_FAILURE_CODES, `${name}.failure_code.value`),
    ),
    facts: historyFacts(entry.facts, `${name}.facts`),
  };
}

function importItem(raw: unknown, name: string): ImportItem {
  const item = expectExactRecord(
    raw,
    [
      "ref",
      "title",
      "media_kind",
      "source_label",
      "media_ref",
      "state",
      "accepted_at",
      "updated_at",
      "matched_event",
      "capabilities",
    ],
    name,
  );
  return {
    ref: importRef(item.ref, `${name}.ref`),
    title: expectNonemptyString(item.title, `${name}.title`),
    mediaKind: expectOneOf(item.media_kind, MEDIA_KINDS, `${name}.media_kind`),
    sourceLabel: decodePresence(item.source_label, (value) =>
      expectNonemptyString(value, `${name}.source_label.value`),
    ),
    mediaRef: decodePresence(item.media_ref, (value) =>
      mediaResourceRef(value, `${name}.media_ref.value`),
    ),
    state: importState(item.state, `${name}.state`),
    acceptedAt: expectIsoInstant(item.accepted_at, `${name}.accepted_at`),
    updatedAt: expectIsoInstant(item.updated_at, `${name}.updated_at`),
    matchedEvent: decodePresence(item.matched_event, (value) =>
      historyEntry(value, `${name}.matched_event.value`),
    ),
    capabilities: importCapabilities(
      item.capabilities,
      `${name}.capabilities`,
    ),
  };
}

export function decodeImportPage(raw: unknown): ImportPage {
  const name = "GET /api/imports";
  const data = expectExactRecord(
    expectExactRecord(raw, ["data"], name).data,
    ["observed_at", "matched_count", "groups", "items", "next_cursor"],
    `${name}.data`,
  );
  const matchedCount = expectNonnegativeInteger(
    data.matched_count,
    `${name}.matched_count`,
  );
  const groups = expectArray(
    data.groups,
    (group, index) => {
      const value = expectExactRecord(
        group,
        ["stage", "count"],
        `${name}.groups[${index}]`,
      );
      return {
        stage: expectOneOf(
          value.stage,
          IMPORT_STAGES,
          `${name}.groups[${index}].stage`,
        ),
        count: expectNonnegativeInteger(
          value.count,
          `${name}.groups[${index}].count`,
        ),
      };
    },
    `${name}.groups`,
  );
  const items = expectArray(
    data.items,
    (item, index) => importItem(item, `${name}.items[${index}]`),
    `${name}.items`,
  );
  const nextCursor = decodePresence(data.next_cursor, (value) =>
    expectNonemptyString(value, `${name}.next_cursor.value`),
  );
  if (items.length > matchedCount) {
    throw new TypeError(`${name} returned more items than it matched`);
  }
  if (new Set(items.map((item) => item.ref)).size !== items.length) {
    throw new TypeError(`${name} returned the same import twice`);
  }
  if (groups.reduce((total, group) => total + group.count, 0) > matchedCount) {
    throw new TypeError(`${name} grouped more imports than it matched`);
  }
  if (nextCursor.kind === "Present" && items.length === 0) {
    throw new TypeError(`${name} continues a page that returned no items`);
  }
  return {
    observedAt: expectIsoInstant(data.observed_at, `${name}.observed_at`),
    matchedCount,
    groups,
    items,
    nextCursor,
  };
}

export function decodeImportSummary(raw: unknown): ImportSummary {
  const name = "GET /api/imports/summary";
  const data = expectExactRecord(
    expectExactRecord(raw, ["data"], name).data,
    ["observed_at", "needs_attention_count", "active_count"],
    `${name}.data`,
  );
  return {
    observedAt: expectIsoInstant(data.observed_at, `${name}.observed_at`),
    needsAttentionCount: expectNonnegativeInteger(
      data.needs_attention_count,
      `${name}.needs_attention_count`,
    ),
    activeCount: expectNonnegativeInteger(
      data.active_count,
      `${name}.active_count`,
    ),
  };
}

export function decodeImportDetail(raw: unknown): ImportDetail {
  const name = "GET /api/imports/:ref";
  const data = expectExactRecord(
    expectExactRecord(raw, ["data"], name).data,
    ["item", "readiness", "history_coverage"],
    `${name}.data`,
  );
  const readiness = expectExactRecord(
    data.readiness,
    ["can_read", "can_search", "can_play"],
    `${name}.readiness`,
  );
  return {
    item: importItem(data.item, `${name}.item`),
    readiness: {
      canRead: expectBoolean(readiness.can_read, `${name}.readiness.can_read`),
      canSearch: expectBoolean(
        readiness.can_search,
        `${name}.readiness.can_search`,
      ),
      canPlay: expectBoolean(readiness.can_play, `${name}.readiness.can_play`),
    },
    historyCoverage: historyCoverage(
      data.history_coverage,
      `${name}.history_coverage`,
    ),
  };
}

export function decodeImportHistoryPage(raw: unknown): HistoryPage {
  const name = "GET /api/imports/:ref/history";
  const data = expectExactRecord(
    expectExactRecord(raw, ["data"], name).data,
    ["entries", "next_cursor"],
    `${name}.data`,
  );
  return {
    entries: expectArray(
      data.entries,
      (entry, index) => historyEntry(entry, `${name}.entries[${index}]`),
      `${name}.entries`,
    ),
    nextCursor: decodePresence(data.next_cursor, (value) =>
      expectNonemptyString(value, `${name}.next_cursor.value`),
    ),
  };
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
  const body = await apiFetch<unknown>("/api/imports/summary", {
    cache: "no-store",
    signal,
  });
  return decodeApiPayload(
    body,
    decodeImportSummary,
    "GET /api/imports/summary",
  );
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
  const body = await apiFetch<unknown>(`/api/imports?${params}`, {
    cache: "no-store",
    signal,
  });
  return decodeApiPayload(body, decodeImportPage, "GET /api/imports");
}

export async function fetchImportDetail({
  ref,
  signal,
}: {
  readonly ref: ImportRef;
  readonly signal?: AbortSignal;
}): Promise<ImportDetail> {
  const body = await apiFetch<unknown>(
    `/api/imports/${encodeURIComponent(ref)}`,
    { cache: "no-store", signal },
  );
  return decodeApiPayload(body, decodeImportDetail, "GET /api/imports/:ref");
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
  const body = await apiFetch<unknown>(
    `/api/imports/${encodeURIComponent(ref)}/history${query}`,
    { cache: "no-store", signal },
  );
  return decodeApiPayload(
    body,
    decodeImportHistoryPage,
    "GET /api/imports/:ref/history",
  );
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
