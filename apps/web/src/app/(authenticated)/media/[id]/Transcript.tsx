"use client";

// A transcript's surroundings: its state until the text exists (with the
// request where allowed), and above the text the playback, the chapters (the
// active one follows the player) and the show notes with seekable times.
// Playback never moves the transcript.
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import HtmlRenderer from "@/components/HtmlRenderer";
import YouTubeEmbedFrame, { isAllowedYoutubeEmbedUrl } from "@/components/media/YouTubeEmbedFrame";
import Button from "@/components/ui/Button";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { activityRecorder } from "@/lib/consumption/activityRecorder";
import { parseMediaRef } from "@/lib/consumption/activityContract";
import { clock } from "@/lib/documentReader/model";
import { parseMediaId } from "@/lib/lectern/contract";
import { useLectern } from "@/lib/lectern/LecternProvider";
import type { MediaDetail } from "@/lib/media/mediaDetail";
import {
  playingEpisode,
  usePlayerCommands,
  usePlayerSession,
  usePlayerTimeline,
} from "@/lib/player/playerRuntime";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import styles from "./media.module.css";

function requestFailure(error: unknown): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const reason: Record<string, string> = {
    E_NETWORK: "Check your connection and retry.",
    E_RATE_LIMITED: "Wait a moment, then retry.",
    E_TRANSCRIPT_UNAVAILABLE: "No transcript is available from this source.",
    E_MEDIA_NOT_READY: "This episode is still preparing. Wait for it to settle, then retry.",
  };
  return {
    tone: "Danger",
    title: "Transcript wasn’t requested",
    message: reason[error.code] ?? "Retry the request.",
    requestId: error.requestId,
  };
}

/** No readable transcript yet: its state, the request, and polling while it runs. */
export function TranscriptState({
  media,
  onChange,
}: {
  readonly media: MediaDetail;
  readonly onChange: (media: Pick<MediaDetail, "transcript_state" | "transcript_coverage" | "capabilities">) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  const state = media.transcript_state;
  const reread = async () => {
    const { data } = await apiFetch<ApiJson<"/media/{media_id}", "get">>(`/api/media/${media.id}`);
    onChange(data);
  };
  // justify-polling: transcript provisioning has no stream; its state ends the schedule.
  useIntervalPoll({
    enabled: state === "queued" || state === "running",
    onPoll: () => reread().catch((error: unknown) => void handleUnauthenticatedApiError(error)),
    pollIntervalMs: 3_000,
  });
  async function request() {
    setBusy(true);
    setFailure(null);
    try {
      await apiFetch<ApiJson<"/media/{media_id}/transcript/request", "post">>(
        `/api/media/${media.id}/transcript/request`,
        { method: "POST", body: JSON.stringify({ reason: "episode_open" }) },
      );
      await reread();
    } catch (error) {
      if (!handleUnauthenticatedApiError(error)) setFailure(requestFailure(error));
    } finally {
      setBusy(false);
    }
  }
  const text =
    state === "not_requested"
      ? "Transcript has not been requested yet."
      : state === "failed_provider"
        ? "Previous transcription failed. You can retry on demand."
        : state === "queued"
          ? "Transcript request queued."
          : state === "running"
            ? "Transcript transcription is currently running."
            : state === "unavailable"
              ? "Transcript unavailable for this episode."
              : "This media is still being processed.";
  return (
    <div className={styles.state}>
      <p>{text}</p>
      {state === "not_requested" || state === "failed_provider" ? (
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void request()}>
          {busy ? "Requesting..." : "Transcribe this episode"}
        </Button>
      ) : null}
      {failure ? <FeedbackNotice content={failure} announcement="Assertive" /> : null}
    </div>
  );
}

/** Show notes as html with their `m:ss` / `h:mm:ss` times as seek buttons. */
function showNotes(media: MediaDetail): string | null {
  const html =
    media.description_html?.trim() ||
    (media.description_text?.trim()
      ? media.description_text
          .split(/\r?\n+/)
          .filter((line) => line.trim())
          .map((line) => {
            const p = document.createElement("p");
            p.textContent = line.trim();
            return p.outerHTML;
          })
          .join("")
      : null);
  if (!html) return null;
  const root = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html").body.firstElementChild!;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (!node.parentElement?.closest("a,button")) texts.push(node as Text);
  for (const node of texts) {
    const parts = node.data.split(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
    if (parts.length === 1) continue;
    node.replaceWith(
      ...parts.map((part, index) => {
        if (index % 2 === 0) return part;
        const units = part.split(":").map(Number);
        const ms = units.reduce((total, unit) => total * 60 + unit, 0) * 1000;
        const button = root.ownerDocument.createElement("button");
        button.type = "button";
        button.className = styles.seek;
        button.dataset.seekMs = String(ms);
        button.setAttribute("aria-label", `Seek to ${part}`);
        button.textContent = part;
        return button;
      }),
    );
  }
  return root.innerHTML;
}

/** Playback, chapters and show notes above the transcript text. */
export function TranscriptChrome({
  media,
  paneActive,
  videoAt,
  onSeek,
}: {
  readonly media: MediaDetail;
  readonly paneActive: boolean;
  /** Where the video embed starts (a seek reloads it there). */
  readonly videoAt: number | null;
  readonly onSeek: (ms: number) => void;
}) {
  const { playAudio } = usePlayerCommands();
  const { state } = usePlayerSession();
  const { positionMs } = usePlayerTimeline();
  const { placeItems, resource } = useLectern();
  const [notes] = useState(() => showNotes(media));
  const [videoFailed, setVideoFailed] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const source = media.playback_source;
  const embed = source?.kind === "external_video" && source.embed_url && isAllowedYoutubeEmbedUrl(source.embed_url) ? source.embed_url : null;
  const descriptor = media.playerDescriptor.kind === "Present" ? media.playerDescriptor.value : null;
  const ready = resource.status === "ready";
  // "Play next" goes after the playing episode's lectern row, else first.
  const playing = playingEpisode(state)?.mediaId ?? null;
  const playingRow = ready ? resource.data.items.find((item) => item.mediaSummary.mediaId === playing) : undefined;
  const active = media.chapters.findLast((chapter) => chapter.t_start_ms <= (positionMs ?? -1));

  // A visible, loaded video in the active pane is watching time.
  useEffect(() => {
    const iframe = frame.current;
    if (!iframe || !embed) return;
    const key = `video:${media.id}`;
    const observation = (eligible: boolean) => ({
      mediaRef: parseMediaRef(`media:${media.id}`),
      modality: "Viewing" as const,
      deviceClass: window.matchMedia("(max-width: 768px)").matches ? ("Mobile" as const) : ("Desktop" as const),
      eligible,
    });
    const recorder = activityRecorder();
    const unregister = recorder.registerObserver(key, observation(false));
    let visible = false;
    const update = () =>
      recorder.observe(
        key,
        observation(visible && paneActive && !videoFailed && document.visibilityState === "visible" && (document.hasFocus() || document.activeElement === iframe)),
      );
    const observer = new IntersectionObserver(([entry]) => {
      visible = (entry?.intersectionRatio ?? 0) >= 0.5;
      update();
    }, { threshold: [0, 0.5] });
    observer.observe(iframe);
    for (const [target, name] of [[document, "visibilitychange"], [window, "focus"], [window, "blur"]] as const)
      target.addEventListener(name, update);
    return () => {
      observer.disconnect();
      for (const [target, name] of [[document, "visibilitychange"], [window, "focus"], [window, "blur"]] as const)
        target.removeEventListener(name, update);
      unregister();
    };
  }, [embed, media.id, paneActive, videoFailed]);

  return (
    <div className={styles.transcriptChrome}>
      {media.kind === "video" ? (
        embed && !videoFailed ? (
          <YouTubeEmbedFrame ref={frame} embedUrl={embed} seekTargetMs={videoAt} className={styles.video} onError={() => setVideoFailed(true)} />
        ) : (
          <p className={styles.status}>In-app video playback is unavailable.</p>
        )
      ) : descriptor ? (
        <div className={styles.playback}>
          <p>Playback continues in the global player.</p>
          <Button variant="secondary" size="sm" disabled={!ready} onClick={() => playAudio(descriptor)}>
            Play
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!ready || (playingRow !== undefined && playing === media.id)}
            onClick={() =>
              void placeItems({
                mediaIds: [parseMediaId(media.id)],
                placement: playingRow ? { kind: "After", itemId: playingRow.itemId } : { kind: "First" },
              })
            }
          >
            Play next
          </Button>
          <Button variant="secondary" size="sm" disabled={!ready} onClick={() => void placeItems({ mediaIds: [parseMediaId(media.id)], placement: { kind: "Last" } })}>
            Add to Lectern
          </Button>
        </div>
      ) : null}
      {(media.kind === "video" || !descriptor) && (source?.source_url || media.canonical_source_url) ? (
        <a href={source?.source_url || media.canonical_source_url!} target="_blank" rel="noopener noreferrer" className={styles.textButton}>
          Open in source ↗
        </a>
      ) : null}
      {media.chapters.length > 0 ? (
        <section aria-label="Episode chapters">
          <h2 className={styles.kind}>Chapters</h2>
          <ol className={styles.chapters}>
            {media.chapters.map((chapter) => (
              <li key={chapter.chapter_idx}>
                <button
                  type="button"
                  aria-current={chapter === active ? "true" : undefined}
                  aria-label={`Jump to chapter ${chapter.chapter_idx + 1}: ${chapter.title}`}
                  onClick={() => onSeek(chapter.t_start_ms)}
                >
                  <span>{clock(chapter.t_start_ms)}</span> {chapter.title}
                </button>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {notes ? (
        <section
          aria-label="Show notes"
          onClick={(event: MouseEvent<HTMLElement>) => {
            const ms = (event.target as HTMLElement).closest<HTMLElement>("[data-seek-ms]")?.dataset.seekMs;
            if (ms) onSeek(Number(ms));
          }}
        >
          <h2 className={styles.kind}>Show Notes</h2>
          <HtmlRenderer htmlSanitized={notes} headingLevelOffset={2} />
        </section>
      ) : null}
    </div>
  );
}
