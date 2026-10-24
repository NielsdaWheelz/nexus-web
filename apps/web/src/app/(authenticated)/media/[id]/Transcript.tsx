"use client";

// Transcript admission, publisher notes, and the thin hosted playback binding.
// Only the small bindings observe the engine clock; the shared reader sees cue changes.
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type KeyboardEvent } from "react";
import { Captions } from "lucide-react";
import { FeedbackNotice, FeedbackStatus, type FeedbackAnnouncement, type FeedbackContent } from "@/components/feedback/Feedback";
import HtmlRenderer from "@/components/HtmlRenderer";
import YouTubeEmbedFrame, { isAllowedYoutubeEmbedUrl } from "@/components/media/YouTubeEmbedFrame";
import Button from "@/components/ui/Button";
import PaneSection from "@/components/ui/PaneSection";
import { apiFetch, isApiError, isRefusal, isSameSystemApiDefect, outcomeUnknown, type ApiError } from "@/lib/api/client";
import { useThrowLater } from "@/lib/api/serverState";
import type { ApiJson } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { registerActivityObserver } from "@/lib/consumption/capture";
import DocumentReaderView, { useReaderState, type DocumentReaderViewProps, type Reader } from "@/lib/documentReader/DocumentReader";
import { transcriptUnitAtTime } from "@/lib/documentReader/model";
import { activateReaderDestination } from "@/lib/documentReader/navigation";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import type { MediaDetail } from "@/lib/media/mediaDetail";
import { usePlayerSession, usePlayerTimeline } from "@/lib/player/playerRuntime";
import styles from "./media.module.css";

function requestFailure(error: ApiError): FeedbackContent {
  const reason: Record<string, string> = {
    E_NETWORK: "check your connection and retry.",
    E_RATE_LIMITED: "wait a moment, then retry.",
    E_TRANSCRIPT_UNAVAILABLE: "no transcript is available from this source.",
    E_MEDIA_NOT_READY: "this episode is still preparing. wait for it to settle, then retry.",
  };
  return {
    tone: "Danger",
    title: outcomeUnknown(error) || !isRefusal(error) ? "transcript request not confirmed"
      : error.code === "E_TRANSCRIPT_UNAVAILABLE" ? "transcript unavailable" : "couldn’t request transcript",
    message: reason[error.code] ?? "check this episode’s current transcript status.",
    requestId: error.requestId,
  };
}

/** Admission requests work; the mounted processing stream owns its subsequent state. */
export function TranscriptState({ media, announcement, returnFocus, holdFocus }: {
  readonly media: MediaDetail;
  readonly announcement: FeedbackAnnouncement;
  readonly returnFocus: () => HTMLElement | null;
  readonly holdFocus: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const throwLater = useThrowLater();
  const owner = useRef<HTMLDivElement>(null);
  const active = useRef(announcement !== "None");
  active.current = announcement !== "None";
  useLayoutEffect(() => {
    const element = owner.current;
    return () => {
      if (active.current && element?.contains(document.activeElement)) holdFocus();
    };
  }, [holdFocus]);
  async function request(control: HTMLButtonElement) {
    if (busy) return;
    // The button becomes disabled, then disappears at queued. The pane root survives both.
    if (active.current && document.activeElement === control) holdFocus();
    setBusy(true);
    try {
      await apiFetch<ApiJson<"/media/{media_id}/transcript/request", "post">>(
        `/api/media/${media.id}/transcript/request`,
        { method: "POST", body: JSON.stringify({ reason: "episode_open" }) },
      );
      setFailure(null);
    } catch (error) {
      if (!handleUnauthenticatedApiError(error)) {
        if (!isApiError(error) || isSameSystemApiDefect(error)) throwLater({ error });
        else setFailure(error);
      }
    } finally {
      setBusy(false);
    }
  }
  const state = media.transcript_state;
  const sourceUnavailable = (state === "not_requested" || state === "failed_provider") && failure?.code === "E_TRANSCRIPT_UNAVAILABLE";
  const requestable = !sourceUnavailable && (state === "not_requested" || state === "failed_provider");
  return <div ref={owner}>
    {requestable ? <>
      {state === "failed_provider" ? <FeedbackStatus content={{ tone: "Danger", title: "transcription failed" }} announcement={announcement} /> : null}
      <Button icon={<Captions />} aria-busy={busy} aria-disabled={busy} onClick={(event) => void request(event.currentTarget)}>
        {state === "failed_provider" || failure ? "retry transcription" : "transcribe"}
      </Button>
      <span className="sr-only" role="status" aria-live={announcement === "None" ? "off" : "polite"}>
        {busy ? "requesting transcript" : ""}
      </span>
    </> : <FeedbackStatus content={sourceUnavailable && failure ? requestFailure(failure) : { tone: "Neutral", title: state === "queued" ? "transcript queued"
      : state === "running" ? "transcribing" : state === "unavailable" ? "transcript unavailable" : "preparing transcript" }}
      announcement={announcement} returnFocus={returnFocus} />}
    {failure && requestable ? <FeedbackNotice content={requestFailure(failure)} announcement={announcement} /> : null}
  </div>;
}

/** Confirmed engine source time, projected only onto the displayed transcript publication. */
function useTranscriptPlayback(mediaId: string, reader: Reader, expectedKey: string | null) {
  const { state } = usePlayerSession();
  const { positionMs } = usePlayerTimeline();
  const doc = useReaderState(reader, (view) => view.document.status === "ready" ? view.document.doc : null);
  const loaded = state.kind === "Loaded" && state.source.kind === "Episode" && state.source.descriptor.media_id === mediaId;
  const unit = loaded && state.error === null && doc?.kind === "text" && doc.format === "transcript"
    && (expectedKey === null || doc.transcriptNavigation?.key === expectedKey)
    ? transcriptUnitAtTime(doc.units, positionMs) : null;
  const identity = unit !== null && doc !== null ? doc.identity : null;
  const unitId = unit?.id ?? null;
  const playback = useMemo(() => identity !== null && unitId !== null ? { identity, unit: unitId } : null, [identity, unitId]);
  return { loaded, playback };
}

const ReaderView = memo(DocumentReaderView);

/** Clock ticks stop here unless their covered cue changes. */
export function HostedReaderView({ mediaId, transcriptReaderKey, ...props }: Omit<DocumentReaderViewProps, "playback"> & {
  readonly mediaId: string;
  readonly transcriptReaderKey: string | null;
}) {
  const { playback } = useTranscriptPlayback(mediaId, props.reader, transcriptReaderKey);
  return <ReaderView {...props} playback={playback} />;
}

function PlaybackPosition({ mediaId, reader, transcriptReaderKey }: {
  readonly mediaId: string;
  readonly reader: Reader;
  readonly transcriptReaderKey: string | null;
}) {
  const { loaded, playback } = useTranscriptPlayback(mediaId, reader, transcriptReaderKey);
  const reasonId = useId();
  if (!loaded) return null;
  return <div>
    <Button disabled={playback === null} aria-describedby={playback === null ? reasonId : undefined}
      onClick={() => {
        if (playback !== null) void reader.inspect({ target: { kind: "point", point: { kind: "text", unit: playback.unit, offset: 0 } } });
      }}>
      show playback position
    </Button>
    {playback === null ? <span id={reasonId} className={styles.menuStatus}>no transcript at this time</span> : null}
  </div>;
}

/** Show notes as html with their `m:ss` / `h:mm:ss` times as seek buttons. */
function showNotes(media: { readonly title: string; readonly description_html: string | null; readonly description_text: string | null }, hrefForTime: (ms: number) => string | null): string | null {
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
  if (!root.textContent?.trim()) return null;
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
        const href = hrefForTime(ms);
        const button = root.ownerDocument.createElement(href ? "a" : "button");
        if (button instanceof HTMLAnchorElement) { button.href = href!; button.dataset.workspaceRichTarget = "true"; }
        else button.type = "button";
        button.className = styles.seek;
        button.dataset.seekMs = String(ms);
        button.setAttribute("aria-label", `play ${media.title} at ${part}`);
        button.textContent = part;
        return button;
      }),
    );
  }
  return root.innerHTML;
}

/** One publisher-notes presenter for live and downloaded sources; documents stay with their source owner. */
export function PublisherNotes({ title, html, text = null, hrefForTime, onOpenTime }: {
  readonly title: string;
  readonly html: string | null;
  readonly text?: string | null;
  readonly hrefForTime: (ms: number) => string | null;
  readonly onOpenTime: (event: TargetActivationEvent, ms: number) => void;
}) {
  const notes = useMemo(() => showNotes({ title, description_html: html, description_text: text }, hrefForTime), [title, html, text, hrefForTime]);
  if (notes === null) return null;
  const activate = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    const ms = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-seek-ms]")?.dataset.seekMs : null;
    if (ms !== null && ms !== undefined) onOpenTime(event, Number(ms));
  };
  return <PaneSection title="show notes" className={styles.showNotes} onClick={activate} onKeyDown={activate}>
    <HtmlRenderer htmlSanitized={notes} headingLevelOffset={2} className={styles.showNotesBody} />
  </PaneSection>;
}

/** Publisher notes remain expanded host content; video retains its embed behavior. */
export function TranscriptChrome({ media, paneActive, videoAt, onSeek, reader, transcriptReaderKey }: {
  readonly media: MediaDetail;
  readonly paneActive: boolean;
  readonly videoAt: number | null;
  readonly onSeek: (ms: number) => void;
  readonly reader: Reader;
  readonly transcriptReaderKey: string | null;
}) {
  const identity = useReaderState(reader, (view) => view.document.status === "ready" ? view.document.doc.identity : null);
  const [locationUnavailable, setLocationUnavailable] = useState(false);
  const openTime = (event: TargetActivationEvent, ms: number) => {
    const play = () => {
      const document = reader.getState().document;
      if (media.kind === "podcast_episode" && document.status === "ready" && document.doc.kind === "text") {
        const unit = transcriptUnitAtTime(document.doc.units, ms);
        if (unit !== null) reader.readFrom({ kind: "text", unit: unit.id, offset: 0 });
      }
      onSeek(ms);
    };
    if (identity !== null) {
      activateReaderDestination(reader, { source_identity: identity, target: { kind: "time", ms } }, event, play);
      return;
    }
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Consume") return;
    if (activation.intent === "new_pane") setLocationUnavailable(true);
    else play();
  };
  const [videoFailed, setVideoFailed] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const source = media.playback_source;
  const embed = source?.kind === "external_video" && source.embed_url && isAllowedYoutubeEmbedUrl(source.embed_url) ? source.embed_url : null;
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

  return <div className={styles.transcriptChrome}>
    {locationUnavailable ? <FeedbackNotice content={{ tone: "Warning", title: "timed reader location unavailable" }} announcement={paneActive ? "Polite" : "None"} /> : null}
    {media.kind === "video" ? embed && !videoFailed
      ? <YouTubeEmbedFrame ref={frame} embedUrl={embed} seekTargetMs={videoAt} className={styles.video} onError={() => setVideoFailed(true)} />
      : <FeedbackStatus content={{ tone: "Neutral", title: "in-app video playback is unavailable" }} announcement={paneActive ? "Polite" : "None"} /> : null}
    {(media.kind === "video" || !media.playerDescriptor) && (source?.source_url || media.canonical_source_url) ?
      <a href={source?.source_url || media.canonical_source_url!} target="_blank" rel="noopener noreferrer" className={styles.textButton}>open in source</a> : null}
    {media.kind === "podcast_episode" && identity !== null ? <PlaybackPosition mediaId={media.id} reader={reader} transcriptReaderKey={transcriptReaderKey} /> : null}
    <PublisherNotes title={media.title} html={media.description_html} text={media.description_text}
      hrefForTime={ms => identity === null ? null : reader.navigation?.href({ source_identity: identity, target: { kind: "time", ms } }) ?? null}
      onOpenTime={openTime} />
  </div>;
}
