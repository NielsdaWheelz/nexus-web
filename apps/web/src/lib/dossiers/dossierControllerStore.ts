"use client";

// The external, subscribable Dossier controller store (A14/A15). Created PER
// SUBJECT by the mounted primary pane (via `useResourceInspector`), NOT with
// `useMemo`, NEVER disposed during render, never module-global. It owns the A15
// `head` / `revision_selection` / `historical_revision` / `stream` unions, the
// head/revision fetches, and the build SSE connection. Stream tokens MUTATE the
// store (replacing its immutable snapshot) — they never republish the pane's
// Dossier body — so the primary pane does not re-render per token.
//
// `getSnapshot` returns the current immutable snapshot by reference; every
// mutation replaces the whole `DossierControllerState` object, so snapshot
// identity is a sound change signal for `useSyncExternalStore`.
import { useRef } from "react";
import { useSyncExternalStore } from "react";
import { isApiError } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import {
  cancelDossierBuild,
  createDossierBuild,
  fetchDossierHead,
  fetchDossierRevision,
  fetchDossierRevisions,
  makeDossierRevisionCurrent,
  openDossierBuildStream,
  type DossierSubjectDescriptor,
} from "@/lib/dossiers/generationAdapter";
import {
  decodeDossierStreamEvent,
  isTerminalDossierStreamEvent,
} from "@/lib/dossiers/eventDecoder";
import { toDossierErrorInfo } from "@/lib/dossiers/dossierErrorMessage";
import {
  initialDossierControllerState,
  type DossierBuildSummary,
  type DossierControllerState,
  type DossierHeadReady,
} from "@/lib/dossiers/dossierControllerTypes";
import type { DecodedDossierHead } from "@/lib/dossiers/dossierWire";

export interface DossierControllerStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): DossierControllerState;
  /** Mounted Dossier body signals liveness: load head + resume active stream. */
  attach(): void;
  /** Dossier body unmounted (tab switch / close): drop the CLIENT stream only —
   * the durable build continues; the snapshot is retained for remount. */
  detach(): void;
  refreshHead(): void;
  loadHistory(): void;
  generate(instruction: string | null): void;
  /** Regenerate preserves the current readable revision (A15); same path as
   * Generate with a fresh idempotency key. */
  regenerate(instruction: string | null): void;
  /** Retry a terminal (failed/cancelled) build as a brand-new build — never
   * reuses the terminal build (A15). */
  retry(): void;
  cancel(): void;
  makeCurrent(revisionRef: string): void;
  selectHistorical(revisionRef: string): void;
  selectCurrent(): void;
  setInstructionDraft(value: string): void;
  /** Reset revision selection to Current (owned by the Inspector hidden→visible
   * observer in `useResourceInspector`; NOT a body mount effect). */
  resetRevisionSelection(): void;
  dispose(): void;
}

function isTransientTransport(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (isApiError(error)) return error.status === 0 || error.status >= 500;
  // A raw TypeError from fetch (network down) has no status.
  return error instanceof TypeError;
}

function isGenerationInProgress(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.code === "E_DOSSIER_GENERATION_IN_PROGRESS"
  );
}

function isBuildNotActive(error: unknown): boolean {
  return isApiError(error) && error.code === "E_DOSSIER_BUILD_NOT_ACTIVE";
}

function readyFromDecodedHead(
  decoded: DecodedDossierHead,
  prior: DossierHeadReady | null,
): DossierHeadReady {
  // Preserve any already-loaded history across a background refresh; a changed
  // revision_count invalidates it (a new revision landed) so it reloads.
  const keepHistory =
    prior !== null &&
    prior.historyStatus === "ready" &&
    prior.revisionCount === decoded.revisionCount;
  return {
    ...decoded,
    history: keepHistory ? prior.history : [],
    historyStatus: keepHistory ? "ready" : "idle",
  };
}

export function createDossierControllerStore(
  subject: DossierSubjectDescriptor,
): DossierControllerStore {
  let state: DossierControllerState = initialDossierControllerState();
  const listeners = new Set<() => void>();

  let disposed = false;
  let attached = false;
  let headRequestId = 0;
  let historicalRequestId = 0;
  let historyRequestId = 0;
  let stopStream: (() => void) | null = null;
  let connectingHandle: string | null = null;

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function set(next: Partial<DossierControllerState>): void {
    if (disposed) return;
    state = { ...state, ...next };
    emit();
  }

  function setReady(mutate: (ready: DossierHeadReady) => DossierHeadReady): void {
    if (state.head.kind !== "Ready") return;
    set({ head: { kind: "Ready", ready: mutate(state.head.ready) } });
  }

  function activeBuild(): DossierBuildSummary | null {
    if (state.head.kind !== "Ready") return null;
    const ab = state.head.ready.activeBuild;
    return ab.kind === "Present" ? ab.value : null;
  }

  function currentArtifactRef(): string | null {
    if (state.head.kind !== "Ready") return null;
    const ref = state.head.ready.artifactRef;
    return ref.kind === "Present" ? ref.value : null;
  }

  // --- Head ----------------------------------------------------------------

  async function loadHead(force: boolean): Promise<void> {
    if (disposed) return;
    const hadReady = state.head.kind === "Ready";
    if (!force && (state.head.kind === "Loading" || hadReady)) return;
    const requestId = ++headRequestId;
    if (!hadReady) set({ head: { kind: "Loading" } });
    try {
      const decoded = await fetchDossierHead(subject);
      if (disposed || requestId !== headRequestId) return;
      const prior = state.head.kind === "Ready" ? state.head.ready : null;
      const nextReady = readyFromDecodedHead(decoded, prior);
      set({ head: { kind: "Ready", ready: nextReady } });
      syncStream();
      if (nextReady.revisionCount > 1 && nextReady.historyStatus === "idle") {
        void loadHistory();
      }
    } catch (error) {
      if (disposed || requestId !== headRequestId) return;
      // A background refresh over an existing Ready must not blank the reader.
      if (state.head.kind !== "Ready") {
        set({ head: { kind: "Failed", error: toDossierErrorInfo(error) } });
      }
    }
  }

  function refreshHead(): void {
    void loadHead(true);
  }

  async function loadHistory(): Promise<void> {
    const artifactRef = currentArtifactRef();
    if (artifactRef === null || state.head.kind !== "Ready") return;
    const requestId = ++historyRequestId;
    setReady((ready) => ({ ...ready, historyStatus: "loading" }));
    try {
      const summaries = await fetchDossierRevisions(artifactRef);
      if (disposed || requestId !== historyRequestId) return;
      setReady((ready) => ({ ...ready, history: summaries, historyStatus: "ready" }));
    } catch {
      if (disposed || requestId !== historyRequestId) return;
      setReady((ready) => ({ ...ready, historyStatus: "failed" }));
    }
  }

  // --- Stream --------------------------------------------------------------

  function teardownStream(): void {
    if (stopStream) {
      stopStream();
      stopStream = null;
    }
    connectingHandle = null;
  }

  function syncStream(): void {
    if (disposed || !attached) {
      teardownStream();
      return;
    }
    const build = activeBuild();
    if (!build) {
      // No active build: keep a Terminal marker (a build just ended) but drop
      // the client connection.
      teardownStream();
      if (state.stream !== "Terminal") set({ stream: "Disconnected" });
      return;
    }
    if (connectingHandle === build.handle) return; // already (re)connecting
    teardownStream();
    void connectStream(build.handle);
  }

  async function connectStream(handle: string): Promise<void> {
    connectingHandle = handle;
    set({ stream: "Connecting", streamingDraft: "", progressMessage: null });
    try {
      const stop = await openDossierBuildStream(handle, {
        decode: (type, data) => decodeDossierStreamEvent(type, data),
        isTerminal: isTerminalDossierStreamEvent,
        onEvent: (event) => {
          if (disposed || connectingHandle !== handle) return;
          handleStreamEvent(event);
        },
        onError: () => {
          if (disposed || connectingHandle !== handle) return;
          // A fatal stream error must not kill the controller: fall back to the
          // head snapshot and let a refetch recover.
          set({ stream: "Disconnected" });
          teardownStream();
          void loadHead(true);
        },
        onReconnect: async () => {
          if (!disposed && connectingHandle === handle) set({ stream: "Reconnecting" });
          return "continue";
        },
      });
      if (disposed || connectingHandle !== handle) {
        stop();
        return;
      }
      stopStream = stop;
    } catch {
      if (disposed || connectingHandle !== handle) return;
      set({ stream: "Disconnected" });
      connectingHandle = null;
    }
  }

  function handleStreamEvent(
    event: ReturnType<typeof decodeDossierStreamEvent>,
  ): void {
    switch (event.kind) {
      case "Started":
        if (state.stream === "Connecting" || state.stream === "Reconnecting") {
          set({ stream: "Live" });
        }
        return;
      case "Progress":
        set({ stream: "Live", progressMessage: event.message });
        return;
      case "Delta":
        set({
          stream: "Live",
          streamingDraft: (state.streamingDraft ?? "") + event.appendedText,
        });
        return;
      case "Advisory":
        if (event.phase === "Suspended") {
          set({ stream: "Suspended" });
        } else if (state.stream === "Connecting" || state.stream === "Reconnecting") {
          set({ stream: "Live" });
        }
        setReady((ready) =>
          ready.activeBuild.kind === "Present"
            ? {
                ...ready,
                activeBuild: {
                  kind: "Present",
                  value: {
                    ...ready.activeBuild.value,
                    execution: { kind: "Present", value: { phase: event.phase } },
                  },
                },
              }
            : ready,
        );
        return;
      case "Succeeded":
        // Keep the completion copy until the next build starts so the one
        // polite live region can announce success after the authoritative head
        // refresh replaces the active build with its new revision.
        set({
          stream: "Terminal",
          streamingDraft: null,
          progressMessage: "Dossier generated.",
        });
        teardownStream();
        void loadHead(true);
        return;
      case "Failed":
      case "Cancelled":
        // Terminal: the durable build is done. Refetch the head for the
        // authoritative outcome (new current revision, or preserved current +
        // latest_unsuccessful_build).
        set({ stream: "Terminal", streamingDraft: null, progressMessage: null });
        teardownStream();
        void loadHead(true);
        return;
    }
  }

  // --- Commands ------------------------------------------------------------

  async function runGenerate(instruction: string | null): Promise<void> {
    if (disposed) return;
    set({ pendingAction: "generate", actionError: null });
    // ONE fresh idempotency key per logical generation; the in-loop transport
    // retry below reuses THIS key (A15).
    const key = crypto.randomUUID();
    let lastError: unknown = null;
    // One in-place transport retry reuses the SAME idempotency key (A15).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await createDossierBuild({ subject, instruction, idempotencyKey: key });
        if (disposed) return;
        set({ pendingAction: null, instructionDraft: "" });
        await loadHead(true);
        syncStream();
        return;
      } catch (error) {
        lastError = error;
        if (!isTransientTransport(error)) break;
      }
    }
    if (disposed) return;
    if (isGenerationInProgress(lastError)) {
      // Our Generate lost the race to an already-active build: surface it and
      // reconcile to the live build.
      set({ pendingAction: null, actionError: toDossierErrorInfo(lastError) });
      await loadHead(true);
      syncStream();
      return;
    }
    set({ pendingAction: null, actionError: toDossierErrorInfo(lastError) });
  }

  async function runCancel(): Promise<void> {
    const build = activeBuild();
    if (!build || disposed) return;
    set({ pendingAction: "cancel", actionError: null });
    try {
      await cancelDossierBuild(build.handle);
    } catch (error) {
      // BuildNotActive (already terminal) is benign — the refetch reconciles.
      if (disposed) return;
      if (!isBuildNotActive(error)) {
        set({ pendingAction: null, actionError: toDossierErrorInfo(error) });
        return;
      }
    }
    if (disposed) return;
    set({ pendingAction: null });
    await loadHead(true);
    syncStream();
  }

  function lastInstruction(): string | null {
    if (state.head.kind !== "Ready") return null;
    const { activeBuild: ab, latestUnsuccessfulBuild: lub, currentRevision } =
      state.head.ready;
    const source =
      ab.kind === "Present"
        ? ab.value.instruction
        : lub.kind === "Present"
          ? lub.value.instruction
          : currentRevision.kind === "Present"
            ? currentRevision.value.instruction
            : null;
    return source && source.kind === "Present" ? source.value : null;
  }

  async function runMakeCurrent(revisionRef: string): Promise<void> {
    if (disposed) return;
    set({ pendingAction: "makeCurrent", actionError: null });
    try {
      await makeDossierRevisionCurrent(revisionRef);
    } catch (error) {
      if (disposed) return;
      set({ pendingAction: null, actionError: toDossierErrorInfo(error) });
      return;
    }
    if (disposed) return;
    // Make current clears the historical selection (A14).
    set({
      pendingAction: null,
      revisionSelection: { kind: "Current" },
      historicalRevision: { kind: "Idle" },
    });
    await loadHead(true);
    void loadHistory();
  }

  async function runSelectHistorical(revisionRef: string): Promise<void> {
    set({
      revisionSelection: { kind: "Historical", revisionRef },
      historicalRevision: { kind: "Loading" },
    });
    const requestId = ++historicalRequestId;
    try {
      const revision = await fetchDossierRevision(revisionRef);
      if (disposed || requestId !== historicalRequestId) return;
      set({ historicalRevision: { kind: "Ready", revision } });
    } catch (error) {
      if (disposed || requestId !== historicalRequestId) return;
      set({ historicalRevision: { kind: "Failed", error: toDossierErrorInfo(error) } });
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return state;
    },
    attach() {
      attached = true;
      // Remount refetches the head (A14) — force, but `loadHead` keeps an
      // existing Ready visible during the background refresh (no blank frame) —
      // then resumes the active build stream.
      void loadHead(true);
      syncStream();
    },
    detach() {
      attached = false;
      teardownStream();
      // Completion is announced once in the mounted Dossier surface. Closing
      // the tab is the consumption boundary; do not reannounce stale success
      // when this workspace-local controller is mounted again.
      if (state.stream === "Terminal") {
        set({ stream: "Disconnected", progressMessage: null });
      }
    },
    refreshHead,
    loadHistory() {
      void loadHistory();
    },
    generate(instruction) {
      void runGenerate(instruction);
    },
    regenerate(instruction) {
      void runGenerate(instruction);
    },
    retry() {
      void runGenerate(lastInstruction());
    },
    cancel() {
      void runCancel();
    },
    makeCurrent(revisionRef) {
      void runMakeCurrent(revisionRef);
    },
    selectHistorical(revisionRef) {
      void runSelectHistorical(revisionRef);
    },
    selectCurrent() {
      set({ revisionSelection: { kind: "Current" }, historicalRevision: { kind: "Idle" } });
    },
    setInstructionDraft(value) {
      set({ instructionDraft: value });
    },
    resetRevisionSelection() {
      if (state.revisionSelection.kind === "Current") return;
      set({ revisionSelection: { kind: "Current" }, historicalRevision: { kind: "Idle" } });
    },
    dispose() {
      disposed = true;
      teardownStream();
      listeners.clear();
    },
  };
}

/**
 * Fine-grained subscription to the controller store. Recomputes the selection
 * only when the snapshot identity changes, and holds the prior reference when
 * `isEqual` says the selection is unchanged — so a per-token snapshot swap that
 * doesn't touch the selected slice does not re-render the subscriber.
 */
export function useDossierSelector<T>(
  store: DossierControllerStore,
  selector: (state: DossierControllerState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const cacheRef = useRef<{ snapshot: DossierControllerState; value: T } | null>(
    null,
  );
  const getSelection = (): T => {
    const snapshot = store.getSnapshot();
    const cache = cacheRef.current;
    if (cache && cache.snapshot === snapshot) return cache.value;
    const value = selector(snapshot);
    if (cache && isEqual(cache.value, value)) {
      cacheRef.current = { snapshot, value: cache.value };
      return cache.value;
    }
    cacheRef.current = { snapshot, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, getSelection, getSelection);
}
