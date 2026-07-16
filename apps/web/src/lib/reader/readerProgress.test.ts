import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import {
  canScheduleSave,
  initialReaderProgressState,
  parseReaderCursorSnapshot,
  pendingLocator,
  readerStateConflictCurrent,
  reduceReaderProgress,
  saveBaseRevision,
  type ReaderCursorPositioned,
  type ReaderProgressState,
} from "./readerProgress";
import type { ReaderResumeState } from "./types";

function webLocator(textOffset: number): ReaderResumeState {
  return {
    kind: "web",
    target: { fragment_id: "frag-1" },
    locations: {
      text_offset: textOffset,
      progression: null,
      total_progression: 0.5,
      position: 1,
    },
    text: { quote: null, quote_prefix: null, quote_suffix: null },
  };
}

function positioned(revision: number, locator: ReaderResumeState): ReaderCursorPositioned {
  return { state: "Positioned", revision, locator };
}

const A = webLocator(10);
const B = webLocator(20);
const C = webLocator(30);

function readyState(revision: number, locator: ReaderResumeState): ReaderProgressState {
  return reduceReaderProgress(initialReaderProgressState, {
    type: "load_succeeded",
    snapshot: positioned(revision, locator),
  });
}

describe("parseReaderCursorSnapshot", () => {
  it("decodes exact Empty and Positioned snapshots", () => {
    expect(parseReaderCursorSnapshot({ state: "Empty", revision: 0 })).toEqual({
      state: "Empty",
      revision: 0,
    });
    expect(parseReaderCursorSnapshot({ state: "Positioned", revision: 3, locator: A })).toEqual({
      state: "Positioned",
      revision: 3,
      locator: A,
    });
  });

  it("treats malformed same-system responses as contract errors, not Empty", () => {
    for (const value of [
      null,
      undefined,
      {},
      A,
      { state: "Empty", revision: 1 },
      { state: "Empty", revision: 0, locator: A },
      { state: "Positioned", revision: 0, locator: A },
      { state: "Positioned", revision: 1.5, locator: A },
      { state: "Positioned", revision: 2, locator: null },
      { state: "Positioned", revision: 2, locator: A, extra: true },
    ]) {
      expect(() => parseReaderCursorSnapshot(value)).toThrow();
    }
  });
});

describe("readerStateConflictCurrent", () => {
  it("returns the current snapshot from a reader-state 409", () => {
    const err = new ApiError(409, "E_READER_STATE_CONFLICT", "conflict", undefined, {
      current: { state: "Positioned", revision: 4, locator: A },
    });
    expect(readerStateConflictCurrent(err)).toEqual(positioned(4, A));
  });

  it("returns null for unrelated errors", () => {
    expect(readerStateConflictCurrent(new ApiError(409, "E_NOTE_CONFLICT", "x"))).toBeNull();
    expect(readerStateConflictCurrent(new ApiError(500, "E_INTERNAL", "x"))).toBeNull();
    expect(readerStateConflictCurrent(new Error("network"))).toBeNull();
  });

  it("throws when a conflict has no decodable current snapshot", () => {
    const err = new ApiError(409, "E_READER_STATE_CONFLICT", "conflict", undefined, {
      current: null,
    });
    expect(() => readerStateConflictCurrent(err)).toThrow();
  });
});

describe("reduceReaderProgress: authority", () => {
  it("cannot schedule saves while loading or after load failure", () => {
    expect(canScheduleSave(initialReaderProgressState)).toBe(false);
    const failed = reduceReaderProgress(initialReaderProgressState, { type: "load_failed" });
    expect(failed.authority).toEqual({ status: "load_failed" });
    const moved = reduceReaderProgress(failed, { type: "moved", locator: A });
    expect(canScheduleSave(moved)).toBe(false);
  });

  it("movement that raced the load survives it unless already canonical", () => {
    const loading = reduceReaderProgress(initialReaderProgressState, { type: "load_started" });
    const moved = reduceReaderProgress(loading, { type: "moved", locator: B });
    const loadedDifferent = reduceReaderProgress(moved, {
      type: "load_succeeded",
      snapshot: positioned(1, A),
    });
    expect(loadedDifferent.local).toEqual({ status: "dirty", locator: B });

    const loadedEqual = reduceReaderProgress(moved, {
      type: "load_succeeded",
      snapshot: positioned(1, B),
    });
    expect(loadedEqual.local).toEqual({ status: "clean" });
  });
});

describe("reduceReaderProgress: A/B/C write ordering", () => {
  it("serializes A/B/C as A then C, with C using A's acknowledged revision", () => {
    let state = readyState(1, A);
    state = reduceReaderProgress(state, { type: "moved", locator: A });
    state = reduceReaderProgress(state, { type: "save_started" });
    state = reduceReaderProgress(state, { type: "moved", locator: B });
    state = reduceReaderProgress(state, { type: "moved", locator: C });
    expect(state.local).toEqual({ status: "saving", sent: A, queued: C });

    state = reduceReaderProgress(state, { type: "save_succeeded", snapshot: positioned(2, A) });
    expect(state.local).toEqual({ status: "dirty", locator: C });
    expect(saveBaseRevision(state)).toBe(2);
    expect(canScheduleSave(state)).toBe(true);
  });

  it("on conflict with queued C: discards A, retains C locally, opens the handoff", () => {
    let state = readyState(1, A);
    state = reduceReaderProgress(state, { type: "moved", locator: B });
    state = reduceReaderProgress(state, { type: "save_started" });
    state = reduceReaderProgress(state, { type: "moved", locator: C });
    const current = positioned(5, webLocator(99));
    state = reduceReaderProgress(state, { type: "save_conflicted", current });

    expect(state.local).toEqual({ status: "dirty", locator: C });
    expect(state.remote).toEqual({ status: "candidate", snapshot: current });
    // No acknowledged base exists for C: auto-save is suspended by the handoff.
    expect(canScheduleSave(state)).toBe(false);
  });

  it("network ambiguity retains the latest locator", () => {
    let state = readyState(1, A);
    state = reduceReaderProgress(state, { type: "moved", locator: B });
    state = reduceReaderProgress(state, { type: "save_started" });
    state = reduceReaderProgress(state, { type: "moved", locator: C });
    state = reduceReaderProgress(state, { type: "save_failed" });
    expect(state.local).toEqual({ status: "save_failed", locator: C });
    expect(pendingLocator(state.local)).toEqual(C);
  });

  it("a successful save supersedes an open candidate", () => {
    let state = readyState(1, A);
    state = reduceReaderProgress(state, {
      type: "revalidated",
      snapshot: positioned(3, B),
    });
    expect(state.remote.status).toBe("candidate");
    state = reduceReaderProgress(state, { type: "moved", locator: C });
    state = reduceReaderProgress(state, { type: "save_started" });
    state = reduceReaderProgress(state, { type: "save_succeeded", snapshot: positioned(4, C) });
    expect(state.remote).toEqual({ status: "none" });
    expect(state.authority).toEqual({ status: "ready", snapshot: positioned(4, C) });
    expect(state.local).toEqual({ status: "clean" });
  });
});

describe("reduceReaderProgress: revalidation arbitration", () => {
  it("keeps a greater-revision snapshot as a candidate (adoption is the hook's call)", () => {
    const state = reduceReaderProgress(readyState(1, A), {
      type: "revalidated",
      snapshot: positioned(2, B),
    });
    expect(state.remote).toEqual({ status: "candidate", snapshot: positioned(2, B) });
    expect(state.authority).toEqual({ status: "ready", snapshot: positioned(1, A) });
  });

  it("reconciles an equal locator at a newer revision without a prompt", () => {
    const state = reduceReaderProgress(readyState(1, A), {
      type: "revalidated",
      snapshot: positioned(2, A),
    });
    expect(state.remote).toEqual({ status: "none" });
    expect(state.authority).toEqual({ status: "ready", snapshot: positioned(2, A) });
  });

  it("resolves an unsaved position that already committed elsewhere", () => {
    let state = readyState(1, A);
    state = reduceReaderProgress(state, { type: "moved", locator: B });
    state = reduceReaderProgress(state, { type: "save_started" });
    state = reduceReaderProgress(state, { type: "save_failed" });
    state = reduceReaderProgress(state, {
      type: "revalidated",
      snapshot: positioned(2, B),
    });
    expect(state.local).toEqual({ status: "clean" });
    expect(state.authority).toEqual({ status: "ready", snapshot: positioned(2, B) });
  });

  it("ignores stale lower-revision revalidations", () => {
    const state = reduceReaderProgress(readyState(3, A), {
      type: "revalidated",
      snapshot: positioned(2, B),
    });
    expect(state.authority).toEqual({ status: "ready", snapshot: positioned(3, A) });
    expect(state.remote).toEqual({ status: "none" });
  });

  it("accepting the candidate adopts it without a write", () => {
    let state = reduceReaderProgress(readyState(1, A), {
      type: "revalidated",
      snapshot: positioned(2, B),
    });
    state = reduceReaderProgress(state, { type: "remote_applied" });
    expect(state).toEqual({
      authority: { status: "ready", snapshot: positioned(2, B) },
      local: { status: "clean" },
      remote: { status: "none" },
    });
  });
});

describe("reduceReaderProgress: conflict against Empty", () => {
  it("adopts Empty authority defensively and retains the local position", () => {
    let state = readyState(2, A);
    state = reduceReaderProgress(state, { type: "moved", locator: B });
    state = reduceReaderProgress(state, { type: "save_started" });
    state = reduceReaderProgress(state, {
      type: "save_conflicted",
      current: { state: "Empty", revision: 0 },
    });
    expect(state.authority).toEqual({
      status: "ready",
      snapshot: { state: "Empty", revision: 0 },
    });
    expect(state.local).toEqual({ status: "dirty", locator: B });
    expect(saveBaseRevision(state)).toBe(0);
  });
});
