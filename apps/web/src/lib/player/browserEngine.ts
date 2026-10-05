"use client";

/**
 * The browser's audio engine: one `<audio>` element, the episode's listening writer, its
 * activity observer, the media session and the natural-end settle.
 *
 * Listening writes are fenced by the reset epoch alone, so they are idempotent samples: one
 * flight at a time carrying the newest sample, at once on pause, seek and rate, every 15 s while
 * playing, and with `keepalive` on pagehide. A stale epoch (409) adopts the server's position.
 * Only the attached episode samples the element; a detached one sends what it already holds.
 *
 * "News" is a sample the server may not have: playing, seeking, a write in flight or failed.
 * Without news this device's position is no newer than the server's, so a play asks the server
 * (another device may have moved or reset it) and an unload writes nothing.
 * The device that hears an end settles it; the server picks what plays next.
 */

import { apiCommand204, apiKeepaliveJson, isApiError } from "@/lib/api/client";
import { absent, present, type Presence } from "@/lib/api/presence";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { PreviewAudioDescriptor } from "@/lib/browse/contract";
import {
  parseMediaRef,
  type ActivityDeviceClass,
} from "@/lib/consumption/activityContract";
import { activityRecorder } from "@/lib/consumption/activityRecorder";
import { publishConsumptionProjectionChange } from "@/lib/consumption/projectionRevision";
import type {
  ConsumptionResult,
  ListeningIn,
  MediaId,
  NaturalEnd,
  PlayerDescriptor,
} from "@/lib/lectern/contract";
import { buildMediaImageProxySrc } from "@/lib/media/imageProxy";
import {
  IDLE_ENGINE_STATE,
  PLAYER_SKIP_BACK_MS,
  PLAYER_SKIP_FORWARD_MS,
  type Engine,
  type EngineState,
} from "@/lib/player/playerRuntime";

export interface BrowserEngineDeps {
  settle(
    input: NaturalEnd & { clientMutationId: string },
  ): Promise<ConsumptionResult>;
  /** The server's descriptor now; null when it does not answer in time. */
  fresh(mediaId: MediaId): Promise<PlayerDescriptor | null>;
  deviceClass(): ActivityDeviceClass;
  onPrevious(): void;
  onNext(): void;
}

const VOLUME_KEY = "nexus.globalPlayer.volume";
const WRITE_EVERY_MS = 15_000;
const LAST_WRITE_BOUND_MS = 2_000;
const SETTLE_RETRY_MS = [2_000, 5_000, 15_000, 60_000];
const ERRORS: Record<number, string> = {
  1: "Playback was interrupted.",
  2: "Network error. Check your connection.",
  3: "Audio format error.",
  4: "Audio URL unavailable.",
};

interface Episode {
  readonly descriptor: PlayerDescriptor;
  resetEpoch: number;
  overrideRevision: Presence<number>; // the natural-end fence
  ratePinned: boolean;
  queued: ListeningIn | null; // the newest sample not yet sent
  writing: Promise<void> | null;
  stopped: boolean; // 404 or a refused body: write no more
  observer: (() => void) | null;
}

export function createBrowserEngine(deps: BrowserEngineDeps): Engine {
  const audio = document.createElement("audio");
  audio.preload = "auto";
  audio.preservesPitch = true;
  audio.hidden = true;
  audio.setAttribute("aria-label", "Media player audio");
  document.body.append(audio);
  try {
    const stored = Number(window.localStorage.getItem(VOLUME_KEY) ?? "1");
    audio.volume = Number.isFinite(stored)
      ? Math.min(1, Math.max(0, stored))
      : 1;
  } catch {
    // justify-ignore-error: storage is a convenience; the default volume stands.
  }
  const listeners = new Set<() => void>();
  let state: EngineState = { ...IDLE_ENGINE_STATE, volume: audio.volume };
  let episode: Episode | null = null;
  let generation = 0; // a load or dismiss retires everything the previous source started
  let asked = 0; // the latest play or pause: a resume awaiting the server yields to a newer one
  let positionStateAt = 0;

  const set = (patch: Partial<EngineState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const ms = (seconds: number) =>
    Number.isFinite(seconds) ? Math.floor(seconds * 1000) : 0;
  const phase = (): EngineState["phase"] =>
    audio.ended
      ? "Ended"
      : audio.paused
        ? "Paused"
        : audio.readyState < 3
          ? "Buffering"
          : "Playing";
  const durationMs = () =>
    ms(audio.duration) ||
    (episode?.descriptor.durationMs.kind === "Present"
      ? episode.descriptor.durationMs.value
      : 0);

  // ---- listening ----
  /** The attached episode's sample, read from the element. */
  const listening = (current: Episode): ListeningIn => {
    const duration = durationMs();
    const positionMs = Math.min(ms(audio.currentTime), duration || Infinity);
    return {
      positionMs,
      durationMs: duration > 0 ? present(duration) : absent<number>(),
      episodePlaybackRate: current.ratePinned
        ? present(audio.playbackRate)
        : absent<number>(),
      expectedResetEpoch: current.resetEpoch,
    };
  };
  const path = (mediaId: MediaId) =>
    `/api/media/${mediaId}/listening-state` as const;
  const news = (current: Episode) =>
    !audio.ended &&
    (!audio.paused ||
      audio.seeking ||
      current.writing !== null ||
      !state.synced);

  /** Queues the attached episode's sample (a detached one is never sampled again) and sends
   * the queue: one flight at a time, each carrying the newest queued sample. */
  const write = (current: Episode | null = episode): Promise<void> => {
    if (current === null || current.stopped) return Promise.resolve();
    if (current === episode && !audio.ended)
      current.queued = listening(current);
    if (current.writing === null && current.queued !== null)
      current.writing = send(current);
    return current.writing ?? Promise.resolve();
  };
  const send = async (current: Episode) => {
    try {
      for (let body = current.queued; body !== null; body = current.queued) {
        current.queued = null;
        try {
          await apiCommand204(path(current.descriptor.mediaId), {
            method: "PUT",
            body: JSON.stringify(body),
          });
          if (current === episode) set({ synced: true });
          publishConsumptionProjectionChange();
        } catch (error) {
          if (handleUnauthenticatedApiError(error)) return;
          const status = isApiError(error) ? error.status : 0;
          if (isApiError(error) && status === 409) {
            // The listening was reset elsewhere: the reset wins, so take its position and epoch.
            const server = error.details?.current as {
              positionMs: number;
              resetEpoch: number;
            };
            current.queued = null; // sampled under the old epoch
            adoptInto(current, server.positionMs, server.resetEpoch, false);
          } else if (status === 0 || status >= 500) {
            current.queued ??= body; // the attached episode retries on the tick or `online`
            if (current === episode) set({ synced: false });
            return;
          } else {
            current.stopped = true;
            console.warn("listening_write_refused", { status });
            return;
          }
        }
      }
    } finally {
      current.writing = null;
    }
  };

  const adoptInto = (
    target: Episode,
    positionMs: number,
    resetEpoch: number,
    pause: boolean,
  ) => {
    target.resetEpoch = resetEpoch;
    if (target !== episode) return;
    if (pause) audio.pause();
    audio.currentTime = positionMs / 1000;
    set({ synced: true, positionMs });
  };

  /** Detaches the episode, its last sample taken now if it has news (without news, writing it
   * again would undo a position another device wrote since). Its writes are awaited for at most
   * 2 s, so a dead network cannot hold the next play. */
  const closeEpisode = async () => {
    const current = episode;
    if (current !== null && news(current)) void write(current);
    episode = null;
    audio.pause();
    if (current === null) return;
    current.observer?.();
    current.observer = null;
    await Promise.race([
      current.writing,
      new Promise((resolve) => setTimeout(resolve, LAST_WRITE_BOUND_MS)),
    ]);
  };

  // ---- activity ----
  const observation = (current: Episode, eligible: boolean) => {
    const duration = durationMs();
    const positionMs = ms(audio.currentTime);
    return {
      mediaRef: parseMediaRef(`media:${current.descriptor.mediaId}`),
      modality: "Listening" as const,
      deviceClass: deps.deviceClass(),
      eligible,
      measurement: {
        progress: duration > 0 ? Math.min(1, positionMs / duration) : undefined,
        mediaPositionMs: positionMs,
      },
    };
  };
  const observe = (current: Episode, eligible: boolean) => {
    if (current.observer !== null) {
      activityRecorder().observe(
        `audio:${current.descriptor.mediaId}`,
        observation(current, eligible),
      );
    }
  };

  // ---- natural end ----
  const settle = async (current: Episode, mine: number) => {
    const clientMutationId = crypto.randomUUID();
    const input = {
      clientMutationId,
      mediaId: current.descriptor.mediaId,
      terminalListening: listening(current),
      expectedConsumptionOverrideRevision: current.overrideRevision,
    };
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await deps.settle(input);
        if (mine !== generation) return;
        set({ synced: true });
        const next =
          result.nextItem.kind === "Present"
            ? result.nextItem.value.activation
            : null;
        if (result.outcome === "Done" && next?.kind === "FooterAudio") {
          await engine.load(next.descriptor);
        }
        return;
      } catch (error) {
        if (handleUnauthenticatedApiError(error) || mine !== generation) return;
        const status = isApiError(error) ? error.status : 0;
        if (
          (status !== 0 && status < 500) ||
          attempt >= SETTLE_RETRY_MS.length
        ) {
          console.warn("natural_end_settle_failed", { status });
          return;
        }
        set({ synced: false });
        await new Promise((resolve) =>
          setTimeout(resolve, SETTLE_RETRY_MS[attempt]),
        );
        if (mine !== generation) return;
      }
    }
  };

  // ---- media session ----
  const session =
    typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ["play", () => engine.play()],
    ["pause", () => engine.pause()],
    ["seekbackward", () => engine.skipBy(-PLAYER_SKIP_BACK_MS)],
    ["seekforward", () => engine.skipBy(PLAYER_SKIP_FORWARD_MS)],
    ["previoustrack", () => deps.onPrevious()],
    ["nexttrack", () => deps.onNext()],
    [
      "seekto",
      (details) =>
        details.seekTime !== undefined &&
        engine.seekTo(details.seekTime * 1000),
    ],
    ["stop", () => void engine.dismiss()],
  ];
  const showSession = () => {
    if (!session) return;
    const source = state.source;
    for (const [action, handler] of handlers) {
      const unsupported =
        source?.kind === "Preview" && action.endsWith("track");
      try {
        session.setActionHandler(
          action,
          source === null || unsupported ? null : handler,
        );
      } catch {
        // justify-ignore-error: browsers support subsets of the actions.
      }
    }
    if (source === null) {
      session.metadata = null;
      session.playbackState = "none";
      return;
    }
    const { kind, descriptor } = source;
    const art =
      kind === "Episode"
        ? descriptor.artworkUrl.kind === "Present" &&
          buildMediaImageProxySrc(descriptor.artworkUrl.value)
        : descriptor.imageUrl.kind === "Present" && descriptor.imageUrl.value;
    const artist =
      kind === "Preview"
        ? descriptor.source
        : descriptor.subtitle.kind === "Present"
          ? descriptor.subtitle.value
          : undefined;
    session.metadata = new MediaMetadata({
      title: descriptor.title,
      artist,
      album: artist,
      artwork: art ? [{ src: art }] : [],
    });
  };
  const showPosition = (force: boolean) => {
    if (!session || Date.now() - positionStateAt < (force ? 0 : 1000)) return;
    positionStateAt = Date.now();
    try {
      session.playbackState = audio.paused ? "paused" : "playing";
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        session.setPositionState({
          duration: audio.duration,
          playbackRate: audio.playbackRate,
          position: Math.min(audio.currentTime, audio.duration),
        });
      }
    } catch {
      // justify-ignore-error: position state is advisory.
    }
  };

  // ---- element events ----
  const sync = () => {
    set({
      phase: phase(),
      positionMs: ms(audio.currentTime),
      durationMs: durationMs(),
      bufferedMs: audio.buffered.length
        ? ms(audio.buffered.end(audio.buffered.length - 1))
        : 0,
      rate: audio.playbackRate,
      volume: audio.volume,
    });
  };
  const events: Record<string, () => void> = {
    timeupdate: () => {
      sync();
      showPosition(false);
      if (episode) observe(episode, !audio.paused);
    },
    playing: () => {
      sync();
      showPosition(true);
      if (episode) observe(episode, true);
    },
    pause: () => {
      sync();
      showPosition(true);
      if (episode) observe(episode, false);
      void write();
    },
    seeked: () => {
      sync();
      showPosition(true);
      void write();
    },
    ratechange: () => {
      sync();
      showPosition(true);
    },
    ended: () => {
      sync();
      const current = episode;
      if (current === null) return;
      observe(current, false);
      current.queued = null; // the settle carries the terminal sample
      void settle(current, generation);
    },
    error: () =>
      set({
        error:
          ERRORS[audio.error?.code ?? 0] ?? "Playback failed. Please retry.",
      }),
  };
  for (const name of [
    "progress",
    "durationchange",
    "waiting",
    "canplay",
    "play",
    "volumechange",
    "loadstart",
  ]) {
    events[name] = sync;
  }
  for (const [name, handler] of Object.entries(events))
    audio.addEventListener(name, handler);
  const cadence = window.setInterval(() => {
    if (!audio.paused || state.synced === false) void write();
  }, WRITE_EVERY_MS);
  const onPageHide = () => {
    if (episode === null || episode.stopped || !news(episode)) return;
    void apiKeepaliveJson(
      path(episode.descriptor.mediaId),
      listening(episode),
    ).catch(() => undefined);
  };
  const onOnline = () => void write();
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("online", onOnline);

  const seekOnceLoaded = (positionMs: number) =>
    audio.addEventListener(
      "loadedmetadata",
      () => (audio.currentTime = positionMs / 1000),
      {
        once: true,
      },
    );

  /** Retire the current source and play `source` from `url`; false when a later start won. */
  const start = async (
    url: string,
    rate: number,
    positionMs: number,
    next: Episode | null,
  ) => {
    const mine = ++generation;
    await closeEpisode();
    if (mine !== generation) return false;
    episode = next;
    audio.src = url;
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
    seekOnceLoaded(positionMs);
    set({
      error: null,
      synced: true,
      positionMs,
      durationMs: 0,
      bufferedMs: 0,
      rate,
    });
    void audio.play().catch(() => sync());
    return true;
  };

  const engine: Engine = {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async load(descriptor) {
      const { streamUrl, playbackRate, positionMs, resetEpoch, mediaId } =
        descriptor;
      const next: Episode = {
        descriptor,
        resetEpoch,
        overrideRevision: descriptor.consumptionOverrideRevision,
        ratePinned: false,
        queued: null,
        writing: null,
        stopped: false,
        observer: null,
      };
      if (!(await start(streamUrl, playbackRate, positionMs, next))) return;
      next.observer = activityRecorder().registerObserver(
        `audio:${mediaId}`,
        observation(next, false),
      );
      set({ source: { kind: "Episode", descriptor } });
      showSession();
    },
    async preview(descriptor: PreviewAudioDescriptor) {
      if (!(await start(descriptor.audioUrl, 1, 0, null))) return;
      set({ source: { kind: "Preview", descriptor } });
      showSession();
    },
    play(given) {
      const current = episode;
      const mine = ++asked;
      if (state.source === null) return;
      if (state.error !== null) {
        audio.load();
        seekOnceLoaded(state.positionMs);
        set({ error: null });
      } else if (current !== null && !news(current)) {
        void deps.fresh(current.descriptor.mediaId).then((fresh) => {
          if (mine !== asked || current !== episode) return;
          const best =
            fresh ??
            (given && given.resetEpoch > current.resetEpoch ? given : null);
          // Moved elsewhere, reset, or ended: play the answer; else resume here under its fence.
          if (
            best !== null &&
            (audio.ended ||
              best.resetEpoch !== current.resetEpoch ||
              best.positionMs !== ms(audio.currentTime))
          )
            return void engine.load(best);
          if (best !== null)
            current.overrideRevision = best.consumptionOverrideRevision;
          void audio.play().catch(() => sync());
        });
        return;
      }
      void audio.play().catch(() => sync());
    },
    pause() {
      asked += 1;
      audio.pause();
    },
    seekTo(positionMs) {
      const duration = durationMs();
      audio.currentTime =
        Math.max(
          0,
          duration > 0 ? Math.min(positionMs, duration) : positionMs,
        ) / 1000;
      sync();
    },
    skipBy: (deltaMs) => engine.seekTo(ms(audio.currentTime) + deltaMs),
    setRate(rate) {
      audio.defaultPlaybackRate = rate;
      audio.playbackRate = rate;
      if (episode !== null) {
        episode.ratePinned = true;
        void write();
      }
    },
    setVolume(volume) {
      audio.volume = volume;
      try {
        window.localStorage.setItem(VOLUME_KEY, String(volume));
      } catch {
        // justify-ignore-error: storage is a convenience.
      }
    },
    setShortenPauses: () => undefined,
    setShortenPausesDefault: () => undefined,
    adopt(mediaId, positionMs, resetEpoch) {
      if (episode?.descriptor.mediaId === mediaId)
        adoptInto(episode, positionMs, resetEpoch, true);
    },
    async dismiss() {
      generation += 1;
      await closeEpisode();
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      state = { ...IDLE_ENGINE_STATE, volume: audio.volume };
      set({});
      showSession();
    },
    close() {
      onPageHide();
      generation += 1;
      window.clearInterval(cadence);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("online", onOnline);
      for (const [name, handler] of Object.entries(events))
        audio.removeEventListener(name, handler);
      episode?.observer?.();
      audio.pause();
      audio.remove();
      listeners.clear();
    },
  };
  return engine;
}
