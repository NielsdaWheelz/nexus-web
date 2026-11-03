"use client";

// A captured episode is a package, not a fabricated live MediaDetail. The saved
// transcript uses the ordinary reader with no cursor writes or playback highlighting;
// its annotations are the account's local authored highlights of this media.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Hold, useOutcome } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { WIRE_HEADER } from "@/lib/api/client";
import type { Schema } from "@/lib/api/wire";
import { WIRE_REVISION } from "@/lib/api/wire.gen";
import { assertNever } from "@/lib/assertNever";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { effectiveEpisode, episodeProgress, useListening } from "@/lib/consumption/listening";
import DocumentReaderView, { useDocumentReader, useReaderState } from "@/lib/documentReader/DocumentReader";
import { Contents } from "@/lib/documentReader/chrome/Contents";
import { useCompactAnnotations } from "@/lib/documentReader/chrome/CompactAnnotations";
import { locatePassage } from "@/lib/documentReader/annotations";
import { readerDocument } from "@/lib/documentReader/model";
import type { ReaderSource } from "@/lib/documentReader/ports";
import { useHostPolicy } from "@/lib/host/policy";
import { LocalMutationObservationError, localCall, localContentAvailable, localMutation, readyEpisode, useLocalContent, type LocalItem } from "@/lib/offline/localContent";
import { useMobileChrome } from "@/lib/mobileShell/chrome";
import { useMobileViewport } from "@/lib/mobileShell/viewport";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { retryNativeListening } from "@/lib/player/nativeEngine";
import { usePlayerCommands, usePlayerSession } from "@/lib/player/playerRuntime";
import { useArrivalFailure, useSourceArrival } from "@/lib/reader/sourceArrival";
import type { Inspection, Reader } from "@/lib/documentReader/DocumentReader";
import { useReaderContext } from "@/lib/reader/ReaderContext";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { formatByteCount } from "@/lib/text/formatByteCount";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import { readerDestinationHref, destinationTarget, useReaderVisit } from "./hostedReader";
import { PublisherNotes } from "./Transcript";
import styles from "./media.module.css";

export interface EpisodeManifest {
  readonly format_version: 1;
  readonly account_id: string;
  readonly media_id: string;
  readonly package_id: string;
  readonly capture: Schema<"EpisodeDownloadOut">;
  readonly audio: { readonly byte_count: number; readonly mime: string; readonly duration_ms: number | null };
}
export type SavedEpisode =
  | { readonly kind: "Loading" }
  | { readonly kind: "Absent" }
  | { readonly kind: "Failed"; readonly retry: () => void }
  | { readonly kind: "Ready"; readonly manifest: EpisodeManifest; readonly item: LocalItem };
const componentPath = (id: string, packageId: string, component: string) =>
  `/_nexus/device/episodes/${encodeURIComponent(id)}/${encodeURIComponent(packageId)}/${component}`;
async function localResponse(path: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(path, { signal, cache: "no-store", headers: { [WIRE_HEADER]: String(WIRE_REVISION) } });
  if (!response.ok) throw new Error(`downloaded content answered ${response.status}`);
  return response;
}

/** Resolve device availability independently of live detail and saved catalog coverage. */
export function useSavedEpisode(mediaId: string): SavedEpisode {
  const { index, error } = useLocalContent();
  const item = index === null ? null : readyEpisode(index, mediaId);
  const packageId = item?.package_id ?? null;
  const accountId = index?.account_id ?? null;
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => { setResult(null); setAttempt(value => value + 1); void localCall("hello").catch(() => undefined); }, []);
  const [result, setResult] = useState<{ readonly packageId: string; readonly manifest: EpisodeManifest | null } | null>(null);
  useEffect(() => {
    if (packageId === null || accountId === null) return;
    const abort = new AbortController();
    void localResponse(componentPath(mediaId, packageId, "episode.json"), abort.signal).then(response => response.json()).then((manifest: EpisodeManifest) => {
      if (manifest.format_version !== 1 || manifest.account_id !== accountId || manifest.media_id !== mediaId || manifest.package_id !== packageId || manifest.capture.media_id !== mediaId)
        throw new Error("downloaded episode identity is invalid");
      if (!abort.signal.aborted) setResult({ packageId, manifest });
    }).catch(() => { if (!abort.signal.aborted) setResult({ packageId, manifest: null }); });
    return () => abort.abort();
  }, [accountId, mediaId, packageId, attempt]);
  if (!localContentAvailable) return { kind: "Absent" };
  if (index === null) return error === null ? { kind: "Loading" } : { kind: "Failed", retry };
  if (item === null || packageId === null) return { kind: "Absent" };
  if (result?.packageId !== packageId) return { kind: "Loading" };
  if (result.manifest === null) return { kind: "Failed", retry };
  return { kind: "Ready", manifest: result.manifest, item };
}

export default function DownloadedEpisode({ saved, onIntent }: {
  readonly saved: Extract<SavedEpisode, { kind: "Ready" }>;
  readonly onIntent: () => void;
}) {
  const { manifest, item } = saved;
  const { capture, media_id: id, package_id: packageId } = manifest;
  const runtime = requirePaneRuntime(usePaneRuntime(), "DownloadedEpisode");
  const isMobile = useIsMobileViewport();
  const { profile } = useReaderContext();
  const { Image } = useHostPolicy();
  const chrome = useMobileChrome();
  const viewport = useMobileViewport();
  const { playAudio, pause } = usePlayerCommands();
  const { state: player } = usePlayerSession();
  const { run } = useActionRuntime();
  const listening = useListening();
  const [contents, setContents] = useState(false);
  const [artwork, setArtwork] = useState<string | null>(null);
  const { say } = useOutcome();
  const [retrying, setRetrying] = useState(false);
  const transcriptReady = item.extras?.transcript.kind === "Ready";
  const readerRef = useRef<Reader | null>(null);
  const arrivalRef = useRef<ReturnType<typeof useSourceArrival> | null>(null);
  const savedView = useReaderVisit(readerRef);
  const source = useMemo<ReaderSource>(() => ({
    async load(signal) {
      const response = await localResponse(componentPath(id, packageId, "transcript.json"), signal);
      const body = await response.json() as { readonly data: Schema<"ReaderTranscriptDocumentOut"> };
      return readerDocument(body.data);
    },
    async refreshPdf() { throw new Error("episode transcript has no pdf"); },
  }), [id, packageId]);
  const reader = useDocumentReader(`${id}:${packageId}`, useMemo(() => ({ source, progress: null, entry: { fresh: null, cold: null, view: savedView }, host: {
    onIntent: (intent: { readonly kind: "Navigate"; readonly signal: AbortSignal | null } | { readonly kind: "Read" }) => {
      onIntent();
      arrivalRef.current?.supersede({ preserveSignal: intent.kind === "Navigate" ? intent.signal : null, retireFailure: intent.kind === "Navigate" });
    },
    scrollport: (element: HTMLElement, changed: (reason: "Occlusion" | "Layout") => void) => {
      const releaseChrome = chrome.registerReaderScrollport(element);
      const releaseViewport = viewport.registerReaderScrollport(element, changed);
      return () => { releaseChrome(); releaseViewport(); };
    },
    navigation: {
      href: (destination: Parameters<typeof readerDestinationHref>[1]) => {
        const href = readerDestinationHref(id, destination);
        if (href === null) return null;
        const url = new URL(href, window.location.origin); url.searchParams.set("view", "downloaded");
        return `${url.pathname}${url.search}${url.hash}`;
      },
      activate: (destination: Parameters<typeof readerDestinationHref>[1], intent: "default" | "new_pane", onDefault: () => void) => {
        if (intent === "default") { onDefault(); return "Accepted"; }
        const href = readerDestinationHref(id, destination);
        if (href === null) return "Refused";
        const result = runtime.activateTarget({ target: { href: `${href}${href.includes("?") ? "&" : "?"}view=downloaded` }, disposition: { kind: "Fork" } });
        return result.kind === "Cancelled" ? "Refused" : "Accepted";
      },
    },
  } }), [chrome, viewport, source, id, onIntent, runtime, savedView]), transcriptReady);
  readerRef.current = reader;
  // without a saved transcript, retained quotes and their notes still list and stay editable.
  const annotations = useCompactAnnotations(reader, id, { kind: "podcast_episode", label: capture.rendition.title }, transcriptReady);
  const document = useReaderState(reader, state => state.document);
  const doc = document.status === "ready" ? document.doc : null;
  const restored = useReaderState(reader, state => state.restored);
  const [inspection, setInspection] = useState<(Inspection & { activationId: string }) | null>(null);
  const arrival = useSourceArrival({ ready: restored || !transcriptReady, sourceIdentity: doc?.identity ?? null,
    apply: async (target, context) => {
      if (context.signal.aborted) return "Cancelled";
      if (target.kind === "source") return target.source.location.kind === "resource" ? "Applied" : "Unavailable";
      if (target.kind === "passage") {
        const location = doc && locatePassage(doc, id, target.passage, target.canonical_source_ref);
        if (!location) return "Unavailable";
        if (!context.restored) {
          const outcome = await reader.inspect({ target: location.target, signal: context.signal });
          switch (outcome.kind) {
            case "Unavailable": return "FailureHandled";
            case "Cancelled": return "Cancelled";
            case "Arrived":
            case "Unchanged": break;
            default: assertNever(outcome);
          }
        }
        const current = reader.getState().document;
        if (context.signal.aborted) return "Cancelled";
        if (current.status !== "ready" || current.doc.identity !== location.inspection.identity) return "Unavailable";
        setInspection({ ...location.inspection, activationId: context.activationId });
        context.signal.addEventListener("abort", () => {
          setInspection(current => current?.activationId === context.activationId ? null : current);
        }, { once: true });
        if (context.mayFocus()) reader.focusSource();
        return "Applied";
      }
      if (target.kind !== "reader_destination") return "Unavailable";
      const destination = destinationTarget(target.destination, reader);
      if (destination === null) return "Unavailable";
      if (!context.restored) {
        const outcome = await reader.inspect({ target: destination, signal: context.signal });
        if (outcome.kind === "Cancelled") return "Cancelled";
        if (outcome.kind === "Unavailable") return "FailureHandled";
      }
      if (context.mayFocus()) reader.focusSource();
      return "Applied";
    },
  });
  arrivalRef.current = arrival;
  useArrivalFailure(arrival.failure);
  const retryListening = () => void retryNativeListening(id).catch(() =>
    say({ fact: "couldn’t resume listening sync." }, [{ label: "retry", commandKey: "RetryListeningSync", run: retryListening }]));
  usePaneChrome({ displayTitle: capture.rendition.title, resourceRef: canonicalResourceRef({ scheme: "media", id }),
    header: { kind: "Resource", resource: { status: "Ready", creditGroups: [] } } });
  usePaneReturnReady(!transcriptReady || document.status === "ready" || document.status === "failed");
  const artworkReady = item.extras?.artwork.kind === "Ready";
  useEffect(() => {
    if (!artworkReady) return;
    const abort = new AbortController();
    let url: string | null = null;
    void localResponse(componentPath(id, packageId, "artwork"), abort.signal).then(response => response.blob()).then(blob => {
      if (!abort.signal.aborted) { url = URL.createObjectURL(blob); setArtwork(url); }
    // artwork is decorative: a copy that won't open leaves its slot empty.
    }).catch(() => {});
    return () => { abort.abort(); if (url !== null) URL.revokeObjectURL(url); setArtwork(null); };
  }, [artworkReady, id, packageId]);
  const observation = capture.playback_baseline.observation;
  const entry = listening.facts?.episodes.get(id);
  const effective = effectiveEpisode({ revision: observation.consumption_revision, state: observation.state, source_duration_ms: capture.rendition.duration_ms }, entry);
  const fraction = episodeProgress(effective ?? { status: observation.state.consumption_override_status, position_ms: observation.state.position_ms,
    duration_ms: observation.state.duration_ms ?? manifest.audio.duration_ms ?? capture.rendition.duration_ms, lectern_member: observation.state.lectern_member });
  const sourceUnavailable = entry?.local?.disposition === "SourceUnavailable";
  const loaded = player.kind === "Loaded" && player.source.kind === "Episode" && player.source.descriptor.media_id === id;
  const play = useCallback((ms: number | null) => {
    run({ ref: `media:${id}`, id: "Playback", label: "play", feedbackLabel: "play", title: capture.rendition.title, confirmation: null, tracked: false,
      execute: () => playAudio({ mediaId: id, knownDescriptor: null, positionMs: ms, source: null, recapture: false }) });
  }, [capture.rendition.title, id, playAudio, run]);
  const openTime = (event: TargetActivationEvent, ms: number) => {
    const intent = workspaceTargetActivationIntent(event);
    if (intent.kind === "Unowned") return;
    event.preventDefault();
    if (intent.kind === "Consume") return;
    onIntent();
    if (intent.intent === "new_pane") {
      say({ fact: "this timestamp can’t open in a new pane." }); return;
    }
    play(ms);
  };
  const [extrasUnknown, setExtrasUnknown] = useState<number | null>(null);
  const extrasFailed = item.extras !== null && Object.values(item.extras).some(extra => extra.kind === "Failed" && extra.reason !== "Changed" && extra.reason !== "TooLarge" && extra.reason !== "E_MEDIA_NOT_READY");
  useEffect(() => { if (!extrasFailed) setExtrasUnknown(null); }, [extrasFailed]);
  async function retryExtras() {
    if (retrying) return;
    setRetrying(true);
    try { await localMutation("retry_extras", { media_id: id, package_id: packageId }); setExtrasUnknown(null); }
    catch (error) {
      if (error instanceof LocalMutationObservationError) {
        if (error.observation.receipt !== null) setExtrasUnknown(null);
        else setExtrasUnknown(attempt => (attempt ?? 0) + 1);
        return;
      }
      say({ fact: "couldn’t fetch the missing content." }, [{ label: "retry", commandKey: "RetryMissingContent", run: () => void retryExtras() }]);
    }
    finally { setRetrying(false); }
  }
  const transcript = item.extras?.transcript;
  const transcriptCopy = transcript?.kind === "Absent" ? "this episode has no published transcript."
    : transcript?.kind === "Pending" ? "the transcript is still downloading."
    : transcript?.kind === "Failed" ? transcript.reason === "Changed" ? "the published transcript changed after download."
      : transcript.reason === "TooLarge" ? "the transcript was too large to download."
      : transcript.reason === "E_MEDIA_NOT_READY" ? "no transcript existed when this was downloaded." : "couldn’t download the transcript."
    : null;
  const header = <div className={styles.savedEpisode} onPointerDown={onIntent} onKeyDown={onIntent}>
    {artwork === null ? null : <Image className={styles.savedArtwork} src={artwork} alt="" width={80} height={80} unoptimized onError={() => setArtwork(null)} />}
    <h1>{capture.rendition.title}</h1>
    {capture.rendition.subtitle === null ? null : <p>{capture.rendition.subtitle}</p>}
    <p>downloaded · {formatByteCount(manifest.audio.byte_count)}</p>
    {loaded && player.source.kind === "Episode" && player.source.packageId !== null ? <p>{player.phase === "Playing" ? "playing downloaded audio" : "downloaded audio"}</p> : null}
    <div className={styles.savedActions}><Button onClick={() => { if (loaded && player.phase === "Playing") pause(); else play(null); }}>{loaded && player.phase === "Playing" ? "pause" : "play"}</Button>
      {extrasFailed ? <Button aria-busy={retrying} disabled={retrying} onClick={() => void retryExtras()}>retry missing content</Button> : null}
      {sourceUnavailable ? <Button onClick={retryListening}>retry listening sync</Button> : null}
      {doc?.kind === "text" && doc.toc.length > 0 ? <Button aria-expanded={contents} onClick={() => { onIntent(); setContents(value => !value); }}>contents</Button> : null}
    </div>
    {extrasUnknown !== null ? <Hold id={`episode-extras:${id}:${packageId}`} attempt={extrasUnknown}
      line={{ fact: "not sure the missing content started.", reason: UNKNOWN_OUTCOME_REASON }}
      verbs={[{ label: "retry", commandKey: "RetryMissingContent", run: () => void retryExtras(), busy: retrying }]} /> : null}
    {fraction === null ? null : <p>{Math.round(fraction * 100)}% listened</p>}
    {sourceUnavailable ? <p>the original isn’t available. listening stays saved on this device.</p> : null}
    {capture.show_notes.kind === "Available" ? <PublisherNotes title={capture.rendition.title} html={capture.show_notes.html} hrefForTime={() => null} onOpenTime={openTime} />
      : capture.show_notes.kind === "Unavailable" ? <p>{capture.show_notes.reason === "TooLarge" ? "show notes were too large to download." : "show notes weren’t available."}</p> : null}
    {transcriptCopy === null ? null : <p>{transcriptCopy}</p>}
    {capture.transcript.kind === "Available" && capture.transcript.coverage === "partial" && transcriptReady ? <p>this transcript is partial.</p> : null}
    {contents ? <Contents reader={reader} /> : null}
  </div>;
  if (!transcriptReady) return <div className={styles.stateScrollport} data-mobile={isMobile}>{header}{annotations.list}{annotations.panel}</div>;
  return <div className={styles.layout}>
    <DocumentReaderView reader={reader} profile={profile} isMobile={isMobile} playback={null} showCaptureTitle={false}
      before={<>{header}{annotations.list}</>} onSeekTime={ms => { onIntent(); play(ms); }}
      inspection={inspection} decorations={annotations.decorations} onSelection={annotations.onSelection} onMarks={annotations.onMarks} />
    {annotations.panel}
  </div>;
}
