"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { absent, present, type Presence } from "@/lib/api/presence";
import type { ReaderCursorSnapshot } from "./readerProgress";
import type { ReaderResumeState } from "./types";

export interface ReaderCapturedCheckpoint<Placement> {
  kind: "Captured";
  source: string;
  locator: ReaderResumeState;
  placement: Placement;
  occurrence: Presence<string>;
  focus: Presence<HTMLElement>;
}

export type ReaderCheckpoint<Placement> = ReaderCapturedCheckpoint<Placement> | {
  kind: "Saved";
  source: string;
  locator: ReaderResumeState;
};

export type ReaderNavigationMode<Placement> =
  | { kind: "Reading" }
  | { kind: "Exploring"; origin: Presence<ReaderCheckpoint<Placement>> };

export type ReaderNavigationFailure =
  | "CaptureUnavailable"
  | "TargetUnavailable"
  | "SourceChanged"
  | "PositioningFailed";

export type ReaderNavigationOutcome =
  | { kind: "Arrived" }
  | { kind: "Unchanged" }
  | { kind: "Cancelled"; displaced: boolean }
  | { kind: "Unavailable"; reason: ReaderNavigationFailure; displaced: boolean };

export type ReaderNavigationPosition<Target, Placement> =
  | { kind: "Target"; target: Target }
  | { kind: "Checkpoint"; checkpoint: ReaderCheckpoint<Placement> }
  | { kind: "Canonical"; snapshot: ReaderCursorSnapshot };

export interface ReaderNavigationState<Placement> {
  mode: ReaderNavigationMode<Placement>;
  positioning: boolean;
  originUnavailable: boolean;
  error: Presence<{
    action: "Inspect" | "Return" | "Adopt" | "Canonical";
    reason: ReaderNavigationFailure;
  }>;
}

/** Read synchronously at acquisition time; already queued writes remain eligible. */
export interface ReaderNavigationSeekOperation {
  settle(outcome: ReaderNavigationOutcome): Promise<ReaderNavigationOutcome>;
  cancel(displaced: boolean): Promise<ReaderNavigationOutcome>;
}

export interface ReaderNavigationEligibility {
  canAcquireProgress(): boolean;
  isPositioning(): boolean;
  heldReadingLocator(): ReaderResumeState | null;
  isExploringWithoutOrigin(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface ReaderNavigationAdapter<Target, Placement> {
  capture(): ReaderCapturedCheckpoint<Placement> | null;
  position(
    request: ReaderNavigationPosition<Target, Placement>,
    signal: AbortSignal,
  ): Promise<ReaderNavigationOutcome>;
}

interface UseReaderNavigationOptions<Target, Placement> {
  visitKey: string;
  /** Publication generation, PDF fingerprint, or offline package identity. */
  source: string | null;
  adapter: ReaderNavigationAdapter<Target, Placement>;
  captureEligibleLocator(): ReaderResumeState | null;
  /** Admission to the current ordered writer, without taking another capture. */
  admitProgress(locator: ReaderResumeState): void;
  /** Closes this pane's current activity interval with its old measurement. */
  closeActivity(): void;
}

interface NavigationRequest<Placement> {
  controller: AbortController;
  source: string;
  departure: ReaderCapturedCheckpoint<Placement> | null;
  previous: ReaderNavigationState<Placement>;
  exploring: Extract<ReaderNavigationMode<Placement>, { kind: "Exploring" }>;
  action: "Inspect" | "Return" | "Canonical";
  completesReading: boolean;
  entry: boolean;
}

const initialState = <Placement,>(): ReaderNavigationState<Placement> => ({
  mode: { kind: "Reading" },
  positioning: false,
  originUnavailable: false,
  error: absent(),
});

export function useReaderNavigation<Target, Placement>(
  options: UseReaderNavigationOptions<Target, Placement>,
) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [state, setState] = useState<ReaderNavigationState<Placement>>(initialState);
  const stateRef = useRef(state);
  const requestRef = useRef<NavigationRequest<Placement> | null>(null);
  const pendingResetRef = useRef<{
    snapshot: ReaderCursorSnapshot;
    resolve(outcome: ReaderNavigationOutcome): void;
    reject(error: unknown): void;
  } | null>(null);
  const visitRef = useRef(options.visitKey);
  const listenersRef = useRef(new Set<() => void>());

  const publish = useCallback((next: ReaderNavigationState<Placement>) => {
    stateRef.current = next;
    setState(next);
    for (const listener of listenersRef.current) listener();
  }, []);

  const eligibility = useMemo<ReaderNavigationEligibility>(() => ({
    canAcquireProgress: () =>
      visitRef.current === optionsRef.current.visitKey &&
      optionsRef.current.source !== null &&
      !stateRef.current.positioning && stateRef.current.mode.kind === "Reading",
    isPositioning: () => stateRef.current.positioning,
    heldReadingLocator: () => {
      const mode = stateRef.current.mode;
      return mode.kind === "Exploring" && mode.origin.kind === "Present" &&
        mode.origin.value.source === optionsRef.current.source
        ? mode.origin.value.locator
        : null;
    },
    isExploringWithoutOrigin: () => {
      const mode = stateRef.current.mode;
      return mode.kind === "Exploring" && mode.origin.kind === "Absent";
    },
    subscribe: (listener) => {
      listenersRef.current.add(listener);
      return () => { listenersRef.current.delete(listener); };
    },
  }), []);

  const failCapture = useCallback((action: NavigationRequest<Placement>["action"] | "Adopt") => {
    publish({ ...stateRef.current, error: present({ action, reason: "CaptureUnavailable" }) });
    return { kind: "Unavailable", reason: "CaptureUnavailable", displaced: false } as const;
  }, [publish]);

  const cancelPendingReset = useCallback(() => {
    const pending = pendingResetRef.current;
    if (pending === null) return false;
    pendingResetRef.current = null;
    pending.resolve({ kind: "Cancelled", displaced: false });
    return true;
  }, []);

  const begin = useCallback((
    action: NavigationRequest<Placement>["action"],
    completesReading: boolean,
    occurrence: Presence<string>,
    entryOrigin?: Presence<ReaderCheckpoint<Placement>>,
  ): NavigationRequest<Placement> | Extract<ReaderNavigationOutcome, { kind: "Unavailable" }> => {
    const current = optionsRef.current;
    const pending = requestRef.current;
    const superseding = pending !== null && pending.source === current.source;
    // A loading document can have no measurable viewport. Supersession keeps
    // that request's validated departure for rollback until a new viewport is
    // available; it never invents a checkpoint for the intermediate loading UI.
    const departure = current.adapter.capture() ?? (superseding ? pending.departure : null);
    const returningDuringMove = action === "Return" && stateRef.current.positioning;
    if (current.source === null || (entryOrigin === undefined && departure === null && !returningDuringMove && !superseding)) {
      return failCapture(action);
    }
    if (departure !== null && departure.source !== current.source) {
      publish({ ...stateRef.current, error: present({ action, reason: "SourceChanged" }) });
      return { kind: "Unavailable", reason: "SourceChanged", displaced: false };
    }
    const previous = stateRef.current;
    if (action === "Inspect" && previous.mode.kind === "Reading" && !previous.positioning && entryOrigin === undefined) {
      const eligible = current.captureEligibleLocator();
      if (eligible !== null) current.admitProgress(eligible);
    }
    const captured = departure === null ? null : {
      ...departure,
      occurrence: occurrence.kind === "Present" ? occurrence : departure.occurrence,
    };
    const exploring: NavigationRequest<Placement>["exploring"] = previous.mode.kind === "Exploring"
      ? previous.mode
      : { kind: "Exploring", origin: entryOrigin ?? (captured === null ? absent() : present(captured)) };
    current.closeActivity();
    cancelPendingReset();
    requestRef.current?.controller.abort();
    const request: NavigationRequest<Placement> = {
      controller: new AbortController(), source: current.source,
      departure, previous, exploring, action, completesReading,
      entry: action === "Inspect" && entryOrigin !== undefined,
    };
    requestRef.current = request;
    publish({ ...previous, mode: exploring, positioning: true, error: absent() });
    return request;
  }, [cancelPendingReset, failCapture, publish]);

  const settle = useCallback(async (
    request: NavigationRequest<Placement>,
    outcome: ReaderNavigationOutcome,
  ): Promise<ReaderNavigationOutcome> => {
    if (requestRef.current !== request) return { kind: "Cancelled", displaced: false };
    if (optionsRef.current.source !== request.source) {
      outcome = { kind: "Unavailable", reason: optionsRef.current.source === null ? "CaptureUnavailable" : "SourceChanged", displaced: true };
    }
    if (outcome.kind === "Arrived" || outcome.kind === "Unchanged") {
      requestRef.current = null;
      const next: ReaderNavigationState<Placement> = request.completesReading
        ? initialState<Placement>()
        : outcome.kind === "Unchanged" && !request.entry
          ? { ...request.previous, positioning: false }
          : { ...stateRef.current, positioning: false, error: absent() };
      publish(next);
      return outcome;
    }
    if (outcome.kind === "Cancelled") {
      requestRef.current = null;
      publish(outcome.displaced
        ? { ...stateRef.current, positioning: false }
        : { ...request.previous, positioning: false });
      return outcome;
    }
    let restored = !outcome.displaced;
    if (outcome.displaced && outcome.reason !== "SourceChanged" && request.departure !== null && !request.controller.signal.aborted) {
      const rollback = await optionsRef.current.adapter.position(
        { kind: "Checkpoint", checkpoint: request.departure }, request.controller.signal,
      );
      if (requestRef.current !== request) return { kind: "Cancelled", displaced: true };
      restored = rollback.kind === "Arrived" || rollback.kind === "Unchanged";
    }
    requestRef.current = null;
    const unavailableOrigin = outcome.reason === "SourceChanged" || (
      request.action === "Return" && outcome.reason === "TargetUnavailable"
    );
    publish({
      ...(restored ? request.previous : stateRef.current),
      positioning: false,
      originUnavailable: unavailableOrigin || stateRef.current.originUnavailable,
      error: present({ action: request.action, reason: outcome.reason }),
    });
    return outcome;
  }, [publish]);

  const position = useCallback(async (
    request: NavigationRequest<Placement>,
    target: ReaderNavigationPosition<Target, Placement>,
    signal?: AbortSignal,
  ): Promise<ReaderNavigationOutcome> => {
    const abort = () => request.controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const outcome = await optionsRef.current.adapter.position(target, request.controller.signal);
      return await settle(request, outcome);
    } catch (error) {
      // Adapters report expected cancellation/unavailability as outcomes. A
      // defect must still reach normal reporting while the viewport stays held.
      if (requestRef.current === request) {
        requestRef.current = null;
        publish({ ...stateRef.current, positioning: false, error: present({ action: request.action, reason: "PositioningFailed" }) });
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }, [publish, settle]);

  const inspect = useCallback((target: Target, occurrence: Presence<string> = absent(), signal?: AbortSignal): Promise<ReaderNavigationOutcome> => {
    if (signal?.aborted) return Promise.resolve({ kind: "Cancelled", displaced: false });
    const request = begin("Inspect", false, occurrence);
    return "kind" in request ? Promise.resolve(request) : position(request, { kind: "Target", target }, signal);
  }, [begin, position]);

  const inspectEntry = useCallback((target: Target, savedLocator: Presence<ReaderResumeState>, occurrence: Presence<string> = absent()): Promise<ReaderNavigationOutcome> => {
    const source = optionsRef.current.source;
    if (source === null) return Promise.resolve(failCapture("Inspect"));
    const origin: Presence<ReaderCheckpoint<Placement>> = savedLocator.kind === "Present"
      ? present({ kind: "Saved", source, locator: savedLocator.value }) : absent();
    const request = begin("Inspect", false, occurrence, origin);
    return "kind" in request ? Promise.resolve(request) : position(request, { kind: "Target", target });
  }, [begin, failCapture, position]);

  const beginSeek = useCallback((): ReaderNavigationSeekOperation | null => {
    const request = begin("Inspect", false, absent());
    if ("kind" in request) return null;
    return {
      settle: (outcome: ReaderNavigationOutcome) => settle(request, outcome),
      cancel: (displaced: boolean) => {
        request.controller.abort();
        return settle(request, { kind: "Cancelled", displaced });
      },
    };
  }, [begin, settle]);

  const returnToOrigin = useCallback((): Promise<ReaderNavigationOutcome> => {
    const current = stateRef.current;
    if (current.mode.kind !== "Exploring" || current.mode.origin.kind === "Absent") {
      return Promise.resolve({ kind: "Unchanged" });
    }
    const origin = current.mode.origin.value;
    if (optionsRef.current.source === null) return Promise.resolve(failCapture("Return"));
    if (origin.source !== optionsRef.current.source) {
      publish({ ...current, originUnavailable: true, error: present({ action: "Return", reason: "SourceChanged" }) });
      return Promise.resolve({ kind: "Unavailable", reason: "SourceChanged", displaced: false });
    }
    const request = begin("Return", true, absent());
    return "kind" in request ? Promise.resolve(request) : position(request, { kind: "Checkpoint", checkpoint: origin });
  }, [begin, failCapture, position, publish]);

  const adoptHere = useCallback((): ReaderNavigationOutcome => {
    const current = stateRef.current;
    if (current.positioning) return { kind: "Cancelled", displaced: false };
    if (current.mode.kind === "Reading") return { kind: "Unchanged" };
    const captured = optionsRef.current.adapter.capture();
    if (captured === null) return failCapture("Adopt");
    if (captured.source !== optionsRef.current.source) {
      publish({ ...current, error: present({ action: "Adopt", reason: "SourceChanged" }) });
      return { kind: "Unavailable", reason: "SourceChanged", displaced: false };
    }
    optionsRef.current.closeActivity();
    optionsRef.current.admitProgress(captured.locator);
    publish(initialState());
    return { kind: "Arrived" };
  }, [failCapture, publish]);

  const applyCanonical = useCallback((snapshot: ReaderCursorSnapshot, reason: "Remote" | "Reset"): Promise<ReaderNavigationOutcome> => {
    if (reason === "Reset") {
      optionsRef.current.closeActivity();
      cancelPendingReset();
      requestRef.current?.controller.abort();
      requestRef.current = null;
      // Reset authority cancels the old origin even when its new viewport is
      // unavailable. The subsequent canonical positioning remains fenced.
      publish({ ...initialState<Placement>(), mode: { kind: "Exploring", origin: absent() }, positioning: true });
      if (optionsRef.current.source === null) {
        return new Promise((resolve, reject) => {
          pendingResetRef.current = { snapshot, resolve, reject };
        });
      }
    }
    const request = begin("Canonical", true, absent(), reason === "Reset" ? absent() : undefined);
    return "kind" in request ? Promise.resolve(request) : position(request, { kind: "Canonical", snapshot });
  }, [begin, cancelPendingReset, position, publish]);

  const cancelPositioning = useCallback(() => {
    if (cancelPendingReset()) publish({ ...stateRef.current, positioning: false });
    requestRef.current?.controller.abort();
  }, [cancelPendingReset, publish]);

  useEffect(() => {
    const pending = pendingResetRef.current;
    if (options.source === null || pending === null) return;
    pendingResetRef.current = null;
    void applyCanonical(pending.snapshot, "Reset").then(pending.resolve, pending.reject);
  }, [applyCanonical, options.source]);

  useEffect(() => {
    const mode = stateRef.current.mode;
    if (options.source !== null && mode.kind === "Exploring" && mode.origin.kind === "Present" && mode.origin.value.source !== options.source) {
      requestRef.current?.controller.abort();
      requestRef.current = null;
      publish({ ...stateRef.current, positioning: false, originUnavailable: true, error: present({ action: "Return", reason: "SourceChanged" }) });
    }
  }, [options.source, publish]);

  useEffect(() => {
    visitRef.current = options.visitKey;
    publish(initialState());
    return () => {
      cancelPendingReset();
      requestRef.current?.controller.abort();
      requestRef.current = null;
    };
  }, [cancelPendingReset, options.visitKey, publish]);

  return { state, eligibility, inspect, inspectEntry, beginSeek, returnToOrigin, adoptHere, applyCanonical, cancelPositioning };
}
