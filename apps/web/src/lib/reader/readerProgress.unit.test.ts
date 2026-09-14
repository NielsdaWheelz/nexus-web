import { expect, it } from "vitest";
import {
  canScheduleSave,
  initialReaderProgressState,
  pendingLocator,
  reduceReaderProgress,
  type ReaderCursorPositioned,
} from "./readerProgress";
import type { ReaderResumeState } from "./types";

const selected = { kind: "Publication", reader_generation: 2 } as const;
const page = (number: number): ReaderResumeState => ({
  kind: "pdf", page: number, page_progression: null, zoom: null, position: null,
});

it("an equal page from another publication cannot acknowledge local movement", () => {
  let state = reduceReaderProgress(initialReaderProgressState, { type: "reset", source: selected });
  state = reduceReaderProgress(state, { type: "load_succeeded", snapshot: { state: "Empty", revision: 0 } });
  state = reduceReaderProgress(state, { type: "moved", locator: page(4) });
  const otherPublication: ReaderCursorPositioned = {
    state: "Positioned", revision: 1, locator: page(4),
    source: { kind: "Publication", reader_generation: 1 },
  };
  state = reduceReaderProgress(state, { type: "revalidated", snapshot: otherPublication });
  expect(pendingLocator(state.local)).toEqual(page(4));
  expect(state.remote).toEqual({ status: "candidate", snapshot: otherPublication });
});

it("an earlier delivery cannot clear the newer position waiting at settlement", () => {
  let state = reduceReaderProgress(initialReaderProgressState, { type: "reset", source: selected });
  state = reduceReaderProgress(state, { type: "load_succeeded", snapshot: { state: "Empty", revision: 0 } });
  state = reduceReaderProgress(state, { type: "moved", locator: page(9) });
  state = reduceReaderProgress(state, { type: "save_started" });
  state = reduceReaderProgress(state, { type: "save_succeeded", snapshot: {
    state: "Positioned", revision: 1, source: selected, locator: page(8),
  } });
  expect(pendingLocator(state.local)).toEqual(page(9));
  expect(canScheduleSave(state)).toBe(true);
  state = reduceReaderProgress(state, { type: "save_started" });
  state = reduceReaderProgress(state, { type: "save_succeeded", snapshot: {
    state: "Positioned", revision: 2, source: selected, locator: page(9),
  } });
  expect(pendingLocator(state.local)).toBeNull();
});

it("a stale read cannot acknowledge later movement at the same coordinates", () => {
  let state = reduceReaderProgress(initialReaderProgressState, { type: "reset", source: selected });
  state = reduceReaderProgress(state, { type: "load_succeeded", snapshot: {
    state: "Positioned", revision: 4, source: selected, locator: page(8),
  } });
  state = reduceReaderProgress(state, { type: "moved", locator: page(3) });
  state = reduceReaderProgress(state, { type: "revalidated", snapshot: {
    state: "Positioned", revision: 2, source: selected, locator: page(3),
  } });
  expect(pendingLocator(state.local)).toEqual(page(3));
  expect(state.authority).toMatchObject({ snapshot: { revision: 4 } });
});

it("a delayed write acknowledgment preserves an already observed later cursor", () => {
  let state = reduceReaderProgress(initialReaderProgressState, { type: "reset", source: selected });
  state = reduceReaderProgress(state, { type: "load_succeeded", snapshot: { state: "Empty", revision: 0 } });
  state = reduceReaderProgress(state, { type: "moved", locator: page(3) });
  state = reduceReaderProgress(state, { type: "save_started" });
  const later: ReaderCursorPositioned = {
    state: "Positioned", revision: 2, source: selected, locator: page(8),
  };
  state = reduceReaderProgress(state, { type: "revalidated", snapshot: later });
  state = reduceReaderProgress(state, { type: "save_succeeded", snapshot: {
    state: "Positioned", revision: 1, source: selected, locator: page(3),
  } });
  expect(pendingLocator(state.local)).toBeNull();
  expect(state.remote).toEqual({ status: "candidate", snapshot: later });
});
