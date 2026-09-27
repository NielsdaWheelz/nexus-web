"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { absent, present, type Presence } from "@/lib/api/presence";
import { readerResumeStatesEqual, type ReaderResumeState } from "./types";

export type ReaderCheckpoint =
  | {
      kind: "Captured";
      sourceKey: string;
      locator: ReaderResumeState;
      placement:
        | { kind: "Text"; anchorToViewport: number; horizontal: number }
        | { kind: "Pdf"; pageDelta: number; zoom: number; horizontal: number };
      occurrence: Presence<string>;
      focus: Presence<string>;
    }
  | { kind: "Saved"; sourceKey: string; locator: ReaderResumeState };

export interface ReaderOccurrence {
  sourceKey: string;
  id: string;
}

export type NavigationOutcome =
  | { kind: "Arrived" }
  | { kind: "Unchanged" }
  | { kind: "Cancelled"; displaced: boolean }
  | {
      kind: "Unavailable";
      reason: "CaptureUnavailable" | "TargetUnavailable" | "SourceChanged" | "PositioningFailed";
      displaced: boolean;
    };

export interface ReaderNavigationError {
  action: "Inspect" | "Return" | "Adopt" | "Canonical";
  outcome: NavigationOutcome;
}

export type ReaderNavigationState =
  | { kind: "Reading"; error: ReaderNavigationError | null }
  | {
      kind: "Exploring";
      origin: Presence<ReaderCheckpoint>;
      busy: boolean;
      originUnavailable: boolean;
      error: ReaderNavigationError | null;
    };

export interface ReaderNavigationAdapter {
  /** Only a trusted, published reading viewport may enter the progress writer. */
  captureReading(): Extract<ReaderCheckpoint, { kind: "Captured" }> | null;
  /** Exact current viewport, including inspection destinations. */
  capture(): Extract<ReaderCheckpoint, { kind: "Captured" }> | null;
  position(checkpoint: ReaderCheckpoint, signal: AbortSignal): Promise<NavigationOutcome>;
}

export interface ReaderSeekOperation {
  settle(outcome: NavigationOutcome): Promise<NavigationOutcome>;
  cancel(displaced: boolean): Promise<NavigationOutcome>;
}

export interface ReaderNavigationPort {
  inspect(
    move: (signal: AbortSignal) => Promise<NavigationOutcome>,
    occurrence?: Presence<ReaderOccurrence>,
    targetedEntry?: boolean,
  ): Promise<NavigationOutcome>;
  beginSeek(): ReaderSeekOperation | null;
  noteGenuineInput(): void;
  returnToOrigin(): Promise<NavigationOutcome>;
  adoptHere(): NavigationOutcome;
  applyCanonical(checkpoint: ReaderCheckpoint | null, reason: "Remote" | "Reset"): Promise<NavigationOutcome>;
  isReadingEligible(): boolean;
  heldLocator(): ReaderResumeState | null;
}

export interface ReaderNavigation extends ReaderNavigationPort {
  state: ReaderNavigationState;
}

export function useReaderNavigation({
  adapter,
  savedOrigin,
  closeActivity,
  admit,
  admitAdoption,
}: {
  adapter: ReaderNavigationAdapter;
  savedOrigin: () => ReaderCheckpoint | null;
  closeActivity: () => void;
  admit: (locator: ReaderResumeState) => void;
  admitAdoption: (locator: ReaderResumeState) => void;
}): ReaderNavigation {
  const [, setState] = useState<ReaderNavigationState>({ kind: "Reading", error: null });
  const stateRef = useRef<ReaderNavigationState>({ kind: "Reading", error: null });
  const requestRef = useRef<{ id: number; controller: AbortController } | null>(null);
  const requestIdRef = useRef(0);
  const optionsRef = useRef({ adapter, savedOrigin, closeActivity, admit, admitAdoption });
  optionsRef.current = { adapter, savedOrigin, closeActivity, admit, admitAdoption };

  const publish = useCallback((next: ReaderNavigationState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const start = useCallback(() => {
    requestRef.current?.controller.abort();
    const request = { id: ++requestIdRef.current, controller: new AbortController() };
    requestRef.current = request;
    return request;
  }, []);

  const current = useCallback((id: number) => requestRef.current?.id === id, []);

  const finish = useCallback((id: number) => {
    if (current(id)) requestRef.current = null;
  }, [current]);

  const heldLocator = useCallback((): ReaderResumeState | null => {
    const mode = stateRef.current;
    return mode.kind === "Exploring" && mode.origin.kind === "Present"
      ? mode.origin.value.locator
      : null;
  }, []);

  const isReadingEligible = useCallback(() => stateRef.current.kind === "Reading" && requestRef.current === null, []);

  const movedFrom = useCallback((departure: ReaderCheckpoint | null): boolean => {
    if (departure === null) return true;
    let currentPosition: ReaderCheckpoint | null;
    try {
      currentPosition = optionsRef.current.adapter.capture();
    } catch (error) {
      console.error("Could not inspect reader position after navigation failure:", error);
      return true;
    }
    if (currentPosition === null || currentPosition.sourceKey !== departure.sourceKey ||
      !readerResumeStatesEqual(currentPosition.locator, departure.locator) ||
      departure.kind !== "Captured" || currentPosition.placement.kind !== departure.placement.kind) return true;
    if (currentPosition.placement.kind === "Text" && departure.placement.kind === "Text") {
      return currentPosition.placement.anchorToViewport !== departure.placement.anchorToViewport ||
        currentPosition.placement.horizontal !== departure.placement.horizontal;
    }
    if (currentPosition.placement.kind === "Pdf" && departure.placement.kind === "Pdf") {
      return currentPosition.placement.pageDelta !== departure.placement.pageDelta ||
        currentPosition.placement.zoom !== departure.placement.zoom ||
        currentPosition.placement.horizontal !== departure.placement.horizontal;
    }
    return true;
  }, []);

  const rollback = useCallback(async (departure: ReaderCheckpoint, signal: AbortSignal): Promise<boolean> => {
    try {
      const result = await optionsRef.current.adapter.position(departure, signal);
      return result.kind === "Arrived" || result.kind === "Unchanged";
    } catch (error) {
      console.error("Reader navigation rollback failed:", error);
      return false;
    }
  }, []);

  const returnToOrigin = useCallback(async (): Promise<NavigationOutcome> => {
    const mode = stateRef.current;
    if (mode.kind !== "Exploring" || mode.origin.kind === "Absent" || mode.originUnavailable) {
      return { kind: "Unavailable", reason: "TargetUnavailable", displaced: false };
    }
    const departure = optionsRef.current.adapter.capture();
    if (departure === null) {
      const failure: NavigationOutcome = { kind: "Unavailable", reason: "CaptureUnavailable", displaced: false };
      publish({ ...mode, error: { action: "Return", outcome: failure } });
      return failure;
    }
    const request = start();
    optionsRef.current.closeActivity();
    publish({ ...mode, busy: true, error: null });
    let result: NavigationOutcome;
    try {
      result = await optionsRef.current.adapter.position(mode.origin.value, request.controller.signal);
    } catch (error) {
      if (!current(request.id)) return { kind: "Cancelled", displaced: false };
      console.error("Reader return failed:", error);
      result = { kind: "Unavailable", reason: "PositioningFailed", displaced: movedFrom(departure) };
    }
    if (!current(request.id)) return { kind: "Cancelled", displaced: false };
    if (request.controller.signal.aborted && (result.kind === "Arrived" || result.kind === "Unchanged")) {
      result = { kind: "Cancelled", displaced: movedFrom(departure) };
    }
    if (result.kind === "Unavailable" && result.displaced && !request.controller.signal.aborted) {
      const restored = await rollback(departure, request.controller.signal);
      if (!current(request.id)) return { kind: "Cancelled", displaced: true };
      if (request.controller.signal.aborted) result = { kind: "Cancelled", displaced: movedFrom(departure) };
      else if (!restored) result = { kind: "Unavailable", reason: "PositioningFailed", displaced: true };
    }
    finish(request.id);
    if (result.kind === "Arrived" || result.kind === "Unchanged") {
      publish({ kind: "Reading", error: null });
      return result;
    }
    publish({
      ...mode,
      busy: false,
      originUnavailable: result.kind === "Unavailable" &&
        (result.reason === "SourceChanged" || result.reason === "TargetUnavailable"),
      error: { action: "Return", outcome: result },
    });
    return result;
  }, [current, finish, movedFrom, publish, rollback, start]);

  const inspect = useCallback(async (
    move: (signal: AbortSignal) => Promise<NavigationOutcome>,
    occurrence: Presence<ReaderOccurrence> = absent(),
    targetedEntry = false,
  ): Promise<NavigationOutcome> => {
    const prior = stateRef.current;
    if (
      prior.kind === "Exploring" && prior.origin.kind === "Present" &&
      prior.origin.value.kind === "Captured" &&
      occurrence.kind === "Present" &&
      prior.origin.value.occurrence.kind === "Present" &&
      occurrence.value.sourceKey === prior.origin.value.sourceKey &&
      occurrence.value.id === prior.origin.value.occurrence.value
    ) return returnToOrigin();

    const departure = optionsRef.current.adapter.capture();
    if (departure === null && !(targetedEntry && prior.kind === "Reading")) {
      const failure: NavigationOutcome = { kind: "Unavailable", reason: "CaptureUnavailable", displaced: false };
      publish({ ...prior, error: { action: "Inspect", outcome: failure } });
      return failure;
    }
    if (occurrence.kind === "Present" && departure !== null && occurrence.value.sourceKey !== departure.sourceKey) {
      const failure: NavigationOutcome = { kind: "Unavailable", reason: "SourceChanged", displaced: false };
      publish({ ...prior, error: { action: "Inspect", outcome: failure } });
      return failure;
    }
    if (prior.kind === "Reading" && !targetedEntry && departure !== null) {
      const eligible = optionsRef.current.adapter.captureReading();
      if (eligible !== null && eligible.sourceKey === departure.sourceKey &&
        readerResumeStatesEqual(eligible.locator, departure.locator)) optionsRef.current.admit(eligible.locator);
    }
    const saved = targetedEntry && prior.kind === "Reading" ? optionsRef.current.savedOrigin() : null;
    const origin = prior.kind === "Exploring"
      ? prior.origin
      : targetedEntry
        ? saved === null ? absent<ReaderCheckpoint>() : present(saved)
        : present<ReaderCheckpoint>({
            ...departure!,
            occurrence: occurrence.kind === "Present" ? present(occurrence.value.id) : absent(),
          });
    optionsRef.current.closeActivity();
    const request = start();
    publish({ kind: "Exploring", origin, busy: true, originUnavailable: prior.kind === "Exploring" && prior.originUnavailable, error: null });
    let result: NavigationOutcome;
    try {
      result = await move(request.controller.signal);
    } catch (error) {
      if (!current(request.id)) return { kind: "Cancelled", displaced: false };
      console.error("Reader navigation failed:", error);
      result = { kind: "Unavailable", reason: "PositioningFailed", displaced: movedFrom(departure) };
    }
    if (!current(request.id)) return { kind: "Cancelled", displaced: false };
    if (request.controller.signal.aborted && (result.kind === "Arrived" || result.kind === "Unchanged")) {
      result = { kind: "Cancelled", displaced: movedFrom(departure) };
    }
    let restored = false;
    if (result.kind === "Unavailable" && result.displaced && departure !== null && !request.controller.signal.aborted) {
      restored = await rollback(departure, request.controller.signal);
      if (!current(request.id)) return { kind: "Cancelled", displaced: true };
      if (request.controller.signal.aborted) {
        result = { kind: "Cancelled", displaced: movedFrom(departure) };
        restored = false;
      } else if (!restored) result = { kind: "Unavailable", reason: "PositioningFailed", displaced: true };
    }
    finish(request.id);
    if (restored || result.kind === "Unchanged" || ((result.kind === "Cancelled" || result.kind === "Unavailable") && !result.displaced)) {
      publish(result.kind === "Unavailable" ? { ...prior, error: { action: "Inspect", outcome: result } } : prior);
    } else {
      publish({
        kind: "Exploring",
        origin,
        busy: false,
        originUnavailable: (prior.kind === "Exploring" && prior.originUnavailable) ||
          (result.kind === "Unavailable" && result.reason === "SourceChanged"),
        error: result.kind === "Unavailable" ? { action: "Inspect", outcome: result } : null,
      });
    }
    return result;
  }, [current, finish, movedFrom, publish, returnToOrigin, rollback, start]);

  const beginSeek = useCallback((): ReaderSeekOperation | null => {
    const prior = stateRef.current;
    const departure = optionsRef.current.adapter.capture();
    if (departure === null) return null;
    if (prior.kind === "Reading") {
      const eligible = optionsRef.current.adapter.captureReading();
      if (eligible !== null && eligible.sourceKey === departure.sourceKey &&
        readerResumeStatesEqual(eligible.locator, departure.locator)) optionsRef.current.admit(eligible.locator);
    }
    const origin = prior.kind === "Exploring" ? prior.origin : present<ReaderCheckpoint>(departure);
    optionsRef.current.closeActivity();
    const request = start();
    publish({ kind: "Exploring", origin, busy: true, originUnavailable: prior.kind === "Exploring" && prior.originUnavailable, error: null });
    const settle = async (result: NavigationOutcome): Promise<NavigationOutcome> => {
      if (!current(request.id)) return { kind: "Cancelled", displaced: false };
      if (request.controller.signal.aborted && (result.kind === "Arrived" || result.kind === "Unchanged")) {
        result = { kind: "Cancelled", displaced: movedFrom(departure) };
      }
      let restored = false;
      if (result.kind === "Unavailable" && result.displaced && !request.controller.signal.aborted) {
        restored = await rollback(departure, request.controller.signal);
        if (!current(request.id)) return { kind: "Cancelled", displaced: true };
        if (request.controller.signal.aborted) {
          result = { kind: "Cancelled", displaced: movedFrom(departure) };
          restored = false;
        } else if (!restored) result = { kind: "Unavailable", reason: "PositioningFailed", displaced: true };
      }
      finish(request.id);
      if (restored || result.kind === "Unchanged" || ((result.kind === "Cancelled" || result.kind === "Unavailable") && !result.displaced)) publish(result.kind === "Unavailable" ? { ...prior, error: { action: "Inspect", outcome: result } } : prior);
      else publish({ kind: "Exploring", origin, busy: false, originUnavailable: (prior.kind === "Exploring" && prior.originUnavailable) || (result.kind === "Unavailable" && result.reason === "SourceChanged"), error: result.kind === "Unavailable" ? { action: "Inspect", outcome: result } : null });
      return result;
    };
    return { settle, cancel: (displaced) => settle({ kind: "Cancelled", displaced }) };
  }, [current, finish, movedFrom, publish, rollback, start]);

  const noteGenuineInput = useCallback(() => {
    requestRef.current?.controller.abort();
  }, []);

  const adoptHere = useCallback((): NavigationOutcome => {
    const mode = stateRef.current;
    if (mode.kind !== "Exploring" || mode.busy) return { kind: "Unavailable", reason: "PositioningFailed", displaced: false };
    const checkpoint = optionsRef.current.adapter.capture();
    if (checkpoint === null) {
      const failure: NavigationOutcome = { kind: "Unavailable", reason: "CaptureUnavailable", displaced: false };
      publish({ ...mode, error: { action: "Adopt", outcome: failure } });
      return failure;
    }
    optionsRef.current.closeActivity();
    optionsRef.current.admitAdoption(checkpoint.locator);
    publish({ kind: "Reading", error: null });
    return { kind: "Arrived" };
  }, [publish]);

  const applyCanonical = useCallback(async (checkpoint: ReaderCheckpoint | null, reason: "Remote" | "Reset"): Promise<NavigationOutcome> => {
    const prior = stateRef.current;
    if (reason === "Remote" && checkpoint === null) {
      const failure: NavigationOutcome = { kind: "Unavailable", reason: "TargetUnavailable", displaced: false };
      publish({ ...prior, error: { action: "Canonical", outcome: failure } });
      return failure;
    }
    const departure = optionsRef.current.adapter.capture();
    optionsRef.current.closeActivity();
    const request = start();
    if (reason === "Reset") publish(checkpoint === null
      ? { kind: "Reading", error: null }
      : { kind: "Exploring", origin: absent(), busy: true, originUnavailable: false, error: null });
    else if (prior.kind === "Exploring") publish({ ...prior, busy: true, error: null });
    if (checkpoint === null) {
      finish(request.id);
      return { kind: "Arrived" };
    }
    let result: NavigationOutcome;
    try {
      result = await optionsRef.current.adapter.position(checkpoint, request.controller.signal);
    } catch (error) {
      if (!current(request.id)) return { kind: "Cancelled", displaced: false };
      console.error("Canonical reader positioning failed:", error);
      result = { kind: "Unavailable", reason: "PositioningFailed", displaced: movedFrom(departure) };
    }
    if (request.controller.signal.aborted && (result.kind === "Arrived" || result.kind === "Unchanged")) {
      result = { kind: "Cancelled", displaced: movedFrom(departure) };
    }
    if (!current(request.id)) return { kind: "Cancelled", displaced: false };
    let restored = false;
    if (result.kind === "Unavailable" && result.displaced && departure !== null && !request.controller.signal.aborted) {
      restored = await rollback(departure, request.controller.signal);
      if (!current(request.id)) return { kind: "Cancelled", displaced: true };
      if (request.controller.signal.aborted) {
        result = { kind: "Cancelled", displaced: movedFrom(departure) };
        restored = false;
      } else if (!restored) result = { kind: "Unavailable", reason: "PositioningFailed", displaced: true };
    }
    finish(request.id);
    if (reason === "Remote") {
      if (result.kind === "Arrived" || result.kind === "Unchanged") publish({ kind: "Reading", error: null });
      else if (prior.kind === "Exploring") publish({ ...prior, busy: false, error: result.kind === "Unavailable" ? { action: "Canonical", outcome: result } : null });
      else if (result.displaced && !restored) publish({
        kind: "Exploring",
        origin: departure === null ? absent() : present(departure),
        busy: false,
        originUnavailable: false,
        error: result.kind === "Unavailable" ? { action: "Canonical", outcome: result } : null,
      });
      else if (result.kind === "Unavailable") publish({ ...prior, error: { action: "Canonical", outcome: result } });
    } else if (result.kind === "Arrived" || result.kind === "Unchanged") {
      publish({ kind: "Reading", error: null });
    } else if (prior.kind === "Reading" && (!result.displaced || restored)) {
      publish({ kind: "Reading", error: result.kind === "Unavailable" ? { action: "Canonical", outcome: result } : null });
    } else {
      publish({ kind: "Exploring", origin: absent(), busy: false, originUnavailable: false,
        error: result.kind === "Unavailable" ? { action: "Canonical", outcome: result } : null });
    }
    return result;
  }, [current, finish, movedFrom, publish, rollback, start]);

  return useMemo(() => ({
    get state() { return stateRef.current; },
    inspect,
    beginSeek,
    noteGenuineInput,
    returnToOrigin,
    adoptHere,
    applyCanonical,
    isReadingEligible,
    heldLocator,
  }), [inspect, beginSeek, noteGenuineInput, returnToOrigin, adoptHere, applyCanonical, isReadingEligible, heldLocator]);
}
