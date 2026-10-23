"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import * as Icon from "lucide-react";
import Link from "next/link";
import { FeedbackNotice, FeedbackStatus, type FeedbackContent, type FeedbackActions } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import { buttonClassName } from "@/components/ui/control";
import Tooltip from "@/components/ui/Tooltip";
import PickerSurface from "@/components/ui/PickerSurface";
import MediaImage from "@/components/ui/MediaImage";
import MobileSheet from "@/components/ui/MobileSheet";
import { activateTargetLink, type TargetLinkActivationRuntime } from "@/lib/panes/targetLinkActivation";
import { assertNever } from "@/lib/assertNever";
import { useMobileChromeSurface } from "@/lib/mobileShell/chrome";
import { findActivePaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import { formatClock } from "@/lib/formatClock";
import {
  useMobileViewport,
  useRootTextEntryFocused,
} from "@/lib/mobileShell/viewport";
import { formatPlaybackRate } from "@/lib/player/playbackRate";
import * as Player from "@/lib/player/playerRuntime";
import { useOverlay, wasOverlayInvokedByTouch } from "@/lib/ui/overlay";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useWorkspaceStore } from "@/lib/workspace/store";
import QueuePanel, { QueueStatus } from "./QueuePanel";
import { ChapterList, PlaybackRateEditor, SkipSilenceField } from "./PlayerPlaybackControls";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { getPodcastSettings, type PodcastSettings } from "@/lib/podcasts/api";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
import { usePodcastSettingsSave } from "@/lib/podcasts/usePodcastSettingsSave";
import styles from "./Player.module.css";

type Loaded = Extract<Player.PlayerState, { kind: "Loaded" }>;

const unavailableMessages = {
  UpdateRequired: "update nexus for android",
  NotResponding: "player unavailable",
} satisfies Record<Extract<Player.PlayerState, { kind: "Unavailable" }>["reason"], string>;

const clock = (ms: number) => formatClock(ms / 1000);
const percent = (part: number, whole: number) =>
  `${whole > 0 ? (Math.min(part, whole) / whole) * 100 : 0}%`;

/** Artwork, title and subtitle as one button. */
function Identity({
  state,
  size,
  label,
  onOpen,
  href,
  buttonRef,
  status,
}: {
  state: Loaded;
  size: number;
  label: string;
  onOpen: (event: TargetActivationEvent) => void;
  href?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  status?: string | null;
}) {
  const statusId = useId();
  const { kind, descriptor } = state.source;
  const box = { alt: "", width: size, height: size, className: styles.artwork };
  const image =
    kind === "Episode"
      ? descriptor.artwork_url !== null && (
          <MediaImage
            kind="proxied"
            remoteUrl={descriptor.artwork_url}
            {...box}
          />
        )
      : descriptor.imageUrl !== null && (
          <MediaImage
            kind="proxy-src"
            src={descriptor.imageUrl}
            {...box}
          />
        );
  const subtitle =
    kind === "Preview"
      ? `preview from ${descriptor.source}`
      : descriptor.subtitle;
  const contents = <span className={styles.identityContent}>
      <span className={styles.artworkBox}>{image || <span className={styles.placeholder} style={{ width: size, height: size }} aria-hidden="true">{descriptor.title.trim().charAt(0).toLocaleUpperCase() || "N"}</span>}{status ? <span className={styles.identityStatus} aria-hidden="true"><Icon.Info size={12} /></span> : null}</span>
      <span className={styles.identityCopy}>
        <span className={styles.title}>{descriptor.title}</span>
        {subtitle ? <span className={styles.subtitle}>{subtitle}</span> : null}
      </span>
      {status ? <span id={statusId} className={styles.srOnly}>{status}</span> : null}
    </span>;
  return href ? <ButtonLink href={href} className={styles.identity} data-workspace-rich-target="true" onClick={onOpen} onKeyDown={onOpen} aria-label={`${label}${subtitle ? `, ${subtitle}` : ""}`} aria-describedby={status ? statusId : undefined}>{contents}</ButtonLink>
    : <Button ref={buttonRef} className={styles.identity} onClick={onOpen} aria-label={`${label}${subtitle ? `, ${subtitle}` : ""}`} aria-describedby={status ? statusId : undefined}>{contents}</Button>;
}

function Transport({
  state,
  compact = false,
}: {
  state: Loaded;
  compact?: boolean;
}) {
  const commands = Player.usePlayerCommands();
  const { queue, pendingPlayback } = Player.usePlayerSession();
  const offerPause = pendingPlayback !== null ||
    state.phase === "Playing" || state.phase === "Buffering";
  const episode = !compact && state.source.kind === "Episode";
  return (
    <div
      className={styles.transport}
      role="group"
      aria-label="Media player controls"
    >
      {episode ? (
        <Button size="comfortable" iconOnly icon={<Icon.SkipBack />} aria-label="Previous" onClick={commands.previous} />
      ) : null}
      {compact ? null : (
        <Button size="comfortable" iconOnly aria-label="back 15 seconds"
          onClick={() => commands.skipBy(-Player.PLAYER_SKIP_BACK_MS)}
          icon={<span className={styles.numberedSkip}><Icon.RotateCcw /><span>15</span></span>} />
      )}
      <Button
        emphasis="strong"
        size="comfortable"
        iconOnly
        className={styles.playPause}
        onClick={offerPause ? commands.pause : commands.resume}
        data-player-play="true"
        aria-busy={state.phase === "Buffering" || undefined}
        aria-description={state.phase === "Buffering" ? "buffering" : undefined}
        aria-label={offerPause ? "pause media player" : "play media player"}
        icon={offerPause ? <Icon.Pause fill="currentColor" /> : <Icon.Play fill="currentColor" />}
      />
      {compact ? null : <Button size="comfortable" iconOnly aria-label="forward 30 seconds"
        onClick={() => commands.skipBy(Player.PLAYER_SKIP_FORWARD_MS)}
        icon={<span className={styles.numberedSkip}><Icon.RotateCw /><span>30</span></span>} />}
      {episode ? (
        <Button size="comfortable" iconOnly icon={<Icon.SkipForward />}
          aria-label="Next" onClick={commands.next} disabled={queue.header === null || queue.header.current_index === null || queue.header.current_index + 1 >= queue.header.count} />
      ) : null}
    </div>
  );
}

/** A captured scrub belongs to one confirmed load; cancellation never seeks. */
function Seek({ active = true }: { readonly active?: boolean }) {
  const { positionMs, durationMs, bufferedMs } = Player.usePlayerTimeline();
  const { state, playbackSubject } = Player.usePlayerSession();
  const commands = Player.usePlayerCommands();
  const scrub = useRef<{ readonly pointerId: number; readonly subject: string; value: number; cancelled: boolean } | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const available = active && state.kind === "Loaded" && playbackSubject !== null && durationMs > 0;
  useLayoutEffect(() => {
    if (scrub.current !== null) scrub.current.cancelled = true;
    setDraft(null);
  }, [playbackSubject, available]);
  useEffect(() => () => { scrub.current = null; }, []);
  const shown = Math.max(0, Math.min(draft ?? positionMs, durationMs));
  const track = {
    "--progress": percent(shown, durationMs),
    "--buffered": percent(Math.max(shown, bufferedMs), durationMs),
  } as CSSProperties;
  return <div className={styles.seek} style={track}>
    <span className={styles.time}>{clock(shown)}</span>
    <span className={styles.track} aria-hidden="true" />
    <input type="range" className={styles.seekInput}
      min={0} max={durationMs} step={1000} value={shown} disabled={!available}
      aria-label="seek playback position" aria-valuetext={`${clock(shown)} of ${durationMs > 0 ? clock(durationMs) : "unknown duration"}`}
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0 || !available || playbackSubject === null) return;
        scrub.current = { pointerId: event.pointerId, subject: playbackSubject, value: Number(event.currentTarget.value), cancelled: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={event => {
        const captured = scrub.current;
        if (captured?.pointerId !== event.pointerId) return;
        scrub.current = null;
        setDraft(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (available && !captured.cancelled && captured.subject === playbackSubject) commands.seekTo({ positionMs: captured.value, expectedSubject: captured.subject });
      }}
      onPointerCancel={event => {
        if (scrub.current?.pointerId === event.pointerId) scrub.current.cancelled = true;
        setDraft(null);
      }}
      onLostPointerCapture={event => {
        if (scrub.current?.pointerId === event.pointerId) scrub.current.cancelled = true;
        setDraft(null);
      }}
      onKeyDown={event => {
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
          scrub.current = null;
          setDraft(null);
        }
        // Native step rounding can leave the DOM at an endpoint already.
        if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          if (available && playbackSubject !== null) commands.seekTo({
            positionMs: event.key === "Home" ? 0 : durationMs,
            expectedSubject: playbackSubject,
          });
        }
      }}
      onChange={event => {
        const value = Number(event.currentTarget.value);
        if (scrub.current !== null) {
          if (!scrub.current.cancelled) { scrub.current.value = value; setDraft(value); }
        }
        else if (available && playbackSubject !== null) commands.seekTo({ positionMs: value, expectedSubject: playbackSubject });
      }}
    />
    <span className={styles.time}>{durationMs > 0 ? clock(durationMs) : "—"}</span>
  </div>;
}

/** Plain mobile content; the overlay kernel owns Escape, Back and focus. */
function MobileDisclosure({ kind, id, close, trigger, skipReturnFocus, children }: {
  readonly kind: "Playback" | "Chapters";
  readonly id: string;
  readonly close: () => void;
  readonly trigger: () => HTMLElement | null;
  readonly skipReturnFocus: () => boolean;
  readonly children: ReactNode;
}) {
  const region = useRef<HTMLDivElement>(null);
  useOverlay(true, { kind: "transient", onDismiss: close, returnFocus: true,
    returnFocusTo: trigger, tabContinuation: () => region.current,
    skipReturnFocus: () => {
      if (skipReturnFocus()) return true;
      const active = document.activeElement;
      return active instanceof HTMLElement && active !== document.body && !region.current?.contains(active);
    },
  });
  useEffect(() => {
    if (wasOverlayInvokedByTouch()) return;
    const panel = region.current;
    const target = kind === "Playback" ? panel?.querySelector<HTMLInputElement>('input[type="range"]')
      : panel?.querySelector<HTMLButtonElement>('button[aria-current="true"]') ?? panel?.querySelector<HTMLButtonElement>('ol button');
    target?.focus({ preventScroll: true });
  }, [kind]);
  return <div ref={region} id={id} role="region" aria-label={kind === "Playback" ? "playback" : "chapters"}>{children}</div>;
}

function ChapterContext() {
  const { chapter } = Player.usePlayerTimeline();
  return chapter ? <p className={styles.eyebrow}>current chapter: {chapter.title}</p> : null;
}

/**
 * One permanent player slot. The viewport measures its untransformed box; mobile
 * chrome owns only the inner footer's motion and inertness. Load-scoped settings
 * outlive their pickers. Overlays return ordinary focus; departed controls recover
 * to idle or the active pane.
 */
export default function GlobalPlayerSurfaces({ readerComposition }: { readerComposition: boolean }) {
  const { state, queue, preferences, playbackSubject, supportsSilenceSkipping } = Player.usePlayerSession();
  const commands = Player.usePlayerCommands();
  const workspace = useWorkspaceStore();
  const isMobile = useIsMobileViewport();
  const priorMode = useRef(isMobile);
  const modeChanged = priorMode.current !== isMobile;
  const mobileViewport = useMobileViewport();
  const textEntryFocused = useRootTextEntryFocused();
  const [picker, setPicker] = useState<{ readonly subject: string; readonly kind: "Playback" | "Chapters" } | null>(null);
  const shownPicker = !modeChanged && state.kind === "Loaded" && picker !== null && picker.subject === playbackSubject ? picker.kind : null;
  const panelOpen = shownPicker === "Playback";
  const [opening, setOpening] = useState(0);
  const playbackId = useId();
  const chaptersId = useId();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const queueRef = useRef<HTMLButtonElement>(null);
  const retained = queue.header !== null && queue.header.count > 0;
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const idleRef = useRef<HTMLAnchorElement>(null);
  const rateRef = useRef<HTMLButtonElement>(null);
  const chaptersRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const sheetContentRef = useRef<HTMLDivElement>(null);
  const queueScrollRef = useRef<HTMLDivElement>(null);
  const focusedControl = useRef<HTMLElement | null>(null);
  const sourceOpened = useRef(false);
  const announcedSource = useRef<string | null>(null);
  const announcedStatus = useRef<string | null>(null);
  const announcedPhase = useRef<Loaded["phase"] | null>(null);
  const announcedUnavailable = useRef<string | null>(null);
  const announcedSettings = useRef<string | null>(null);
  const loaded = state.kind === "Loaded" ? state : null;
  const identity = loaded === null ? null : `${loaded.source.kind}:${
    loaded.source.kind === "Episode"
      ? loaded.source.descriptor.media_id
      : loaded.source.descriptor.target
  }`;
  const { accountId } = useAuthenticatedAccount();
  const podcastId = loaded?.source.kind === "Episode" ? loaded.source.descriptor.podcast_id : null;
  const stamp = useChangeStamp("Podcasts");
  const settingsRead = usePaneFreeServerValue({
    key: podcastId === null ? null : `podcast-settings:${accountId}:${podcastId}:${playbackSubject}`,
    stale: `${stamp}:${opening}`,
    load: signal => {
      if (podcastId === null) throw new Error("a podcast read requires a podcast");
      return getPodcastSettings(podcastId, signal);
    },
  });
  const save = usePodcastSettingsSave(podcastId, playbackSubject === null ? null : `${accountId}:${playbackSubject}`);
  const title = loaded?.source.descriptor.title;
  const status = loaded === null ? null : loaded.error ??
    (loaded.phase === "Buffering" ? "Buffering" : loaded.synced ? null : "Progress sync paused");
  const operation = save.state;
  let settingsStatus: string | null = null;
  let settingsFailed = false;
  if (operation !== null) {
    switch (operation.kind) {
      case "Saving": settingsStatus = "saving podcast defaults…"; break;
      case "Reading": settingsStatus = "checking saved settings…"; break;
      case "Unknown":
      case "ReadFailed": settingsStatus = "save not confirmed. open playback settings to check."; settingsFailed = true; break;
      case "Rejected": settingsStatus = "couldn’t save podcast defaults. open playback settings to try again."; settingsFailed = true; break;
      case "Review":
      case "Replaced":
      case "Absent": settingsStatus = "saved settings need review. open playback settings."; settingsFailed = true; break;
      case "Accepted": break;
      default: assertNever(operation);
    }
  }
  if (preferences !== null) {
    switch (preferences.application.kind) {
      case "Ready": break;
      case "Applying": if (!settingsFailed) settingsStatus = "applying playback settings…"; break;
      case "Failed": settingsStatus = "couldn’t apply playback settings. open playback settings to try again."; settingsFailed = true; break;
      default: assertNever(preferences.application);
    }
  }
  const unavailable = state.kind === "Unavailable" ? unavailableMessages[state.reason] : null;
  const sheetShown = !modeChanged && isMobile && sheetOpen;
  const currentSurface = useRef({ sheetShown, playbackSubject });
  currentSurface.current = { sheetShown, playbackSubject };
  const suppressed = isMobile && (sheetShown || textEntryFocused);
  const linkRuntime: TargetLinkActivationRuntime = {
    activateTarget: input => workspace.activateWorkspaceTarget({
      ...input, originPaneId: workspace.state.active_primary_pane_id,
    }),
  };

  useMobileChromeSurface(footerRef, isMobile);
  useLayoutEffect(() => {
    if (!isMobile || suppressed || slotRef.current === null) return;
    return mobileViewport.registerBottomSurface("Player", slotRef.current, footerRef.current);
  }, [isMobile, suppressed, mobileViewport, readerComposition]);

  // Loaded replacement retains the sheet but retires its old disclosure.
  useLayoutEffect(() => { setPicker(null); }, [playbackSubject, isMobile, sheetOpen]);
  useLayoutEffect(() => { priorMode.current = isMobile; setSheetOpen(false); setQueueOpen(false); }, [isMobile]);

  const returnFocus = useCallback((opener: HTMLElement | null): { element: HTMLElement; preventScroll: true } | null => {
    const element = [opener, idleRef.current, findActivePaneLandmarkFocusTarget()]
      .find(candidate => {
        if (!candidate?.isConnected) return false;
        const blocker = candidate.closest("[hidden], [inert]");
        // The overlay retries after this slot's closing suppression commits.
        if (candidate === opener && blocker === slotRef.current && !textEntryFocused) {
          return slotRef.current?.parentElement?.closest("[hidden], [inert]") === null;
        }
        return blocker === null && candidate.getClientRects().length > 0;
      });
    return element ? { element, preventScroll: true } : null;
  }, [textEntryFocused]);
  useLayoutEffect(() => {
    const departed = focusedControl.current;
    if (departed === null) return;
    if (departed.isConnected && !departed.matches(":disabled") && !departed.closest("[hidden], [inert]") && departed.getClientRects().length > 0) return;
    focusedControl.current = null;
    const active = document.activeElement;
    const pane = findActivePaneLandmarkFocusTarget();
    if (active !== document.body && active !== pane && active !== departed) return;
    const target = sheetShown ? sheetContentRef.current?.querySelector<HTMLButtonElement>('[data-player-play="true"]')
      : returnFocus(null)?.element;
    target?.focus({ preventScroll: true });
  }, [state, isMobile, preferences, sheetShown, returnFocus]);

  useEffect(() => {
    switch (state.kind) {
      case "Absent":
        setAnnouncement(announcedSource.current === null ? null : "playback stopped");
        announcedSource.current = null;
        announcedStatus.current = null;
        announcedPhase.current = null;
        announcedUnavailable.current = null;
        break;
      case "Unavailable":
        if (unavailable !== announcedUnavailable.current) setAnnouncement(unavailable);
        announcedUnavailable.current = unavailable;
        break;
      case "Loaded": {
        const recovering = announcedUnavailable.current !== null;
        announcedUnavailable.current = null;
        const started = state.error === null && state.phase === "Playing";
        if (identity !== announcedSource.current) {
          const observation = started ? "now playing"
            : state.error ?? (state.phase === "Buffering" ? "buffering" : "audio loaded");
          setAnnouncement(`${observation}: ${title}`);
        } else if (started && announcedPhase.current !== "Playing") {
          setAnnouncement(`now playing: ${title}`);
        } else if (status !== null && status !== "Buffering" && status !== announcedStatus.current) setAnnouncement(status);
        else if (settingsStatus !== null && settingsStatus !== announcedSettings.current) setAnnouncement(settingsStatus);
        else if (recovering) setAnnouncement(null);
        announcedSettings.current = settingsStatus;
        announcedSource.current = identity;
        announcedStatus.current = status;
        announcedPhase.current = state.phase;
        break;
      }
      default: assertNever(state);
    }
  }, [state, identity, title, status, unavailable, settingsStatus]);

  useEffect(() => {
    const message = queue.phase === "Preparing" ? "preparing queue…" : queue.phase === "Saving" ? "saving queue…"
      : queue.phase === "Uncertain" ? "couldn’t confirm queue change" : queue.error;
    if (message !== null) setAnnouncement(message);
  }, [queue.phase, queue.error]);
  const openQueue = <Button ref={queueRef} size="comfortable" icon={<Icon.ListMusic />} aria-label="up next"
    aria-haspopup="dialog" aria-expanded={isMobile ? sheetShown : queueOpen}
    onClick={() => { if (isMobile) { sourceOpened.current = false; setSheetOpen(true); } else setQueueOpen(value => !value); }}>up next</Button>;
  let contents: ReactNode;
  let overlays: ReactNode = null;
  let sheetPlayerContent: ReactNode = null;
  switch (state.kind) {
    case "Absent": {
      const openLectern = (event: TargetActivationEvent) => activateTargetLink({
        event, runtime: linkRuntime, target: { href: "/lectern", labelHint: "lectern" },
      });
      contents = <div className={styles.idle}>
        <Icon.Headphones className={styles.idleGlyph} aria-hidden="true" />
        <span className={styles.idleCopy}>{retained ? queue.header?.current_entry_id === null ? "queue finished" : "playback stopped" : "nothing queued"}</span>
        {retained ? <Button iconOnly size="comfortable" icon={<Icon.SkipBack />} aria-label="previous" onClick={commands.previous} disabled={queue.phase !== "Ready"} /> : null}
        {retained ? <Button onClick={commands.resume} disabled={queue.phase !== "Ready" || queue.header?.current_entry_id === null}>resume</Button> : null}
        {openQueue}
        <Tooltip text="open lectern" triggerRef={idleRef} renderTrigger={help => (
          <Link {...help} href="/lectern" prefetch={false} className={buttonClassName({ size: "comfortable", iconOnly: true })}
            aria-label="open lectern" data-workspace-rich-target="true" onClick={openLectern} onKeyDown={openLectern}>
            <Icon.ListMusic size={20} aria-hidden="true" />
          </Link>
        )} />
      </div>;
      break;
    }
    case "Unavailable":
      contents = <div className={styles.unavailable}>
        <FeedbackNotice
          content={{ tone: "Warning", title: unavailableMessages[state.reason] }}
          announcement="None"
          actions={state.reason === "UpdateRequired" ? [{ label: "update", href: "/android" }] : undefined}
        />
        {openQueue}
      </div>;
      break;
    case "Loaded": {
      const source = state.source;
      const sourceHref = source.kind === "Episode" ? `/media/${source.descriptor.media_id}` : source.descriptor.previewHref;
      const openSource = (event: TargetActivationEvent) => {
        const handled = activateTargetLink({ event, runtime: linkRuntime,
          target: { href: sourceHref, labelHint: source.descriptor.title },
        });
        if (handled === "handled-default" || handled === "handled-new-pane") {
          sourceOpened.current = sheetShown;
          focusedControl.current = null;
          setSheetOpen(false);
        }
      };
      const identityButton = <Identity state={state} size={44}
        label={`open ${source.descriptor.title}`} href={sourceHref} onOpen={openSource} status={state.error ?? settingsStatus ?? status} />;

      const stop = <Button size="comfortable" iconOnly icon={<Icon.Square />} aria-label="stop playback" onClick={commands.stop} />;
      const episode = source.kind === "Episode" ? source.descriptor : null;
      const podcast = episode?.subtitle ?? "this podcast";
      const saved = settingsRead.status === "ready" ? settingsRead.data : null;
      let playbackPanel: ReactNode = null;
      if (preferences !== null && playbackSubject !== null) {
        const defaults = (rate: number | null, mode: PodcastSettings["pause_shortening_mode"]) =>
          `speed ${rate === null ? "not set (1×)" : formatPlaybackRate(rate)} · android default: skip silence ${mode === null ? "not set (off)" : mode === "Natural" ? "on" : "off"}`;
        const operation = save.state;
        const reviewed = operation?.kind === "Review" ? operation.current : null;
        const baseline = reviewed ?? saved;
        const confirmedMissing = (settingsRead.status === "failed" || settingsRead.status === "ready") && settingsRead.error?.code === "E_NOT_FOUND";
        const replaced = !confirmedMissing && (operation?.kind === "Replaced" || Boolean(operation && saved && operation.command.patch.id !== saved.id && saved.id !== null));
        const missing = confirmedMissing || (!replaced && operation?.kind === "Absent");
        const needsCheck = operation?.kind === "Unknown" || operation?.kind === "ReadFailed";
        const readReady = settingsRead.status === "ready" && settingsRead.error === null && !settingsRead.refreshing;
        const remember = () => {
          if (!baseline || !readReady || preferences.application.kind !== "Ready" || save.busy || needsCheck || missing || replaced) return;
          void save.save({
            id: baseline.id ?? crypto.randomUUID(),
            expected_settings_version: baseline.settings_version,
            default_playback_speed: preferences.rate,
            pause_shortening_mode: supportsSilenceSkipping ? (preferences.skipSilence ? "Natural" : "Off") : baseline.pause_shortening_mode,
          });
        };
        const check = () => { void save.check().then(() => settingsRead.refetch()); };
        let feedback: FeedbackContent | null = null;
        let actions: FeedbackActions | undefined;
        if (replaced) {
          feedback = { tone: "Warning", title: "playback defaults changed. reopen settings before saving." };
        } else if (missing) {
          feedback = { tone: "Warning", title: "this podcast is unavailable. current playback is unchanged." };
        } else if (operation) {
          const patch = operation.command.patch;
          const captured = `${podcast}: ${defaults(patch.default_playback_speed, patch.pause_shortening_mode)}`;
          switch (operation.kind) {
            case "Saving":
              feedback = { tone: "Neutral", title: `remembering ${captured}…` };
              break;
            case "Reading":
              feedback = { tone: "Neutral", title: "checking saved settings…", message: captured };
              break;
            case "Accepted":
              feedback = { tone: "Success", title: supportsSilenceSkipping
                ? `saved: ${formatPlaybackRate(patch.default_playback_speed ?? 1)} · skip silence ${patch.pause_shortening_mode === "Natural" ? "on" : "off"}`
                : `saved speed: ${formatPlaybackRate(patch.default_playback_speed ?? 1)}`, message: podcast };
              break;
            case "Rejected":
              feedback = podcastErrorMessage(operation.error, "couldn’t save podcast defaults.");
              if (preferences.application.kind === "Ready" && patch.default_playback_speed === preferences.rate && (!supportsSilenceSkipping || (patch.pause_shortening_mode === "Natural") === preferences.skipSilence)) {
                actions = [{ label: "try again", commandKey: JSON.stringify(patch), onClick: () => { void save.retry(); } }];
              }
              break;
            case "Unknown":
              feedback = { tone: "Warning", title: "save not confirmed.", message: "the request may have succeeded. check the saved settings before trying again.", requestId: operation.error.requestId };
              actions = [{ label: "check saved settings", commandKey: JSON.stringify(patch), onClick: check }];
              break;
            case "ReadFailed":
              feedback = podcastErrorMessage(operation.error, "couldn’t check saved settings.");
              actions = [{ label: "check saved settings", commandKey: JSON.stringify(patch), onClick: check }];
              break;
            case "Review":
              feedback = { tone: "Warning", title: operation.reason === "Conflict" ? "podcast defaults changed elsewhere." : "the saved settings do not confirm this request.", message: captured };
              break;
            case "Absent":
            case "Replaced":
              break;
            default:
              assertNever(operation);
          }
        }
        let applicationFeedback: ReactNode = null;
        switch (preferences.application.kind) {
          case "Ready":
            break;
          case "Applying":
            applicationFeedback = <FeedbackStatus content={{ tone: "Neutral", title: "applying playback settings…" }} announcement="None" />;
            break;
          case "Failed":
            applicationFeedback = <FeedbackNotice content={{ tone: "Warning", title: "couldn’t apply playback settings.", message: preferences.application.message }} announcement="None" actions={[{ label: "try again", onClick: commands.retryPlaybackPreferences }]} />;
            break;
          default:
            assertNever(preferences.application);
        }
        playbackPanel = <section className={styles.panel} aria-label="playback">
          <div className={styles.panelHeading}>
            <h2>playback</h2>
            {episode ? <p className={styles.podcastName}>{podcast}</p> : null}
          </div>
          <PlaybackRateEditor value={preferences.rate} onChange={commands.setPlaybackRate} label="speed" />
          {episode ? <>
            {supportsSilenceSkipping ? <SkipSilenceField checked={preferences.skipSilence} onChange={commands.setShortenPauses} label="skip silence" />
              : <p className={styles.eyebrow}>skip silence · android app only</p>}
            {state.shortenPausesSavedMs > 0 ? <p className={styles.eyebrow}>approx. time saved on this device · {clock(state.shortenPausesSavedMs)}</p> : null}
          </> : null}
          {applicationFeedback}
          {podcastId !== null ? <div className={styles.panelRow}>
            {!missing && !replaced ? <Button size="comfortable" className={styles.remember} aria-busy={save.busy || undefined} disabled={!readReady || save.busy || preferences.application.kind !== "Ready" || needsCheck} onClick={remember}>
              {supportsSilenceSkipping ? "remember settings for this podcast" : "remember speed for this podcast"}
            </Button> : null}
            {feedback ? <FeedbackNotice content={feedback} announcement="None" actions={actions} /> : null}
            {operation && operation.kind !== "Accepted" && operation.kind !== "Saving" && !missing && !replaced ? <p className={styles.eyebrow}>requested for {podcast}: {defaults(operation.command.patch.default_playback_speed, operation.command.patch.pause_shortening_mode)}</p> : null}
            {reviewed && !replaced ? <div className={styles.comparison}>
              <p>saved defaults: {defaults(reviewed.default_playback_speed, reviewed.pause_shortening_mode)}</p>
              <p>proposed defaults: {defaults(preferences.rate, supportsSilenceSkipping ? (preferences.skipSilence ? "Natural" : "Off") : reviewed.pause_shortening_mode)}</p>
            </div> : null}
            {(!operation || operation.kind === "Accepted") && saved ? <p className={styles.eyebrow}>saved defaults: {defaults(saved.default_playback_speed, saved.pause_shortening_mode)}</p> : null}
            {settingsRead.status === "loading" || (settingsRead.status === "ready" && settingsRead.refreshing) ? <FeedbackStatus content={{ tone: "Neutral", title: "loading saved podcast defaults…" }} announcement="None" /> : null}
            {!missing && ((settingsRead.status === "failed") || (settingsRead.status === "ready" && settingsRead.error)) ? <FeedbackNotice content={podcastErrorMessage(settingsRead.error, "couldn’t load podcast defaults.")} announcement="None" actions={[{ label: "retry loading", onClick: settingsRead.refetch }]} /> : null}
          </div> : null}
        </section>;
      }
      const chaptersPanel = <section className={styles.panel} aria-label="chapters">
        <h2 className={styles.panelTitle}>chapters</h2>
        <ChapterContext />
        <ChapterList state={state} compact={false} />
      </section>;
      const toggle = (kind: "Playback" | "Chapters") => {
        if (shownPicker === kind) { setPicker(null); return; }
        if (kind === "Playback") { save.reset(); setOpening(value => value + 1); }
        if (playbackSubject !== null) setPicker({ subject: playbackSubject, kind });
      };
      const utilities = <div className={styles.options}>
        {isMobile ? null : openQueue}
        {preferences !== null && playbackSubject !== null ? <Button ref={rateRef} size="comfortable" className={styles.rateBadge}
          aria-label={`playback settings, ${formatPlaybackRate(state.rate)}`} aria-description={settingsStatus ?? undefined}
          aria-busy={preferences.application.kind === "Applying" || save.busy || undefined}
          aria-expanded={panelOpen} aria-controls={playbackId} aria-haspopup={isMobile ? undefined : "dialog"}
          onClick={() => toggle("Playback")}>
          {formatPlaybackRate(state.rate)}{settingsStatus ? <span className={styles.controlMarker} aria-hidden="true">{settingsFailed ? "!" : "·"}</span> : null}
        </Button> : null}
        {episode && episode.chapters.length > 0 && playbackSubject !== null ? <Button ref={chaptersRef} size="comfortable" iconOnly
          aria-label="chapters" aria-expanded={shownPicker === "Chapters"} aria-controls={chaptersId} aria-haspopup={isMobile ? undefined : "dialog"}
          onClick={() => toggle("Chapters")} icon={<Icon.ListMusic />} /> : null}
        {stop}
      </div>;
      const feedback = <div className={styles.feedback}>
        {(state.error || (sheetShown && state.phase !== "Buffering")) && status !== null ? <FeedbackStatus
          content={{ tone: state.error ? "Warning" : "Neutral", title: status }}
          announcement="None"
          actions={state.error ? [{ label: "retry", onClick: commands.resume }] : undefined}
        /> : null}
        {settingsFailed && !panelOpen && settingsStatus ? <FeedbackStatus content={{ tone: "Warning", title: settingsStatus }} announcement="None" /> : null}
      </div>;
      contents = isMobile ? <>
        <MiniProgress />
        <div className={styles.miniRow}>
          <Identity state={state} size={44} buttonRef={openerRef} status={state.error ?? settingsStatus ?? status}
            label={`open now playing: ${source.descriptor.title}`}
            onOpen={() => { sourceOpened.current = false; setSheetOpen(true); }} />
          <Transport state={state} compact />
          {openQueue}
        </div>
      </> : <>
        <div className={styles.source}>{identityButton}</div>
        <div className={styles.desktopTransport}><Transport state={state} /></div>
        <div className={styles.listening}><Seek active={!sheetShown} /></div>
        {utilities}
        {feedback}
      </>;
      sheetPlayerContent = <>
        {identityButton}
        <Transport state={state} />
        <Seek active={sheetShown} />
        {utilities}
        {feedback}
        {shownPicker !== null ? <MobileDisclosure key={`${playbackSubject}:${shownPicker}`} kind={shownPicker}
          id={shownPicker === "Playback" ? playbackId : chaptersId} close={() => setPicker(null)}
          trigger={() => shownPicker === "Playback" ? rateRef.current : chaptersRef.current}
          skipReturnFocus={() => sourceOpened.current || !currentSurface.current.sheetShown || picker?.subject !== currentSurface.current.playbackSubject}>
          {shownPicker === "Playback" ? playbackPanel : chaptersPanel}
        </MobileDisclosure> : null}
      </>;
      overlays = <>
        <PickerSurface active={!isMobile && panelOpen} onClose={() => { focusedControl.current = null; setPicker(null); }} title="playback" panelId={playbackId}
          anchor={() => returnFocus(rateRef.current)} returnFocusFallback={() => returnFocus(null)}
          skipReturnFocus={() => sourceOpened.current || (document.activeElement instanceof HTMLElement
            && document.activeElement !== document.body && !document.activeElement.closest('[role="dialog"][aria-label="playback"], [role="dialog"][aria-label="chapters"]'))}
          placement="above" className={styles.picker} initialFocus={panel => panel.querySelector<HTMLInputElement>('input[type="range"]')}>
          {playbackPanel}
        </PickerSurface>
        <PickerSurface active={!isMobile && shownPicker === "Chapters"} onClose={() => { focusedControl.current = null; setPicker(null); }} title="chapters" panelId={chaptersId}
          anchor={() => returnFocus(chaptersRef.current)} returnFocusFallback={() => returnFocus(null)}
          skipReturnFocus={() => sourceOpened.current || (document.activeElement instanceof HTMLElement
            && document.activeElement !== document.body && !document.activeElement.closest('[role="dialog"][aria-label="playback"], [role="dialog"][aria-label="chapters"]'))}
          placement="above" className={styles.picker} initialFocus={panel => panel.querySelector<HTMLButtonElement>('button[aria-current="true"]') ?? panel.querySelector<HTMLButtonElement>('ol button')}>
          <section className={`${styles.panel} ${styles.chapterPanel}`} aria-label="chapters">
            <h2 className={styles.panelTitle}>chapters</h2>
            <ChapterContext />
            <ChapterList state={state} compact />
          </section>
        </PickerSurface>
      </>;
      break;
    }
    default: assertNever(state);
  }

  return <>
    <span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    <div ref={slotRef} className={styles.slot} data-reader-composition={readerComposition || undefined} hidden={suppressed} inert={suppressed || undefined}
      onFocusCapture={event => { focusedControl.current = event.target; sourceOpened.current = false; }}
      onBlurCapture={event => { if (event.relatedTarget !== null) focusedControl.current = null; }}>
      <footer ref={footerRef} className={`${styles.surface} ${isMobile ? styles.mini : styles.bar}`}
        role="region" aria-label="media player">
        {contents}
        <div className={styles.feedback}>{!queueOpen && !sheetShown ? <QueueStatus /> : null}</div>
      </footer>
      {overlays}
      <PickerSurface active={!isMobile && queueOpen} onClose={() => setQueueOpen(false)} title="up next"
        anchor={() => queueRef.current} returnFocusFallback={() => returnFocus(null)} placement="above"
        className={styles.queuePicker} initialFocus={panel => panel.querySelector<HTMLHeadingElement>("h2")}>
        <div ref={queueScrollRef} className={styles.queueScrollport}><QueuePanel announce={setAnnouncement} scrollport={() => queueScrollRef.current} /></div>
      </PickerSurface>
      <MobileSheet active={sheetShown} onDismiss={() => { focusedControl.current = null; setPicker(null); setSheetOpen(false); }} ariaLabel="now playing" handleLabel="collapse player"
        skipReturnFocus={() => sourceOpened.current}
        returnFocusTo={() => returnFocus(loaded !== null ? openerRef.current ?? queueRef.current : queueRef.current)}
        returnFocusFallback={() => returnFocus(null)} focusKey={playbackSubject}
        initialFocus={sheet => {
          const active = document.activeElement;
          if (active instanceof HTMLElement && active !== sheet && sheet.contains(active)
            && !active.matches(":disabled") && !active.closest("[hidden], [inert]") && active.getClientRects().length > 0) return active;
          return sheet.querySelector<HTMLButtonElement>('[data-player-play="true"]') ?? sheet.querySelector<HTMLHeadingElement>("h2");
        }}>
        <div ref={sheetContentRef} className={styles.sheetContent} role="region" aria-label="media player">
          {sheetPlayerContent}
          <QueuePanel key="queue" announce={setAnnouncement} scrollport={() => sheetContentRef.current?.parentElement ?? null} />
        </div>
      </MobileSheet>
    </div>
  </>;
}

function MiniProgress() {
  const { positionMs, durationMs } = Player.usePlayerTimeline();
  return (
    <span className={styles.miniProgress} aria-hidden="true">
      <span className={styles.miniFill} style={{ width: percent(positionMs, durationMs) }} />
    </span>
  );
}
