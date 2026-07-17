import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import {
  READER_PROFILE_ATTEMPT_TIMEOUT_MS,
  READER_PROFILE_IDLE_MS,
  READER_PROFILE_MAX_WAIT_MS,
  classifyReaderProfileSaveError,
  desiredReaderProfile,
  initialReaderProfileSyncState,
  parseReaderProfile,
  readerProfilePersistence,
  readerProfileWorkDueAt,
  reduceReaderProfileSync,
  sendableReaderProfilePatch,
  toReaderProfileSaveErrorMessage,
  type ReaderProfileSyncState,
} from "./readerProfileSync";
import type { ReaderProfile } from "./types";

const BASE: ReaderProfile = {
  theme: "light",
  font_family: "serif",
  font_size_px: 16,
  line_height: 1.5,
  column_width_ch: 65,
  focus_mode: "off",
  hyphenation: "auto",
};

const T0 = 1_000_000;

function clean(): ReaderProfileSyncState {
  return initialReaderProfileSyncState(BASE);
}

function saving(state: ReaderProfileSyncState, attemptId: number, now: number) {
  return reduceReaderProfileSync(state, { type: "save_started", attemptId, now });
}

describe("parseReaderProfile", () => {
  it("decodes the exact seven-field profile", () => {
    expect(parseReaderProfile({ ...BASE })).toEqual(BASE);
  });

  it("treats malformed same-system responses as contract errors, never defaults", () => {
    for (const value of [
      null,
      undefined,
      42,
      "profile",
      {},
      { ...BASE, extra: true },
      (() => {
        const { hyphenation: _hyphenation, ...missing } = BASE;
        return missing;
      })(),
      { ...BASE, theme: "sepia" },
      { ...BASE, font_family: "mono" },
      { ...BASE, focus_mode: "line" },
      { ...BASE, hyphenation: "on" },
      { ...BASE, font_size_px: "16" },
      { ...BASE, font_size_px: 16.5 },
      { ...BASE, font_size_px: 11 },
      { ...BASE, font_size_px: 29 },
      { ...BASE, line_height: "1.5" },
      { ...BASE, line_height: 1.1 },
      { ...BASE, line_height: 2.3 },
      { ...BASE, line_height: Number.NaN },
      { ...BASE, column_width_ch: 65.5 },
      { ...BASE, column_width_ch: 39 },
      { ...BASE, column_width_ch: 121 },
      { ...BASE, theme: null },
    ]) {
      expect(() => parseReaderProfile(value)).toThrow("Invalid reader profile");
    }
  });
});

describe("classifyReaderProfileSaveError", () => {
  it("maps exactly 403/E_FORBIDDEN to the terminal Forbidden failure", () => {
    const err = new ApiError(403, "E_FORBIDDEN", "no");
    expect(classifyReaderProfileSaveError(err)).toEqual({ kind: "Forbidden", error: err });
  });

  it("treats E_INTERNAL_ONLY and unknown 403 codes as defects", () => {
    for (const code of ["E_INTERNAL_ONLY", "E_SOMETHING_NEW"]) {
      const err = new ApiError(403, code, "no");
      expect(() => classifyReaderProfileSaveError(err)).toThrow(err);
    }
  });

  it("classifies 408, 429, and 5xx as retryable TransientApi", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      const err = new ApiError(status, "E_WHATEVER", "boom");
      expect(classifyReaderProfileSaveError(err)).toEqual({ kind: "TransientApi", error: err });
    }
  });

  it("treats other 4xx as defects", () => {
    for (const status of [400, 401, 404, 409, 422]) {
      const err = new ApiError(status, "E_WHATEVER", "no");
      expect(() => classifyReaderProfileSaveError(err)).toThrow(err);
    }
  });

  it("classifies transport throws as retryable and unknown throws as defects", () => {
    const network = new TypeError("fetch failed");
    expect(classifyReaderProfileSaveError(network)).toEqual({ kind: "Transport", error: network });
    const aborted = new DOMException("aborted", "AbortError");
    expect(classifyReaderProfileSaveError(aborted)).toEqual({ kind: "Transport", error: aborted });
    const unknown = new Error("?");
    expect(() => classifyReaderProfileSaveError(unknown)).toThrow(unknown);
  });
});

describe("toReaderProfileSaveErrorMessage", () => {
  it("maps every failure variant to copy and includes the request id when present", () => {
    const withId = new ApiError(500, "E_INTERNAL", "boom", "req-9");
    const transient = toReaderProfileSaveErrorMessage({ kind: "TransientApi", error: withId });
    expect(transient.title).toBe("Reader settings didn’t save");
    expect(transient.requestId).toBe("req-9");

    const withoutId = new ApiError(429, "E_RATE_LIMITED", "slow");
    expect(
      toReaderProfileSaveErrorMessage({ kind: "TransientApi", error: withoutId }).requestId,
    ).toBeUndefined();

    expect(
      toReaderProfileSaveErrorMessage({ kind: "Transport", error: new TypeError("x") }).message,
    ).toContain("network");
    expect(
      toReaderProfileSaveErrorMessage({ kind: "AttemptDeadlineExceeded" }).message,
    ).toContain("timed out");

    const forbidden = toReaderProfileSaveErrorMessage({
      kind: "Forbidden",
      error: new ApiError(403, "E_FORBIDDEN", "no", "req-1"),
    });
    expect(forbidden.title).toBe("Reader settings can’t be changed");
    expect(forbidden.requestId).toBe("req-1");
  });
});

describe("intent scheduling", () => {
  it("defers a discrete intent as Immediate work and updates desired", () => {
    const next = reduceReaderProfileSync(clean(), {
      type: "intent",
      patch: { theme: "dark" },
      now: T0,
    });
    expect(next.local).toEqual({
      status: "deferred",
      work: { patch: { theme: "dark" }, schedule: { kind: "Immediate" } },
    });
    expect(desiredReaderProfile(next).theme).toBe("dark");
    expect(next.acknowledged).toEqual(BASE);
    expect(readerProfilePersistence(next)).toEqual({ state: "Pending" });
  });

  it("defers a range intent on the idle/max-wait cadence", () => {
    const next = reduceReaderProfileSync(clean(), {
      type: "intent",
      patch: { font_size_px: 18 },
      now: T0,
    });
    expect(next.local).toEqual({
      status: "deferred",
      work: {
        patch: { font_size_px: 18 },
        schedule: {
          kind: "Range",
          idleAt: T0 + READER_PROFILE_IDLE_MS,
          deadlineAt: T0 + READER_PROFILE_MAX_WAIT_MS,
        },
      },
    });
    expect(readerProfileWorkDueAt(next.local.status === "deferred" ? next.local.work : null!)).toBe(
      T0 + READER_PROFILE_IDLE_MS,
    );
  });

  it("moves idleAt on further range input but preserves the batch deadline", () => {
    let state = reduceReaderProfileSync(clean(), {
      type: "intent",
      patch: { font_size_px: 18 },
      now: T0,
    });
    state = reduceReaderProfileSync(state, {
      type: "intent",
      patch: { font_size_px: 19 },
      now: T0 + 300,
    });
    expect(state.local).toEqual({
      status: "deferred",
      work: {
        patch: { font_size_px: 19 },
        schedule: {
          kind: "Range",
          idleAt: T0 + 300 + READER_PROFILE_IDLE_MS,
          deadlineAt: T0 + READER_PROFILE_MAX_WAIT_MS,
        },
      },
    });
  });

  it("upgrades merged work to Immediate on any discrete intent, newest value winning", () => {
    let state = reduceReaderProfileSync(clean(), {
      type: "intent",
      patch: { font_size_px: 18 },
      now: T0,
    });
    state = reduceReaderProfileSync(state, {
      type: "intent",
      patch: { theme: "dark" },
      now: T0 + 100,
    });
    expect(state.local).toEqual({
      status: "deferred",
      work: {
        patch: { font_size_px: 18, theme: "dark" },
        schedule: { kind: "Immediate" },
      },
    });
    // A later range input cannot downgrade an Immediate batch.
    state = reduceReaderProfileSync(state, {
      type: "intent",
      patch: { font_size_px: 20 },
      now: T0 + 200,
    });
    expect(state.local).toEqual({
      status: "deferred",
      work: {
        patch: { font_size_px: 20, theme: "dark" },
        schedule: { kind: "Immediate" },
      },
    });
  });

  it("ignores intent that would not change a desired pixel", () => {
    const state = clean();
    expect(reduceReaderProfileSync(state, { type: "intent", patch: { theme: "light" }, now: T0 })).toBe(
      state,
    );
    const deferred = reduceReaderProfileSync(state, {
      type: "intent",
      patch: { theme: "dark" },
      now: T0,
    });
    expect(
      reduceReaderProfileSync(deferred, { type: "intent", patch: { theme: "dark" }, now: T0 + 50 }),
    ).toBe(deferred);
  });

  it("keeps a value that reverts to acknowledged in the patch while work is pending", () => {
    let state = reduceReaderProfileSync(clean(), {
      type: "intent",
      patch: { theme: "dark" },
      now: T0,
    });
    state = reduceReaderProfileSync(state, { type: "intent", patch: { theme: "light" }, now: T0 + 10 });
    // The newest value is asserted for last-write-wins, not silently dropped.
    expect(state.local).toMatchObject({
      status: "deferred",
      work: { patch: { theme: "light" } },
    });
    expect(desiredReaderProfile(state).theme).toBe("light");
  });
});

describe("single-flight save lifecycle", () => {
  it("starts a save with the deferred patch and the 35 s watchdog deadline", () => {
    const deferred = reduceReaderProfileSync(clean(), {
      type: "intent",
      patch: { theme: "dark" },
      now: T0,
    });
    expect(sendableReaderProfilePatch(deferred.local)).toEqual({ theme: "dark" });
    const started = saving(deferred, 1, T0 + 5);
    expect(started.local).toEqual({
      status: "saving",
      attemptId: 1,
      sentPatch: { theme: "dark" },
      queued: null,
      startedAt: T0 + 5,
      expiresAt: T0 + 5 + READER_PROFILE_ATTEMPT_TIMEOUT_MS,
    });
    expect(sendableReaderProfilePatch(started.local)).toBeNull();
    expect(readerProfilePersistence(started)).toEqual({ state: "Pending" });
  });

  it("defects when a save starts without sendable work", () => {
    expect(() => saving(clean(), 1, T0)).toThrow("without sendable work");
    const inFlight = saving(
      reduceReaderProfileSync(clean(), { type: "intent", patch: { theme: "dark" }, now: T0 }),
      1,
      T0,
    );
    expect(() => saving(inFlight, 2, T0 + 1)).toThrow("without sendable work");
  });

  it("queues intent behind the in-flight PATCH with its own cadence", () => {
    let state = saving(
      reduceReaderProfileSync(clean(), { type: "intent", patch: { theme: "dark" }, now: T0 }),
      1,
      T0,
    );
    state = reduceReaderProfileSync(state, {
      type: "intent",
      patch: { font_size_px: 20 },
      now: T0 + 100,
    });
    expect(state.local).toMatchObject({
      status: "saving",
      sentPatch: { theme: "dark" },
      queued: {
        patch: { font_size_px: 20 },
        schedule: {
          kind: "Range",
          idleAt: T0 + 100 + READER_PROFILE_IDLE_MS,
          deadlineAt: T0 + 100 + READER_PROFILE_MAX_WAIT_MS,
        },
      },
    });
    // B renders continuously while A saves.
    expect(desiredReaderProfile(state)).toEqual({ ...BASE, theme: "dark", font_size_px: 20 });
    state = reduceReaderProfileSync(state, {
      type: "intent",
      patch: { hyphenation: "off" },
      now: T0 + 200,
    });
    expect(state.local).toMatchObject({
      queued: {
        patch: { font_size_px: 20, hyphenation: "off" },
        schedule: { kind: "Immediate" },
      },
    });
  });

  it("acknowledges a decoded success and converges to Clean without queued work", () => {
    const state = saving(
      reduceReaderProfileSync(clean(), { type: "intent", patch: { theme: "dark" }, now: T0 }),
      1,
      T0,
    );
    const acked = { ...BASE, theme: "dark" as const };
    const next = reduceReaderProfileSync(state, {
      type: "save_succeeded",
      attemptId: 1,
      profile: acked,
    });
    expect(next).toEqual({ acknowledged: acked, local: { status: "clean" } });
    expect(desiredReaderProfile(next)).toEqual(acked);
  });

  it("overlays queued work on the acknowledged response; an older response never reverts queued intent", () => {
    let state = saving(
      reduceReaderProfileSync(clean(), { type: "intent", patch: { theme: "dark" }, now: T0 }),
      1,
      T0,
    );
    state = reduceReaderProfileSync(state, { type: "intent", patch: { theme: "light" }, now: T0 + 50 });
    const next = reduceReaderProfileSync(state, {
      type: "save_succeeded",
      attemptId: 1,
      profile: { ...BASE, theme: "dark" },
    });
    expect(next.acknowledged.theme).toBe("dark");
    expect(next.local).toMatchObject({ status: "deferred", work: { patch: { theme: "light" } } });
    expect(desiredReaderProfile(next).theme).toBe("light");
  });

  it("preserves queued range clocks across the acknowledgement", () => {
    let state = saving(
      reduceReaderProfileSync(clean(), { type: "intent", patch: { theme: "dark" }, now: T0 }),
      1,
      T0,
    );
    state = reduceReaderProfileSync(state, {
      type: "intent",
      patch: { font_size_px: 20 },
      now: T0 + 100,
    });
    const next = reduceReaderProfileSync(state, {
      type: "save_succeeded",
      attemptId: 1,
      profile: { ...BASE, theme: "dark" },
    });
    expect(next.local).toEqual({
      status: "deferred",
      work: {
        patch: { font_size_px: 20 },
        schedule: {
          kind: "Range",
          idleAt: T0 + 100 + READER_PROFILE_IDLE_MS,
          deadlineAt: T0 + 100 + READER_PROFILE_MAX_WAIT_MS,
        },
      },
    });
  });

  it("ignores settlement for a stale attempt", () => {
    const state = saving(
      reduceReaderProfileSync(clean(), { type: "intent", patch: { theme: "dark" }, now: T0 }),
      2,
      T0,
    );
    expect(
      reduceReaderProfileSync(state, {
        type: "save_succeeded",
        attemptId: 1,
        profile: { ...BASE, theme: "dark" },
      }),
    ).toBe(state);
    expect(
      reduceReaderProfileSync(state, {
        type: "save_failed",
        attemptId: 1,
        failure: { kind: "AttemptDeadlineExceeded" },
      }),
    ).toBe(state);
  });
});

describe("failure, expiry, and retry", () => {
  const FAILURE = {
    kind: "TransientApi",
    error: new ApiError(500, "E_INTERNAL", "boom"),
  } as const;

  function failedState() {
    let state = saving(
      reduceReaderProfileSync(clean(), { type: "intent", patch: { theme: "dark" }, now: T0 }),
      1,
      T0,
    );
    state = reduceReaderProfileSync(state, {
      type: "intent",
      patch: { font_size_px: 20 },
      now: T0 + 100,
    });
    return reduceReaderProfileSync(state, { type: "save_failed", attemptId: 1, failure: FAILURE });
  }

  it("re-merges sent and queued work into one retryable failed patch, keeping desired pixels", () => {
    const state = failedState();
    expect(state.local).toEqual({
      status: "save_failed",
      patch: { theme: "dark", font_size_px: 20 },
      failure: FAILURE,
    });
    expect(desiredReaderProfile(state)).toEqual({ ...BASE, theme: "dark", font_size_px: 20 });
    expect(readerProfilePersistence(state)).toEqual({ state: "SaveFailed", failure: FAILURE });
    expect(sendableReaderProfilePatch(state.local)).toEqual({ theme: "dark", font_size_px: 20 });
  });

  it("converts watchdog expiry into the retryable AttemptDeadlineExceeded failure", () => {
    const inFlight = saving(
      reduceReaderProfileSync(clean(), { type: "intent", patch: { theme: "dark" }, now: T0 }),
      1,
      T0,
    );
    const expired = reduceReaderProfileSync(inFlight, {
      type: "save_failed",
      attemptId: 1,
      failure: { kind: "AttemptDeadlineExceeded" },
    });
    expect(expired.local).toMatchObject({
      status: "save_failed",
      failure: { kind: "AttemptDeadlineExceeded" },
    });
    // Late settlement of the expired attempt is ignored.
    expect(
      reduceReaderProfileSync(expired, {
        type: "save_succeeded",
        attemptId: 1,
        profile: { ...BASE, theme: "dark" },
      }),
    ).toBe(expired);
  });

  it("retries as one merged save from SaveFailed", () => {
    const retried = saving(failedState(), 2, T0 + 500);
    expect(retried.local).toMatchObject({
      status: "saving",
      attemptId: 2,
      sentPatch: { theme: "dark", font_size_px: 20 },
      queued: null,
    });
  });

  it("merges new intent into failed work, clears the failure, and follows the new field's cadence", () => {
    const state = reduceReaderProfileSync(failedState(), {
      type: "intent",
      patch: { line_height: 1.8 },
      now: T0 + 500,
    });
    expect(state.local).toEqual({
      status: "deferred",
      work: {
        patch: { theme: "dark", font_size_px: 20, line_height: 1.8 },
        schedule: {
          kind: "Range",
          idleAt: T0 + 500 + READER_PROFILE_IDLE_MS,
          deadlineAt: T0 + 500 + READER_PROFILE_MAX_WAIT_MS,
        },
      },
    });
    expect(readerProfilePersistence(state)).toEqual({ state: "Pending" });
  });

  it("terminal Forbidden restores desired to acknowledged, disables further intent, and discards queued work", () => {
    let state = saving(
      reduceReaderProfileSync(clean(), { type: "intent", patch: { theme: "dark" }, now: T0 }),
      1,
      T0,
    );
    state = reduceReaderProfileSync(state, {
      type: "intent",
      patch: { font_size_px: 20 },
      now: T0 + 10,
    });
    const forbidden = {
      kind: "Forbidden",
      error: new ApiError(403, "E_FORBIDDEN", "no"),
    } as const;
    state = reduceReaderProfileSync(state, { type: "save_failed", attemptId: 1, failure: forbidden });
    expect(state.local).toEqual({ status: "forbidden", failure: forbidden });
    expect(desiredReaderProfile(state)).toEqual(BASE);
    expect(readerProfilePersistence(state)).toEqual({ state: "Forbidden", failure: forbidden });
    expect(sendableReaderProfilePatch(state.local)).toBeNull();
    expect(
      reduceReaderProfileSync(state, { type: "intent", patch: { theme: "dark" }, now: T0 + 20 }),
    ).toBe(state);
  });
});

describe("revalidated", () => {
  it("adopts server truth only from Clean", () => {
    const remote = { ...BASE, theme: "dark" as const };
    expect(reduceReaderProfileSync(clean(), { type: "revalidated", profile: remote })).toEqual({
      acknowledged: remote,
      local: { status: "clean" },
    });
    const deferred = reduceReaderProfileSync(clean(), {
      type: "intent",
      patch: { font_size_px: 20 },
      now: T0,
    });
    expect(reduceReaderProfileSync(deferred, { type: "revalidated", profile: remote })).toBe(deferred);
    const inFlight = saving(
      reduceReaderProfileSync(clean(), { type: "intent", patch: { theme: "dark" }, now: T0 }),
      1,
      T0,
    );
    expect(reduceReaderProfileSync(inFlight, { type: "revalidated", profile: remote })).toBe(inFlight);
  });
});
