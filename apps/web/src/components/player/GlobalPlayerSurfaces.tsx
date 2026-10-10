"use client";

import Link from "next/link";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import * as Icon from "lucide-react";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import MediaImage from "@/components/ui/MediaImage";
import MobileSheet from "@/components/ui/MobileSheet";
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
}: {
  state: Loaded;
  size: number;
  label: string;
  onOpen: () => void;
}) {
  const { kind, descriptor } = state.source;
  const box = { alt: "", width: size, height: size, className: styles.artwork };
  const image =
    kind === "Episode"
      ? descriptor.artworkUrl.kind === "Present" && (
          <MediaImage
            kind="proxied"
            remoteUrl={descriptor.artworkUrl.value}
            {...box}
          />
        )
      : descriptor.imageUrl.kind === "Present" && (
          <MediaImage
            kind="proxy-src"
            src={descriptor.imageUrl.value}
            {...box}
          />
        );
  const subtitle =
    kind === "Preview"
      ? `Preview from ${descriptor.source}`
      : descriptor.subtitle.kind === "Present"
        ? descriptor.subtitle.value
        : null;
  return (
    <Button
      variant="ghost"
      className={styles.identity}
      onClick={onOpen}
      aria-label={label}
    >
      {image || (
        <span
          className={styles.placeholder}
          style={{ width: size, height: size }}
          aria-hidden="true"
        >
          {descriptor.title.trim().charAt(0).toLocaleUpperCase() || "N"}
        </span>
      )}
      <span className={styles.identityCopy}>
        <span className={styles.title}>{descriptor.title}</span>
        {subtitle ? <span className={styles.subtitle}>{subtitle}</span> : null}
      </span>
    </Button>
  );
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
    <div className={styles.status} aria-label="Player status">
      <span className={styles.statusDot} aria-hidden="true" />
      {message}
      {state.error ? (
        <Button variant="ghost" size="sm" onClick={commands.resume}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export default function GlobalPlayerSurfaces() {
  const { state, nextUp } = Player.usePlayerSession();
  const commands = Player.usePlayerCommands();
  const workspace = useWorkspaceStore();
  const isMobile = useIsMobileViewport();
  const mobileViewport = useMobileViewport();
  const textEntryFocused = useRootTextEntryFocused();
  const [panelOpen, setPanelOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const miniRef = useRef<HTMLElement>(null);
  const unavailableRef = useRef<HTMLElement>(null);
  const rateRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const loaded = state.kind === "Loaded" ? state : null;
  const identity =
    loaded &&
    (loaded.source.kind === "Episode"
      ? loaded.source.descriptor.mediaId
      : loaded.source.descriptor.target);
  const title = loaded?.source.descriptor.title;
  const status = loaded && statusOf(loaded);

  // Polite announcements: what starts playing, when the player closes, and status changes.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (identity === announced.current) return;
    setAnnouncement(
      title
        ? `Now playing: ${title}`
        : announced.current
          ? "Player closed"
          : "",
    );
    if (identity === null) {
      setSheetOpen(false);
      setPanelOpen(false);
    }
    announced.current = identity;
  }, [identity, title]);
  useEffect(() => {
    if (status && status !== "Buffering") setAnnouncement(status);
  }, [status]);

  const miniHidden =
    !isMobile || loaded === null || sheetOpen || textEntryFocused;
  useLayoutEffect(() => {
    if (miniHidden || miniRef.current === null) return;
    return mobileViewport.registerBottomSurface("Player", miniRef.current);
  }, [miniHidden, mobileViewport]);
  useLayoutEffect(() => {
    if (!isMobile || state.kind !== "Unavailable" || unavailableRef.current === null) return;
    return mobileViewport.registerBottomSurface("Player", unavailableRef.current);
  }, [isMobile, state.kind, mobileViewport]);

  const live = (
    <span
      className={styles.srOnly}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {announcement}
    </span>
  );
  if (state.kind === "Unavailable") {
    const update = state.reason === "UpdateRequired";
    return (
      <section
        ref={unavailableRef}
        className={styles.unavailable}
        role="region"
        aria-label="Media player"
      >
        <strong>
          {update ? "Update Nexus for Android" : "Player unavailable"}
        </strong>
        {update ? (
          <Button asChild variant="secondary" size="sm">
            <Link href="/android">Update</Link>
          </Button>
        ) : null}
      </section>
    );
  }
  if (loaded === null) return live;

  const source = loaded.source;
  const openTarget = () => {
    setSheetOpen(false);
    workspace.activateWorkspaceTarget({
      originPaneId: workspace.state.activePrimaryPaneId,
      target: {
        href:
          source.kind === "Episode"
            ? `/media/${source.descriptor.mediaId}`
            : source.descriptor.previewHref,
        labelHint: source.descriptor.title,
      },
      disposition: { kind: "Follow" },
    });
  };
  const identityButton = (
    <Identity
      state={loaded}
      size={48}
      label={`Open ${source.descriptor.title}`}
      onOpen={openTarget}
    />
  );
  const next = nextUp ? (
    <span className={styles.subtitle}>Next: {nextUp.title}</span>
  ) : null;
  const close = (
    <IconButton label="Close player" onClick={commands.dismiss}>
      <Icon.X />
    </IconButton>
  );

  if (!isMobile) {
    return (
      <>
        {live}
        <footer
          className={styles.bar}
          role="region"
          aria-label="Media player"
          inert={panelOpen}
        >
          <div className={styles.column}>
            {identityButton}
            {next}
          </div>
          <div className={styles.listening}>
            <Transport state={loaded} />
            <Seek />
            <Status state={loaded} />
          </div>
          <div className={styles.row}>
            <Button
              ref={rateRef}
              variant="ghost"
              size="lg"
              leadingIcon={<Icon.Gauge />}
              aria-label={`Playback speed, ${loaded.rate === 1 ? "normal" : `${formatPlaybackRate(loaded.rate).slice(0, -1)} times`}`}
              onClick={() => setPanelOpen(true)}
            >
              {formatPlaybackRate(loaded.rate)}
            </Button>
            <VolumeControl state={loaded} />
            {close}
          </div>
        </footer>
        <Dialog
          open={panelOpen}
          onClose={() => setPanelOpen(false)}
          title="Playback"
          returnFocusTo={() => rateRef.current}
        >
          <PlayerPanel />
        </Dialog>
      </>
    );
  }
  return (
    <>
      {live}
      <footer
        ref={miniRef}
        className={styles.mini}
        role="region"
        aria-label="Media player"
        data-hidden={miniHidden || undefined}
        inert={miniHidden}
      >
        <MiniProgress />
        <div className={styles.row}>
          <Identity
            state={loaded}
            size={44}
            label={`Open Now Playing: ${source.descriptor.title}`}
            onOpen={() => setSheetOpen(true)}
          />
          <Transport state={loaded} compact />
        </div>
        <Status state={loaded} />
      </footer>
      <MobileSheet
        active={sheetOpen}
        onDismiss={() => setSheetOpen(false)}
        ariaLabel="Now Playing"
        returnFocusTo={() => openerRef.current}
      >
        <div className={styles.column} role="region" aria-label="Media player">
          <div className={styles.row}>
            <IconButton
              label="Collapse player"
              onClick={() => setSheetOpen(false)}
            >
              <Icon.ChevronDown />
            </IconButton>
            {close}
          </div>
          {identityButton}
          {next}
          <Seek />
          <Transport state={loaded} />
          <Status state={loaded} />
          <PlayerPanel />
        </div>
      </MobileSheet>
    </>
  );
}

function MiniProgress() {
  const { positionMs, durationMs } = Player.usePlayerTimeline();
  return (
    <span className={styles.miniProgress} aria-hidden="true">
      <span style={{ width: percent(positionMs, durationMs) }} />
    </span>
  );
}
