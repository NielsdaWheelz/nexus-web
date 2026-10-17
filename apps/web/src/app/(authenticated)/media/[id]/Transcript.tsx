"use client";

// A transcript's surroundings: its state until the text exists (with the
// request where allowed), and above the text the playback, the chapters (the
// active one follows the player) and the show notes with seekable times.
// Playback never moves the transcript.
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { FeedbackNotice, FeedbackStatus, type FeedbackAnnouncement, type FeedbackContent } from "@/components/feedback/Feedback";
import HtmlRenderer from "@/components/HtmlRenderer";
import YouTubeEmbedFrame, { isAllowedYoutubeEmbedUrl } from "@/components/media/YouTubeEmbedFrame";
import Button from "@/components/ui/Button";
import LecternAddControl from "@/components/collections/LecternAddControl";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { registerActivityObserver } from "@/lib/consumption/capture";
import { clock } from "@/lib/documentReader/model";
import { lecternFull, useLecternCommands, useLectern } from "@/lib/lectern/lectern";
import type { MediaDetail } from "@/lib/media/mediaDetail";
import {
  playingEpisode,
  usePlayerCommands,
  usePlayerSession,
  usePlayerTimeline,
} from "@/lib/player/playerRuntime";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
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
    title: "transcript request not confirmed",
    message: reason[error.code] ?? "check this episode’s current transcript status.",
    requestId: error.requestId,
  };
}

/** No readable transcript yet: its state, the request, and polling while it runs. */
export function TranscriptState({
  media,
  onChange,
  announcement,
  returnFocus,
}: {
  readonly media: MediaDetail;
  readonly onChange: (media: Pick<MediaDetail, "transcript_state" | "transcript_coverage" | "capabilities">) => void;
  readonly announcement: FeedbackAnnouncement;
  readonly returnFocus: () => HTMLElement | null;
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
    if (busy) return;
    setBusy(true);
    try {
      await apiFetch<ApiJson<"/media/{media_id}/transcript/request", "post">>(
        `/api/media/${media.id}/transcript/request`,
        { method: "POST", body: JSON.stringify({ reason: "episode_open" }) },
      );
      await reread();
      setFailure(null);
    } catch (error) {
      if (!handleUnauthenticatedApiError(error)) setFailure(requestFailure(error));
    } finally {
      setBusy(false);
    }
  }
  const text =
    state === "not_requested"
      ? "transcript not requested"
      : state === "failed_provider"
        ? "transcription did not finish"
        : state === "queued"
          ? "transcript queued"
          : state === "running"
            ? "transcribing this episode"
            : state === "unavailable"
              ? "no transcript available for this episode"
              : "preparing this episode";
  return (
    <div className={styles.state}>
      <FeedbackStatus
        content={{ tone: "Neutral", title: text }}
        announcement={announcement}
        actions={state === "not_requested" || state === "failed_provider"
          ? [{ label: "transcribe this episode", onClick: () => void request(), busy }]
          : undefined}
        returnFocus={returnFocus}
      />
      {failure ? <FeedbackNotice content={failure} announcement={announcement} /> : null}
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
  const lectern = useLectern();
  const lecternCommands = useLecternCommands();
  const paneId = usePaneRuntime()?.paneId;
  const playRef = useRef<HTMLButtonElement | null>(null);
  const [notes] = useState(() => showNotes(media));
  const [videoFailed, setVideoFailed] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const source = media.playback_source;
  const embed = source?.kind === "external_video" && source.embed_url && isAllowedYoutubeEmbedUrl(source.embed_url) ? source.embed_url : null;
  const descriptor = media.playerDescriptor;
  // "Play next" goes after the playing episode's lectern row (the server puts it first without one).
  const playing = playingEpisode(state)?.media_id ?? null;
  const active = media.chapters.findLast((chapter) => chapter.t_start_ms <= (positionMs ?? -1));

  // A visible, loaded video in the active pane is watching time.
  useEffect(() => {
    const iframe = frame.current;
    if (!iframe || !embed) return;
    const observation = (eligible: boolean) => ({
      deviceClass: window.matchMedia("(max-width: 768px)").matches ? ("Mobile" as const) : ("Desktop" as const),
      eligible,
    });
    const activity = registerActivityObserver(media.id, "Viewing", observation(false));
    let visible = false;
    const update = () =>
      activity.observe(
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
      activity.close();
    };
  }, [embed, media.id, paneActive, videoFailed]);

  return (
    <div className={styles.transcriptChrome}>
      {media.kind === "video" ? (
        embed && !videoFailed ? (
          <YouTubeEmbedFrame ref={frame} embedUrl={embed} seekTargetMs={videoAt} className={styles.video} onError={() => setVideoFailed(true)} />
        ) : (
          <FeedbackStatus content={{ tone: "Neutral", title: "in-app video playback is unavailable" }} announcement={paneActive ? "Polite" : "None"} />
        )
      ) : descriptor ? (
        <div className={styles.playback}>
          <p>Playback continues in the global player.</p>
          <Button ref={playRef} variant="secondary" size="sm" onClick={() => playAudio(descriptor)}>
            Play
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              void lecternCommands.place({ mediaId: media.id, title: media.title,
                placement: playing !== null && playing !== media.id ? { kind: "After", media_id: playing } : { kind: "First" },
              })
            }
          >
            Play next
          </Button>
          <LecternAddControl mediaId={media.id} title={media.title}
            returnFocus={() => playRef.current?.isConnected && !playRef.current.closest("[inert]")
              ? playRef.current : findPaneLandmarkFocusTarget(paneId)} />
          {lecternFull(lectern) ? <FeedbackNotice
            content={{ tone: "Neutral", title: "lectern is full", message: "remove an item to add another." }}
            announcement="None" /> : null}
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
