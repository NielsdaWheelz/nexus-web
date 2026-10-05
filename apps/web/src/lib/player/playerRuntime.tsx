"use client";

/**
 * The global player: one audio engine per device (the browser's `<audio>`, or the Android
 * service behind `window.nexusAudio`), rendered from one `EngineState`, plus what only the web
 * shell knows: device history (previous/next), what plays next, and where a play starts.
 *
 * Every play starts from the server's resume point: another media loads its fresh descriptor,
 * and the loaded one resumes through its engine, which asks the server unless it holds a newer
 * sample itself. Loads run one at a time, last request winning, so a replay never reads a
 * position older than this device's own last write. The engine that hears an end settles it;
 * the server picks the next.
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
import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import { absent, present, type Presence } from "@/lib/api/presence";
import type { ApiJson } from "@/lib/api/wire";
import type {
  DiscoveryTargetHandle,
  PreviewAudioDescriptor,
} from "@/lib/browse/contract";
import {
  playerDescriptorFromWire,
  type ChapterOut,
  type LecternItem,
  type MediaId,
  type PlayerDescriptor,
} from "@/lib/lectern/contract";
import { useLectern } from "@/lib/lectern/LecternProvider";
import { createBrowserEngine } from "@/lib/player/browserEngine";
import {
  createNativeEngine,
  nativePlayerAvailable,
} from "@/lib/player/nativeEngine";
import { savePodcastSubscriptionSettings } from "@/lib/podcasts/subscriptionSettings";
import {
  useAndroidShell,
  useViewportState,
} from "@/lib/renderEnvironment/provider";
import { isInteractiveTarget } from "@/lib/ui/interactiveTarget";
import { isEditableTarget } from "@/lib/ui/isEditableTarget";

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
  /** Pause shortening (Android only; null: unsupported): effective, this session's override,
   * the device default, and the time it has saved on this device. */
  readonly shortenPauses: boolean | null;
  readonly shortenPausesSession: boolean | null;
  readonly shortenPausesDefault: boolean | null;
  readonly shortenPausesSavedMs: number;
  readonly error: string | null; // playback failure
  readonly synced: boolean; // the newest listening sample is stored
}

export const IDLE_ENGINE_STATE: EngineState = {
  source: null,
  phase: "Paused",
  positionMs: 0,
  durationMs: 0,
  bufferedMs: 0,
  rate: 1,
  volume: 1,
  shortenPauses: null,
  shortenPausesSession: null,
  shortenPausesDefault: null,
  shortenPausesSavedMs: 0,
  error: null,
  synced: true,
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
  /** Pins the episode rate. */
  setRate(rate: number): void;
  setVolume(volume: number): void;
  /** This session's override; null returns to the podcast's or the device's setting. */
  setShortenPauses(on: boolean | null): void;
  setShortenPausesDefault(on: boolean): void;
  adopt(mediaId: MediaId, positionMs: number, resetEpoch: number): void;
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
export interface PlayerSession {
  readonly state: PlayerState;
  readonly nextUp: PlayerDescriptor | null;
}
export interface PlayerTimeline {
  readonly positionMs: number;
  readonly durationMs: number;
  readonly bufferedMs: number;
  readonly chapter: ChapterOut | null;
}
export interface PreviewAudioPosition {
  readonly positionMs: number;
  readonly durationMs: Presence<number>;
}
export interface PlayerCommands {
  playAudio(descriptor: PlayerDescriptor): void;
  playPreviewAudio(descriptor: PreviewAudioDescriptor): void;
  stopPreviewAudio(target: DiscoveryTargetHandle): PreviewAudioPosition | null;
  resume(): void;
  pause(): void;
  seekTo(positionMs: number): void;
  skipBy(deltaMs: number): void;
  previous(): void;
  next(): void;
  setPlaybackRate(rate: number): void;
  rememberPlaybackRateForPodcast(): Promise<void>;
  setVolume(volume: number): void;
  setShortenPauses(on: boolean | null): void;
  setShortenPausesDefault(on: boolean): void;
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
  mediaId: MediaId,
): Promise<PlayerDescriptor | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FRESH_DESCRIPTOR_BOUND_MS);
  try {
    const body = await apiFetch<ApiJson<"/media/{media_id}/player", "get">>(
      `/api/media/${mediaId}/player`,
      { signal: controller.signal, cache: "no-store" },
    );
    return decodeApiPayload(
      body,
      ({ data }) => playerDescriptorFromWire(data),
      "GET player",
    );
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The first audio row after the current media's row (from the head when it has none). */
function lecternNext(
  items: readonly LecternItem[],
  current: PlayerDescriptor | null,
) {
  const at = items.findIndex(
    (item) => item.mediaSummary.mediaId === current?.mediaId,
  );
  for (const item of items.slice(at + 1)) {
    if (
      item.activation.kind === "FooterAudio" &&
      item.mediaSummary.mediaId !== current?.mediaId
    ) {
      return item.activation.descriptor;
    }
  }
  return null;
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
  const [responding, setResponding] = useState(true);

  useEffect(() => {
    if (androidShell && !nativePlayerAvailable) return;
    const created = androidShell
      ? createNativeEngine(accountId, setResponding)
      : createBrowserEngine({
          settle: (input) => lecternRef.current.settleNaturalEnd(input),
          fresh: freshDescriptor,
          deviceClass: () => (mobileRef.current ? "Mobile" : "Desktop"),
          onPrevious: () => navigation.current.previous(),
          onNext: () => navigation.current.next(),
        });
    engineRef.current = created;
    setEngine(created);
    return () => {
      engineRef.current = null;
      created.close();
    };
  }, [accountId, androidShell]);

  const subscribe = useCallback(
    (listener: () => void) => engine?.subscribe(listener) ?? (() => {}),
    [engine],
  );
  const s = useSyncExternalStore(
    subscribe,
    () => engine?.state() ?? IDLE_ENGINE_STATE,
    () => IDLE_ENGINE_STATE,
  );
  const episode = s.source?.kind === "Episode" ? s.source.descriptor : null;

  // ---- device history ----
  const back = useRef<PlayerDescriptor[]>([]);
  const forward = useRef<PlayerDescriptor[]>([]);
  const navigatingTo = useRef<MediaId | null>(null);
  const requested = useRef<MediaId | null>(null);
  const shown = useRef<PlayerDescriptor | null>(null);
  useEffect(() => {
    const before = shown.current;
    shown.current = episode;
    if (before === null || before.mediaId === episode?.mediaId) return;
    if (episode !== null && episode.mediaId === navigatingTo.current) {
      navigatingTo.current = null;
      return;
    }
    back.current.push(before);
    forward.current = [];
    // The native service advances on its own; the web's Lectern then needs the server's view.
    if (
      androidShell &&
      episode !== null &&
      episode.mediaId !== requested.current
    ) {
      lecternRef.current.revalidate();
    }
  }, [androidShell, episode]);
  useEffect(() => {
    if (androidShell && s.phase === "Ended") lecternRef.current.revalidate();
  }, [androidShell, s.phase]);

  const lecternItems =
    lectern.resource.status === "ready" ? lectern.resource.data.items : null;
  // Forward history changes only with a source change, so `episode` covers it.
  const nextUp = useMemo(
    () => forward.current.at(-1) ?? lecternNext(lecternItems ?? [], episode),
    [episode, lecternItems],
  );

  // ---- loads: one at a time, the latest request wins ----
  const loads = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef(0);
  const enqueue = useCallback((work: () => Promise<void>) => {
    const mine = ++latest.current;
    loads.current = loads.current.then(async () => {
      if (mine !== latest.current) return;
      await work().catch((error: unknown) =>
        console.warn("player_load_failed", error),
      );
    });
  }, []);
  const play = useCallback(
    (descriptor: PlayerDescriptor) => {
      const target = engineRef.current;
      if (target === null) return;
      requested.current = descriptor.mediaId;
      const mine = latest.current + 1;
      enqueue(async () => {
        const fresh = await freshDescriptor(descriptor.mediaId);
        if (mine === latest.current) await target.load(fresh ?? descriptor);
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
      navigatingTo.current = target.mediaId;
      play(target);
    };
    return {
      playAudio(descriptor) {
        // The loaded episode resumes through its engine, which owns where a resume starts.
        if (playing()?.mediaId === descriptor.mediaId) live()?.play(descriptor);
        else play(descriptor);
      },
      playPreviewAudio(descriptor) {
        const target = live();
        if (target !== null) enqueue(() => target.preview(descriptor));
      },
      stopPreviewAudio(target) {
        const state = current();
        if (
          state.source?.kind !== "Preview" ||
          state.source.descriptor.target !== target
        )
          return null;
        void live()?.dismiss();
        return {
          positionMs: state.positionMs,
          durationMs:
            state.durationMs > 0 ? present(state.durationMs) : absent(),
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
        const lecternTarget = lecternNext(
          lecternRef.current.getCanonicalSnapshot()?.items ?? [],
          now,
        );
        if (lecternTarget !== null) play(lecternTarget);
      },
      setPlaybackRate: (rate) => live()?.setRate(rate),
      async rememberPlaybackRateForPodcast() {
        const now = playing();
        if (now?.podcastId.kind !== "Present") return;
        await savePodcastSubscriptionSettings(now.podcastId.value, {
          defaultPlaybackSpeed: present(current().rate),
        });
      },
      setVolume: (volume) => live()?.setVolume(volume),
      setShortenPauses: (on) => live()?.setShortenPauses(on),
      setShortenPausesDefault: (on) => live()?.setShortenPausesDefault(on),
      dismiss: () => void live()?.dismiss(),
    };
  }, [enqueue, play]);
  navigation.current = commands;

  // A reset elsewhere arrives with the Lectern's progressState: the loaded episode adopts it.
  useEffect(
    () =>
      lecternRef.current.onCanonicalInstall(({ state }) => {
        if (state.listeningState.kind !== "Present") return;
        const { positionMs, resetEpoch } = state.listeningState.value;
        engine?.adopt(state.mediaId, positionMs, resetEpoch);
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
      if (!loaded || event.defaultPrevented || event.isComposing) return;
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
    androidShell && (!nativePlayerAvailable || !responding)
      ? {
          kind: "Unavailable",
          reason: nativePlayerAvailable ? "NotResponding" : "UpdateRequired",
        }
      : source === null
        ? { kind: "Absent" }
        : { kind: "Loaded", source, ...display };
  const stable = useRef<PlayerState>(derived);
  const before: Record<string, unknown> = stable.current;
  if (Object.entries(derived).some(([key, value]) => before[key] !== value)) {
    stable.current = derived;
  }
  const state = stable.current;
  const session = useMemo(() => ({ state, nextUp }), [state, nextUp]);
  const chapters = episode?.chapters;
  const timeline = useMemo<PlayerTimeline>(
    () => ({
      positionMs,
      durationMs,
      bufferedMs,
      chapter: chapters?.findLast((c) => c.startMs <= positionMs) ?? null,
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
