"use client";

import { installedApp, remoteReady } from "@/lib/native/admission";
import { useCallback, useEffect, useRef, useState } from "react";
import { isApiError, isSameSystemApiDefect, isStaleBuild, type ApiError, type ApiPath } from "@/lib/api/client";
import { readSharedValue, useServerArrival, type ArrivalClaim } from "@/lib/api/serverState";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { useSuggestionEntryRead } from "@/lib/panes/suggestionEntryReads";
import { openStream } from "@/lib/api/stream";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { assertNever } from "@/lib/assertNever";
import { isAbortError } from "@/lib/errors";
import {
  refreshSuggestions, viewSuggestions,
  type SuggestionItem, type SuggestionObservation, type SuggestionPublication,
  type Suggestions, type SuggestionsDestination, type SuggestionState,
} from "@/lib/suggestions";
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";

interface AdoptedPool {
  publication: SuggestionPublication;
  displayed: string[];
}

const VISIT = definePaneVisitDataKey<AdoptedPool>("Suggestions.Pool");
type ReadIntention = "Initial" | "Reconcile" | "Refresh";
type ReadOwner = "Inline" | "Pane";

interface SuggestionsView {
  state: SuggestionState | null;
  adopted: AdoptedPool | null;
  readFailure: { intention: ReadIntention; owner: ReadOwner; error: ApiError } | null;
  observationError: Error | null;
  observationInterrupted: boolean;
  admissionError: { error: ApiError } | null;
  initialCompleted: boolean;
  reconciling: boolean;
  admitting: boolean;
  withdrawn: boolean;
}

export type RefreshOutcome = "Refreshed" | "Finding" | "Repair" | "Failed" | "NotApplicable";

interface ActiveSuggestions {
  reconcile: () => Promise<void>;
  retry: () => Promise<RefreshOutcome>;
  refresh: (signal: AbortSignal) => Promise<RefreshOutcome>;
  retryAdmission: () => void;
}

/** Keep survivors in place, then fill vacancies from the already hydrated pool. */
function displayedRefs(items: SuggestionItem[], previous: string[]): string[] {
  const eligible = new Set(items.map((item) => item.target.ref));
  const next = previous.filter((ref) => eligible.has(ref));
  const used = new Set(next);
  for (const item of items) {
    if (next.length === 10) break;
    if (!used.has(item.target.ref)) {
      next.push(item.target.ref);
      used.add(item.target.ref);
    }
  }
  return next;
}

/** One logical visit retains one selection, including empty publications. Work
 * observation never replaces it. Explicit refresh owns one bounded GET; newer
 * observations can require eligibility reconciliation, never another latest GET.
 * A null refresh snapshot cannot undo a first publication installed meanwhile.
 * Inactivity retires requests, not the visit's pool or server-admitted work.
 */
export function useSuggestions(destination: SuggestionsDestination, isActive: boolean) {
  const libraryId = destination.kind === "Library" ? destination.id : null;
  const key = libraryId === null ? "/lectern/suggestions" : `/libraries/${libraryId}/suggestions`;
  const path: ApiPath = libraryId === null
    ? "/api/lectern/suggestions"
    : `/api/libraries/${encodeURIComponent(libraryId)}/suggestions`;
  const captured = useRef<AdoptedPool | null>(null);
  const restored = usePaneVisitData(VISIT, () => captured.current);
  const writeVisit = usePaneVisitDataWriter(VISIT);
  const { accountId } = useAuthenticatedAccount();
  const descriptor = useSuggestionEntryRead();
  // justify-defect: library and lectern entries own their published-selection GET.
  if (descriptor === null) throw new Error("suggestions without route entry");
  const ownedDescriptor = descriptor;
  const { peek: preparedOutcome, claim: claimArrival } = useServerArrival(ownedDescriptor);
  const seed = preparedOutcome?.status === "success" ? preparedOutcome.data : null;
  const prepared = useRef<ArrivalClaim<Suggestions> | null>(null);
  useEffect(() => {
    prepared.current = claimArrival();
    return () => { prepared.current?.release(); prepared.current = null; };
  // Claim only this body's first arrival, including strict effect replay.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const [view, setView] = useState<SuggestionsView>(() => ({
    state: seed?.state ?? null,
    adopted: seed?.state.capability === "NotApplicable" ? null : restored ?? (seed?.publication != null ? {
      publication: seed.publication,
      displayed: displayedRefs(seed.publication.items, []),
    } : null),
    readFailure: null, observationError: null, observationInterrupted: false,
    admissionError: null, initialCompleted: false,
    reconciling: false, admitting: false, withdrawn: seed?.state.capability === "NotApplicable",
  }));
  captured.current = view.adopted;
  const current = useRef(view);
  const commit = useCallback((change: (value: SuggestionsView) => SuggestionsView) => {
    current.current = change(current.current);
    setView(current.current);
  }, []);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [visible, setVisible] = useState(false);
  const runtime = useRef<ActiveSuggestions | null>(null);
  const accountRetired = useRef(false);
  const receiptSequence = useRef(0);
  const accepted = useRef(new Map<string, number>());
  const clock = useRef<{ serverTime: number; receivedAt: number } | null>(null);

  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    if (!isActive || !visible || current.current.withdrawn) return;
    const controller = new AbortController();
    let observationVersion = 0;
    let observationSession = 0;
    let stopObservation = () => {};
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reading: Promise<void> | null = null;
    let admitting: Promise<boolean> | null = null;
    let pendingInitial = false;
    let pendingView = false;
    let replacement: AbortController | null = null;
    let retrying = false;
    let attemptedAdvice: string | null = null;

    function unavailable() {
      return current.current.withdrawn || current.current.state?.capability === "NotApplicable";
    }

    function outcome(): RefreshOutcome {
      if (accountRetired.current) throw new DOMException("Suggestions account retired", "AbortError");
      if (unavailable()) return "NotApplicable";
      if (current.current.adopted !== null) return "Refreshed";
      return current.current.state?.work === "Suspended" ? "Repair" : "Finding";
    }

    function withdraw() {
      controller.abort();
      stopObservation();
      if (timer !== null) clearTimeout(timer);
      writeVisit(null);
      commit((value) => ({ ...value, adopted: null, readFailure: null, withdrawn: true, reconciling: false, admitting: false }));
    }

    function authorityLost(error: unknown) {
      if (handleUnauthenticatedApiError(error)) {
        accountRetired.current = true;
      } else if (!isApiError(error) || isSameSystemApiDefect(error) || (error.status !== 403 && error.status !== 404)) {
        return false;
      }
      withdraw();
      return true;
    }

    function failed(error: unknown, area: ReadIntention | "Observation" | "Admission", owner: ReadOwner = "Inline") {
      if (isAbortError(error) || controller.signal.aborted || authorityLost(error)) return;
      if (isStaleBuild(error) && !installedApp) return setDefect({ error });
      if (isApiError(error) && !isSameSystemApiDefect(error)) {
        commit((value) => area === "Admission"
          ? { ...value, admissionError: { error } }
          : area === "Observation" ? { ...value, observationError: error, observationInterrupted: true }
            : value.readFailure?.intention === "Refresh" && area !== "Refresh" ? value
              : { ...value, readFailure: { intention: area, owner, error } });
        return;
      }
      setDefect({ error });
    }

    function installState(state: SuggestionState, validatedPool: AdoptedPool | null = null, includedPublicationId: string | null = null) {
      observationVersion += 1;
      const inputsChanged = current.current.state?.input_revision !== state.input_revision;
      commit((value) => ({
        ...value, state,
        admissionError: state.work !== null ||
          (state.latest !== null && value.state?.latest != null && state.latest.id !== value.state.latest.id)
          ? null : value.admissionError,
      }));
      if (state.capability === "NotApplicable") return withdraw();
      armTimer();
      if (unavailable()) return;
      const selected = current.current.adopted;
      void queue({ initial: selected === null && state.latest !== null && state.latest.id !== includedPublicationId,
        view: inputsChanged && selected !== null && selected !== validatedPool });
    }

    function readState(response: Pick<Suggestions, "observed_at" | "state">, version: number, validatedPool: AdoptedPool | null, includedPublicationId: string | null = null) {
      const serverTime = Date.parse(response.observed_at);
      if (clock.current === null || serverTime >= clock.current.serverTime)
        clock.current = { serverTime, receivedAt: performance.now() };
      if (version === observationVersion || response.state.capability === "NotApplicable")
        installState(response.state, validatedPool, includedPublicationId);
      armTimer();
    }

    function eligibleReceiptItems(items: SuggestionItem[], beganAt: number) {
      return items.filter((item) => (accepted.current.get(item.target.ref) ?? 0) <= beganAt);
    }

    function clearReadFailure(value: SuggestionsView, intention: ReadIntention) {
      return intention === "Refresh" || value.readFailure?.intention === intention ? null : value.readFailure;
    }

    async function readLatest(intention: "Initial" | "Refresh", owner: ReadOwner, signal: AbortSignal, automatic: boolean): Promise<RefreshOutcome> {
      if (unavailable()) return outcome();
      const beganAt = receiptSequence.current;
      const version = observationVersion;
      const claimed = intention === "Initial" ? prepared.current : null;
      if (claimed !== null) prepared.current = null;
      const release = () => claimed?.release();
      signal.addEventListener("abort", release, { once: true });
      try {
        const response = claimed !== null ? await claimed.promise
          : await readSharedValue({ ...ownedDescriptor, key, accountId, signal, invalidate: intention === "Refresh" });
        if (unavailable()) return outcome();
        if (signal.aborted || controller.signal.aborted) throw new DOMException("Suggestions read retired", "AbortError");
        readState(response, version, current.current.adopted, response.publication?.id ?? null);
        if (unavailable()) return outcome();
        commit((value) => {
          if (intention === "Initial" && value.adopted !== null) return value;
          if (response.publication === null) return { ...value, readFailure: clearReadFailure(value, intention) };
          const publication = { ...response.publication, items: eligibleReceiptItems(response.publication.items, beganAt) };
          return { ...value, readFailure: clearReadFailure(value, intention),
            initialCompleted: value.initialCompleted || (automatic && replacement === null && !retrying && value.adopted === null),
            adopted: { publication, displayed: displayedRefs(publication.items, []) } };
        });
        if (current.current.adopted !== null && current.current.state !== null &&
            response.state.input_revision < current.current.state.input_revision) void queue({ view: true });
        return outcome();
      } catch (error) {
        if (unavailable()) return outcome();
        if (signal.aborted || controller.signal.aborted || isAbortError(error)) throw new DOMException("Suggestions read retired", "AbortError");
        if (authorityLost(error)) return outcome();
        if (intention === "Initial" && current.current.adopted !== null && claimed === null) return outcome();
        failed(error, claimed !== null && current.current.adopted !== null ? "Reconcile" : intention, owner);
        if (unavailable()) return outcome();
        if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
        return "Failed";
      } finally {
        signal.removeEventListener("abort", release);
        claimed?.release();
      }
    }

    async function reconcilePool(): Promise<RefreshOutcome> {
      const selected = current.current.adopted;
      if (unavailable()) return outcome();
      if (selected === null) return readLatest("Initial", "Inline", controller.signal, false);
      const beganAt = receiptSequence.current;
      const version = observationVersion;
      try {
        const response = await viewSuggestions(path, selected.publication.items.map((item) => item.target.ref), controller.signal);
        if (unavailable()) return outcome();
        if (controller.signal.aborted) throw new DOMException("Suggestions read retired", "AbortError");
        readState(response, version, selected);
        if (unavailable()) return outcome();
        if (current.current.adopted !== selected) return outcome();
        if (current.current.state !== null && response.state.input_revision < current.current.state.input_revision) {
          pendingView = true;
          return outcome();
        }
        const items = eligibleReceiptItems(response.items, beganAt);
        commit((value) => ({ ...value, readFailure: clearReadFailure(value, "Reconcile"), adopted: {
          publication: { ...selected.publication, items }, displayed: displayedRefs(items, selected.displayed),
        } }));
        return outcome();
      } catch (error) {
        if (unavailable()) return outcome();
        if (controller.signal.aborted || isAbortError(error)) throw new DOMException("Suggestions read retired", "AbortError");
        if (authorityLost(error)) return outcome();
        if (current.current.adopted !== selected) return outcome();
        failed(error, "Reconcile");
        if (unavailable()) return outcome();
        if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
        return "Failed";
      }
    }

    async function replacePool(signal: AbortSignal, owner: ReadOwner) {
      if (unavailable()) return outcome();
      replacement?.abort();
      const request = new AbortController();
      replacement = request;
      const cancel = () => request.abort();
      if (signal.aborted || controller.signal.aborted) cancel();
      else {
        signal.addEventListener("abort", cancel, { once: true });
        controller.signal.addEventListener("abort", cancel, { once: true });
      }
      try { return await readLatest("Refresh", owner, request.signal, false); }
      finally {
        if (replacement === request) replacement = null;
        signal.removeEventListener("abort", cancel);
        controller.signal.removeEventListener("abort", cancel);
      }
    }

    function queue(input: { initial?: boolean; view?: boolean }) {
      pendingInitial ||= input.initial === true && (prepared.current !== null || current.current.adopted === null && current.current.readFailure?.intention !== "Initial");
      pendingView ||= input.view === true && current.current.adopted !== null;
      if (reading !== null) return reading;
      if (controller.signal.aborted || unavailable() || (!pendingInitial && !pendingView)) return Promise.resolve();
      commit((value) => ({ ...value, reconciling: true }));
      reading = (async () => {
        try {
          while (!controller.signal.aborted && !unavailable() && (pendingInitial || pendingView)) {
            const initial = pendingInitial;
            const viewPool = pendingView;
            pendingInitial = false; pendingView = false;
            if (initial && (prepared.current !== null || current.current.adopted === null)) {
              const result = await readLatest("Initial", "Inline", controller.signal, true);
              if (result === "Failed") { pendingInitial = false; pendingView = false; break; }
            }
            if (viewPool && current.current.adopted !== null) await reconcilePool();
          }
        } catch (error) {
          // justify-ignore-error: inactive or retired requests cannot affect this visit.
          if (!isAbortError(error)) setDefect({ error });
          pendingInitial = false; pendingView = false;
        } finally {
          reading = null;
          if (!controller.signal.aborted) commit((value) => ({ ...value, reconciling: false }));
        }
      })();
      return reading;
    }

    function sendRefresh(): Promise<boolean> {
      if (admitting !== null) return admitting;
      commit((value) => ({ ...value, admitting: true }));
      const version = observationVersion;
      const latestAtAdmission = current.current.state?.latest;
      admitting = (async () => {
        try {
          const state = await refreshSuggestions(path, controller.signal);
          if (controller.signal.aborted || unavailable()) return false;
          if (version === observationVersion || state.capability === "NotApplicable") installState(state);
          commit((value) => ({ ...value, admissionError: null }));
          return true;
        } catch (error) {
          if (isAbortError(error)) throw error;
          if (controller.signal.aborted || unavailable()) return false;
          const state = current.current.state;
          const publicationChanged = state?.latest != null && (latestAtAdmission == null || state.latest.id !== latestAtAdmission.id);
          // Observation can confirm admission before its HTTP receipt is lost.
          if (isApiError(error) &&
              (error.code === "E_NETWORK" || error.code === "E_UPSTREAM" || error.code === "E_UPSTREAM_TIMEOUT") &&
              (state?.work != null || publicationChanged)) {
            commit((value) => ({ ...value, admissionError: null }));
            return true;
          }
          failed(error, "Admission");
          return false;
        } finally {
          admitting = null;
          if (!controller.signal.aborted) commit((value) => ({ ...value, admitting: false }));
          armTimer();
        }
      })();
      return admitting;
    }

    function automaticRefresh() {
      if (!remoteReady() || unavailable()) return;
      attemptedAdvice = adviceKey();
      void sendRefresh().catch((error: unknown) => {
        // justify-ignore-error: inactivity cancels this attempt, not admitted work.
        if (!isAbortError(error)) setDefect({ error });
      });
    }

    function adviceKey() {
      const state = current.current.state;
      return JSON.stringify([state?.input_revision, state?.latest, state?.automatic_refresh]);
    }

    function armTimer() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const state = current.current.state;
      if (!remoteReady() || controller.signal.aborted || unavailable() || admitting !== null || current.current.admissionError !== null || state === null || attemptedAdvice === adviceKey()) return;
      const advice = state.automatic_refresh;
      switch (advice.kind) {
        case "Stopped": return;
        case "Now": timer = setTimeout(automaticRefresh, 0); return;
        case "At": {
          const sample = clock.current;
          if (sample === null) return;
          const remaining = Date.parse(advice.at) - sample.serverTime - (performance.now() - sample.receivedAt);
          timer = setTimeout(automaticRefresh, Math.max(0, remaining));
          return;
        }
        default: assertNever(advice);
      }
    }

    function observe() {
      stopObservation();
      const session = ++observationSession;
      stopObservation = openStream<SuggestionObservation, SuggestionObservation>({
        path: libraryId === null ? "/api/stream/lectern/suggestions" : `/api/stream/libraries/${encodeURIComponent(libraryId)}/suggestions`,
        signal: controller.signal,
        decode: (type, data) => {
          if (type !== "state" && type !== "done") throw new Error(`Unknown SSE event type: ${type}`);
          // justify-defect: the snapshot tailer terminates only after withdrawal.
          if (type === "done" && data.kind !== "Withdrawn") throw new Error("Invalid SSE suggestions terminal state");
          return data;
        },
        isTerminal: (event) => event.kind === "Withdrawn",
        onEvent: (event) => {
          if (controller.signal.aborted || session !== observationSession) return;
          if (event.kind === "Withdrawn") return withdraw();
          installState(event.state);
          commit((value) => ({ ...value, observationError: null, observationInterrupted: false }));
        },
        onSuspended: error => { if (session === observationSession) failed(error, "Observation"); },
        onError: error => { if (session === observationSession) failed(error, "Observation"); },
        onReconnect: () => {
          if (controller.signal.aborted || session !== observationSession) return;
          const interrupted = current.current.observationInterrupted;
          commit((value) => ({ ...value, observationInterrupted: true }));
          if (!interrupted) void queue({ initial: current.current.adopted === null, view: current.current.adopted !== null });
        },
      });
    }

    runtime.current = {
      reconcile: () => queue({ view: true }),
      retry: async () => {
        retrying = true;
        try {
          if (current.current.observationInterrupted) observe();
          const intention = current.current.readFailure?.intention ?? (current.current.adopted === null ? "Initial" : "Reconcile");
          if (intention === "Refresh") return await replacePool(controller.signal, "Inline");
          if (intention === "Initial") return await readLatest(intention, "Inline", controller.signal, false);
          await queue({ view: true });
          if (controller.signal.aborted && !unavailable()) throw new DOMException("Suggestions read retired", "AbortError");
          return current.current.readFailure?.intention === "Reconcile" ? "Failed" : outcome();
        } finally { retrying = false; }
      },
      refresh: (signal) => replacePool(signal, "Pane"),
      retryAdmission: () => {
        if (current.current.admissionError === null || current.current.state?.work === "Suspended") return;
        void sendRefresh().catch((error: unknown) => {
          // justify-ignore-error: a retired pane no longer owns this attempt.
          if (!isAbortError(error)) setDefect({ error });
        });
      },
    };
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      if (current.current.observationInterrupted) observe();
      void queue({ initial: current.current.adopted === null, view: current.current.adopted !== null });
    };
    window.addEventListener("focus", wake);
    commit((value) => ({ ...value, admitting: false }));
    if (seed !== null && clock.current === null)
      clock.current = { serverTime: Date.parse(seed.observed_at), receivedAt: performance.now() };
    observe();
    armTimer();
    void queue({ initial: prepared.current !== null || current.current.adopted === null, view: current.current.adopted !== null });
    return () => {
      runtime.current = null;
      window.removeEventListener("focus", wake);
      controller.abort();
      stopObservation();
      if (timer !== null) clearTimeout(timer);
    };
  // The descriptor policy is fixed for this destination; the first claim alone adopts preparation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, libraryId, key, accountId, isActive, visible, commit, writeVisit]);

  const acknowledge = useCallback((ref: string) => {
    accepted.current.set(ref, ++receiptSequence.current);
    commit((value) => {
      const adopted = value.adopted;
      const items = adopted?.publication.items.filter((item) => item.target.ref !== ref) ?? [];
      return { ...value, adopted: adopted === null ? null : {
        publication: { ...adopted.publication, items }, displayed: displayedRefs(items, adopted.displayed),
      } };
    });
    void runtime.current?.reconcile();
  }, [commit]);
  const retry = useCallback(() => runtime.current?.retry() ?? Promise.reject<RefreshOutcome>(new DOMException("Suggestions owner inactive", "AbortError")), []);
  const refresh = useCallback((signal: AbortSignal) => {
    if (signal.aborted || accountRetired.current) return Promise.reject<RefreshOutcome>(new DOMException("Suggestions refresh cancelled", "AbortError"));
    if (current.current.withdrawn || current.current.state?.capability === "NotApplicable") return Promise.resolve<RefreshOutcome>("NotApplicable");
    return runtime.current?.refresh(signal) ?? Promise.reject<RefreshOutcome>(new DOMException("Suggestions owner inactive", "AbortError"));
  }, []);
  const retryAdmission = useCallback(() => runtime.current?.retryAdmission(), []);
  if (defect) throw defect.error;
  const byRef = new Map(view.adopted?.publication.items.map((item) => [item.target.ref, item]) ?? []);
  const rows = view.adopted?.displayed.flatMap((ref) => {
    const item = byRef.get(ref);
    return item ? [item] : [];
  }) ?? [];
  return { ...view, rows, active: isActive && visible, acknowledge, retry, refresh, retryAdmission };
}

export type SuggestionsController = ReturnType<typeof useSuggestions>;
