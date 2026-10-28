"use client";

/**
 * The playback command owner. Queue identity spans engine loads; occurrence ids
 * fence selection and end independently of media identity. Browser queue writes
 * are durable before activation; Android owns its queue/cursor in the service and
 * resolves each activation from a downloaded lease or its own descriptor read.
 * Android starts never await an api descriptor read in the renderer.
 * Sources prepare complete captures before replacement. All engine starts share
 * one latest-intent lane, while an already-sent write always resolves first.
 * Queue absence is actionable only after authority confirms it. Creation never
 * replaces a queue discovered while acquiring ownership; retries retain the
 * captured occurrence and use the existing absolute-state revision contract.
 * Restore proves that revision and retained undo before retiring playback intent.
 * Only public explicit-play admission notifies presentation, before any awaits.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { apiFetch, ApiError, isApiError, isSameSystemApiDefect, outcomeUnknown, requestWithDeadline } from "@/lib/api/client";
import { useFeedback } from "@/components/feedback/Feedback";
import { actionFailure } from "@/lib/actions/catalog";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { useThrowLater } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { holdProgress } from "@/lib/consumption/state";
import { publishChange } from "@/lib/api/changes";
import { createBrowserSession, type QueueSavePhase, type QueueTerminal } from "@/lib/player/browserSession";
import { BROWSER_COORDINATION_BOUND_MS, createBrowserOwnership, type BrowserPlayerCommand } from "@/lib/player/browserOwnership";
import { QueueCommandError, captureQueue, currentQueueEntry, editQueue, queueHeader,
  type NativeQueueOwner, type QueueCommand, type QueueEntry, type QueueHeader, type QueueRequest, type QueueIndex, type QueueManifest, type QueueState } from "@/lib/player/queue";
import { createBrowserEngine } from "@/lib/player/browserEngine";
import {
  createNativeEngine,
  nativePlayerAvailable,
} from "@/lib/player/nativeEngine";
import type { MediaImageProxySrc } from "@/lib/media/imageProxy";
import {
  useAndroidShell,
  useViewportState,
} from "@/lib/renderEnvironment/provider";
import { isEditableTarget, isInteractiveTarget } from "@/lib/ui/eventTarget";
import { hasActiveInteractionOwner } from "@/lib/ui/overlay";

/**
 * Browse preview audio. It carries no media identity because a preview never
 * acquires; its json fields are the Android bridge's frozen wire.
 */
export interface PreviewAudioDescriptor {
  readonly target: string;
  readonly previewHref: string;
  readonly title: string;
  readonly source: string;
  readonly sourceHref: string;
  readonly audioUrl: string;
  readonly imageUrl: MediaImageProxySrc | null;
  readonly durationMs: number | null;
}

export type PlayerDescriptor = Schema<"PlayerDescriptor">;
export type PlayerSource =
  /** `packageId`: the downloaded recording the native engine loaded; null when streaming. */
  | { readonly kind: "Episode"; readonly descriptor: PlayerDescriptor; readonly packageId: string | null }
  | { readonly kind: "Preview"; readonly descriptor: PreviewAudioDescriptor };
export type PlayerPhase = "Buffering" | "Playing" | "Paused" | "Ended";

/** What an engine reports; the native adapter maps bridge load_id to playbackSubject. */
export interface EngineState {
  readonly source: PlayerSource | null;
  readonly queue: QueueHeader | null;
  /** Engine-owned load occurrence; independent of preferences and transport availability. */
  readonly playbackSubject: string | null;
  readonly phase: PlayerPhase;
  readonly positionMs: number;
  readonly durationMs: number; // 0 until known
  readonly bufferedMs: number;
  readonly rate: number;
  /** Observed processing state; requested preferences are owned separately by the runtime. */
  readonly shortenPauses: boolean;
  readonly shortenPausesSavedMs: number;
  readonly error: string | null;
  readonly playbackFailed: boolean;
  readonly synced: boolean; // the newest listening sample is stored
  readonly consumptionRevision: number; // accepted native writes, never device-only activity
}

export const IDLE_ENGINE_STATE: EngineState = {
  source: null,
  queue: null,
  playbackSubject: null,
  phase: "Paused",
  positionMs: 0,
  durationMs: 0,
  bufferedMs: 0,
  rate: 1,
  shortenPauses: false,
  shortenPausesSavedMs: 0,
  error: null,
  playbackFailed: false,
  synced: true,
  consumptionRevision: 0,
};

export interface Engine {
  /** Instance capability, independent of source and transport availability. */
  readonly supportsSilenceSkipping: boolean;
  readonly queue: NativeQueueOwner | null;
  state(): EngineState;
  subscribe(listener: () => void): () => void;
  /** Explicit time overrides ordinary resume, including a newer outgoing sample.
   * Resolves after the outgoing session's last write (bounded at 2 s). */
  load(descriptor: PlayerDescriptor, play: boolean, positionMs: number | null): Promise<void>;
  preview(descriptor: PreviewAudioDescriptor): Promise<void>;
  /** A resume asks the server unless this device holds a newer sample; `given` (the page's
   * descriptor) stands in for an unanswered ask when it knows a reset the session has not. */
  play(given?: PlayerDescriptor): Promise<void>;
  /** Resumes only this accepted load; queue toggles never reread or reinstall it. */
  resumeLoaded(expectedSubject: string): Promise<void>;
  pause(): Promise<void>;
  cancelPendingPlayback(): void;
  seekAndPlay(mediaId: string, positionMs: number): Promise<void>;
  seekTo(input: { readonly positionMs: number; readonly expectedSubject?: string }): void;
  skipBy(deltaMs: number): void;
  /** Pins the episode rate; resolves after application and snapshot publication. */
  setRate(rate: number): Promise<void>;
  /** This load's explicit choice; resolves after application and snapshot publication. */
  setShortenPauses(on: boolean): Promise<void>;
  /** An operational refusal rejects with action feedback; its consumption write must not send. */
  prepareProgressFence(mediaId: string): Promise<void>;
  /** Reads the server's position; an authority outage keeps the fence and local retry feedback. */
  reconcileProgressFence(mediaId: string): Promise<void>;
  dismiss(): Promise<void>;
  close(): void;
}

export type PlayerState =
  | { readonly kind: "Absent" }
  | {
      readonly kind: "Unavailable";
      readonly reason: "UpdateRequired" | "NotResponding";
    }
  | ({ readonly kind: "Loaded"; readonly source: PlayerSource } & Omit<
      EngineState,
      "source" | "playbackSubject" | "positionMs" | "durationMs" | "bufferedMs"
    >);
/** Expected engine refusal; unexpected exceptions belong to the existing defect boundary. */
export class PlaybackPreferenceError extends Error {}

export interface PlaybackPreferences {
  readonly rate: number;
  readonly skipSilence: boolean;
  readonly application:
    | { readonly kind: "Ready" }
    | { readonly kind: "Applying" }
    | { readonly kind: "Failed"; readonly message: string };
}

interface PreferenceIntent extends PlaybackPreferences {
  readonly engine: Engine;
  readonly subject: string;
}

/** An admitted start can still be paused while descriptor or installation awaits. */
export type PendingPlayback =
  | { readonly kind: "Episode"; readonly mediaId: string }
  | { readonly kind: "Preview"; readonly target: string };

export type QueueFailure =
  | { readonly kind: "Episode"; readonly entry_id: string; readonly title: string | null }
  | { readonly kind: "Preparation" | "Save" | "Coordination" };

export interface PlayerQueue {
  readonly known: boolean;
  readonly header: QueueHeader | null;
  readonly index: QueueIndex;
  readonly phase: QueueSavePhase;
  readonly error: string | null;
  readonly failure: QueueFailure | null;
  readonly canRestore: boolean;
  readonly owner: boolean;
}

export interface PlayerSession {
  readonly supportsSilenceSkipping: boolean;
  readonly state: PlayerState;
  readonly pendingPlayback: PendingPlayback | null;
  readonly playingEntryId: string | null;
  readonly queue: PlayerQueue;
  readonly preferences: PlaybackPreferences | null;
  /** Confirmed engine load, retained through temporary native unavailability. */
  readonly playbackSubject: string | null;
}
export interface PlayerTimeline {
  readonly positionMs: number;
  readonly durationMs: number;
  readonly bufferedMs: number;
  readonly chapter: Schema<"ChapterOut"> | null;
}
export interface PlayerCommands {
  playAudio(input: { mediaId: string; knownDescriptor: PlayerDescriptor | null; positionMs: number | null; source: (() => Promise<Schema<"PlaybackSnapshotOut">>) | null; recapture: boolean }): Promise<"Applied" | "Superseded">;
  createQueue(input: { entry: QueueEntry }): Promise<void>;
  queueCommand(request: QueueRequest): Promise<void>;
  retryQueueIndex(): Promise<void>;
  stop(): void;
  checkQueue(): void;
  cancelQueuePreparation(): void;
  playPreviewAudio(input: { target: string; resolveDescriptor: () => Promise<PreviewAudioDescriptor> }): Promise<"Installed" | "Superseded">;
  resume(): void;
  pause(): void;
  /** Omission captures the confirmed load at admission; stale application is a silent no-op. */
  seekTo(input: { readonly positionMs: number; readonly expectedSubject?: string }): void;
  skipBy(deltaMs: number): void;
  previous(): void;
  next(): void;
  setPlaybackRate(rate: number): void;
  setShortenPauses(on: boolean): void;
  retryPlaybackPreferences(): void;
}

export const PLAYER_SKIP_BACK_MS = 15_000;
export const PLAYER_SKIP_FORWARD_MS = 30_000;
const FRESH_DESCRIPTOR_BOUND_MS = 2_000;
const RESTART_AFTER_MS = 3_000;

function preparationErrorMessage(error: unknown): string {
  if (error instanceof QueueCommandError) return error.message;
  if (isApiError(error) && error.code === "E_LIMIT") return "too many episodes; narrow this view";
  return "couldn’t prepare queue; try again";
}

/** A displayed occurrence may act only against its exact confirmed authority. */
function admitQueueCommand(queue: PlayerQueue, request: QueueRequest): QueueEntry | null {
  if (!queue.known) throw new QueueCommandError("loading queue…");
  const header = queue.header;
  if (header?.queue_id !== request.queue_id || header.revision !== request.expected_revision)
    throw new QueueCommandError("queue changed; try again");
  if (queue.phase === "Uncertain") throw new QueueCommandError("couldn’t confirm queue change");
  if (queue.phase === "Saving") throw new QueueCommandError("saving queue…");
  const command = request.command;
  if (command.kind === "restore" && !queue.canRestore) throw new QueueCommandError("previous queue is no longer available");
  if (command.kind === "select" && command.entry_id === header.current_entry_id) return header.current_entry;
  if (command.kind === "select" || command.kind === "move-before" || command.kind === "remove" && command.entry_id !== header.current_entry_id) {
    const index = queue.index;
    if (index.kind !== "Ready" || index.snapshot.queue_id !== header.queue_id || index.snapshot.revision !== header.revision)
      throw new QueueCommandError("loading queue…");
    const entry = index.snapshot.entries.find(item => item.id === command.entry_id);
    if (entry === undefined) throw new QueueCommandError("episode is no longer queued");
    return entry;
  }
  return null;
}

function playingQueueEntry(state: EngineState, header: QueueHeader | null,
  loaded: { readonly queueId: string; readonly entryId: string; readonly subject: string | null } | null): string | null {
  return header !== null && loaded?.queueId === header.queue_id && loaded.entryId === header.current_entry_id &&
    loaded.subject !== null && loaded.subject === state.playbackSubject && state.source?.kind === "Episode" &&
    state.source.descriptor.media_id === header.current_entry?.media_id && !state.playbackFailed &&
    (state.phase === "Playing" || state.phase === "Buffering") ? loaded.entryId : null;
}

function queueCommandChangesPlayback(command: QueueCommand): boolean {
  switch (command.kind) {
    case "append": case "insert-next": case "move-before": return false;
    case "remove": return command.failed_current;
    case "select": case "previous": case "next": case "stop": case "restore": return true;
  }
}

const SessionContext = createContext<PlayerSession | null>(null);
const TimelineContext = createContext<PlayerTimeline | null>(null);
const CommandsContext = createContext<PlayerCommands | null>(null);

export function playingEpisode(state: PlayerState): PlayerDescriptor | null {
  return state.kind === "Loaded" && state.source.kind === "Episode"
    ? state.source.descriptor
    : null;
}

/** The browser engine's current descriptor within the existing load deadline. */
async function freshDescriptor(
  mediaId: string,
  signal: AbortSignal | null,
): Promise<PlayerDescriptor> {
  const body = await requestWithDeadline({
    signal: signal ?? new AbortController().signal, timeoutMs: FRESH_DESCRIPTOR_BOUND_MS,
    request: signal => apiFetch<ApiJson<"/media/{media_id}/player", "get">>(
      `/api/media/${mediaId}/player`, { signal, cache: "no-store" },
    ),
  });
  return body.data.descriptor;
}

export function GlobalPlayerProvider({
  accountId,
  onExplicitPlay,
  children,
}: {
  accountId: string;
  onExplicitPlay: () => void;
  children: ReactNode;
}) {
  const androidShell = useAndroidShell();
  const viewport = useViewportState();
  const mobileRef = useRef(viewport.isMobile);
  mobileRef.current = viewport.isMobile;
  const navigation = useRef<(PlayerCommands & { failure(error: unknown): void; terminal(input: { mediaId: string; subject: string; advance: boolean; body: Promise<Schema<"NaturalEndIn">> }): Promise<void> }) | null>(null);
  const [queueView, setQueueView] = useState<PlayerQueue>({ known: false, header: null, index: { kind: "Loading", previous: null }, phase: "Ready", error: null, failure: null, canRestore: false, owner: false });
  const queueViewRef = useRef(queueView);
  const failedOccurrence = useRef<{ queueId: string; failure: Extract<QueueFailure, { kind: "Episode" }> } | null>(null);
  const [mirroredEngine, setMirroredEngine] = useState<EngineState | null>(null);
  const [mirroredPlayingEntryId, setMirroredPlayingEntryId] = useState<string | null>(null);
  const publishQueue = useCallback((value: PlayerQueue) => {
    const before = queueViewRef.current;
    // Preparation and cancellation cannot erase an unresolved first observation.
    if (!value.known && !before.known && before.error !== null)
      value = { ...value, error: before.error, failure: before.failure };
    if (value.failure?.kind === "Episode" && value.header !== null)
      failedOccurrence.current = { queueId: value.header.queue_id, failure: value.failure };
    else if (failedOccurrence.current?.queueId !== value.header?.queue_id || failedOccurrence.current?.failure.entry_id !== value.header?.current_entry_id)
      failedOccurrence.current = null;
    queueViewRef.current = value;
    setQueueView(value);
  }, []);
  const browser = useRef<ReturnType<typeof createBrowserSession> | null>(null);
  const ownership = useRef<ReturnType<typeof createBrowserOwnership> | null>(null);
  const executeRef = useRef<(command: BrowserPlayerCommand) => Promise<void>>(async () => {});
  const publishBrowser = useCallback(() => {
    const value = browser.current?.snapshot();
    if (value === undefined) return;
    if (!value.known) {
      publishQueue({ ...queueViewRef.current, phase: value.phase, index: { kind: value.error === null ? "Loading" : "Failed", previous: null } });
      return;
    }
    const saved = value.saved;
    const failed = failedOccurrence.current;
    const retainedFailure = failed?.queueId === saved?.state.queue_id && failed?.failure.entry_id === saved?.state.current_entry_id ? failed?.failure ?? null : null;
    const before = queueViewRef.current.index;
    const index: QueueIndex = saved === null ? { kind: "Loading", previous: null }
      : before.kind === "Ready" && before.snapshot.queue_id === saved.state.queue_id && before.snapshot.revision === saved.revision
        ? before : { kind: "Ready", snapshot: { queue_id: saved.state.queue_id, revision: saved.revision, entries: saved.state.entries } };
    publishQueue({ known: value.known, header: saved === null ? null : { ...queueHeader(saved.state, saved.revision), can_restore: value.canRestore }, index,
      phase: value.phase, error: value.error ?? (retainedFailure === null ? null : retainedFailure.title === null ? "episode unavailable" : `couldn’t play “${retainedFailure.title}”`), failure: value.error === null ? retainedFailure : { kind: "Save" }, canRestore: value.canRestore, owner: ownership.current?.owner() ?? false });
    ownership.current?.publish();
  }, [publishQueue]);
  const [engine, setEngine] = useState<Engine | null>(null);
  // Commands read the engine through a ref: a click can land before the render carrying it commits.
  const engineRef = useRef<Engine | null>(null);
  const loads = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef(0);
  const retainedCursor = useRef<{ queueId: string; entryId: string } | null>(null);
  const pendingTerminal = useRef<{ queueId: string; entryId: string; subject: string } | null>(null);
  const loadedOccurrence = useRef<{ queueId: string; entryId: string; subject: string | null } | null>(null);
  const retainCurrent = useCallback(() => {
    const terminal = pendingTerminal.current;
    const loaded = loadedOccurrence.current;
    retainedCursor.current = terminal !== null && loaded?.queueId === terminal.queueId && loaded.entryId === terminal.entryId &&
      engineRef.current?.state().playbackSubject === terminal.subject ? { queueId: terminal.queueId, entryId: terminal.entryId } : null;
  }, []);
  const pendingLoad = useRef<number | null>(null);
  const descriptorRead = useRef<AbortController | null>(null);
  const preparationRetry = useRef<(() => Promise<"Applied" | "Superseded">) | null>(null);
  const [pendingPlayback, setPendingPlayback] = useState<PendingPlayback | null>(null);
  const intent = useRef<PreferenceIntent | null>(null);
  const [preferenceState, setPreferenceState] = useState<PreferenceIntent | null>(null);
  const applying = useRef(false);
  const fail = useThrowLater();
  const feedback = useFeedback();
  const publishPreferences = useCallback((value: PreferenceIntent | null) => {
    intent.current = value;
    setPreferenceState(value);
  }, []);
  const ownsPreferences = useCallback((value: PreferenceIntent) =>
    engineRef.current === value.engine &&
    value.engine.state().playbackSubject === value.subject &&
    pendingLoad.current === null,
  []);

  // One flight applies the newest pair. Each setter is guarded immediately before invocation;
  // an earlier acknowledgement may publish observed state, but never replace newer intent.
  const applyPreferences = useCallback(() => {
    if (applying.current) return;
    applying.current = true;
    void (async () => {
      try {
        for (;;) {
          const next = intent.current;
          if (next === null || next.application.kind !== "Applying") return;
          if (!ownsPreferences(next)) return;
          try {
            if (Math.abs(next.engine.state().rate - next.rate) > 0.0001)
              await next.engine.setRate(next.rate);
            if (intent.current !== next) continue;
            if (!ownsPreferences(next)) continue;
            if (next.engine.state().shortenPauses !== next.skipSilence)
              await next.engine.setShortenPauses(next.skipSilence);
            if (intent.current !== next) continue;
            if (!ownsPreferences(next)) continue;
            const observed = next.engine.state();
            if (Math.abs(observed.rate - next.rate) > 0.0001 || observed.shortenPauses !== next.skipSilence)
              throw new Error("Playback preference acknowledgement did not publish applied values");
            publishPreferences({ ...next, application: { kind: "Ready" } });
          } catch (error) {
            if (!ownsPreferences(next)) continue;
            if (!(error instanceof PlaybackPreferenceError)) {
              fail({ error });
              return;
            }
            if (intent.current === next)
              publishPreferences({ ...next, application: { kind: "Failed", message: error.message } });
          }
        }
      } finally {
        applying.current = false;
      }
    })();
  }, [fail, ownsPreferences, publishPreferences]);

  const syncPreferences = useCallback(() => {
    const target = engineRef.current;
    const snapshot = target?.state();
    if (target === null || snapshot === undefined || snapshot.source === null || snapshot.playbackSubject === null) {
      if (intent.current !== null) publishPreferences(null);
      return;
    }
    if (pendingLoad.current !== null) return;
    const before = intent.current;
    if (before !== null && ownsPreferences(before)) {
      if (before.application.kind === "Ready" &&
          (Math.abs(before.rate - snapshot.rate) > 0.0001 || before.skipSilence !== snapshot.shortenPauses))
        publishPreferences({ ...before, rate: snapshot.rate, skipSilence: snapshot.shortenPauses });
      return;
    }
    publishPreferences({
      engine: target,
      subject: snapshot.playbackSubject,
      rate: snapshot.rate,
      skipSilence: snapshot.shortenPauses,
      application: { kind: "Ready" },
    });
  }, [ownsPreferences, publishPreferences]);

  const requestPreferences = useCallback((patch: Partial<Pick<PlaybackPreferences, "rate" | "skipSilence">>) => {
    const before = intent.current;
    if (before === null || !ownsPreferences(before)) return;
    publishPreferences({ ...before, ...patch, application: { kind: "Applying" } });
    applyPreferences();
  }, [applyPreferences, ownsPreferences, publishPreferences]);
  const [unavailable, setUnavailable] = useState<Extract<
    PlayerState,
    { kind: "Unavailable" }
  > | null>(null);
  const unavailableRef = useRef(false);

  useEffect(() => {
    const initial: PlayerQueue = { known: false, header: null, index: { kind: "Loading", previous: null }, phase: "Ready", error: null, failure: null, canRestore: false, owner: false };
    queueViewRef.current = initial;
    publishQueue(initial);
    setMirroredEngine(null);
    setMirroredPlayingEntryId(null);
    if (androidShell && !nativePlayerAvailable) {
      unavailableRef.current = true;
      setEngine(null);
      setUnavailable({ kind: "Unavailable", reason: "UpdateRequired" });
      return;
    }
    setUnavailable(null);
    unavailableRef.current = false;
    const created = androidShell
      ? createNativeEngine((responding) => {
          unavailableRef.current = !responding;
          setUnavailable(
            responding ? null : { kind: "Unavailable", reason: "NotResponding" },
          );
        })
      : createBrowserEngine({
          terminal: input => navigation.current?.terminal(input) ?? Promise.resolve(),
          fresh: mediaId => freshDescriptor(mediaId, null).catch(error => { if (isAbortError(error) || outcomeUnknown(error)) return null; throw error; }),
          deviceClass: () => (mobileRef.current ? "Mobile" : "Desktop"),
          commands: () => navigation.current,
          onFailure: error => navigation.current?.failure(error),
        });
    engineRef.current = created;
    setEngine(created);
    let observationDeadline: ReturnType<typeof setTimeout> | null = null;
    if (!androidShell) {
      observationDeadline = setTimeout(() => {
        if (engineRef.current === created && !queueViewRef.current.known)
          publishQueue({ ...queueViewRef.current, error: "playback is still in another tab", failure: { kind: "Coordination" } });
      }, BROWSER_COORDINATION_BOUND_MS);
      const session = createBrowserSession(accountId, () => {
        if (browser.current !== session) return;
        if (session.snapshot().known && observationDeadline !== null) clearTimeout(observationDeadline);
        publishBrowser();
      });
      browser.current = session;
      ownership.current = createBrowserOwnership({
        accountId,
        acquired: async () => { await session.read(); if (engineRef.current === created) setMirroredEngine(null); },
        release: (expectedQueue, isCurrent) => {
          const transfer = loads.current.then(async () => {
            const saved = session.snapshot().saved;
            if (!isCurrent()) throw new QueueCommandError("playback request expired");
            if (expectedQueue !== null && (saved?.state.queue_id !== expectedQueue.queue_id || saved.revision !== expectedQueue.expected_revision))
              throw new QueueCommandError("queue changed; try again");
            if (session.uncertain()) throw new QueueCommandError("couldn’t confirm queue change");
            if (engineRef.current !== created) return;
            latest.current += 1;
            descriptorRead.current?.abort();
            created.cancelPendingPlayback();
            setPendingPlayback(null);
            if (session.snapshot().phase === "Preparing") { preparationRetry.current = null; session.preparing(false); }
            await created.pause();
            if (!isCurrent()) throw new QueueCommandError("playback request expired");
            if (engineRef.current === created) await created.dismiss();
            if (!isCurrent()) throw new QueueCommandError("playback request expired");
          });
          loads.current = transfer.catch(() => {});
          return transfer;
        },
        command: command => executeRef.current(command),
        snapshot: () => ({ queue: queueViewRef.current, engine: created.state(),
          playing_entry_id: playingQueueEntry(created.state(), queueViewRef.current.header, loadedOccurrence.current) }),
        mirror: snapshot => {
          if (observationDeadline !== null) clearTimeout(observationDeadline);
          const before = queueViewRef.current.index;
          const retained = before.kind === "Ready" ? before.snapshot : before.previous;
          const incoming = snapshot.queue.index;
          const manifest = incoming.kind === "Ready" ? incoming.snapshot : incoming.previous;
          const same = retained !== null && manifest !== null && retained.queue_id === manifest.queue_id && retained.revision === manifest.revision;
          const index: QueueIndex = !same ? incoming : incoming.kind === "Ready" ? { kind: "Ready", snapshot: retained }
            : { kind: incoming.kind, previous: retained };
          publishQueue({ ...snapshot.queue, index, known: true, owner: false });
          setMirroredEngine(snapshot.engine);
          setMirroredPlayingEntryId(snapshot.playing_entry_id);
        },
        changed: publishBrowser,
      });
      if (!ownership.current.supported) publishQueue({ known: false, header: null, index: { kind: "Loading", previous: null }, phase: "Unavailable", error: "playback needs a browser with web locks and broadcast channels", failure: { kind: "Coordination" }, canRestore: false, owner: false });
      else void ownership.current.acquire(false, null).catch(error => {
        if (engineRef.current !== created || handleUnauthenticatedApiError(error)) return;
        if (!(error instanceof QueueCommandError) && (!isApiError(error) || isSameSystemApiDefect(error))) { fail({ error }); return; }
        publishQueue({ ...queueViewRef.current, index: { kind: "Failed", previous: null } });
      });
    }
    return () => {
      if (observationDeadline !== null) clearTimeout(observationDeadline);
      engineRef.current = null;
      descriptorRead.current?.abort();
      latest.current += 1;
      pendingLoad.current = null;
      setPendingPlayback(null);
      publishPreferences(null);
      if (!androidShell) void created.pause().catch(error => { if (!handleUnauthenticatedApiError(error)) fail({ error }); });
      preparationRetry.current = null;
      loadedOccurrence.current = null;
      pendingTerminal.current = null;
      retainedCursor.current = null;
      ownership.current?.close();
      ownership.current = null;
      browser.current = null;
      created.close();
    };
  }, [accountId, androidShell, fail, publishPreferences, publishBrowser, publishQueue]);

  const subscribe = useCallback(
    (listener: () => void) => engine?.subscribe(() => {
      const state = engine.state();
      const loaded = loadedOccurrence.current;
      const header = queueViewRef.current.header;
      // A resume can refresh this occurrence inside the engine. Its new load
      // subject belongs to the same queue entry, never another copy of the media.
      if (engine === engineRef.current && engine.queue === null && state.playbackSubject !== null &&
          state.source?.kind === "Episode" && loaded !== null && header !== null && loaded.queueId === header.queue_id &&
          loaded.entryId === header.current_entry_id && state.source.descriptor.media_id === header.current_entry?.media_id)
        loadedOccurrence.current = { ...loaded, subject: state.playbackSubject };
      syncPreferences();
      ownership.current?.publish();
      listener();
    }) ?? (() => {}),
    [engine, syncPreferences],
  );
  const observed = useSyncExternalStore(
    subscribe,
    () => engine?.state() ?? IDLE_ENGINE_STATE,
    () => IDLE_ENGINE_STATE,
  );
  const s = !androidShell && !queueView.owner && mirroredEngine !== null ? mirroredEngine : observed;
  const episode = s.source?.kind === "Episode" ? s.source.descriptor : null;
  useEffect(syncPreferences, [engine, syncPreferences]);
  useEffect(() => {
    const header = queueViewRef.current.header;
    if (header?.current_entry_id === null || header === null) return;
    if (!s.playbackFailed) {
      if (s.phase === "Playing" && s.source?.kind === "Episode" && s.source.descriptor.media_id === header.current_entry?.media_id) {
        failedOccurrence.current = null;
        if (queueViewRef.current.failure?.kind === "Episode") publishQueue({ ...queueViewRef.current, error: null, failure: null });
      }
      return;
    }
    if (androidShell ? s.queue?.current_entry_id !== header.current_entry_id : loadedOccurrence.current?.entryId !== header.current_entry_id) return;
    const title = s.source?.kind === "Episode" && s.source.descriptor.media_id === header.current_entry?.media_id ? s.source.descriptor.title : null;
    publishQueue({ ...queueViewRef.current, error: title === null ? "episode unavailable" : `couldn’t play “${title}”`,
      failure: { kind: "Episode", entry_id: header.current_entry_id, title } });
  }, [androidShell, s.playbackFailed, s.phase, s.source, s.queue, publishQueue]);

  // ---- loads: one at a time, the latest request wins ----
  const enqueue = useCallback((work: (generation: number) => Promise<void>, playback: PendingPlayback | null) => {
    ownership.current?.cancelAcquisition();
    const mine = ++latest.current;
    const engineAtAdmission = engineRef.current;
    descriptorRead.current?.abort();
    engineAtAdmission?.cancelPendingPlayback();
    setPendingPlayback(playback);
    const result = loads.current.then(async (): Promise<"Applied" | "Superseded"> => {
      try {
        if (mine !== latest.current || engineAtAdmission !== engineRef.current) return "Superseded";
        if (engineAtAdmission === null) throw new ApiError(409, "E_PLAYBACK_REFUSED", "the player is unavailable. reload the app and try again.");
        await work(mine);
        return mine === latest.current && engineAtAdmission !== null && engineAtAdmission === engineRef.current ? "Applied" : "Superseded";
      } catch (error) {
        if (mine !== latest.current && isApiError(error) && error.code === "E_PLAYBACK_STALE") return "Superseded";
        throw error;
      } finally {
        if (mine === latest.current) {
          setPendingPlayback(null);
          syncPreferences();
        }
      }
    });
    // A caller owns its failure; a failed request never poisons the ordered lane.
    loads.current = result.then(() => {}, () => {});
    return result;
  }, [syncPreferences]);
  const retireIntent = useCallback(() => {
    ownership.current?.cancelAcquisition();
    descriptorRead.current?.abort();
    latest.current += 1;
    setPendingPlayback(null);
    if (queueViewRef.current.phase === "Preparing") {
      preparationRetry.current = null;
      browser.current?.preparing(false);
      publishQueue({ ...queueViewRef.current, phase: "Ready" });
    }
  }, [publishQueue]);
  const retirePending = useCallback(() => {
    retireIntent();
    engineRef.current?.cancelPendingPlayback();
  }, [retireIntent]);
  const enqueueQueueEdit = useCallback((work: (generation: number) => Promise<void>, changesPlayback: boolean) => {
    if (changesPlayback) retirePending();
    const generation = latest.current;
    const target = engineRef.current;
    const result = loads.current.then(async () => {
      if (target !== engineRef.current) throw new QueueCommandError("playback account changed");
      await work(generation);
    });
    loads.current = result.then(() => {}, () => {});
    return result;
  }, [retirePending]);
  const activate = useCallback(async (entry: QueueEntry, play: boolean, mine: number, known: PlayerDescriptor | null = null, positionMs: number | null = null) => {
    const target = engineRef.current;
    if (target === null || mine !== latest.current) return;
    failedOccurrence.current = null;
    publishQueue({ ...queueViewRef.current, error: null, failure: null });
    let descriptor: PlayerDescriptor;
    try { descriptor = await freshDescriptor(entry.media_id, null); }
    catch (error) {
      if (mine !== latest.current || target !== engineRef.current) return;
      if (!isApiError(error) && !isAbortError(error) || isSameSystemApiDefect(error)) throw error;
      if (positionMs !== null || known === null || !(isAbortError(error) || outcomeUnknown(error))) {
        publishQueue({ ...queueViewRef.current, error: known === null ? "episode unavailable" : `couldn’t play “${known.title}”`, failure: { kind: "Episode", entry_id: entry.id, title: known?.title ?? null } });
        await target.dismiss();
        loadedOccurrence.current = null;
        if (positionMs !== null) throw error;
        return;
      }
      descriptor = known;
    }
    if (mine !== latest.current || target !== engineRef.current || (!androidShell && !ownership.current?.owner())) return;
    pendingLoad.current = mine;
    publishPreferences(null);
    try { await target.load(descriptor, play, positionMs); }
    finally { if (pendingLoad.current === mine) pendingLoad.current = null; syncPreferences(); }
    if (mine === latest.current && target === engineRef.current) {
      const header = queueViewRef.current.header;
      if (header !== null) loadedOccurrence.current = { queueId: header.queue_id, entryId: entry.id, subject: target.state().playbackSubject };
      ownership.current?.publish();
    }
  }, [androidShell, publishPreferences, publishQueue, syncPreferences]);

  const report = useCallback((error: unknown) => {
    if (handleUnauthenticatedApiError(error)) return;
    if (!(error instanceof QueueCommandError) && (!isApiError(error) || isSameSystemApiDefect(error))) { fail({ error }); return; }
    // The queue surface keeps the failure below; the receipt reports this command once.
    if (isApiError(error)) feedback.receipt(actionFailure("Playback", "play", error));
    if (queueViewRef.current.failure !== null && queueViewRef.current.error !== null) return;
    publishQueue({ ...queueViewRef.current, phase: browser.current?.uncertain() || engineRef.current?.queue?.uncertain() ? "Uncertain" : "Ready", error: error instanceof QueueCommandError ? error.message : isApiError(error) ? actionFailure("Playback", "play", error).title : "couldn’t change playback", failure: { kind: browser.current?.uncertain() || engineRef.current?.queue?.uncertain() ? "Save" : "Coordination" } });
  }, [fail, feedback, publishQueue]);

  const indexRead = useRef<{ readonly target: Engine; readonly header: QueueHeader; readonly promise: Promise<void> } | null>(null);
  const nativeRefresh = useCallback((target: Engine, header: QueueHeader | null, retry = false): Promise<void> => {
    const matches = () => target === engineRef.current && target.queue?.known() === true &&
      (header === null ? target.state().queue === null : target.state().queue?.queue_id === header.queue_id &&
        target.state().queue?.revision === header.revision && target.state().queue?.count === header.count &&
        target.state().queue?.current_entry_id === header.current_entry_id && target.state().queue?.current_index === header.current_index);
    if (!matches() || target.queue === null) return Promise.resolve();
    const before = queueViewRef.current;
    if (header === null) {
      indexRead.current = null;
      publishQueue({ ...before, known: true, header: null, index: { kind: "Loading", previous: null },
        canRestore: false, owner: true });
      return Promise.resolve();
    }
    const sameRevision = before.header?.queue_id === header.queue_id && before.header.revision === header.revision;
    if (sameRevision && (before.header !== header || before.canRestore !== header.can_restore))
      publishQueue({ ...before, header, canRestore: header.can_restore });
    const active = indexRead.current;
    if (active?.target === target && active.header.queue_id === header.queue_id && active.header.revision === header.revision) return active.promise;
    if (!retry && sameRevision) return Promise.resolve();
    const previous = before.header?.queue_id === header.queue_id
      ? before.index.kind === "Ready" ? before.index.snapshot : before.index.previous : null;
    const retiredFailure = before.failure?.kind === "Episode" && (before.header?.queue_id !== header.queue_id || before.header.current_entry_id !== header.current_entry_id);
    publishQueue({ ...before, known: true, header, index: { kind: "Loading", previous }, canRestore: header.can_restore, owner: true,
      ...(retiredFailure ? { error: null, failure: null } : {}) });
    const collect = async (): Promise<void> => {
      const entries: QueueEntry[] = [];
      const ids = new Set<string>();
      const priorMedia = new Map(previous?.entries.map(entry => [entry.id, entry.media_id]));
      try {
        for (let offset = 0; offset < header.count; offset += 100) {
          if (!matches() || indexRead.current !== read) return;
          const length = Math.min(100, header.count - offset);
          const page = await target.queue!.page({ expected_revision: header.revision, offset, limit: length });
          if (!matches() || indexRead.current !== read) return;
          // justify-defect: native pages must describe exactly one complete accepted sequence.
          if (page.length !== length) throw new TypeError("native queue page has an unexpected length");
          for (const entry of page) {
            if (ids.has(entry.id) || priorMedia.has(entry.id) && priorMedia.get(entry.id) !== entry.media_id)
              throw new TypeError("native queue occurrence identity changed");
            ids.add(entry.id);
            entries.push(entry);
          }
        }
        if (!matches() || indexRead.current !== read) return;
        const current = header.current_index === null ? null : entries[header.current_index];
        if (entries.length !== header.count || (header.current_entry_id === null ? header.current_entry !== null
          : current?.id !== header.current_entry_id || current.media_id !== header.current_entry?.media_id))
          throw new TypeError("native queue index disagrees with its header");
        const snapshot: QueueManifest = { queue_id: header.queue_id, revision: header.revision, entries };
        publishQueue({ ...queueViewRef.current, index: { kind: "Ready", snapshot } });
      } catch (error) {
        if (!matches() || indexRead.current !== read) return;
        if (handleUnauthenticatedApiError(error)) return;
        if (!(error instanceof QueueCommandError) && (!isApiError(error) || isSameSystemApiDefect(error))) { fail({ error }); return; }
        publishQueue({ ...queueViewRef.current, index: { kind: "Failed", previous } });
      } finally { if (indexRead.current === read) indexRead.current = null; }
    };
    // The collector starts after its ownership record exists, outside the write/load lane.
    const read = { target, header, promise: Promise.resolve().then(collect) };
    indexRead.current = read;
    return read.promise;
  }, [fail, publishQueue]);

  const readNativeQueue = useCallback(async (target: Engine, retry = false) => {
    if (target.queue === null) return;
    const before = queueViewRef.current;
    const observed = target.state().queue;
    try {
      const header = await target.queue.read();
      if (target !== engineRef.current) return;
      publishQueue({ ...queueViewRef.current, phase: target.queue.uncertain() ? "Uncertain" : "Ready",
        ...(queueViewRef.current.failure?.kind === "Episode" ? {} : { error: null, failure: null }) });
      await nativeRefresh(target, header, retry);
    } catch (error) {
      if (target !== engineRef.current || target.state().queue !== observed || queueViewRef.current.header !== before.header) return;
      if (handleUnauthenticatedApiError(error)) return;
      if (!(error instanceof QueueCommandError) && (!isApiError(error) || isSameSystemApiDefect(error))) { fail({ error }); return; }
      const previous = before.index.kind === "Ready" ? before.index.snapshot : before.index.previous;
      publishQueue({ ...queueViewRef.current, index: { kind: "Failed", previous } });
    }
  }, [fail, nativeRefresh, publishQueue]);
  useEffect(() => {
    if (androidShell && engine !== null) void readNativeQueue(engine);
  }, [androidShell, engine, readNativeQueue]);
  const nativeKnown = engine?.queue?.known() ?? false;
  useEffect(() => {
    if (androidShell && engine !== null && nativeKnown) void nativeRefresh(engine, observed.queue);
  }, [androidShell, engine, nativeKnown, observed.queue, nativeRefresh]);

  const replaceQueue = useCallback(async ({ state, knownDescriptor, play, positionMs }: { state: QueueState; knownDescriptor: PlayerDescriptor | null; play: boolean; positionMs: number | null }) => {
    retainedCursor.current = null;
    await enqueue(async mine => {
      const target = engineRef.current;
      if (target === null) return;
      if (target.queue !== null) {
        publishQueue({ ...queueViewRef.current, phase: "Saving", error: null, failure: null });
        const header = await target.queue.replace({ state, expected_revision: queueViewRef.current.header?.revision ?? null,
          known_descriptor: knownDescriptor, is_current: () => mine === latest.current && target === engineRef.current });
        if (target !== engineRef.current) return;
        publishQueue({ ...queueViewRef.current, phase: "Ready" });
        void nativeRefresh(target, header);
        if (mine !== latest.current || target !== engineRef.current || header.current_entry_id === null) return;
        await target.queue.command({ queue_id: header.queue_id, expected_revision: header.revision, command: { kind: "select", entry_id: header.current_entry_id, play, position_ms: positionMs } });
        return;
      }
      if (!(await ownership.current?.acquire(true, null)) || mine !== latest.current) return;
      const saved = await browser.current?.save(state, null, true);
      if (saved === undefined || saved === null || mine !== latest.current) return;
      const current = currentQueueEntry(saved.state);
      if (current !== null) await activate(current, play, mine, knownDescriptor, positionMs);
      else await target.dismiss();
    }, state.current_entry_id === null ? null : { kind: "Episode", mediaId: currentQueueEntry(state)!.media_id });
  }, [activate, enqueue, nativeRefresh, publishQueue]);

  const createQueue = useCallback(async ({ entry }: { entry: QueueEntry }) => {
    const target = engineRef.current;
    try {
      const before = queueViewRef.current;
      if (!before.known) throw new QueueCommandError("loading queue…");
      if (before.header !== null) throw new QueueCommandError("queue changed; try again");
      if (before.phase !== "Ready") throw new QueueCommandError("check the queue before trying again");
      const state: QueueState = { queue_id: crypto.randomUUID(), entries: [entry], current_entry_id: entry.id };
      await enqueueQueueEdit(async () => {
        if (target === null || target !== engineRef.current) return;
        if (target.queue !== null) {
          if (!target.queue.known() || target.state().queue !== null) throw new QueueCommandError("queue changed; try again");
          publishQueue({ ...queueViewRef.current, phase: "Saving", error: null, failure: null });
          const header = await target.queue.replace({ state, expected_revision: null, known_descriptor: null,
            is_current: () => target === engineRef.current });
          if (target !== engineRef.current) return;
          publishQueue({ ...queueViewRef.current, phase: "Ready" });
          void nativeRefresh(target, header);
          return;
        }
        if (!(await ownership.current?.acquire(true, null)) || target !== engineRef.current) return;
        const session = browser.current;
        const current = session?.snapshot();
        if (current === undefined || !current.known || current.saved !== null) throw new QueueCommandError("queue changed; try again");
        await session?.save(state);
      }, false);
    } catch (error) {
      if (target !== engineRef.current) return;
      report(error);
      throw error;
    }
  }, [enqueueQueueEdit, nativeRefresh, publishQueue, report]);

  const queueCommand = useCallback(async (request: QueueRequest) => {
    const target = engineRef.current;
    try {
      const entry = admitQueueCommand(queueViewRef.current, request);
      if (target === null) return;
      if (target.queue !== null) {
        const authority = target.state().queue;
        if (authority?.queue_id !== request.queue_id || authority.revision !== request.expected_revision)
          throw new QueueCommandError("queue changed; try again");
        if (request.command.kind === "restore" && !authority.can_restore)
          throw new QueueCommandError("previous queue is no longer available");
        const changesPlayback = queueCommandChangesPlayback(request.command);
        if (changesPlayback) {
          retainedCursor.current = null;
          // Only the native fenced command may cancel native activation.
          retireIntent();
        }
        const generation = latest.current;
        if (request.command.kind === "select" && request.command.play && entry !== null)
          setPendingPlayback({ kind: "Episode", mediaId: entry.media_id });
        try {
          await enqueueQueueEdit(async () => {
            admitQueueCommand(queueViewRef.current, request);
            if (target !== engineRef.current) return;
            publishQueue({ ...queueViewRef.current, phase: "Saving", error: null, failure: null });
            const header = await target.queue!.command(request);
            if (target === engineRef.current) {
              publishQueue({ ...queueViewRef.current, phase: "Ready" });
              void nativeRefresh(target, header);
            }
          }, false);
        } finally { if (generation === latest.current) setPendingPlayback(null); }
        return;
      }
      if (request.command.kind === "select" && request.command.play && !ownership.current?.owner()) {
        if (entry === null) throw new QueueCommandError("episode is no longer queued");
        retainedCursor.current = null;
        retirePending();
        const mine = latest.current;
        setPendingPlayback({ kind: "Episode", mediaId: entry.media_id });
        try {
          const expected = { queue_id: request.queue_id, expected_revision: request.expected_revision };
          if (!(await ownership.current?.acquire(true, expected)) || mine !== latest.current || target !== engineRef.current) return;
          admitQueueCommand(queueViewRef.current, request);
          await ownership.current?.command({ kind: "queue", request });
        } finally { if (mine === latest.current) setPendingPlayback(null); }
        return;
      }
      await ownership.current?.command({ kind: "queue", request });
    } catch (error) {
      if (target !== engineRef.current) return;
      report(error);
      throw error;
    }
  }, [enqueueQueueEdit, nativeRefresh, publishQueue, report, retireIntent, retirePending]);

  const play = useCallback(async ({ mediaId, knownDescriptor, positionMs, source, recapture }: Parameters<PlayerCommands["playAudio"]>[0]): Promise<"Applied" | "Superseded"> => {
    if (positionMs !== null && (!Number.isFinite(positionMs) || positionMs < 0)) throw new Error("playback position must be finite and nonnegative");
    if (knownDescriptor !== null && knownDescriptor.media_id !== mediaId) throw new Error("playback descriptor does not match media");
    const read = async (mine: number) => {
      const request = new AbortController();
      descriptorRead.current = request;
      try { return await freshDescriptor(mediaId, request.signal); }
      catch (error) {
        if (mine !== latest.current) throw new ApiError(409, "E_PLAYBACK_STALE", "playback source changed. try again.");
        if (!(isAbortError(error) || outcomeUnknown(error))) throw error;
        if (positionMs === null && knownDescriptor !== null) return knownDescriptor;
        throw new ApiError(409, "E_PLAYBACK_REFUSED", "couldn’t read this episode’s current playback state. check your connection and try again.");
      } finally { if (descriptorRead.current === request) descriptorRead.current = null; }
    };
    const header = queueViewRef.current.header;
    const current = header?.current_entry;
    const target = engineRef.current;
    const passive = !androidShell && !ownership.current?.owner();
    const state = passive ? mirroredEngine : target?.state();
    const loaded = loadedOccurrence.current;
    const ownsOccurrence = passive ? current !== null && current !== undefined
      : target?.queue !== null && target?.queue !== undefined
        ? state?.queue?.queue_id === header?.queue_id && state?.queue?.current_entry_id === current?.id
        : loaded?.queueId === header?.queue_id && loaded?.entryId === current?.id && loaded?.subject === state?.playbackSubject;
    const sameOccurrence = ownsOccurrence && state?.source?.kind === "Episode" && state.source.descriptor.media_id === mediaId && state.playbackSubject !== null;
    if (!recapture && current?.media_id === mediaId && (positionMs === null || sameOccurrence && state?.phase !== "Ended")) {
      if (positionMs !== null) retainCurrent();
      retirePending();
      return enqueue(async mine => {
        const owner = engineRef.current;
        if (owner === null || queueViewRef.current.header?.queue_id !== header?.queue_id || queueViewRef.current.header?.current_entry_id !== current.id)
          throw new ApiError(409, "E_PLAYBACK_STALE", "playback source changed. try again.");
        if (browser.current?.uncertain() || owner.queue?.uncertain()) throw new QueueCommandError("couldn’t confirm queue change");
        if (!androidShell && !ownership.current?.owner()) {
          const descriptor = await read(mine);
          if (mine !== latest.current || !(await ownership.current?.acquire(true, null)) || mine !== latest.current) return;
          const saved = browser.current?.snapshot().saved;
          const selected = saved === null || saved === undefined ? null : currentQueueEntry(saved.state);
          if (selected === null || selected.id !== current.id || saved?.state.queue_id !== header?.queue_id) return;
          await activate(selected, true, mine, descriptor, positionMs);
        } else if (sameOccurrence && state?.phase !== "Ended") {
          if (positionMs !== null) await owner.seekAndPlay(mediaId, positionMs);
          else await owner.play(knownDescriptor ?? undefined);
        } else if (owner.queue !== null) {
          const saved = queueViewRef.current.header!;
          void nativeRefresh(owner, await owner.queue.command({ queue_id: saved.queue_id, expected_revision: saved.revision,
            command: { kind: "select", entry_id: current.id, play: true, position_ms: null } }));
        } else await activate(current, true, mine, knownDescriptor, null);
      }, { kind: "Episode", mediaId });
    }
    let frozen: QueueState | null = null;
    const attempt = async (): Promise<"Applied" | "Superseded"> => {
      ownership.current?.cancelAcquisition();
      const mine = ++latest.current;
      setPendingPlayback({ kind: "Episode", mediaId });
      descriptorRead.current?.abort();
      engineRef.current?.cancelPendingPlayback();
      let committing = false;
      let commitGeneration: number | null = null;
      browser.current?.preparing(true);
      publishQueue({ ...queueViewRef.current, phase: "Preparing", error: null, failure: null });
      try {
        if (frozen === null) {
          const captured = source === null ? { media_ids: [mediaId] } : await source();
          if (mine !== latest.current) return "Superseded";
          frozen = captureQueue(captured.media_ids, mediaId);
        }
        const descriptor = androidShell ? null : await read(mine);
        if (mine !== latest.current) return "Superseded";
        committing = true;
        commitGeneration = latest.current + 1;
        await replaceQueue({ state: frozen, knownDescriptor: descriptor, play: true, positionMs });
        if (commitGeneration !== latest.current) return "Superseded";
        if (preparationRetry.current === attempt) preparationRetry.current = null;
        return "Applied";
      } catch (error) {
        if (!committing && mine !== latest.current) return "Superseded";
        if (committing && commitGeneration !== latest.current && !browser.current?.uncertain() && !engineRef.current?.queue?.uncertain()) return "Superseded";
        if (browser.current?.uncertain() || engineRef.current?.queue?.uncertain()) {
          preparationRetry.current = null;
          await engineRef.current?.pause();
        } else browser.current?.preparing(false);
        publishQueue({ ...queueViewRef.current, phase: browser.current?.uncertain() || engineRef.current?.queue?.uncertain() ? "Uncertain" : "Ready", error: preparationErrorMessage(error), failure: { kind: browser.current?.uncertain() || engineRef.current?.queue?.uncertain() ? "Save" : "Preparation" } });
        throw error;
      } finally { if (mine === latest.current) setPendingPlayback(null); }
    };
    preparationRetry.current = attempt;
    return attempt();
  }, [activate, androidShell, enqueue, mirroredEngine, nativeRefresh, publishQueue, replaceQueue, retainCurrent, retirePending]);

  const execute = useCallback(async (command: BrowserPlayerCommand) => {
    const target = engineRef.current;
    if (target === null) return;
    if (command.kind === "pause") { retainCurrent(); retirePending(); await enqueueQueueEdit(async () => { await target.pause(); }, false); return; }
    if (command.kind === "seek") {
      const subject = command.expected_subject ?? target.state().playbackSubject;
      retainCurrent(); retirePending();
      if (subject !== null) await enqueueQueueEdit(async () => { target.seekTo({ positionMs: command.position_ms, expectedSubject: subject }); }, false);
      return;
    }
    if (command.kind === "rate") { requestPreferences({ rate: command.rate }); return; }
    if (command.kind === "silence") { requestPreferences({ skipSilence: command.on }); return; }
    if (command.kind === "queue") admitQueueCommand(queueViewRef.current, command.request);
    const changesPlayback = command.kind === "queue" ? queueCommandChangesPlayback(command.request.command) : command.kind !== "check";

    const work = async (mine: number) => {
      const session = browser.current;
      const before = session?.snapshot().saved;
      switch (command.kind) {
        case "check": {
          const checkingEnd = pendingTerminal.current;
          try {
            const saved = await session?.check();
            if (target !== engineRef.current) return;
            const retained = retainedCursor.current;
            if (saved !== null && saved !== undefined && checkingEnd !== null && pendingTerminal.current === checkingEnd &&
                retained?.queueId === saved.state.queue_id && saved.state.entries.some(entry => entry.id === retained.entryId))
              await session?.save({ ...saved.state, current_entry_id: retained.entryId });
          } finally {
            if (!session?.uncertain() && pendingTerminal.current === checkingEnd) {
              pendingTerminal.current = null;
              retainedCursor.current = null;
            }
          }
          return;
        }
        case "stop": await target.dismiss(); return;
        case "resume": {
          if (mine !== latest.current) return;
          if (target.state().source?.kind === "Preview") { await target.play(); return; }
          if (session?.uncertain()) throw new QueueCommandError("couldn’t confirm queue change");
          if (before === null || before === undefined) { await target.play(); return; }
          const entry = currentQueueEntry(before.state);
          if (entry !== null) {
            const source = target.state().source;
            const loaded = loadedOccurrence.current;
            if (source?.kind === "Episode" && loaded?.queueId === before.state.queue_id && loaded.entryId === entry.id && loaded.subject === target.state().playbackSubject) await target.play();
            else await activate(entry, true, mine);
          }
          return;
        }
        case "queue": {
          const request = command.request;
          const operation = request.command;
          admitQueueCommand(queueViewRef.current, request);
          if (operation.kind !== "restore" && queueCommandChangesPlayback(operation)) retainedCursor.current = null;
          if (before === null || before === undefined || request.queue_id !== before.state.queue_id) throw new QueueCommandError("queue changed; try again");
          if ((operation.kind === "append" || operation.kind === "insert-next") &&
              before.state.entries.some(entry => entry.id === operation.entry.id && entry.media_id === operation.entry.media_id)) return;
          if (request.expected_revision !== before.revision) throw new QueueCommandError("queue changed; try again");
          if (operation.kind === "stop") { await target.dismiss(); return; }
          if (operation.kind === "restore") {
            if (mine !== latest.current) throw new QueueCommandError("queue changed; try again");
            if (!session?.snapshot().canRestore) throw new QueueCommandError("previous queue is no longer available");
            retainedCursor.current = null;
            retirePending();
            await target.dismiss();
            if (target !== engineRef.current || !ownership.current?.owner()) return;
            await session.restore(request);
            loadedOccurrence.current = null;
            return;
          }
          const currentIndex = before.state.entries.findIndex(entry => entry.id === before.state.current_entry_id);
          if (operation.kind === "previous" && currentIndex >= 0 && (target.state().positionMs > RESTART_AFTER_MS || currentIndex === 0)) {
            target.seekTo({ positionMs: 0 });
            return;
          }
          if (operation.kind === "remove" && operation.entry_id === before.state.current_entry_id &&
              (!operation.failed_current || failedOccurrence.current?.failure.entry_id !== operation.entry_id))
            throw new QueueCommandError("only a failed current episode can be removed");
          const previous = currentQueueEntry(before.state);
          if (operation.kind === "select" && previous?.id === operation.entry_id && operation.position_ms === null) {
            const observed = target.state();
            const loaded = loadedOccurrence.current;
            if (loaded?.queueId === before.state.queue_id && loaded.entryId === previous.id && loaded.subject !== null &&
                loaded.subject === observed.playbackSubject && observed.source?.kind === "Episode" &&
                observed.source.descriptor.media_id === previous.media_id && !observed.playbackFailed && observed.phase !== "Ended") {
              if (operation.play) await target.resumeLoaded(loaded.subject); else await target.pause();
              return;
            }
          }
          const state = editQueue(before.state, operation);
          const next = currentQueueEntry(state);
          const observed = target.state();
          const playing = observed.source?.kind === "Episode" && (observed.phase === "Playing" || observed.phase === "Buffering");
          const addingFromEnd = previous === null && (operation.kind === "append" || operation.kind === "insert-next");
          const play = operation.kind === "select" ? operation.play : operation.kind === "remove" || addingFromEnd ? false : playing;
          if (state !== before.state) await session?.save(state);
          if (mine !== latest.current) return;
          if (next?.id !== previous?.id || operation.kind === "select") {
            if (next !== null) await activate(next, play, mine, null, operation.kind === "select" ? operation.position_ms : null);
            else await target.dismiss();
          }
          return;
        }
      }
    };
    const selection = command.kind === "queue" ? command.request.command : null;
    if (selection?.kind === "select" && selection.play) {
      const entry = browser.current?.snapshot().saved?.state.entries.find(item => item.id === selection.entry_id);
      if (entry === undefined) throw new QueueCommandError("episode is no longer queued");
      retirePending();
      await enqueue(work, { kind: "Episode", mediaId: entry.media_id });
    } else if (command.kind === "resume") {
      const saved = browser.current?.snapshot().saved;
      const source = target.state().source;
      const entry = saved == null ? null : currentQueueEntry(saved.state);
      const playback: PendingPlayback | null = source?.kind === "Preview" ? { kind: "Preview", target: source.descriptor.target }
        : entry !== null ? { kind: "Episode", mediaId: entry.media_id }
        : saved == null && source?.kind === "Episode" ? { kind: "Episode", mediaId: source.descriptor.media_id } : null;
      retirePending();
      await enqueue(work, playback);
    } else await enqueueQueueEdit(work, selection?.kind !== "restore" && changesPlayback);
  }, [activate, enqueue, enqueueQueueEdit, requestPreferences, retainCurrent, retirePending]);
  executeRef.current = execute;
  const route = useCallback(async (command: BrowserPlayerCommand) => {
    try {
      const target = engineRef.current;
      if (target?.queue !== null && target?.queue !== undefined) {
        const header = queueViewRef.current.header;
        if (command.kind === "queue") { await queueCommand(command.request); return; }
        if (command.kind === "pause") { retainCurrent(); retirePending(); await enqueueQueueEdit(async () => { await target.pause(); }, false); return; }
        if (command.kind === "seek") {
          const subject = command.expected_subject ?? target.state().playbackSubject;
          retainCurrent(); retirePending();
          if (subject !== null) await enqueueQueueEdit(async () => { target.seekTo({ positionMs: command.position_ms, expectedSubject: subject }); }, false);
          return;
        }
        if (command.kind === "rate") { requestPreferences({ rate: command.rate }); return; }
        if (command.kind === "silence") { requestPreferences({ skipSilence: command.on }); return; }
        if (command.kind === "resume") {
          const source = target.state().source;
          if (source?.kind !== "Preview" && header !== null && header.current_entry_id !== null)
            await queueCommand({ queue_id: header.queue_id, expected_revision: header.revision, command: { kind: "select", entry_id: header.current_entry_id, play: true, position_ms: null } });
          else if (source !== null) {
            retirePending();
            await enqueue(async () => { await target.play(); }, source.kind === "Preview"
              ? { kind: "Preview", target: source.descriptor.target } : { kind: "Episode", mediaId: source.descriptor.media_id });
          } else await target.play();
          return;
        }
        if (command.kind === "stop" && header === null) { await target.dismiss(); return; }
        if (command.kind === "stop" && header !== null) { await queueCommand({ queue_id: header.queue_id, expected_revision: header.revision, command: { kind: "stop" } }); return; }
        if (command.kind === "check") { await readNativeQueue(target); return; }
      }
      await ownership.current?.command(command);
    } catch (error) { report(error); }
  }, [enqueue, enqueueQueueEdit, queueCommand, readNativeQueue, report, requestPreferences, retainCurrent, retirePending]);

  const commands = useMemo<PlayerCommands>(() => {
    const live = () => engineRef.current;
    const seekTo: PlayerCommands["seekTo"] = input => {
      const observed = !androidShell && !ownership.current?.owner() ? mirroredEngine : live()?.state();
      const subject = observed?.playbackSubject;
      if (subject == null || unavailableRef.current || input.expectedSubject !== undefined && input.expectedSubject !== subject) return;
      retainCurrent(); retirePending();
      void route({ kind: "seek", position_ms: input.positionMs, expected_subject: input.expectedSubject ?? subject });
    };
    return {
      playAudio: input => { onExplicitPlay(); return play(input); },
      createQueue,
      queueCommand: request => {
        if (request.command.kind === "select" && request.command.play) onExplicitPlay();
        return queueCommand(request);
      },
      retryQueueIndex: async () => {
        const target = live();
        if (target?.queue != null) await readNativeQueue(target, true);
        else {
          try {
            if (ownership.current?.owner()) await browser.current?.read();
            else await ownership.current?.command({ kind: "check" });
          } catch (error) {
            if (handleUnauthenticatedApiError(error)) return;
            if (!(error instanceof QueueCommandError) && (!isApiError(error) || isSameSystemApiDefect(error))) { fail({ error }); return; }
            publishQueue({ ...queueViewRef.current, index: { kind: "Failed", previous: null } });
          }
        }
      },
      stop: () => { void route({ kind: "stop" }); },
      checkQueue: () => {
        const retry = preparationRetry.current;
        if (queueViewRef.current.known && retry !== null) void retry().catch(report);
        else void route({ kind: "check" });
      },
      cancelQueuePreparation: () => { preparationRetry.current = null; retirePending(); browser.current?.preparing(false); publishQueue({ ...queueViewRef.current, phase: "Ready" }); },
      async playPreviewAudio({ target: previewTarget, resolveDescriptor }) {
        onExplicitPlay();
        const target = live();
        const result = await enqueue(async mine => {
          if (target === null || target !== live()) return;
          const source = target.state().source;
          if (source?.kind === "Preview" && source.descriptor.target === previewTarget) {
            await target.play();
            return;
          }
          let descriptor: PreviewAudioDescriptor;
          try { descriptor = await resolveDescriptor(); }
          catch (error) {
            if (mine !== latest.current || target !== live()) return;
            throw error;
          }
          if (mine !== latest.current || target !== live()) return;
          if (!androidShell && !(await ownership.current?.acquire(true, null))) return;
          if (mine === latest.current && target === live()) {
            pendingLoad.current = mine; publishPreferences(null);
            try { await target.preview(descriptor); }
            finally { if (pendingLoad.current === mine) pendingLoad.current = null; syncPreferences(); }
          }
        }, { kind: "Preview", target: previewTarget });
        return result === "Applied" ? "Installed" : result;
      },
      resume: () => {
        onExplicitPlay();
        if (!androidShell && !ownership.current?.owner()) {
          const source = mirroredEngine?.source;
          if (source?.kind === "Preview") {
            void enqueue(async mine => {
              const target = live();
              if (target === null || !(await ownership.current?.acquire(true, null)) || mine !== latest.current) return;
              await target.preview(source.descriptor);
            }, { kind: "Preview", target: source.descriptor.target }).catch(report);
          } else {
            const header = queueViewRef.current.header;
            if (header?.current_entry_id != null) void queueCommand({ queue_id: header.queue_id, expected_revision: header.revision,
              command: { kind: "select", entry_id: header.current_entry_id, play: true, position_ms: null } }).catch(() => {});
          }
        } else void route({ kind: "resume" });
      },
      pause: () => { retainCurrent(); retirePending(); void route({ kind: "pause" }); },
      seekTo,
      skipBy: deltaMs => {
        const observed = !androidShell && !ownership.current?.owner() ? mirroredEngine : live()?.state();
        if (observed !== null && observed !== undefined) seekTo({ positionMs: observed.positionMs + deltaMs });
      },
      previous() {
        const header = queueViewRef.current.header;
        if (!queueViewRef.current.known || header === null) return;
        void queueCommand({ queue_id: header.queue_id, expected_revision: header.revision, command: { kind: "previous" } }).catch(report);
      },
      next() {
        const header = queueViewRef.current.header;
        if (!queueViewRef.current.known || header === null || header.current_entry_id === null) return;
        void queueCommand({ queue_id: header.queue_id, expected_revision: header.revision, command: { kind: "next" } }).catch(report);
      },
      setPlaybackRate: rate => { if (!androidShell && !ownership.current?.owner()) void route({ kind: "rate", rate }); else requestPreferences({ rate }); },
      setShortenPauses: on => { if (!androidShell && !ownership.current?.owner()) void route({ kind: "silence", on }); else requestPreferences({ skipSilence: on }); },
      retryPlaybackPreferences: () => requestPreferences({}),
    };
  }, [enqueue, play, createQueue, queueCommand, onExplicitPlay, publishPreferences, publishQueue, syncPreferences, androidShell, mirroredEngine, requestPreferences, retainCurrent, retirePending, route, report, readNativeQueue, fail]);
  navigation.current = { ...commands, failure: report, terminal: async input => {
    const target = engineRef.current;
    const before = browser.current?.snapshot().saved;
    if (androidShell || target === null || before === null || before === undefined || !ownership.current?.owner()) return;
    const current = currentQueueEntry(before.state);
    const loaded = loadedOccurrence.current;
    if (current === null || current.media_id !== input.mediaId || target.state().playbackSubject !== input.subject ||
        loaded?.queueId !== before.state.queue_id || loaded.entryId !== current.id || loaded.subject !== input.subject) return;
    if (pendingTerminal.current !== null) return;
    const end = { queueId: before.state.queue_id, entryId: current.id, subject: input.subject };
    pendingTerminal.current = end;
    const session = browser.current;
    const generation = latest.current;
    const mayAdvance = input.advance && pendingLoad.current === null && queueViewRef.current.phase !== "Preparing";
    if (!input.advance && pendingLoad.current === null && queueViewRef.current.phase !== "Preparing")
      retainedCursor.current = { queueId: end.queueId, entryId: end.entryId };
    // Terminal recording keeps its place in the durable lane even when a newer
    // pause, seek or source preparation has already retired automatic activation.
    const terminalWrite = loads.current.then(async () => {
      if (target !== engineRef.current) return;
      const terminal: QueueTerminal = { ended_entry_id: current.id, ...await input.body };
      if (target !== engineRef.current || !ownership.current?.owner()) return;
      const latestQueue = session?.snapshot().saved;
      if (latestQueue === null || latestQueue === undefined || latestQueue.state.queue_id !== end.queueId ||
          latestQueue.state.current_entry_id !== end.entryId) return;
      const restoreRetained = async () => {
        const retained = retainedCursor.current;
        const saved = session?.snapshot().saved;
        if (target === engineRef.current && pendingTerminal.current === end && retained?.queueId === end.queueId &&
            retained.entryId === end.entryId && saved?.state.queue_id === end.queueId)
          await session?.save({ ...saved.state, current_entry_id: end.entryId });
      };
      // Capture once at this lane position, after earlier sequence edits settled.
      const state = editQueue(latestQueue.state, { kind: "next" });
      const saved = await session?.save(state, terminal);
      publishChange("Consumption");
      if (saved === null || saved === undefined) return;
      if (generation !== latest.current || !mayAdvance) { await restoreRetained(); return; }
      const next = currentQueueEntry(saved.state);
      if (next !== null) await activate(next, true, generation);
      else await target.dismiss();
      if (generation !== latest.current) await restoreRetained();
    }).finally(() => {
      if (!session?.uncertain() && pendingTerminal.current === end) {
        pendingTerminal.current = null;
        retainedCursor.current = null;
      }
    });
    loads.current = terminalWrite.catch(() => {});
    await terminalWrite;
  } };

  // Unread, reset and undo of the loaded episode: its unsaved sample settles first, the server's
  // position after.
  useEffect(
    () =>
      holdProgress({
        prepare: async (mediaId) => engine?.prepareProgressFence(mediaId),
        reconcile: async (mediaId) => engine?.reconcileProgressFence(mediaId),
      }),
    [engine],
  );

  // Space plays/pauses, ←/→ skip, shift+←/→ previous/next; never inside controls or text.
  const keyed = useRef({ commands, canPause: false, loaded: false });
  keyed.current = {
    commands,
    canPause: pendingPlayback !== null || s.phase === "Playing" || s.phase === "Buffering",
    loaded: s.source !== null || queueView.header?.current_entry_id != null,
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { commands: c, canPause, loaded } = keyed.current;
      const target = event.target;
      if ((!loaded && !canPause) || event.defaultPrevented || event.isComposing || hasActiveInteractionOwner()) return;
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        isEditableTarget(target)
      )
        return;
      if (
        target instanceof Element &&
        (target.closest("[data-player-shortcuts-disabled]") ||
          isInteractiveTarget(target))
      ) {
        return;
      }
      const shortcut = `${event.shiftKey ? "Shift+" : ""}${event.code === "Space" ? "Space" : event.key}`;
      if (shortcut !== "Space" && !loaded) return;
      const action = {
        Space: canPause ? c.pause : c.resume,
        ArrowLeft: () => c.skipBy(-PLAYER_SKIP_BACK_MS),
        ArrowRight: () => c.skipBy(PLAYER_SKIP_FORWARD_MS),
        "Shift+ArrowLeft": c.previous,
        "Shift+ArrowRight": c.next,
      }[shortcut];
      if (action === undefined) return;
      event.preventDefault();
      action();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Session readers re-render on what they show, never on the clock.
  const { positionMs, durationMs, bufferedMs, source, playbackSubject, ...display } = s;
  const derived: PlayerState =
    unavailable ??
    (source === null
      ? { kind: "Absent" }
      : { kind: "Loaded", source, ...display });
  const stable = useRef<PlayerState>(derived);
  const before: Record<string, unknown> = stable.current;
  if (Object.entries(derived).some(([key, value]) => before[key] !== value)) {
    stable.current = derived;
  }
  const state = stable.current;
  const activePreferences = preferenceState !== null && ownsPreferences(preferenceState) ? preferenceState : null;
  const nativeLoaded = androidShell && s.queue !== null && s.queue.current_entry_id !== null
    ? { queueId: s.queue.queue_id, entryId: s.queue.current_entry_id, subject: s.playbackSubject } : loadedOccurrence.current;
  const playingEntryId = !androidShell && !queueView.owner && mirroredEngine !== null ? mirroredPlayingEntryId
    : playingQueueEntry(s, queueView.header, nativeLoaded);
  const session = useMemo<PlayerSession>(() => ({
    supportsSilenceSkipping: engine?.supportsSilenceSkipping ?? false,
    state,
    pendingPlayback,
    playingEntryId,
    queue: queueView,
    preferences: activePreferences === null ? null : {
      rate: activePreferences.rate,
      skipSilence: activePreferences.skipSilence,
      application: activePreferences.application,
    },
    playbackSubject,
  }), [engine, state, pendingPlayback, playingEntryId, queueView, activePreferences, playbackSubject]);
  const chapters = episode?.chapters;
  const timeline = useMemo<PlayerTimeline>(
    () => ({
      positionMs,
      durationMs,
      bufferedMs,
      chapter: chapters?.findLast((c) => c.start_ms <= positionMs) ?? null,
    }),
    [chapters, positionMs, durationMs, bufferedMs],
  );

  return (
    <CommandsContext.Provider value={commands}>
      <SessionContext.Provider value={session}>
        <TimelineContext.Provider value={timeline}>
          {children}
        </TimelineContext.Provider>
      </SessionContext.Provider>
    </CommandsContext.Provider>
  );
}

function required<T>(value: T | null, hook: string): T {
  if (value === null)
    throw new Error(`${hook} must be used inside GlobalPlayerProvider`);
  return value;
}
export const usePlayerCommands = () =>
  required(useContext(CommandsContext), "usePlayerCommands");
export const usePlayerSession = () =>
  required(useContext(SessionContext), "usePlayerSession");
export const usePlayerTimeline = () =>
  required(useContext(TimelineContext), "usePlayerTimeline");
