"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isApiError, isSameSystemApiDefect, isStaleBuild, type ApiError, type ApiPath } from "@/lib/api/client";
import { useServerSeed } from "@/lib/api/serverState";
import { openStream } from "@/lib/api/stream";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { assertNever } from "@/lib/assertNever";
import { isAbortError } from "@/lib/errors";
import {
  getSuggestions, refreshSuggestions, viewSuggestions,
  type SuggestionItem, type SuggestionObservation, type SuggestionPublication,
  type SuggestionRefresh, type Suggestions, type SuggestionsDestination, type SuggestionState,
} from "@/lib/suggestions";

interface AdoptedPool {
  publication: SuggestionPublication;
  displayed: string[];
}

interface ReadEvidence {
  includedPublicationId?: string;
  validatedPoolId?: string;
}

interface SuggestionsView {
  state: SuggestionState | null;
  adopted: AdoptedPool | null;
  staged: SuggestionPublication | null;
  readError: ApiError | null;
  observationError: Error | null;
  observationInterrupted: boolean;
  admissionError: { input: SuggestionRefresh; error: ApiError } | null;
  reconciling: boolean;
  admitting: boolean;
  withdrawn: boolean;
}

interface ActiveSuggestions {
  reconcile: () => Promise<void>;
  retry: () => Promise<void>;
  adopt: () => Promise<boolean>;
  refresh: (signal: AbortSignal) => Promise<boolean>;
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

function sameRefs(left: SuggestionItem[], right: SuggestionItem[]): boolean {
  return left.length === right.length && left.every((item, index) => item.target.ref === right[index].target.ref);
}

/** One pane visit owns its adopted order; the server owns eligibility and work.
 * PaneContent remounts on destination/visit changes. Inactivity retires only
 * observation and requests, preserving the visit's hydrated pool.
 */
export function useSuggestions(destination: SuggestionsDestination, isActive: boolean) {
  const libraryId = destination.kind === "Library" ? destination.id : null;
  const key = libraryId === null ? "/lectern/suggestions" : `/libraries/${libraryId}/suggestions`;
  const path: ApiPath = libraryId === null
    ? "/api/lectern/suggestions"
    : `/api/libraries/${encodeURIComponent(libraryId)}/suggestions`;
  const seed = useServerSeed<Suggestions>(key)?.data ?? null;
  const [view, setView] = useState<SuggestionsView>(() => ({
    state: seed?.state ?? null,
    adopted: seed?.publication != null ? {
      publication: seed.publication,
      displayed: displayedRefs(seed.publication.items, []),
    } : null,
    staged: null, readError: null, observationError: null,
    observationInterrupted: false, admissionError: null,
    reconciling: false, admitting: false, withdrawn: false,
  }));
  const current = useRef(view);
  const commit = useCallback((change: (value: SuggestionsView) => SuggestionsView) => {
    current.current = change(current.current);
    setView(current.current);
  }, []);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [visible, setVisible] = useState(false);
  const runtime = useRef<ActiveSuggestions | null>(null);
  const interaction = useRef(0);
  const receiptSequence = useRef(0);
  const accepted = useRef(new Map<string, number>());
  const clock = useRef<{ serverTime: number; receivedAt: number } | null>(null);
  const seedUsed = useRef(false);
  const wasActive = useRef(false);
  const revisit = useRef<number | null>(null);

  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    if (isActive && !wasActive.current) revisit.current = interaction.current;
    wasActive.current = isActive;
  }, [isActive]);

  useEffect(() => {
    if (!isActive || !visible) return;
    const controller = new AbortController();
    const autoAdoptAt = revisit.current;
    revisit.current = null;
    let observationVersion = 0;
    let observationSession = 0;
    let stopObservation = () => {};
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reading: Promise<void> | null = null;
    let admitting: Promise<boolean> | null = null;
    let pendingLatest = false;
    let pendingView = false;
    let pendingAdoption = false;
    let pendingExplicitAdoption = false;
    let pendingAutoAdopt: number | null = null;
    let clearAdmissionAfterRead = autoAdoptAt !== null;
    let attemptedAdvice: string | null = null;

    function withdraw() {
      controller.abort();
      stopObservation();
      if (timer !== null) clearTimeout(timer);
      commit((value) => ({ ...value, adopted: null, staged: null, withdrawn: true, reconciling: false, admitting: false }));
    }

    function failed(error: unknown, area: "Read" | "Observation", input?: SuggestionRefresh) {
      if (isAbortError(error) || controller.signal.aborted) return;
      if (handleUnauthenticatedApiError(error)) return withdraw();
      if (isApiError(error) && !isSameSystemApiDefect(error) && (error.status === 403 || error.status === 404)) return withdraw();
      if (isStaleBuild(error)) return setDefect({ error });
      if (isApiError(error) && !isSameSystemApiDefect(error)) {
        commit((value) => input
          ? { ...value, admissionError: { input, error } }
          : area === "Read" ? { ...value, readError: error }
            : { ...value, observationError: error, observationInterrupted: true });
        return;
      }
      setDefect({ error });
    }

    function installState(state: SuggestionState, evidence: ReadEvidence = {}) {
      observationVersion += 1;
      const inputsChanged = current.current.state?.input_revision !== state.input_revision;
      commit((value) => ({
        ...value, state,
        ...(state.capability === "NotApplicable" ? { adopted: null, staged: null } : {}),
        admissionError: state.work !== null ||
          (state.latest !== null && value.state?.latest != null &&
            state.latest.id !== value.state.latest.id)
          ? null : value.admissionError,
      }));
      armTimer();
      const value = current.current;
      const latest = state.latest !== null && state.latest.id !== evidence.includedPublicationId &&
        state.latest.id !== value.adopted?.publication.id && state.latest.id !== value.staged?.id;
      const viewPool = inputsChanged && value.adopted !== null && value.adopted.publication.id !== evidence.validatedPoolId;
      if (latest || viewPool) {
        // HTTP can reveal new inputs or a publication before its stream event.
        // Every observation owns discovery; hydration proves only its own pool.
        void queue({ latest, view: viewPool });
      }
    }

    function readState(response: Pick<Suggestions, "observed_at" | "state">, version: number, evidence: ReadEvidence = {}) {
      clock.current = { serverTime: Date.parse(response.observed_at), receivedAt: performance.now() };
      if (version === observationVersion) installState(response.state, evidence);
      if (clearAdmissionAfterRead) {
        clearAdmissionAfterRead = false;
        commit((value) => ({ ...value, admissionError: null }));
      }
      armTimer();
    }

    function eligibleReceiptItems(items: SuggestionItem[], beganAt: number) {
      return items.filter((item) => (accepted.current.get(item.target.ref) ?? 0) <= beganAt);
    }

    async function readLatest(autoAt: number | null) {
      const beganAt = receiptSequence.current;
      const version = observationVersion;
      const response = await getSuggestions(path, controller.signal);
      if (controller.signal.aborted) return;
      readState(response, version, response.publication !== null ? {
        includedPublicationId: response.publication.id,
        validatedPoolId: response.publication.id,
      } : {});
      const authoritative = current.current.state;
      if (authoritative && (response.state.input_revision < authoritative.input_revision ||
          (response.state.latest !== null && authoritative.latest !== null &&
            response.state.latest.id !== authoritative.latest.id))) {
        pendingLatest = true;
        if (autoAt !== null) pendingAutoAdopt = autoAt;
        return;
      }
      commit((value) => {
        if (response.publication === null) return { ...value, readError: null };
        const publication = { ...response.publication,
          items: eligibleReceiptItems(response.publication.items, beganAt) };
        const adopted = value.adopted;
        if (adopted === null || publication.id === adopted.publication.id || sameRefs(publication.items, adopted.publication.items)) {
          return { ...value, readError: null, staged: null,
            adopted: { publication, displayed: displayedRefs(publication.items, adopted?.displayed ?? []) } };
        }
        return { ...value, readError: null, staged: publication };
      });
      if (autoAt !== null && autoAt === interaction.current && current.current.staged !== null) {
        pendingAdoption = true;
        pendingAutoAdopt = autoAt;
      }
    }

    async function reconcilePool(adopting: boolean, autoAt: number | null) {
      const selected = adopting ? current.current.staged : current.current.adopted?.publication;
      if (!selected || (adopting && autoAt !== null && autoAt !== interaction.current)) return;
      const adoptedId = current.current.adopted?.publication.id ?? null;
      const beganAt = receiptSequence.current;
      const version = observationVersion;
      const response = await viewSuggestions(path, selected.items.map((item) => item.target.ref), controller.signal);
      if (controller.signal.aborted) return;
      readState(response, version, { validatedPoolId: selected.id });
      if (current.current.state && response.state.input_revision < current.current.state.input_revision) {
        if (adopting) {
          pendingAdoption = true;
          pendingAutoAdopt = autoAt;
        } else pendingView = true;
        return;
      }
      commit((value) => {
        if (value.adopted?.publication.id !== adoptedId) return value;
        const items = eligibleReceiptItems(response.items, beganAt);
        if (adopting) {
          if (value.staged?.id !== selected.id || (autoAt !== null && autoAt !== interaction.current)) return value;
          return { ...value, readError: null, staged: null,
            adopted: { publication: { ...selected, items }, displayed: displayedRefs(items, []) } };
        }
        if (value.adopted === null) return value;
        return { ...value, readError: null, adopted: {
          publication: { ...value.adopted.publication, items },
          displayed: displayedRefs(items, value.adopted.displayed),
        } };
      });
    }

    function queue(input: { latest?: boolean; view?: boolean; adopt?: boolean; autoAt?: number } = {}) {
      pendingLatest ||= input.latest === true;
      pendingView ||= input.view === true;
      pendingAdoption ||= input.adopt === true;
      pendingExplicitAdoption ||= input.adopt === true;
      if (input.autoAt !== undefined) pendingAutoAdopt = input.autoAt;
      if (reading !== null) return reading;
      if (controller.signal.aborted) return Promise.resolve();
      commit((value) => ({ ...value, reconciling: true }));
      reading = (async () => {
        try {
          while (!controller.signal.aborted && (pendingLatest || pendingView || pendingAdoption)) {
            const latest = pendingLatest;
            const viewPool = pendingView;
            const adopt = pendingAdoption;
            const explicitAdoption = pendingExplicitAdoption;
            const autoAt = pendingAutoAdopt;
            pendingLatest = false; pendingView = false; pendingAdoption = false; pendingExplicitAdoption = false; pendingAutoAdopt = null;
            if (latest) await readLatest(autoAt);
            if (viewPool) await reconcilePool(false, null);
            if (adopt) await reconcilePool(true, explicitAdoption ? null : autoAt);
          }
        } catch (error) {
          failed(error, "Read");
          pendingLatest = false; pendingView = false; pendingAdoption = false; pendingExplicitAdoption = false; pendingAutoAdopt = null;
        } finally {
          reading = null;
          if (!controller.signal.aborted) commit((value) => ({ ...value, reconciling: false }));
        }
      })();
      return reading;
    }

    function sendRefresh(input: SuggestionRefresh, signal: AbortSignal): Promise<boolean> {
      if (admitting !== null) return admitting;
      commit((value) => ({ ...value, admitting: true }));
      const version = observationVersion;
      const latestAtAdmission = current.current.state?.latest;
      admitting = (async () => {
        try {
          const state = await refreshSuggestions(path, input, AbortSignal.any([signal, controller.signal]));
          if (controller.signal.aborted) return false;
          if (version === observationVersion) installState(state);
          else void queue({ latest: true });
          commit((value) => ({ ...value, admissionError: null }));
          return true;
        } catch (error) {
          if (isAbortError(error)) throw error;
          if (controller.signal.aborted) return false;
          const state = current.current.state;
          const publicationChanged = state?.latest != null &&
            (latestAtAdmission == null || state.latest.id !== latestAtAdmission.id);
          // The observation can confirm admitted work before its HTTP receipt is
          // lost. Unrelated input changes do not establish that confirmation.
          if (isApiError(error) &&
              (error.code === "E_NETWORK" || error.code === "E_UPSTREAM" || error.code === "E_UPSTREAM_TIMEOUT") &&
              (state?.work != null || publicationChanged)) {
            commit((value) => ({ ...value, admissionError: null }));
            return true;
          }
          failed(error, "Read", input);
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
      attemptedAdvice = adviceKey();
      void sendRefresh({ kind: "EnsureFresh" }, controller.signal).catch((error: unknown) => {
        // justify-ignore-error: inactivity cancels this browser attempt, not admitted work.
        if (isAbortError(error)) return;
        setDefect({ error });
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
      if (controller.signal.aborted || admitting !== null || current.current.admissionError !== null || state === null || attemptedAdvice === adviceKey()) return;
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
        onError: (error) => {
          if (session === observationSession) failed(error, "Observation");
        },
        onReconnect: () => {
          if (controller.signal.aborted || session !== observationSession) return;
          const interrupted = current.current.observationInterrupted;
          commit((value) => ({ ...value, observationInterrupted: true }));
          if (!interrupted) void queue({ latest: true, view: true });
        },
      });
    }

    runtime.current = {
      reconcile: () => queue({ view: true }),
      retry: () => { observe(); return queue({ latest: true, view: true }); },
      adopt: async () => {
        const stagedId = current.current.staged?.id ?? null;
        if (stagedId === null) return false;
        await queue({ adopt: true });
        return current.current.adopted?.publication.id === stagedId;
      },
      refresh: async (signal) => {
        if (current.current.state === null) await queue({ latest: true });
        const state = current.current.state;
        if (state === null || controller.signal.aborted) return false;
        const requested = await sendRefresh({ kind: "Explicit", observed_publication_id:
          state.latest?.id ?? null }, signal);
        if (requested) void queue({ latest: true, view: true });
        return requested;
      },
      retryAdmission: () => {
        const failure = current.current.admissionError;
        if (failure === null) return;
        void sendRefresh(failure.input, controller.signal).then((requested) => {
          if (requested) void queue({ latest: true, view: true });
        }).catch((error: unknown) => {
          // justify-ignore-error: a retired pane no longer owns this attempt.
          if (isAbortError(error)) return;
          setDefect({ error });
        });
      },
    };
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      if (current.current.observationInterrupted) observe();
      void queue({ latest: true, view: true });
    };
    window.addEventListener("focus", wake);
    commit((value) => ({ ...value, withdrawn: false, admitting: false }));
    observe();
    if (seed !== null && !seedUsed.current) {
      seedUsed.current = true;
      clock.current = { serverTime: Date.parse(seed.observed_at), receivedAt: performance.now() };
      clearAdmissionAfterRead = false;
      armTimer();
    } else {
      void queue({ latest: true, view: current.current.adopted !== null,
        ...(autoAdoptAt === null ? {} : { autoAt: autoAdoptAt }) });
    }
    return () => {
      runtime.current = null;
      window.removeEventListener("focus", wake);
      controller.abort();
      stopObservation();
      if (timer !== null) clearTimeout(timer);
    };
  }, [path, libraryId, isActive, visible, seed, commit]);

  const acknowledge = useCallback((ref: string) => {
    accepted.current.set(ref, ++receiptSequence.current);
    commit((value) => {
      const adopted = value.adopted;
      const items = adopted?.publication.items.filter((item) => item.target.ref !== ref) ?? [];
      return { ...value,
        adopted: adopted === null ? null : { publication: { ...adopted.publication, items }, displayed: displayedRefs(items, adopted.displayed) },
        staged: value.staged === null ? null : { ...value.staged, items: value.staged.items.filter((item) => item.target.ref !== ref) },
      };
    });
    void runtime.current?.reconcile();
  }, [commit]);
  const reconcile = useCallback(() => { void runtime.current?.retry(); }, []);
  const adopt = useCallback(() => runtime.current?.adopt() ?? Promise.resolve(false), []);
  const refresh = useCallback((signal: AbortSignal) => runtime.current?.refresh(signal) ?? Promise.resolve(false), []);
  const retryAdmission = useCallback(() => runtime.current?.retryAdmission(), []);
  const interact = useCallback(() => { interaction.current += 1; }, []);
  if (defect) throw defect.error;
  const byRef = new Map(view.adopted?.publication.items.map((item) => [item.target.ref, item]) ?? []);
  const rows = view.adopted?.displayed.flatMap((ref) => {
    const item = byRef.get(ref);
    return item ? [item] : [];
  }) ?? [];
  return { ...view, rows, active: isActive && visible, acknowledge, reconcile, adopt, refresh, retryAdmission, interact };
}

export type SuggestionsController = ReturnType<typeof useSuggestions>;
