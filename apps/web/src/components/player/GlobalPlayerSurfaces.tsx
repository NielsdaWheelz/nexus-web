"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import PickerSurface from "@/components/ui/PickerSurface";
import { activateTargetLink, type TargetLinkActivationRuntime } from "@/lib/panes/targetLinkActivation";
import { assertNever } from "@/lib/assertNever";
import { useMediaSummaryIds } from "@/lib/media/MediaSummaryProvider";
import { useMobileChromeSurface } from "@/lib/mobileShell/chrome";
import { findActivePaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import { useMobileViewport, useRootTextEntryFocused } from "@/lib/mobileShell/viewport";
import { barClock, barMode, barSubjectId, liveKeys, miniKeys } from "@/lib/player/barModel";
import { usePlayerPresentation } from "@/lib/player/presentation";
import * as Player from "@/lib/player/playerRuntime";
import * as Icon from "@/lib/ui/icons";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useNativeKeyboardVisibility } from "@/lib/ui/useKeyboardInset";
import { useLatestWorkspace } from "@/lib/workspace/store";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import QueuePanel from "./QueuePanel";
import PlayerIdentity from "./PlayerIdentity";
import PlayerTransport from "./PlayerTransport";
import PlayerRule from "./PlayerRule";
import PlayerFolio from "./PlayerFolio";
import PlayerUtilities from "./PlayerUtilities";
import SpeedKey from "./SpeedKey";
import { PlaybackPanel, usePlaybackSettings } from "./PlaybackSettings";
import PlayerChapters from "./PlayerChapters";
import { unavailableMessages } from "./PlayerFailures";
import PlayerSheet, { MobileDisclosure } from "./PlayerSheet";
import PlayerKeys from "./PlayerKeys";
import PlayerMore from "./PlayerMore";
import { usePlayerOrigin } from "./usePlayerOrigin";
import styles from "./GlobalPlayerSurfaces.module.css";

type Loaded = Extract<Player.PlayerState, { kind: "Loaded" }>;

const PICKER_DIALOGS = '[role="dialog"][aria-label="playback"], [role="dialog"][aria-label="chapters"]';

/** Shown: connected, outside a hidden or inert subtree, laid out and visible. */
const shown = (element: HTMLElement | null): element is HTMLElement => element !== null && element.isConnected
  && element.closest("[hidden], [inert]") === null && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";

/**
 * The player's root: what the bar shows is `barMode`'s, read from the session and the one summary
 * it names; leaves render it. The root wires refs, pickers, the more menu, focus and the one live
 * region, and never reads the clock. Presentation hides desktop chrome without retiring settings or
 * announcements; overlays return only to shown controls and never reclaim unrelated focus.
 */
export default function GlobalPlayerSurfaces({ readerComposition }: { readerComposition: boolean }) {
  const session = Player.usePlayerSession();
  const { state, queue, preferences, playbackSubject, supportsSilenceSkipping } = session;
  const presentation = usePlayerPresentation();
  const latestWorkspace = useLatestWorkspace();
  const isMobile = useIsMobileViewport();
  const priorMode = useRef(isMobile);
  const modeChanged = priorMode.current !== isMobile;
  const mobileViewport = useMobileViewport();
  const textEntryFocused = useRootTextEntryFocused();
  const nativeKeyboard = useNativeKeyboardVisibility();
  const subjectId = barSubjectId(session);
  const summaries = useMediaSummaryIds(subjectId === null ? [] : [subjectId]);
  const mode = barMode(session, subjectId !== null && summaries.pending(subjectId) ? { kind: "Pending" }
    : { kind: "Ready", summary: subjectId === null ? null : summaries.resolve(subjectId) });
  const keys = liveKeys(mode, session);
  const clock = barClock(mode);
  const origin = usePlayerOrigin(playbackSubject);
  const [draft, setDraft] = useState<number | null>(null);
  const [picker, setPicker] = useState<{ readonly subject: string; readonly kind: "Playback" | "Chapters" } | null>(null);
  const shownPicker = (isMobile || presentation.visible) && !modeChanged && state.kind === "Loaded" && picker !== null && picker.subject === playbackSubject ? picker.kind : null;
  const [opening, setOpening] = useState(0);
  const playbackId = useId();
  const chaptersId = useId();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [sheetTarget, setSheetTarget] = useState<"Player" | "Queue">("Player");
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const discRef = useRef<HTMLButtonElement>(null);
  const previousRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const rateRef = useRef<HTMLButtonElement>(null);
  const chaptersRef = useRef<HTMLButtonElement>(null);
  const queueRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const setMoreRef = useCallback((node: HTMLButtonElement | null) => { moreRef.current = node; }, []);
  const openerRef = useRef<HTMLButtonElement>(null);
  const sheetContentRef = useRef<HTMLDivElement>(null);
  const focusedControl = useRef<HTMLElement | null>(null);
  const sourceOpened = useRef(false);
  const announced = useRef<{ source: string | null; phase: Loaded["phase"] | null; unavailable: string | null; stopped: string | null }>({ source: null, phase: null, unavailable: null, stopped: null });
  const loaded = state.kind === "Loaded" ? state : null;
  const identity = loaded?.source.descriptor.media_id ?? null;
  const { accountId } = useAuthenticatedAccount();
  const settings = usePlaybackSettings({ loaded, playbackSubject, preferences, opening });
  const title = loaded?.source.descriptor.title;
  const queuePlaybackFailure = loaded !== null && loaded.playbackFailed
    && queue.failure?.kind === "Episode" && queue.failure.entry_id === queue.header?.current_entry_id;
  const unavailable = state.kind === "Unavailable" ? unavailableMessages[state.reason] : null;
  const sheetShown = !modeChanged && isMobile && sheetOpen;
  const currentSurface = useRef({ sheetShown, playbackSubject, desktopVisible: presentation.visible });
  currentSurface.current = { sheetShown, playbackSubject, desktopVisible: presentation.visible };
  const suppressed = isMobile ? sheetShown || (textEntryFocused && nativeKeyboard !== false) : !presentation.visible;
  const setFooter = useCallback((element: HTMLElement | null) => {
    footerRef.current = element;
    presentation.regionRef.current = isMobile ? null : element;
  }, [isMobile, presentation.regionRef]);
  const linkRuntime: TargetLinkActivationRuntime = {
    activateTarget: input => {
      const workspace = latestWorkspace();
      return workspace.activateWorkspaceTarget({ ...input, originPaneId: workspace.state.active_primary_pane_id });
    },
  };
  const opened = () => {
    sourceOpened.current = true;
    focusedControl.current = null;
    setPicker(null);
    setSheetOpen(false);
    setQueueOpen(false);
  };
  /** A closing desktop picker returns focus unless it moved on to anything outside these dialogs. */
  const skipReturnFocus = (dialogs: string) => () => sourceOpened.current || (document.activeElement instanceof HTMLElement
    && document.activeElement !== document.body && !document.activeElement.closest(dialogs));

  useMobileChromeSurface(footerRef, isMobile);
  useLayoutEffect(() => {
    if (!isMobile || suppressed || slotRef.current === null) return;
    return mobileViewport.registerBottomSurface("Player", slotRef.current, footerRef.current);
  }, [isMobile, suppressed, mobileViewport, readerComposition]);

  // Loaded replacement retains the sheet but retires its old disclosure.
  useLayoutEffect(() => { setPicker(null); }, [playbackSubject, isMobile, sheetOpen]);
  useLayoutEffect(() => { priorMode.current = isMobile; setSheetOpen(false); setQueueOpen(false); }, [isMobile, accountId]);
  useLayoutEffect(() => {
    if (!isMobile && !presentation.visible) { setPicker(null); setQueueOpen(false); }
  }, [isMobile, presentation.visible]);

  /** The first shown of `preferred`, then the disc, up next, the region and the pane. */
  const returnFocus = useCallback((preferred: readonly (HTMLElement | null)[]): { element: HTMLElement; preventScroll: true } | null => {
    const candidates = !isMobile && !currentSurface.current.desktopVisible ? [presentation.railRef.current]
      : [...preferred, discRef.current, queueRef.current, isMobile ? null : presentation.regionRef.current, findActivePaneLandmarkFocusTarget()];
    const element = candidates.find(candidate => {
      // The overlay retries after this slot's closing suppression commits.
      if (candidate !== null && preferred.includes(candidate) && candidate.closest("[hidden], [inert]") === slotRef.current && !textEntryFocused)
        return candidate.isConnected && slotRef.current?.parentElement?.closest("[hidden], [inert]") === null;
      return shown(candidate);
    });
    return element ? { element, preventScroll: true } : null;
  }, [textEntryFocused, isMobile, presentation.railRef, presentation.regionRef]);
  // A control that leaves the bar, by mode or by a tier resize, hands owned focus on.
  const recoverFocus = useCallback(() => {
    const departed = focusedControl.current;
    if (departed === null || shown(departed) && !departed.matches(":disabled")) return;
    focusedControl.current = null;
    const active = document.activeElement;
    if (active !== document.body && active !== findActivePaneLandmarkFocusTarget() && active !== departed) return;
    const target = sheetShown ? sheetContentRef.current?.querySelector<HTMLButtonElement>('[data-player-play="true"]') : returnFocus([])?.element;
    target?.focus({ preventScroll: true });
  }, [sheetShown, returnFocus]);
  useLayoutEffect(() => recoverFocus(), [recoverFocus, state, isMobile, preferences, presentation.visible, mode.kind]);
  const recover = useRef(recoverFocus);
  recover.current = recoverFocus;
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (slot === null) return;
    const observer = new ResizeObserver(() => recover.current());
    observer.observe(slot);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const said = announced.current;
    switch (state.kind) {
      case "Absent": {
        // the queue running out says so, in place of the stop it also is.
        const stop = mode.kind === "Finished" ? "queue finished" : "playback stopped";
        if (said.source !== null || said.stopped === "playback stopped" && stop === "queue finished") { setAnnouncement(stop); said.stopped = stop; }
        said.source = null;
        said.phase = null;
        said.unavailable = null;
        break;
      }
      case "Unavailable":
        if (unavailable !== said.unavailable) setAnnouncement(unavailable);
        said.unavailable = unavailable;
        break;
      case "Loaded": {
        said.stopped = null;
        if (queuePlaybackFailure) { said.source = identity; said.phase = state.phase; break; }
        const recovering = said.unavailable !== null;
        said.unavailable = null;
        const started = state.error === null && state.phase === "Playing";
        if (identity !== said.source) {
          const observation = started ? "now playing" : state.phase === "Buffering" ? "buffering" : "audio loaded";
          setAnnouncement(state.error === null ? `${observation}: ${title}` : null);
        } else if (started && said.phase !== "Playing") setAnnouncement(`now playing: ${title}`);
        else if (recovering) setAnnouncement(null);
        said.source = identity;
        said.phase = state.phase;
        break;
      }
      default: assertNever(state);
    }
  }, [state, mode.kind, identity, title, unavailable, queuePlaybackFailure]);

  const toggle = (kind: "Playback" | "Chapters") => {
    if (shownPicker === kind) { setPicker(null); return; }
    if (kind === "Playback") { settings.save.reset(); setOpening(value => value + 1); }
    if (playbackSubject !== null) setPicker({ subject: playbackSubject, kind });
  };
  const openQueue = () => { sourceOpened.current = false; if (isMobile) { setSheetTarget("Queue"); setSheetOpen(true); } else setQueueOpen(value => !value); };
  const openLectern = (event: TargetActivationEvent) => activateTargetLink({ event, runtime: linkRuntime, target: { href: "/lectern", labelHint: "lectern" } });
  const openEpisode = (event: TargetActivationEvent, episode: { readonly mediaId: string; readonly title: string }) => {
    const handled = activateTargetLink({ event, runtime: linkRuntime, target: { href: `/media/${episode.mediaId}`, labelHint: episode.title } });
    if (handled === "handled-default" || handled === "handled-new-pane") opened();
  };
  const speedKey = (variant: "Bar" | "Sheet") => <SpeedKey ref={rateRef} variant={variant} expanded={shownPicker === "Playback"} controls={playbackId}
    status={settings.status} failed={settings.failed} busy={settings.save.busy} onToggle={() => toggle("Playback")} />;
  const chaptersKey = { chaptersExpanded: shownPicker === "Chapters", chaptersId, chaptersRef, onToggleChapters: () => toggle("Chapters") };
  const upNext = <Button ref={queueRef} size="comfortable" iconOnly icon={<Icon.UpNext />} aria-label="up next" className={styles.key}
    aria-haspopup="dialog" aria-expanded={isMobile ? sheetShown : queueOpen} aria-busy={queue.phase === "Preparing" || queue.phase === "Saving" || undefined}
    aria-description={queue.phase === "Preparing" ? "preparing queue…" : queue.phase === "Saving" ? "saving queue…" : undefined} onClick={openQueue} />;
  const more = <PlayerMore keys={keys} shedRefs={{ previous: previousRef, next: nextRef, chapters: chaptersRef, upNext: queueRef }}
    onChapters={() => toggle("Chapters")} onUpNext={openQueue} onOpened={opened} triggerRef={setMoreRef}
    returnFocusTo={() => returnFocus([moreRef.current])} className={styles.key} />;

  const playbackPanel = (surface: "Popup" | "Embedded") => loaded === null || preferences === null || playbackSubject === null ? null
    : <PlaybackPanel loaded={loaded} preferences={preferences} supportsSilenceSkipping={supportsSilenceSkipping} settings={settings} presentation={surface} />;
  const chapterPanel = (surface: "Popup" | "Embedded") => loaded === null ? null
    : <PlayerChapters loaded={loaded} presentation={surface} onSeek={origin.seek} onOpened={opened} />;
  const mini = miniKeys(mode);
  const contents = isMobile ? <>
    <PlayerRule variant="Mini" clock={clock} origin={origin} />
    <div className={styles.miniRow}>
      <PlayerIdentity variant="Mini" mode={mode} openLectern={openLectern} buttonRef={openerRef}
        onOpenSheet={() => { sourceOpened.current = false; setSheetTarget("Player"); setSheetOpen(true); }} />
      {mini.has("upNext") ? upNext : null}
      {mini.has("disc") ? <PlayerTransport variant="Mini" mode={mode} keys={keys} discRef={discRef} /> : null}
    </div>
  </> : <>
    <PlayerRule variant="Bar" clock={clock} origin={origin} draft={draft} onDraft={setDraft} />
    <PlayerIdentity variant="Bar" mode={mode} openLectern={openLectern} open={openEpisode} />
    <PlayerTransport variant="Bar" mode={mode} keys={keys} discRef={discRef} previousRef={previousRef} nextRef={nextRef} />
    <div className={styles.right}>
      <PlayerUtilities variant="Bar" keys={keys} tiered={mode.kind === "Active" || mode.kind === "Advancing"} speed={speedKey("Bar")} upNext={upNext} more={more} {...chaptersKey} />
      <PlayerFolio variant="Bar" clock={clock} draft={draft} panelOpen={shownPicker === "Playback"} />
    </div>
  </>;
  const cold = clock.kind === "Live" && (clock.loaded.phase === "Paused" || clock.loaded.phase === "Ended" || clock.loaded.playbackFailed || clock.loaded.error !== null);

  return <>
    <PlayerKeys origin={origin} />
    <span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    <div ref={slotRef} className={styles.slot} data-reader-composition={readerComposition || undefined} hidden={suppressed} inert={suppressed || undefined}
      onFocusCapture={event => { focusedControl.current = event.target; sourceOpened.current = false; }}
      onBlurCapture={event => { if (event.relatedTarget !== null) focusedControl.current = null; }}>
      <footer ref={setFooter} id={isMobile ? undefined : presentation.regionId} tabIndex={isMobile ? undefined : -1}
        className={`${styles.surface} ${isMobile ? styles.mini : styles.bar}`} role="region" aria-label="media player"
        data-player-bar={isMobile ? undefined : ""} data-cold={cold} data-scrub={draft !== null}>
        {contents}
      </footer>
      <PickerSurface active={!isMobile && presentation.visible && shownPicker === "Playback"} onClose={() => { focusedControl.current = null; setPicker(null); }} title="playback" panelId={playbackId}
        anchor={() => returnFocus([rateRef.current])} returnFocusFallback={() => returnFocus([])} skipReturnFocus={skipReturnFocus(PICKER_DIALOGS)}
        placement="above" className={styles.picker} initialFocus={panel => panel.querySelector<HTMLInputElement>('input[type="range"]')}>
        {playbackPanel("Popup")}
      </PickerSurface>
      <PickerSurface active={!isMobile && presentation.visible && shownPicker === "Chapters"} onClose={() => { focusedControl.current = null; setPicker(null); }} title="chapters" panelId={chaptersId} heightLimit="available"
        anchor={() => returnFocus([chaptersRef.current, moreRef.current])} returnFocusFallback={() => returnFocus([])} skipReturnFocus={skipReturnFocus(PICKER_DIALOGS)}
        placement="above" className={styles.picker} initialFocus={panel => panel.querySelector<HTMLButtonElement>('button[aria-current="true"]') ?? panel.querySelector<HTMLButtonElement>('ol button')}>
        {chapterPanel("Popup")}
      </PickerSurface>
      <PickerSurface active={!isMobile && presentation.visible && queueOpen} onClose={() => setQueueOpen(false)} title="up next"
        anchor={() => returnFocus([queueRef.current, moreRef.current])} returnFocusFallback={() => returnFocus([])} placement="above"
        skipReturnFocus={skipReturnFocus('[role="dialog"][aria-label="up next"]')}
        className={styles.queuePicker} initialFocus={panel => {
          const target = panel.querySelector<HTMLElement>('[data-queue-initial-target="true"] [data-row-focusable]') ?? panel.querySelector<HTMLHeadingElement>("h2");
          target?.focus({ preventScroll: true });
          return target;
        }}>
        <div className={styles.queueScrollport}><QueuePanel announce={setAnnouncement} scrollport={section => section.parentElement} runtime={linkRuntime} onOpened={opened} revealOnOpen /></div>
      </PickerSurface>
      <PlayerSheet active={sheetShown} target={sheetTarget} contentRef={sheetContentRef}
        onDismiss={() => { focusedControl.current = null; setPicker(null); setSheetOpen(false); }}
        skipReturnFocus={() => sourceOpened.current}
        returnFocusTo={() => returnFocus([openerRef.current, queueRef.current])}
        returnFocusFallback={() => returnFocus([])}
        announce={setAnnouncement} runtime={linkRuntime} onOpened={opened}>
        <PlayerIdentity variant="Sheet" mode={mode} openLectern={openLectern} open={openEpisode} />
        {mode.kind === "Active" ? <PlayerRule variant="Sheet" clock={clock} origin={origin} draft={draft} onDraft={setDraft} /> : null}
        <PlayerTransport variant="Sheet" mode={mode} keys={keys} />
        {mode.kind === "Active" ? <PlayerUtilities variant="Sheet" keys={keys} speed={speedKey("Sheet")} {...chaptersKey} /> : null}
        {shownPicker !== null ? <MobileDisclosure key={`${playbackSubject}:${shownPicker}`} kind={shownPicker}
          id={shownPicker === "Playback" ? playbackId : chaptersId} close={() => setPicker(null)}
          trigger={() => shownPicker === "Playback" ? rateRef.current : chaptersRef.current}
          skipReturnFocus={() => sourceOpened.current || !currentSurface.current.sheetShown || picker?.subject !== currentSurface.current.playbackSubject}>
          {shownPicker === "Playback" ? playbackPanel("Embedded") : chapterPanel("Embedded")}
        </MobileDisclosure> : null}
      </PlayerSheet>
    </div>
  </>;
}
