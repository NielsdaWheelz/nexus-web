"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import * as Icon from "lucide-react";
import Link from "next/link";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
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
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useWorkspaceStore } from "@/lib/workspace/store";
import { PlayerPanel, VolumeControl } from "./PlayerPlaybackControls";
import styles from "./Player.module.css";

type Loaded = Extract<Player.PlayerState, { kind: "Loaded" }>;

const unavailableMessages = {
  UpdateRequired: "update nexus for android",
  NotResponding: "player unavailable",
} satisfies Record<Extract<Player.PlayerState, { kind: "Unavailable" }>["reason"], string>;

const clock = (ms: number) => formatClock(ms / 1000);
const percent = (part: number, whole: number) =>
  `${whole > 0 ? (Math.min(part, whole) / whole) * 100 : 0}%`;

function IconButton(props: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const { label, onClick, disabled, children } = props;
  return (
    <Button
      variant="ghost"
      size="lg"
      iconOnly
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
    >
      {children}
    </Button>
  );
}

/** Artwork, title and subtitle as one button. */
function Identity({
  state,
  size,
  label,
  onOpen,
  href,
  buttonRef,
}: {
  state: Loaded;
  size: number;
  label: string;
  onOpen: (event: TargetActivationEvent) => void;
  href?: string;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
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
      ? `Preview from ${descriptor.source}`
      : descriptor.subtitle;
  const contents = <>
      {image || <span className={styles.placeholder} style={{ width: size, height: size }} aria-hidden="true">{descriptor.title.trim().charAt(0).toLocaleUpperCase() || "N"}</span>}
      <span className={styles.identityCopy}>
        <span className={styles.title}>{descriptor.title}</span>
        {subtitle ? <span className={styles.subtitle}>{subtitle}</span> : null}
      </span>
    </>;
  return href ? <Button asChild variant="ghost" className={styles.identity}>
    <a href={href} data-workspace-rich-target="true" onClick={onOpen} onKeyDown={onOpen} aria-label={label}>{contents}</a>
  </Button> : <Button ref={buttonRef} variant="ghost" className={styles.identity} onClick={onOpen} aria-label={label}>{contents}</Button>;
}

function Transport({
  state,
  compact = false,
}: {
  state: Loaded;
  compact?: boolean;
}) {
  const commands = Player.usePlayerCommands();
  const { nextUp } = Player.usePlayerSession();
  const playing = state.phase === "Playing" || state.phase === "Buffering";
  const episode = !compact && state.source.kind === "Episode";
  return (
    <div
      className={styles.transport}
      role="group"
      aria-label="Media player controls"
    >
      {episode ? (
        <IconButton label="Previous" onClick={commands.previous}>
          <Icon.SkipBack />
        </IconButton>
      ) : null}
      {compact ? null : (
        <IconButton
          label="Back 15 seconds"
          onClick={() => commands.skipBy(-Player.PLAYER_SKIP_BACK_MS)}
        >
          <Icon.RotateCcw />
        </IconButton>
      )}
      <Button
        variant="primary"
        size="lg"
        iconOnly
        className={styles.playPause}
        onClick={playing ? commands.pause : commands.resume}
        aria-label={playing ? "Pause media player" : "Play media player"}
      >
        {playing ? (
          <Icon.Pause fill="currentColor" />
        ) : (
          <Icon.Play fill="currentColor" />
        )}
      </Button>
      <IconButton
        label="Forward 30 seconds"
        onClick={() => commands.skipBy(Player.PLAYER_SKIP_FORWARD_MS)}
      >
        <Icon.RotateCw />
      </IconButton>
      {episode ? (
        <IconButton
          label="Next"
          onClick={commands.next}
          disabled={nextUp === null}
        >
          <Icon.SkipForward />
        </IconButton>
      ) : null}
    </div>
  );
}

/** Seek range over a painted track; a pointer scrub seeks once, on release. */
function Seek() {
  const { positionMs, durationMs, bufferedMs, chapter } =
    Player.usePlayerTimeline();
  const commands = Player.usePlayerCommands();
  const scrubbing = useRef(false);
  const [draft, setDraft] = useState<number | null>(null);
  const shown = Math.min(draft ?? positionMs, durationMs);
  const commit = () => {
    scrubbing.current = false;
    if (draft !== null) commands.seekTo(draft);
    setDraft(null);
  };
  const track = {
    "--progress": percent(shown, durationMs),
    "--buffered": percent(Math.max(shown, bufferedMs), durationMs),
  } as CSSProperties;
  return (
    <div className={styles.seekField}>
      <div className={styles.seek} style={track}>
        <span className={styles.time}>{clock(shown)}</span>
        <span className={styles.track} aria-hidden="true" />
        <input
          type="range"
          className={styles.seekInput}
          min={0}
          max={durationMs}
          step={1000}
          value={shown}
          disabled={durationMs <= 0}
          aria-label="Seek playback position"
          aria-valuetext={`${clock(shown)} of ${clock(durationMs)}`}
          onPointerDown={() => (scrubbing.current = true)}
          onPointerUp={commit}
          onPointerCancel={commit}
          onChange={(event) => {
            const value = Number(event.currentTarget.value);
            if (scrubbing.current) setDraft(value);
            else commands.seekTo(value);
          }}
        />
        <span className={styles.time}>{clock(durationMs)}</span>
      </div>
      {chapter ? (
        <span className={styles.subtitle} aria-label="Current chapter">
          {chapter.title}
        </span>
      ) : null}
    </div>
  );
}

function statusOf(state: Loaded): string | null {
  return (
    state.error ??
    (state.phase === "Buffering"
      ? "Buffering"
      : state.synced
        ? null
        : "Progress sync paused")
  );
}

function Status({ state }: { state: Loaded }) {
  const commands = Player.usePlayerCommands();
  const message = statusOf(state);
  return message === null ? null : (
    <FeedbackStatus
      content={{ tone: state.error ? "Warning" : "Neutral", title: message }}
      announcement="None"
      actions={state.error ? [{ label: "retry", onClick: commands.resume }] : undefined}
    />
  );
}

/**
 * One permanent player slot. The viewport measures its untransformed box; mobile
 * chrome owns only the inner footer's motion and inertness. Overlays own ordinary
 * focus return; detached player controls recover to idle or the active pane.
 */
export default function GlobalPlayerSurfaces() {
  const { state, nextUp } = Player.usePlayerSession();
  const commands = Player.usePlayerCommands();
  const workspace = useWorkspaceStore();
  const isMobile = useIsMobileViewport();
  const mobileViewport = useMobileViewport();
  const textEntryFocused = useRootTextEntryFocused();
  const [panelOpen, setPanelOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const idleRef = useRef<HTMLAnchorElement>(null);
  const rateRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const focusedControl = useRef<HTMLElement | null>(null);
  const sourceOpened = useRef(false);
  const announcedSource = useRef<string | null>(null);
  const announcedStatus = useRef<string | null>(null);
  const announcedUnavailable = useRef<string | null>(null);
  const loaded = state.kind === "Loaded" ? state : null;
  const identity = loaded === null ? null : `${loaded.source.kind}:${
    loaded.source.kind === "Episode"
      ? loaded.source.descriptor.media_id
      : loaded.source.descriptor.target
  }`;
  const title = loaded?.source.descriptor.title;
  const status = loaded === null ? null : statusOf(loaded);
  const unavailable = state.kind === "Unavailable" ? unavailableMessages[state.reason] : null;
  const panelShown = loaded !== null && !isMobile && panelOpen;
  const sheetShown = loaded !== null && isMobile && sheetOpen;
  const suppressed = isMobile && (sheetShown || textEntryFocused);
  const linkRuntime: TargetLinkActivationRuntime = {
    activateTarget: input => workspace.activateWorkspaceTarget({
      ...input, originPaneId: workspace.state.active_primary_pane_id,
    }),
  };

  useMobileChromeSurface(footerRef, isMobile);
  useLayoutEffect(() => {
    if (!isMobile || suppressed || slotRef.current === null) return;
    return mobileViewport.registerBottomSurface("Player", slotRef.current);
  }, [isMobile, suppressed, mobileViewport]);

  // Invalidate overlays independently of source-announcement deduplication.
  useLayoutEffect(() => {
    setSheetOpen(false);
    setPanelOpen(false);
  }, [state.kind, isMobile]);

  const returnFocus = (opener: HTMLElement | null): { element: HTMLElement; preventScroll: true } | null => {
    const element = [opener, idleRef.current, findActivePaneLandmarkFocusTarget()]
      .find(candidate => {
        if (!candidate?.isConnected) return false;
        const blocker = candidate.closest("[hidden], [inert]");
        // The overlay retries after this slot's closing suppression commits.
        if (candidate === opener && blocker === slotRef.current) {
          return slotRef.current?.parentElement?.closest("[hidden], [inert]") === null;
        }
        return blocker === null && candidate.getClientRects().length > 0;
      });
    return element ? { element, preventScroll: true } : null;
  };
  useLayoutEffect(() => {
    const departed = focusedControl.current;
    if (departed === null || departed.isConnected) return;
    focusedControl.current = null;
    const active = document.activeElement;
    // Overlay cleanup may have returned to the pane before idle's ref attached.
    if (active !== document.body && active !== findActivePaneLandmarkFocusTarget()) return;
    const idle = idleRef.current;
    const target = idle?.isConnected && !idle.closest("[hidden], [inert]") && idle.getClientRects().length > 0
      ? idle : findActivePaneLandmarkFocusTarget();
    target?.focus({ preventScroll: true });
  }, [state, isMobile]);

  useEffect(() => {
    switch (state.kind) {
      case "Absent":
        setAnnouncement(announcedSource.current === null ? null : "playback stopped");
        announcedSource.current = null;
        announcedStatus.current = null;
        announcedUnavailable.current = null;
        break;
      case "Unavailable":
        if (unavailable !== announcedUnavailable.current) setAnnouncement(unavailable);
        announcedUnavailable.current = unavailable;
        break;
      case "Loaded": {
        const recovering = announcedUnavailable.current !== null;
        announcedUnavailable.current = null;
        if (identity !== announcedSource.current) setAnnouncement(`now playing: ${title}`);
        else if (status !== null && status !== "Buffering" && status !== announcedStatus.current) setAnnouncement(status);
        else if (recovering) setAnnouncement(null);
        announcedSource.current = identity;
        announcedStatus.current = status;
        break;
      }
      default: assertNever(state);
    }
  }, [state, identity, title, status, unavailable]);

  let contents: ReactNode;
  let overlays: ReactNode = null;
  switch (state.kind) {
    case "Absent": {
      const openLectern = (event: TargetActivationEvent) => activateTargetLink({
        event, runtime: linkRuntime, target: { href: "/lectern", labelHint: "lectern" },
      });
      contents = <div className={styles.idle}>
        <Icon.Headphones className={styles.idleGlyph} aria-hidden="true" />
        <span className={styles.idleCopy}>nothing playing</span>
        <Button asChild variant="secondary" size="lg" className={styles.idleAction}>
          <Link ref={idleRef} href="/lectern" prefetch={false} data-workspace-rich-target="true" onClick={openLectern} onKeyDown={openLectern}>open lectern</Link>
        </Button>
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
      const identityButton = <Identity state={state} size={48}
        label={`Open ${source.descriptor.title}`} href={sourceHref} onOpen={openSource} />;
      const next = nextUp ? <span className={styles.subtitle}>Next: {nextUp.title}</span> : null;
      const stop = <IconButton label="stop playback" onClick={commands.dismiss}>
        <Icon.Square aria-hidden="true" />
      </IconButton>;
      contents = isMobile ? <>
        <MiniProgress />
        <div className={styles.row}>
          <Identity state={state} size={44} buttonRef={openerRef}
            label={`Open Now Playing: ${source.descriptor.title}`}
            onOpen={() => { sourceOpened.current = false; setSheetOpen(true); }} />
          <Transport state={state} compact />
        </div>
        <Status state={state} />
      </> : <>
        <div className={`${styles.column} ${styles.source}`}>
          {identityButton}
          {next}
        </div>
        <div className={styles.desktopTransport}><Transport state={state} /></div>
        <div className={styles.listening}><Seek /><Status state={state} /></div>
        <div className={`${styles.row} ${styles.options}`}>
          <Button ref={rateRef} variant="ghost" size="lg" leadingIcon={<Icon.Gauge aria-hidden="true" />}
            aria-label={`Playback speed, ${state.rate === 1 ? "normal" : `${formatPlaybackRate(state.rate).slice(0, -1)} times`}`}
            onClick={() => setPanelOpen(true)}>
            {formatPlaybackRate(state.rate)}
          </Button>
          {stop}
        </div>
        <div className={styles.desktopVolume}><VolumeControl state={state} /></div>
      </>;
      overlays = <>
        <Dialog open={panelShown} onClose={() => { focusedControl.current = null; setPanelOpen(false); }} title="Playback"
          returnFocusTo={() => returnFocus(isMobile ? null : rateRef.current)}
          returnFocusFallback={() => returnFocus(null)}>
          <div role="region" aria-label="media player"><PlayerPanel /></div>
        </Dialog>
        <MobileSheet active={sheetShown} onDismiss={() => { focusedControl.current = null; setSheetOpen(false); }} ariaLabel="now playing"
          skipReturnFocus={() => sourceOpened.current}
          returnFocusTo={() => returnFocus(isMobile ? openerRef.current : null)}
          returnFocusFallback={() => returnFocus(null)}>
          <div className={styles.column} role="region" aria-label="media player">
            <div className={styles.row}>{stop}</div>
            {identityButton}
            {next}
            <Seek />
            <Transport state={state} />
            <Status state={state} />
            <PlayerPanel />
          </div>
        </MobileSheet>
      </>;
      break;
    }
    default: assertNever(state);
  }

  return <>
    <span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    <div ref={slotRef} className={styles.slot} hidden={suppressed} inert={suppressed || panelShown || undefined}
      onFocusCapture={event => { focusedControl.current = event.target; sourceOpened.current = false; }}
      onBlurCapture={event => { if (event.relatedTarget !== null) focusedControl.current = null; }}>
      <footer ref={footerRef} className={`${styles.surface} ${isMobile ? styles.mini : styles.bar}`}
        role="region" aria-label="media player">
        {contents}
      </footer>
      {overlays}
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
