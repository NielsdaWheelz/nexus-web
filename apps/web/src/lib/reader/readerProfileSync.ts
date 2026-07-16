/**
 * Pure reader-profile decisions and wire decoding.
 *
 * Owns strict parsing of the seven-field profile contract, per-field patch
 * merging, save-failure classification, and the coordinator reducer over two
 * facts:
 *
 *   acknowledged: ReaderProfile (confirmed server truth)
 *   local:        Clean | Deferred(work) | Saving(attempt) | SaveFailed | Forbidden
 *
 * The desired (optimistic) profile is a projection of both, so an older
 * response can never revert queued intent. The impure coordinator
 * (`useReaderProfile`) owns timers, fetches, the attempt watchdog, lifecycle
 * flush, and revalidation generations; every decision lives here.
 */

import { isApiError, type ApiError } from "@/lib/api/client";
import { isRecord } from "@/lib/validation";
import {
  isReaderFocusMode,
  isReaderFontFamily,
  isReaderHyphenation,
  isReaderTheme,
  type ReaderProfile,
} from "./types";

export const READER_PROFILE_IDLE_MS = 400;
export const READER_PROFILE_MAX_WAIT_MS = 5_000;
/** The BFF's 30 s upstream deadline plus margin; see spec §7. */
export const READER_PROFILE_ATTEMPT_TIMEOUT_MS = 35_000;

export type ReaderProfilePatch = Partial<ReaderProfile>;
export type ReaderProfileField = keyof ReaderProfile;

/** Fields that send immediately when the writer is idle; the rest debounce. */
const DISCRETE_FIELDS: ReadonlySet<ReaderProfileField> = new Set([
  "theme",
  "font_family",
  "focus_mode",
  "hyphenation",
]);

const PROFILE_FIELDS = [
  "theme",
  "font_family",
  "font_size_px",
  "line_height",
  "column_width_ch",
  "focus_mode",
  "hyphenation",
] as const satisfies readonly ReaderProfileField[];

/**
 * Strictly decode a reader profile. A malformed same-system response is a
 * contract error, never a default.
 */
export function parseReaderProfile(value: unknown): ReaderProfile {
  if (!isRecord(value) || Object.keys(value).length !== PROFILE_FIELDS.length) {
    throw new Error("Invalid reader profile");
  }
  const {
    theme,
    font_family,
    font_size_px,
    line_height,
    column_width_ch,
    focus_mode,
    hyphenation,
  } = value;
  if (
    !isReaderTheme(theme) ||
    !isReaderFontFamily(font_family) ||
    !isReaderFocusMode(focus_mode) ||
    !isReaderHyphenation(hyphenation) ||
    typeof font_size_px !== "number" ||
    !Number.isInteger(font_size_px) ||
    font_size_px < 12 ||
    font_size_px > 28 ||
    typeof line_height !== "number" ||
    !Number.isFinite(line_height) ||
    line_height < 1.2 ||
    line_height > 2.2 ||
    typeof column_width_ch !== "number" ||
    !Number.isInteger(column_width_ch) ||
    column_width_ch < 40 ||
    column_width_ch > 120
  ) {
    throw new Error("Invalid reader profile");
  }
  return {
    theme,
    font_family,
    font_size_px,
    line_height,
    column_width_ch,
    focus_mode,
    hyphenation,
  };
}

export type ReaderProfileRetryableFailure =
  | { kind: "TransientApi"; error: ApiError } // 408, 429, or 5xx
  | { kind: "Transport"; error: TypeError | DOMException }
  | { kind: "AttemptDeadlineExceeded" };

export type ReaderProfileForbiddenFailure = { kind: "Forbidden"; error: ApiError };

export type ReaderProfileSaveFailure =
  | ReaderProfileRetryableFailure
  | ReaderProfileForbiddenFailure;

/**
 * Classify a PATCH settlement error. 401 must be routed to the auth boundary
 * before this is called. Anything unclassifiable (other 4xx, unknown 403
 * codes, unknown throws) is a defect and is rethrown; the attempt watchdog is
 * the liveness escape for a defective settlement.
 */
export function classifyReaderProfileSaveError(error: unknown): ReaderProfileSaveFailure {
  if (isApiError(error)) {
    if (error.status === 403) {
      if (error.code === "E_FORBIDDEN") {
        return { kind: "Forbidden", error };
      }
      // E_INTERNAL_ONLY and unknown 403 codes are contract defects.
      throw error;
    }
    if (error.status === 408 || error.status === 429 || error.status >= 500) {
      return { kind: "TransientApi", error };
    }
    throw error;
  }
  if (error instanceof TypeError || error instanceof DOMException) {
    return { kind: "Transport", error };
  }
  throw error;
}

/** Structurally matches the Feedback owner's content shape without importing it. */
export interface ReaderProfileSaveErrorMessage {
  title: string;
  message: string;
  requestId?: string;
}

/** The one exhaustive failure-to-copy mapper, applied at the UI boundary. */
export function toReaderProfileSaveErrorMessage(
  failure: ReaderProfileSaveFailure,
): ReaderProfileSaveErrorMessage {
  switch (failure.kind) {
    case "TransientApi":
      return {
        title: "Reader settings didn’t save",
        message: "The server had a temporary problem. Retry to save your reader settings.",
        requestId: failure.error.requestId,
      };
    case "Transport":
      return {
        title: "Reader settings didn’t save",
        message: "A network problem interrupted the save. Check your connection and retry.",
      };
    case "AttemptDeadlineExceeded":
      return {
        title: "Reader settings didn’t save",
        message: "The save timed out. Retry to save your reader settings.",
      };
    case "Forbidden":
      return {
        title: "Reader settings can’t be changed",
        message: "Your account isn’t allowed to update reader settings.",
        requestId: failure.error.requestId,
      };
  }
}

export type ReaderProfileSchedule =
  | { kind: "Immediate" }
  | { kind: "Range"; idleAt: number; deadlineAt: number };

export interface ReaderProfileWork {
  patch: ReaderProfilePatch;
  schedule: ReaderProfileSchedule;
}

export type ReaderProfileLocal =
  | { status: "clean" }
  | { status: "deferred"; work: ReaderProfileWork }
  | {
      status: "saving";
      attemptId: number;
      sentPatch: ReaderProfilePatch;
      queued: ReaderProfileWork | null;
      startedAt: number;
      expiresAt: number;
    }
  | { status: "save_failed"; patch: ReaderProfilePatch; failure: ReaderProfileRetryableFailure }
  | { status: "forbidden"; failure: ReaderProfileForbiddenFailure };

export interface ReaderProfileSyncState {
  acknowledged: ReaderProfile;
  local: ReaderProfileLocal;
}

export function initialReaderProfileSyncState(profile: ReaderProfile): ReaderProfileSyncState {
  return { acknowledged: profile, local: { status: "clean" } };
}

/** Desired drives pixels; it overlays every unacknowledged patch, newest last. */
export function desiredReaderProfile(state: ReaderProfileSyncState): ReaderProfile {
  switch (state.local.status) {
    case "clean":
    case "forbidden":
      return state.acknowledged;
    case "deferred":
      return { ...state.acknowledged, ...state.local.work.patch };
    case "saving":
      return {
        ...state.acknowledged,
        ...state.local.sentPatch,
        ...state.local.queued?.patch,
      };
    case "save_failed":
      return { ...state.acknowledged, ...state.local.patch };
  }
}

export type ReaderProfilePersistence =
  | { state: "Clean" }
  | { state: "Pending" }
  | { state: "SaveFailed"; failure: ReaderProfileRetryableFailure }
  | { state: "Forbidden"; failure: ReaderProfileForbiddenFailure };

const PERSISTENCE_CLEAN: ReaderProfilePersistence = { state: "Clean" };
const PERSISTENCE_PENDING: ReaderProfilePersistence = { state: "Pending" };

export function readerProfilePersistence(state: ReaderProfileSyncState): ReaderProfilePersistence {
  switch (state.local.status) {
    case "clean":
      return PERSISTENCE_CLEAN;
    case "deferred":
    case "saving":
      return PERSISTENCE_PENDING;
    case "save_failed":
      return { state: "SaveFailed", failure: state.local.failure };
    case "forbidden":
      return { state: "Forbidden", failure: state.local.failure };
  }
}

export function readerProfilesEqual(left: ReaderProfile, right: ReaderProfile): boolean {
  return PROFILE_FIELDS.every((field) => left[field] === right[field]);
}

/** The patch a started save would send, if a send is currently legal. */
export function sendableReaderProfilePatch(local: ReaderProfileLocal): ReaderProfilePatch | null {
  switch (local.status) {
    case "clean":
    case "saving":
    case "forbidden":
      return null;
    case "deferred":
      return local.work.patch;
    case "save_failed":
      return local.patch;
  }
}

/** Epoch instant at which deferred work is due; Immediate work is always due. */
export function readerProfileWorkDueAt(work: ReaderProfileWork): number {
  return work.schedule.kind === "Immediate"
    ? 0
    : Math.min(work.schedule.idleAt, work.schedule.deadlineAt);
}

function isDiscretePatch(patch: ReaderProfilePatch): boolean {
  return Object.keys(patch).some((field) => DISCRETE_FIELDS.has(field as ReaderProfileField));
}

/** Cadence for the first input of a new unflushed batch. */
function scheduleForNewBatch(patch: ReaderProfilePatch, now: number): ReaderProfileSchedule {
  return isDiscretePatch(patch)
    ? { kind: "Immediate" }
    : {
        kind: "Range",
        idleAt: now + READER_PROFILE_IDLE_MS,
        deadlineAt: now + READER_PROFILE_MAX_WAIT_MS,
      };
}

/**
 * Merge new intent into existing work: newest field value wins; a range input
 * moves `idleAt` but preserves the batch's first `deadlineAt`; any discrete
 * intent upgrades the merged work to Immediate.
 */
function mergeWork(
  existing: ReaderProfileWork,
  patch: ReaderProfilePatch,
  now: number,
): ReaderProfileWork {
  const merged = { ...existing.patch, ...patch };
  if (existing.schedule.kind === "Immediate" || isDiscretePatch(patch)) {
    return { patch: merged, schedule: { kind: "Immediate" } };
  }
  return {
    patch: merged,
    schedule: {
      kind: "Range",
      idleAt: now + READER_PROFILE_IDLE_MS,
      deadlineAt: existing.schedule.deadlineAt,
    },
  };
}

function patchChangesProfile(profile: ReaderProfile, patch: ReaderProfilePatch): boolean {
  return Object.entries(patch).some(
    ([field, value]) => profile[field as ReaderProfileField] !== value,
  );
}

export type ReaderProfileSyncEvent =
  | { type: "intent"; patch: ReaderProfilePatch; now: number }
  | { type: "save_started"; attemptId: number; now: number }
  | { type: "save_succeeded"; attemptId: number; profile: ReaderProfile }
  | { type: "save_failed"; attemptId: number; failure: ReaderProfileSaveFailure }
  | { type: "revalidated"; profile: ReaderProfile };

export function reduceReaderProfileSync(
  state: ReaderProfileSyncState,
  event: ReaderProfileSyncEvent,
): ReaderProfileSyncState {
  const { local } = state;
  switch (event.type) {
    case "intent": {
      // Intent that would not move a single desired pixel asserts nothing and
      // schedules nothing. Forbidden controls are disabled; a queued pointer
      // event racing that render is deliberately ignored, never promoted.
      if (local.status === "forbidden" || !patchChangesProfile(desiredReaderProfile(state), event.patch)) {
        return state;
      }
      switch (local.status) {
        case "clean":
          return {
            ...state,
            local: {
              status: "deferred",
              work: { patch: event.patch, schedule: scheduleForNewBatch(event.patch, event.now) },
            },
          };
        case "deferred":
          return {
            ...state,
            local: { status: "deferred", work: mergeWork(local.work, event.patch, event.now) },
          };
        case "saving":
          return {
            ...state,
            local: {
              ...local,
              queued: local.queued
                ? mergeWork(local.queued, event.patch, event.now)
                : {
                    patch: event.patch,
                    schedule: scheduleForNewBatch(event.patch, event.now),
                  },
            },
          };
        case "save_failed":
          // New intent clears stale feedback and follows its own cadence; the
          // failed patch rides along for one idempotent merged retry.
          return {
            ...state,
            local: {
              status: "deferred",
              work: {
                patch: { ...local.patch, ...event.patch },
                schedule: scheduleForNewBatch(event.patch, event.now),
              },
            },
          };
      }
    }

    case "save_started": {
      if (local.status !== "deferred" && local.status !== "save_failed") {
        throw new Error("Reader profile save started without sendable work");
      }
      return {
        ...state,
        local: {
          status: "saving",
          attemptId: event.attemptId,
          sentPatch: local.status === "deferred" ? local.work.patch : local.patch,
          queued: null,
          startedAt: event.now,
          expiresAt: event.now + READER_PROFILE_ATTEMPT_TIMEOUT_MS,
        },
      };
    }

    case "save_succeeded": {
      // Settlement for an expired or superseded attempt is ignored.
      if (local.status !== "saving" || local.attemptId !== event.attemptId) {
        return state;
      }
      return {
        acknowledged: event.profile,
        local: local.queued ? { status: "deferred", work: local.queued } : { status: "clean" },
      };
    }

    case "save_failed": {
      if (local.status !== "saving" || local.attemptId !== event.attemptId) {
        return state;
      }
      if (event.failure.kind === "Forbidden") {
        // Desired projects back to acknowledged: the optimistic pixels revert.
        return { ...state, local: { status: "forbidden", failure: event.failure } };
      }
      return {
        ...state,
        local: {
          status: "save_failed",
          patch: { ...local.sentPatch, ...local.queued?.patch },
          failure: event.failure,
        },
      };
    }

    case "revalidated": {
      // Clean-resume adoption only; any local intent outranks a background GET.
      if (local.status !== "clean") {
        return state;
      }
      return { acknowledged: event.profile, local: { status: "clean" } };
    }
  }
}
