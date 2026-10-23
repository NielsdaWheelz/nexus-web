"use client";

/**
 * The browser's audio engine: one `<audio>` element, the episode's listening writer, its
 * activity observer, the media session and terminal listening capture.
 *
 * Listening writes are fenced by the reset epoch alone, so they are idempotent samples: one
 * flight at a time carrying the newest sample, at once on pause, seek and rate, every 15 s while
 * playing, and with `keepalive` on pagehide. A stale epoch (409) adopts the server's position.
 * Only the attached episode samples the element; a detached one sends what it already holds.
 * Command preparation holds only acknowledged/superseded progress; failure releases the hold
 * and retains the sample, with the existing player retry for an explicitly refused write.
 *
 * "News" is a sample the server may not have: playing, seeking, a write in flight or failed.
 * Without news this device's position is no newer than the server's, so a play asks the server
 * (another device may have moved or reset it) and an unload writes nothing.
 * Natural end reports its real terminal sample to the queue command owner. The engine never
 * chooses a successor; durable queue advancement precedes the next load.
 * Each installation/reload owns a fresh playback subject. A seek validates that occurrence
 * immediately before changing the element; deferred metadata work keeps the load generation
 * and applies the latest seek target, so an explicit seek outranks the initial resume point.
 * An explicit installation time overrides the outgoing episode's newer resume sample.
 */

import { ProgressPreparationError } from "@/lib/consumption/progressFence";
import { apiFetch, ApiError, isApiError } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  registerActivityObserver,
  type ActivityObservation,
  type ActivityObserver,
} from "@/lib/consumption/capture";
import { publishChange } from "@/lib/api/changes";
import { buildMediaImageProxySrc } from "@/lib/media/imageProxy";
import {
  IDLE_ENGINE_STATE,
  PLAYER_SKIP_BACK_MS,
  PLAYER_SKIP_FORWARD_MS,
  PlaybackPreferenceError,
  type Engine,
  type EngineState,
  type PlayerDescriptor,
  type PlayerCommands,
  type PreviewAudioDescriptor,
} from "@/lib/player/playerRuntime";

type ListeningIn = Schema<"ListeningIn">;
type ListeningPosition = Schema<"ListeningPositionOut">;

export interface BrowserEngineDeps {
  terminal(input: { readonly mediaId: string; readonly subject: string; readonly advance: boolean; readonly body: Promise<Schema<"NaturalEndIn">> }): Promise<void>;
  /** The server's descriptor now; null when it does not answer in time. */
  fresh(mediaId: string): Promise<PlayerDescriptor | null>;
  deviceClass(): ActivityObservation["deviceClass"];
  commands(): PlayerCommands | null;
  onFailure(error: unknown): void;
}

const WRITE_EVERY_MS = 15_000;
const LAST_WRITE_BOUND_MS = 2_000;
const ERRORS: Record<number, string> = {
  1: "Playback was interrupted.",
  2: "Network error. Check your connection.",
  3: "Audio format error.",
  4: "Audio URL unavailable.",
};

interface Episode {
  readonly descriptor: PlayerDescriptor;
  resetEpoch: number;
  overrideRevision: number | null; // the natural-end fence
  ratePinned: boolean;
  queued: ListeningIn | null; // the newest sample not yet sent
  writing: Promise<void> | null;
  stopped: boolean; // 404 or a refused body: write no more
  observer: ActivityObserver | null;
  fenced: boolean;
  active: boolean; // a play or explicit seek, never an authority installation
}

export function createBrowserEngine(deps: BrowserEngineDeps): Engine {
  const audio = document.createElement("audio");
  audio.preload = "auto";
  audio.preservesPitch = true;
  audio.hidden = true;
  audio.setAttribute("aria-label", "Media player audio");
  document.body.append(audio);
  const listeners = new Set<() => void>();
  let state: EngineState = IDLE_ENGINE_STATE;
  let episode: Episode | null = null;
  let generation = 0; // a load or dismiss retires everything the previous source started
  let metadataPositionMs = 0;
  let pendingSeek: (() => void) | null = null;
  let advanceAllowed = false;
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
    (episode?.descriptor.duration_ms != null
      ? episode.descriptor.duration_ms
      : 0);

  // ---- listening ----
  /** The attached episode's sample, read from the element. */
  const listening = (current: Episode): ListeningIn => {
    const duration = durationMs();
    const positionMs = Math.min(ms(audio.currentTime), duration || Infinity);
    return {
      position_ms: positionMs,
      duration_ms: duration > 0 ? duration : null,
      episode_playback_rate: current.ratePinned
        ? audio.playbackRate
        : null,
      expected_reset_epoch: current.resetEpoch,
    };
  };
  const path = (mediaId: string) =>
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
    if (current === null || current.stopped || current.fenced || !current.active)
      return current?.writing ?? Promise.resolve();
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
          const { data } = await apiFetch<ApiJson<"/media/{media_id}/listening-state", "put">>(path(current.descriptor.media_id), {
            method: "PUT",
            body: JSON.stringify(body),
          });
          current.overrideRevision = data.consumption_override_revision;
          if (current === episode) set({ synced: true });
          publishChange("Consumption");
        } catch (error) {
          current.queued ??= body;
          if (current === episode) set({ synced: false });
          if (handleUnauthenticatedApiError(error)) return;
          const status = isApiError(error) ? error.status : 0;
          if (isApiError(error) && status === 409) {
            // The listening was reset elsewhere: the reset wins, so take its position and epoch.
            // justify-type-assertion: the 409 carries this route's authoritative position tuple.
            const server = error.details?.current as ListeningPosition;
            current.queued = null; // sampled under the old epoch
            adoptInto(current, server);
          } else if (status === 0 || status >= 500) {
            // The attached episode retries on the tick or `online`.
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
    position: ListeningPosition,
  ) => {
    const {
      position_ms: positionMs,
      reset_epoch: resetEpoch,
      consumption_override_revision: consumptionOverrideRevision,
    } = position;
    target.resetEpoch = resetEpoch;
    target.overrideRevision = consumptionOverrideRevision;
    target.active = false;
    if (target !== episode) return;
    audio.pause();
    metadataPositionMs = positionMs;
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
    current.observer?.close();
    current.observer = null;
    await Promise.race([
      current.writing,
      new Promise((resolve) => setTimeout(resolve, LAST_WRITE_BOUND_MS)),
    ]);
  };

  // ---- activity ----
  const observation = (eligible: boolean): ActivityObservation => {
    const duration = durationMs();
    const positionMs = ms(audio.currentTime);
    return {
      deviceClass: deps.deviceClass(),
      eligible,
      measurement: {
        progress: duration > 0 ? Math.min(1, positionMs / duration) : undefined,
        mediaPositionMs: positionMs,
      },
    };
  };
  const observe = (current: Episode, eligible: boolean) =>
    current.observer?.observe(observation(eligible));

  // ---- natural end ----
  const terminalBody = async (current: Episode, terminalListening: ListeningIn): Promise<Schema<"NaturalEndIn">> => {
    await current.writing;
    if (!state.synced) {
      const fresh = await deps.fresh(current.descriptor.media_id);
      if (fresh?.reset_epoch === terminalListening.expected_reset_epoch)
        current.overrideRevision = fresh.consumption_override_revision;
    }
    return { terminal_listening: terminalListening, expected_override_revision: current.overrideRevision };
  };

  // ---- media session ----
  const session =
    typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ["play", () => deps.commands()?.resume()],
    ["pause", () => deps.commands()?.pause()],
    ["seekbackward", () => deps.commands()?.skipBy(-PLAYER_SKIP_BACK_MS)],
    ["seekforward", () => deps.commands()?.skipBy(PLAYER_SKIP_FORWARD_MS)],
    ["previoustrack", () => deps.commands()?.previous()],
    ["nexttrack", () => deps.commands()?.next()],
    [
      "seekto",
      (details) =>
        details.seekTime !== undefined &&
        deps.commands()?.seekTo({ positionMs: details.seekTime * 1000 }),
    ],
    ["stop", () => deps.commands()?.stop()],
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
        ? descriptor.artwork_url !== null &&
          buildMediaImageProxySrc(descriptor.artwork_url)
        : descriptor.imageUrl !== null && descriptor.imageUrl;
    const artist =
      kind === "Preview"
        ? descriptor.source
        : descriptor.subtitle !== null
          ? descriptor.subtitle
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
    });
  };
  const events: Record<string, () => void> = {
    timeupdate: () => {
      sync();
      showPosition(false);
      if (episode) observe(episode, !audio.paused);
    },
    playing: () => {
      if (episode?.fenced) { audio.pause(); return; }
      sync();
      showPosition(true);
      if (episode) { episode.active = true; observe(episode, true); }
      void write();
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
      const subject = state.playbackSubject;
      if (subject !== null) void deps.terminal({ mediaId: current.descriptor.media_id, subject, advance: advanceAllowed,
        body: terminalBody(current, listening(current)) }).catch(error => { set({ synced: false }); deps.onFailure(error); });
    },
    error: () =>
      set({
        playbackFailed: true,
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
    if (episode === null || episode.stopped || episode.fenced || !episode.active || !news(episode)) return;
    void apiFetch<void>(path(episode.descriptor.media_id), {
      method: "PUT",
      keepalive: true,
      body: JSON.stringify(listening(episode)),
    }).catch(() => undefined);
  };
  const onOnline = () => void write();
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("online", onOnline);

  const seekOnceLoaded = (positionMs: number) => {
    if (pendingSeek !== null) audio.removeEventListener("loadedmetadata", pendingSeek);
    metadataPositionMs = positionMs;
    const mine = generation;
    const apply = () => {
      if (mine !== generation) return;
      pendingSeek = null;
      const duration = durationMs();
      audio.currentTime = (duration > 0 ? Math.min(metadataPositionMs, duration) : metadataPositionMs) / 1000;
    };
    pendingSeek = apply;
    audio.addEventListener("loadedmetadata", apply, { once: true });
  };

  /** Retire the current source and play from `url`; null when a later start won. */
  const start = async (
    url: string,
    rate: number,
    positionMs: number,
    next: Episode | null,
    play: boolean,
  ) => {
    const mine = ++generation;
    asked += 1;
    advanceAllowed = false;
    const admission = asked;
    set({ playbackSubject: null });
    await closeEpisode();
    if (mine !== generation || admission !== asked) return null;
    episode = next;
    advanceAllowed = play;
    audio.src = url;
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
    seekOnceLoaded(positionMs);
    set({
      error: null,
      playbackFailed: false,
      synced: true,
      positionMs,
      durationMs: 0,
      bufferedMs: 0,
      rate,
    });
    if (play) void audio.play().catch(() => sync());
    return mine;
  };

  const engine: Engine = {
    supportsSilenceSkipping: false,
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    queue: null,
    async load(descriptor, play, requestedPositionMs) {
      const outgoing = episode;
      if (outgoing?.descriptor.media_id === descriptor.media_id && outgoing.resetEpoch === descriptor.reset_epoch && news(outgoing)) {
        const local = listening(outgoing);
        descriptor = { ...descriptor, position_ms: local.position_ms,
          playback_rate: local.episode_playback_rate ?? descriptor.playback_rate };
      }
      if (requestedPositionMs !== null) descriptor = { ...descriptor, position_ms: requestedPositionMs };
      const {
        stream_url: streamUrl,
        playback_rate: playbackRate,
        position_ms: positionMs,
        reset_epoch: resetEpoch,
        media_id: mediaId,
      } = descriptor;
      const next: Episode = {
        descriptor,
        resetEpoch,
        overrideRevision: descriptor.consumption_override_revision,
        ratePinned: false,
        queued: null,
        writing: null,
        stopped: false,
        observer: null,
        fenced: false,
        active: false,
      };
      const mine = await start(streamUrl, playbackRate, positionMs, next, play);
      if (mine === null || mine !== generation) return;
      if (outgoing?.descriptor.media_id === mediaId && outgoing.resetEpoch === next.resetEpoch &&
          (outgoing.overrideRevision ?? 0) > (next.overrideRevision ?? 0)) next.overrideRevision = outgoing.overrideRevision;
      next.observer = registerActivityObserver(
        mediaId,
        "Listening",
        observation(false),
      );
      set({ source: { kind: "Episode", descriptor }, playbackSubject: crypto.randomUUID() });
      showSession();
    },
    async preview(descriptor: PreviewAudioDescriptor) {
      const mine = await start(descriptor.audioUrl, 1, 0, null, true);
      if (mine === null || mine !== generation) return;
      set({ source: { kind: "Preview", descriptor }, playbackSubject: crypto.randomUUID() });
      showSession();
    },
    async play(given) {
      const current = episode;
      if (current?.fenced) {
        await engine.reconcileProgressFence(current.descriptor.media_id);
        throw new ApiError(409, "E_PLAYBACK_REFUSED", current.fenced
          ? "listening progress is unavailable. retry to synchronize it."
          : "listening progress synchronized. press play to resume.");
      }
      const mine = ++asked;
      advanceAllowed = true;
      if (state.source === null)
        throw new ApiError(409, "E_PLAYBACK_STALE", "playback source changed. try again.");
      if (state.error !== null) {
        // Explicit retry may resume a refused sample; never replace it with a fresh read.
        if (current !== null && current.queued !== null) current.stopped = false;
        generation += 1;
        set({ playbackSubject: crypto.randomUUID(), error: null, playbackFailed: false });
        audio.load();
        seekOnceLoaded(state.positionMs);
      } else if (current !== null && !news(current)) {
        const fresh = await deps.fresh(current.descriptor.media_id);
        if (mine !== asked || current !== episode) return;
        const best = fresh ?? (given && given.reset_epoch > current.resetEpoch ? given : null);
        if (best !== null && (audio.ended || best.reset_epoch !== current.resetEpoch ||
            best.position_ms !== ms(audio.currentTime))) {
          await engine.load(best, true, null);
          return;
        }
        if (best !== null) current.overrideRevision = best.consumption_override_revision;
      }
      void audio.play().catch(() => sync());
    },
    async pause() {
      advanceAllowed = false;
      asked += 1;
      audio.pause();
    },
    cancelPendingPlayback() { asked += 1; },
    async seekAndPlay(mediaId, positionMs) {
      const current = episode;
      if (current?.descriptor.media_id !== mediaId || state.playbackSubject === null || audio.ended)
        throw new ApiError(409, "E_PLAYBACK_STALE", "playback source changed. try again.");
      if (current.fenced)
        throw new ApiError(409, "E_PLAYBACK_REFUSED", "listening progress is being synchronized. try again after it finishes.");
      if (state.error !== null)
        throw new ApiError(409, "E_PLAYBACK_REFUSED", "playback failed. retry in the player, then choose this time again.");
      asked += 1;
      advanceAllowed = true;
      current.active = true;
      metadataPositionMs = Math.min(positionMs, durationMs() || Infinity);
      if (audio.readyState === 0) seekOnceLoaded(metadataPositionMs);
      audio.currentTime = metadataPositionMs / 1000;
      void audio.play().catch(() => sync());
      sync();
    },
    seekTo({ positionMs, expectedSubject }) {
      const subject = expectedSubject ?? state.playbackSubject;
      if (subject === null || subject !== state.playbackSubject || episode?.fenced) return;
      advanceAllowed = !audio.paused;
      asked += 1;
      if (episode) episode.active = true;
      const duration = durationMs();
      metadataPositionMs = Math.max(0, duration > 0 ? Math.min(positionMs, duration) : positionMs);
      audio.currentTime = metadataPositionMs / 1000;
      sync();
    },
    skipBy: (deltaMs) => engine.seekTo({ positionMs: ms(audio.currentTime) + deltaMs }),
    async setRate(rate) {
      audio.defaultPlaybackRate = rate;
      audio.playbackRate = rate;
      sync();
      if (episode !== null) {
        episode.ratePinned = true;
        void write();
      }
    },
    async setShortenPauses(on) {
      if (on) throw new PlaybackPreferenceError("silence skipping is not available in this browser.");
      set({ shortenPauses: false });
    },
    async prepareProgressFence(mediaId) {
      const current = episode;
      if (current?.descriptor.media_id !== mediaId) return;
      const draining = news(current) ? write(current) : current.writing;
      current.fenced = true;
      asked += 1;
      audio.pause();
      await draining;
      if (current.queued !== null) {
        current.fenced = false;
        if (current === episode) set({ error: "Progress couldn’t be saved. Retry to sync progress.", synced: false });
        throw new ProgressPreparationError();
      }
      current.active = false;
    },
    async reconcileProgressFence(mediaId) {
      const current = episode;
      if (current?.descriptor.media_id !== mediaId || !current.fenced) return;
      const fresh = await deps.fresh(mediaId);
      if (current !== episode) return;
      if (fresh === null) {
        set({ error: "Listening position unavailable. Retry to sync progress.", synced: false });
        return;
      }
      adoptInto(current, fresh);
      current.fenced = false;
      set({ error: null });
    },
    async dismiss() {
      const mine = ++generation;
      set({ playbackSubject: null });
      await closeEpisode();
      if (mine !== generation) return;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      state = IDLE_ENGINE_STATE;
      set({});
      showSession();
    },
    close() {
      generation += 1;
      asked += 1;
      if (pendingSeek !== null) audio.removeEventListener("loadedmetadata", pendingSeek);
      window.clearInterval(cadence);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("online", onOnline);
      for (const [name, handler] of Object.entries(events))
        audio.removeEventListener(name, handler);
      episode?.observer?.close();
      if (episode !== null) { episode.queued = null; episode.stopped = true; }
      episode = null;
      audio.pause();
      audio.remove();
      listeners.clear();
    },
  };
  return engine;
}
