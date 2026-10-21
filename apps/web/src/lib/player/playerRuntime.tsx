"use client";

/**
 * The global player: one audio engine per device (the browser's `<audio>`, or the Android
 * service behind `window.nexusPlayer`), rendered from one `EngineState`, plus what only the web
 * shell knows: device history (previous/next), what plays next, and where a play starts.
 *
 * Every play starts from the server's resume point: another media loads its fresh descriptor,
 * and the loaded one resumes through its engine, which asks the server unless it holds a newer
 * sample itself. Loads run one at a time, last request winning, so a replay never reads a
 * position older than this device's own last write. The engine that hears an end settles it and
 * plays the next audio row after the ended one, read from the Lectern before the settle.
 * Requested playback preferences are separate from observed engine state: one serialized flight
 * coalesces newer intent, fenced by engine, source reference and the existing load generation.
 * Podcast persistence belongs to the presentation owner and never invokes this runtime.
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
import { apiFetch } from "@/lib/api/client";
import { useThrowLater } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { holdProgress, settleNaturalEnd } from "@/lib/consumption/state";
import {
  lecternItems,
  lecternNext,
  useLectern,
} from "@/lib/lectern/lectern";
import type { LecternItem } from "@/lib/lectern/api";
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
  | { readonly kind: "Episode"; readonly descriptor: PlayerDescriptor }
  | { readonly kind: "Preview"; readonly descriptor: PreviewAudioDescriptor };
export type PlayerPhase = "Buffering" | "Playing" | "Paused" | "Ended";

/** What an engine reports; on Android it is the native snapshot as pushed. */
export interface EngineState {
  readonly source: PlayerSource | null;
  readonly phase: PlayerPhase;
  readonly positionMs: number;
  readonly durationMs: number; // 0 until known
  readonly bufferedMs: number;
  readonly rate: number;
  readonly volume: number;
  /** Observed processing state; requested preferences are owned separately by the runtime. */
  readonly shortenPauses: boolean;
  readonly shortenPausesSavedMs: number;
  readonly error: string | null; // playback failure
  readonly synced: boolean; // the newest listening sample is stored
  readonly consumptionRevision: number; // accepted native writes, never device-only activity
}

export const IDLE_ENGINE_STATE: EngineState = {
  source: null,
  phase: "Paused",
  positionMs: 0,
  durationMs: 0,
  bufferedMs: 0,
  rate: 1,
  volume: 1,
  shortenPauses: false,
  shortenPausesSavedMs: 0,
  error: null,
  synced: true,
  consumptionRevision: 0,
};

export interface Engine {
  state(): EngineState;
  subscribe(listener: () => void): () => void;
  /** Resolves after the outgoing session's last write (bounded at 2 s). */
  load(descriptor: PlayerDescriptor): Promise<void>;
  preview(descriptor: PreviewAudioDescriptor): Promise<void>;
  /** A resume asks the server unless this device holds a newer sample; `given` (the page's
   * descriptor) stands in for an unanswered ask when it knows a reset the session has not. */
  play(given?: PlayerDescriptor): void;
  pause(): void;
  seekTo(positionMs: number): void;
  skipBy(deltaMs: number): void;
  /** Pins the episode rate; resolves after application and snapshot publication. */
  setRate(rate: number): Promise<void>;
  setVolume(volume: number): void;
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
      "source" | "positionMs" | "durationMs" | "bufferedMs"
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
  readonly source: PlayerSource;
  readonly generation: number;
  readonly subject: string;
}

export interface PlayerSession {
  readonly state: PlayerState;
  readonly nextUp: PlayerDescriptor | null;
  readonly preferences: PlaybackPreferences | null;
  readonly playbackSubject: string | null;
}
export interface PlayerTimeline {
  readonly positionMs: number;
  readonly durationMs: number;
  readonly bufferedMs: number;
  readonly chapter: Schema<"ChapterOut"> | null;
}
export interface PreviewAudioPosition {
  readonly positionMs: number;
  readonly durationMs: number | null;
}
export interface PlayerCommands {
  playAudio(descriptor: PlayerDescriptor): void;
  playPreviewAudio(descriptor: PreviewAudioDescriptor): void;
  stopPreviewAudio(target: string): PreviewAudioPosition | null;
  resume(): void;
  pause(): void;
  seekTo(positionMs: number): void;
  skipBy(deltaMs: number): void;
  previous(): void;
  next(): void;
  setPlaybackRate(rate: number): void;
  setVolume(volume: number): void;
  setShortenPauses(on: boolean): void;
  retryPlaybackPreferences(): void;
  dismiss(): void;
}

export const PLAYER_SKIP_BACK_MS = 15_000;
export const PLAYER_SKIP_FORWARD_MS = 30_000;
const FRESH_DESCRIPTOR_BOUND_MS = 2_000;
const RESTART_AFTER_MS = 3_000;

const SessionContext = createContext<PlayerSession | null>(null);
const TimelineContext = createContext<PlayerTimeline | null>(null);
const CommandsContext = createContext<PlayerCommands | null>(null);

export function playingEpisode(state: PlayerState): PlayerDescriptor | null {
  return state.kind === "Loaded" && state.source.kind === "Episode"
    ? state.source.descriptor
    : null;
}

/** The server's current descriptor; null when the server is slow or unreachable. */
async function freshDescriptor(
  mediaId: string,
): Promise<PlayerDescriptor | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FRESH_DESCRIPTOR_BOUND_MS);
  try {
    const body = await apiFetch<ApiJson<"/media/{media_id}/player", "get">>(
      `/api/media/${mediaId}/player`,
      { signal: controller.signal, cache: "no-store" },
    );
    return body.data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The first audio row after `mediaId`'s row (from the head when it has none). */
function nextAudio(items: readonly LecternItem[], mediaId: string | null) {
  const activation = lecternNext(items, mediaId, "FooterAudio")?.activation;
  return activation?.kind === "FooterAudio" ? activation.descriptor : null;
}

export function GlobalPlayerProvider({
  accountId,
  children,
}: {
  accountId: string;
  children: ReactNode;
}) {
  const androidShell = useAndroidShell();
  const viewport = useViewportState();
  const lectern = useLectern();
  const lecternRef = useRef(lectern);
  lecternRef.current = lectern;
  const mobileRef = useRef(viewport.isMobile);
  mobileRef.current = viewport.isMobile;
  const navigation = useRef({ previous: () => {}, next: () => {} });
  const [engine, setEngine] = useState<Engine | null>(null);
  // Commands read the engine through a ref: a click can land before the render carrying it commits.
  const engineRef = useRef<Engine | null>(null);
  const loads = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef(0);
  const pendingLoad = useRef<number | null>(null);
  const sourceToken = useRef(0);
  const intent = useRef<PreferenceIntent | null>(null);
  const [preferenceState, setPreferenceState] = useState<PreferenceIntent | null>(null);
  const applying = useRef(false);
  const fail = useThrowLater();
  const publishPreferences = useCallback((value: PreferenceIntent | null) => {
    intent.current = value;
    setPreferenceState(value);
  }, []);
  const ownsPreferences = useCallback((value: PreferenceIntent) =>
    engineRef.current === value.engine &&
    value.engine.state().source === value.source &&
    latest.current === value.generation && pendingLoad.current === null,
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
    if (target === null || snapshot === undefined || snapshot.source === null) {
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
    // The processing PR supplies browser silence skipping. Until then a Natural load retains
    // its requested ON choice and fails explicitly; native restores its actual session choice.
    const skipSilence = androidShell ? snapshot.shortenPauses :
      snapshot.source.kind === "Episode" && snapshot.source.descriptor.pause_shortening_mode === "Natural";
    const needsApplication = skipSilence !== snapshot.shortenPauses;
    publishPreferences({
      engine: target,
      source: snapshot.source,
      generation: latest.current,
      subject: `${accountId}:${latest.current}:${++sourceToken.current}`,
      rate: snapshot.rate,
      skipSilence,
      application: { kind: needsApplication ? "Applying" : "Ready" },
    });
    if (needsApplication) applyPreferences();
  }, [accountId, androidShell, applyPreferences, ownsPreferences, publishPreferences]);

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

  useEffect(() => {
    if (androidShell && !nativePlayerAvailable) {
      setUnavailable({ kind: "Unavailable", reason: "UpdateRequired" });
      return;
    }
    setUnavailable(null);
    const created = androidShell
      ? createNativeEngine(accountId, (responding) =>
          setUnavailable(
            responding ? null : { kind: "Unavailable", reason: "NotResponding" },
          ),
        )
      : createBrowserEngine({
          settle: settleNaturalEnd,
          // Read before the settle removes the ended row; none when it had no row.
          next: (mediaId) => {
            const items = lecternItems(lecternRef.current);
            const onLectern = items.some((item) => item.media_summary.media_id === mediaId);
            return onLectern ? nextAudio(items, mediaId) : null;
          },
          fresh: freshDescriptor,
          deviceClass: () => (mobileRef.current ? "Mobile" : "Desktop"),
          onPrevious: () => navigation.current.previous(),
          onNext: () => navigation.current.next(),
        });
    engineRef.current = created;
    setEngine(created);
    return () => {
      engineRef.current = null;
      latest.current += 1;
      pendingLoad.current = null;
      publishPreferences(null);
      created.close();
    };
  }, [accountId, androidShell, publishPreferences]);

  const subscribe = useCallback(
    (listener: () => void) => engine?.subscribe(() => {
      syncPreferences();
      listener();
    }) ?? (() => {}),
    [engine, syncPreferences],
  );
  const s = useSyncExternalStore(
    subscribe,
    () => engine?.state() ?? IDLE_ENGINE_STATE,
    () => IDLE_ENGINE_STATE,
  );
  const episode = s.source?.kind === "Episode" ? s.source.descriptor : null;
  useEffect(syncPreferences, [engine, syncPreferences]);

  // ---- device history ----
  const back = useRef<PlayerDescriptor[]>([]);
  const forward = useRef<PlayerDescriptor[]>([]);
  const navigatingTo = useRef<string | null>(null);
  const requested = useRef<string | null>(null);
  const shown = useRef<PlayerDescriptor | null>(null);
  useEffect(() => {
    const before = shown.current;
    shown.current = episode;
    if (before === null || before.media_id === episode?.media_id) return;
    if (episode !== null && episode.media_id === navigatingTo.current) {
      navigatingTo.current = null;
      return;
    }
    back.current.push(before);
    forward.current = [];
    // The native service advances on its own; the web's Lectern then needs the server's view.
    if (
      androidShell &&
      episode !== null &&
      episode.media_id !== requested.current
    ) {
      lecternRef.current.refetch();
    }
  }, [androidShell, episode]);
  useEffect(() => {
    if (androidShell && s.phase === "Ended") lecternRef.current.refetch();
  }, [androidShell, s.phase]);

  const rows = lecternItems(lectern);
  // Forward history changes only with a source change, so `episode` covers it.
  const nextUp = useMemo(
    () => forward.current.at(-1) ?? nextAudio(rows, episode?.media_id ?? null),
    [episode, rows],
  );

  // ---- loads: one at a time, the latest request wins ----
  const enqueue = useCallback((work: () => Promise<void>) => {
    const mine = ++latest.current;
    pendingLoad.current = mine;
    publishPreferences(null);
    loads.current = loads.current.then(async () => {
      if (mine !== latest.current) return;
      try {
        await work();
      } catch (error) {
        console.warn("player_load_failed", error);
      } finally {
        if (mine === latest.current) {
          pendingLoad.current = null;
          syncPreferences();
        }
      }
    });
  }, [publishPreferences, syncPreferences]);
  const play = useCallback(
    (descriptor: PlayerDescriptor) => {
      const target = engineRef.current;
      if (target === null) return;
      requested.current = descriptor.media_id;
      const mine = latest.current + 1;
      enqueue(async () => {
        const fresh = await freshDescriptor(descriptor.media_id);
        if (mine === latest.current && target === engineRef.current)
          await target.load(fresh ?? descriptor);
      });
    },
    [enqueue],
  );

  const commands = useMemo<PlayerCommands>(() => {
    const live = () => engineRef.current;
    const current = () => live()?.state() ?? IDLE_ENGINE_STATE;
    const playing = () => {
      const source = current().source;
      return source?.kind === "Episode" ? source.descriptor : null;
    };
    const navigate = (target: PlayerDescriptor) => {
      navigatingTo.current = target.media_id;
      play(target);
    };
    return {
      playAudio(descriptor) {
        // The loaded episode resumes through its engine, which owns where a resume starts.
        if (playing()?.media_id === descriptor.media_id) live()?.play(descriptor);
        else play(descriptor);
      },
      playPreviewAudio(descriptor) {
        const target = live();
        if (target !== null) enqueue(async () => {
          if (target === live()) await target.preview(descriptor);
        });
      },
      stopPreviewAudio(target) {
        const state = current();
        if (
          state.source?.kind !== "Preview" ||
          state.source.descriptor.target !== target
        )
          return null;
        const owner = live();
        if (owner !== null) enqueue(async () => {
          if (owner === live()) await owner.dismiss();
        });
        return {
          positionMs: state.positionMs,
          durationMs:
            state.durationMs > 0 ? state.durationMs : null,
        };
      },
      resume: () => live()?.play(),
      pause: () => live()?.pause(),
      seekTo: (positionMs) => live()?.seekTo(positionMs),
      skipBy: (deltaMs) => live()?.skipBy(deltaMs),
      previous() {
        const now = playing();
        const target = back.current.at(-1);
        if (now === null) return;
        if (current().positionMs > RESTART_AFTER_MS || target === undefined) {
          live()?.seekTo(0);
          return;
        }
        back.current.pop();
        forward.current.push(now);
        navigate(target);
      },
      next() {
        const now = playing();
        const target = forward.current.pop();
        if (target !== undefined) {
          if (now !== null) back.current.push(now);
          navigate(target);
          return;
        }
        const lecternTarget = nextAudio(
          lecternItems(lecternRef.current),
          now?.media_id ?? null,
        );
        if (lecternTarget !== null) play(lecternTarget);
      },
      setPlaybackRate: (rate) => requestPreferences({ rate }),
      setVolume: (volume) => live()?.setVolume(volume),
      setShortenPauses: (on) => requestPreferences({ skipSilence: on }),
      retryPlaybackPreferences: () => requestPreferences({}),
      dismiss() {
        const owner = live();
        if (owner !== null) enqueue(async () => {
          if (owner === live()) await owner.dismiss();
        });
      },
    };
  }, [enqueue, play, requestPreferences]);
  navigation.current = commands;

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
  const keyed = useRef({ commands, playing: false, loaded: false });
  keyed.current = {
    commands,
    playing: s.phase === "Playing",
    loaded: s.source !== null,
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { commands: c, playing, loaded } = keyed.current;
      const target = event.target;
      if (!loaded || event.defaultPrevented || event.isComposing || hasActiveInteractionOwner()) return;
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
      const action = {
        Space: playing ? c.pause : c.resume,
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
  const { positionMs, durationMs, bufferedMs, source, ...display } = s;
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
  const session = useMemo<PlayerSession>(() => ({
    state,
    nextUp,
    preferences: activePreferences === null ? null : {
      rate: activePreferences.rate,
      skipSilence: activePreferences.skipSilence,
      application: activePreferences.application,
    },
    playbackSubject: activePreferences?.subject ?? null,
  }), [state, nextUp, activePreferences]);
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
