"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as Icon from "lucide-react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { buttonClassName } from "@/components/ui/control";
import Tooltip from "@/components/ui/Tooltip";
import PickerSurface from "@/components/ui/PickerSurface";
import { activateTargetLink, type TargetLinkActivationRuntime } from "@/lib/panes/targetLinkActivation";
import { assertNever } from "@/lib/assertNever";
import { useMobileChromeSurface } from "@/lib/mobileShell/chrome";
import { findActivePaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import {
  useMobileViewport,
  useRootTextEntryFocused,
} from "@/lib/mobileShell/viewport";
import { usePlayerPresentation } from "@/lib/player/presentation";
import * as Player from "@/lib/player/playerRuntime";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useNativeKeyboardVisibility } from "@/lib/ui/useKeyboardInset";
import { useLatestWorkspace } from "@/lib/workspace/store";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import QueuePanel from "./QueuePanel";
import PlayerIdentity from "./PlayerIdentity";
import PlayerTransport from "./PlayerTransport";
import PlayerSeek, { MiniProgress } from "./PlayerSeek";
import PlayerUtilities from "./PlayerUtilities";
import { PlaybackPanel, usePlaybackSettings } from "./PlaybackSettings";
import PlayerChapters from "./PlayerChapters";
import { unavailableMessages } from "./PlayerFailures";
import PlayerSheet, { MobileDisclosure } from "./PlayerSheet";
import PlayerKeys from "./PlayerKeys";
import styles from "./GlobalPlayerSurfaces.module.css";

type Loaded = Extract<Player.PlayerState, { kind: "Loaded" }>;

const PICKER_DIALOGS = '[role="dialog"][aria-label="playback"], [role="dialog"][aria-label="chapters"]';

/**
 * presentation hides desktop chrome without retiring settings or announcements.
 * the viewport measures the mobile slot; chrome owns its inner footer's motion.
 * overlays return only to visible controls, and never reclaim unrelated focus.
 */
export default function GlobalPlayerSurfaces({ readerComposition }: { readerComposition: boolean }) {
  const { state, queue, preferences, pendingPlayback, playbackSubject, supportsSilenceSkipping } = Player.usePlayerSession();
  const presentation = usePlayerPresentation();
  const commands = Player.usePlayerCommands();
  const latestWorkspace = useLatestWorkspace();
  const isMobile = useIsMobileViewport();
  const priorMode = useRef(isMobile);
  const modeChanged = priorMode.current !== isMobile;
  const mobileViewport = useMobileViewport();
  const textEntryFocused = useRootTextEntryFocused();
  const nativeKeyboard = useNativeKeyboardVisibility();
  const [picker, setPicker] = useState<{ readonly subject: string; readonly kind: "Playback" | "Chapters" } | null>(null);
  const shownPicker = (isMobile || presentation.visible) && !modeChanged && state.kind === "Loaded" && picker !== null && picker.subject === playbackSubject ? picker.kind : null;
  const panelOpen = shownPicker === "Playback";
  const [opening, setOpening] = useState(0);
  const playbackId = useId();
  const chaptersId = useId();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [sheetTarget, setSheetTarget] = useState<"Player" | "Queue">("Player");
  const queueRef = useRef<HTMLButtonElement>(null);
  const queueBusy = queue.phase === "Preparing" || queue.phase === "Saving";
  const retained = queue.known && queue.header !== null && queue.header.count > 0;
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const idleRef = useRef<HTMLAnchorElement>(null);
  const rateRef = useRef<HTMLButtonElement>(null);
  const chaptersRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const sheetContentRef = useRef<HTMLDivElement>(null);
  const focusedControl = useRef<HTMLElement | null>(null);
  const sourceOpened = useRef(false);
  const announcedSource = useRef<string | null>(null);
  const announcedPhase = useRef<Loaded["phase"] | null>(null);
  const announcedUnavailable = useRef<string | null>(null);
  const loaded = state.kind === "Loaded" ? state : null;
  const identity = loaded?.source.descriptor.media_id ?? null;
  const { accountId } = useAuthenticatedAccount();
  const settings = usePlaybackSettings({ loaded, playbackSubject, preferences, opening });
  const title = loaded?.source.descriptor.title;
  const queuePlaybackFailure = loaded !== null && loaded.playbackFailed
    && queue.failure?.kind === "Episode" && queue.failure.entry_id === queue.header?.current_entry_id;
  const status = loaded === null || queuePlaybackFailure ? null : loaded.error ??
    (loaded.phase === "Buffering" ? "Buffering" : loaded.synced ? null : "Progress sync paused");
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

  const returnFocus = useCallback((opener: HTMLElement | null): { element: HTMLElement; preventScroll: true } | null => {
    const candidates = !isMobile && !currentSurface.current.desktopVisible
      ? [presentation.railRef.current]
      : [opener, idleRef.current, isMobile ? null : presentation.regionRef.current, findActivePaneLandmarkFocusTarget()];
    const element = candidates
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
  }, [textEntryFocused, isMobile, presentation.railRef, presentation.regionRef]);
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
  }, [state, isMobile, preferences, sheetShown, presentation.visible, returnFocus]);

  useEffect(() => {
    switch (state.kind) {
      case "Absent":
        setAnnouncement(announcedSource.current === null ? null : "playback stopped");
        announcedSource.current = null;
        announcedPhase.current = null;
        announcedUnavailable.current = null;
        break;
      case "Unavailable":
        if (unavailable !== announcedUnavailable.current) setAnnouncement(unavailable);
        announcedUnavailable.current = unavailable;
        break;
      case "Loaded": {
        if (queuePlaybackFailure) {
          announcedSource.current = identity;
          announcedPhase.current = state.phase;
          break;
        }
        const recovering = announcedUnavailable.current !== null;
        announcedUnavailable.current = null;
        const started = state.error === null && state.phase === "Playing";
        if (identity !== announcedSource.current) {
          const observation = started ? "now playing" : state.phase === "Buffering" ? "buffering" : "audio loaded";
          setAnnouncement(state.error === null ? `${observation}: ${title}` : null);
        } else if (started && announcedPhase.current !== "Playing") {
          setAnnouncement(`now playing: ${title}`);
        }
        else if (recovering) setAnnouncement(null);
        announcedSource.current = identity;
        announcedPhase.current = state.phase;
        break;
      }
      default: assertNever(state);
    }
  }, [state, identity, title, status, unavailable, settings.status, queuePlaybackFailure]);

  const toggle = (kind: "Playback" | "Chapters") => {
    if (shownPicker === kind) { setPicker(null); return; }
    if (kind === "Playback") { settings.save.reset(); setOpening(value => value + 1); }
    if (playbackSubject !== null) setPicker({ subject: playbackSubject, kind });
  };
  const utilities = { picker: shownPicker, playbackId, chaptersId, rateRef, chaptersRef, onToggle: toggle,
    settings: { status: settings.status, failed: settings.failed, busy: settings.save.busy } };
  const openQueue = <Button ref={queueRef} size="comfortable" className={styles.upNext} icon={<Icon.ListMusic />} aria-label="up next"
    aria-haspopup="dialog" aria-expanded={isMobile ? sheetShown : queueOpen}
    aria-busy={queueBusy || undefined}
    aria-description={queue.phase === "Preparing" ? "preparing queue…" : queue.phase === "Saving" ? "saving queue…" : undefined}
    onClick={() => { sourceOpened.current = false; if (isMobile) { setSheetTarget("Queue"); setSheetOpen(true); } else setQueueOpen(value => !value); }}>up next</Button>;
  const absentCopy = pendingPlayback !== null || !queue.known ? ""
    : retained ? queue.header?.current_entry_id === null ? "queue finished" : "playback stopped" : "nothing queued";
  let desktopSource: ReactNode = <p className={styles.emptyIdentity}>{absentCopy}</p>;
  let contents: ReactNode = null;
  let overlays: ReactNode = null;
  let sheetPlayerContent: ReactNode = null;
  switch (state.kind) {
    case "Absent": {
      const openLectern = (event: TargetActivationEvent) => activateTargetLink({
        event, runtime: linkRuntime, target: { href: "/lectern", labelHint: "lectern" },
      });
      if (pendingPlayback !== null) sheetPlayerContent = <><p>{absentCopy}</p><PlayerTransport variant="Sheet" /></>;
      contents = <div className={styles.idle}>
        <Icon.Headphones className={styles.idleGlyph} aria-hidden="true" />
        <span className={styles.idleCopy}>{absentCopy}</span>
        {pendingPlayback !== null ? <PlayerTransport variant="Mini" /> : <>
          {retained ? <Button iconOnly size="comfortable" icon={<Icon.SkipBack />} aria-label="previous" onClick={commands.previous} disabled={queue.phase !== "Ready"} /> : null}
          {retained ? <Button onClick={commands.resume} disabled={queue.phase !== "Ready" || queue.header?.current_entry_id === null}>resume</Button> : null}
        </>}
        {openQueue}
        <Tooltip text="open lectern" triggerRef={idleRef} renderTrigger={help => (
          // Shared player navigation uses its existing workspace gesture handler.
          // eslint-disable-next-line @next/next/no-html-link-for-pages
          <a {...help} href="/lectern" className={buttonClassName({ size: "comfortable", iconOnly: true })}
            aria-label="open lectern" data-workspace-rich-target="true" onClick={openLectern} onKeyDown={openLectern}>
            <Icon.ListMusic size={20} aria-hidden="true" />
          </a>
        )} />
      </div>;
      break;
    }
    case "Unavailable": {
      const warning = state.reason === "UpdateRequired" ? <FeedbackNotice
        content={{ tone: "Warning", title: unavailableMessages[state.reason] }} announcement="None"
        actions={[{ label: "update", href: "/android" }]} /> : null;
      desktopSource = warning;
      if (pendingPlayback !== null) sheetPlayerContent = <>{warning}<PlayerTransport variant="Sheet" /></>;
      contents = <div className={styles.unavailable}>{warning}{pendingPlayback !== null ? <PlayerTransport variant="Mini" /> : null}{openQueue}</div>;
      break;
    }
    case "Loaded": {
      const source = state.source;
      const sourceHref = `/media/${source.descriptor.media_id}`;
      const openSource = (event: TargetActivationEvent) => {
        const handled = activateTargetLink({ event, runtime: linkRuntime,
          target: { href: sourceHref, labelHint: source.descriptor.title },
        });
        if (handled === "handled-default" || handled === "handled-new-pane") opened();
      };
      const identityStatus = (queuePlaybackFailure ? null : state.error) ?? settings.status ?? status;
      desktopSource = <PlayerIdentity variant="Bar" loaded={state} label={`open ${source.descriptor.title}`} href={sourceHref} onOpen={openSource} status={identityStatus} />;
      const playbackPanel = (presentation: "Popup" | "Embedded") => preferences === null || playbackSubject === null ? null
        : <PlaybackPanel loaded={state} preferences={preferences} supportsSilenceSkipping={supportsSilenceSkipping} settings={settings} presentation={presentation} />;
      const seekChapter = (startMs: number) => {
        if (playbackSubject !== null) commands.seekTo({ positionMs: startMs, expectedSubject: playbackSubject });
      };
      contents = isMobile ? <>
        <MiniProgress />
        <div className={styles.miniRow}>
          <PlayerIdentity variant="Mini" loaded={state} buttonRef={openerRef} status={identityStatus}
            label={`open now playing: ${source.descriptor.title}`}
            onOpen={() => { sourceOpened.current = false; setSheetTarget("Player"); setSheetOpen(true); }} />
          <PlayerTransport variant="Mini" />
          {openQueue}
        </div>
      </> : null;
      sheetPlayerContent = <>
        <PlayerIdentity variant="Sheet" loaded={state} label={`open ${source.descriptor.title}`} href={sourceHref} onOpen={openSource} status={identityStatus} />
        <PlayerTransport variant="Sheet" />
        <PlayerSeek active={sheetShown} />
        <PlayerUtilities variant="Sheet" {...utilities} />
        {shownPicker !== null ? <MobileDisclosure key={`${playbackSubject}:${shownPicker}`} kind={shownPicker}
          id={shownPicker === "Playback" ? playbackId : chaptersId} close={() => setPicker(null)}
          trigger={() => shownPicker === "Playback" ? rateRef.current : chaptersRef.current}
          skipReturnFocus={() => sourceOpened.current || !currentSurface.current.sheetShown || picker?.subject !== currentSurface.current.playbackSubject}>
          {shownPicker === "Playback" ? playbackPanel("Embedded") : <PlayerChapters loaded={state} presentation="Embedded" onSeek={seekChapter} onOpened={opened} />}
        </MobileDisclosure> : null}
      </>;
      overlays = <>
        <PickerSurface active={!isMobile && presentation.visible && panelOpen} onClose={() => { focusedControl.current = null; setPicker(null); }} title="playback" panelId={playbackId}
          anchor={() => returnFocus(rateRef.current)} returnFocusFallback={() => returnFocus(null)} skipReturnFocus={skipReturnFocus(PICKER_DIALOGS)}
          placement="above" className={styles.picker} initialFocus={panel => panel.querySelector<HTMLInputElement>('input[type="range"]')}>
          {playbackPanel("Popup")}
        </PickerSurface>
        <PickerSurface active={!isMobile && presentation.visible && shownPicker === "Chapters"} onClose={() => { focusedControl.current = null; setPicker(null); }} title="chapters" panelId={chaptersId} heightLimit="available"
          anchor={() => returnFocus(chaptersRef.current)} returnFocusFallback={() => returnFocus(null)} skipReturnFocus={skipReturnFocus(PICKER_DIALOGS)}
          placement="above" className={styles.picker} initialFocus={panel => panel.querySelector<HTMLButtonElement>('button[aria-current="true"]') ?? panel.querySelector<HTMLButtonElement>('ol button')}>
          <PlayerChapters loaded={state} presentation="Popup" onSeek={seekChapter} onOpened={opened} />
        </PickerSurface>
      </>;
      break;
    }
    default: assertNever(state);
  }

  if (!isMobile) contents = <>
    <div className={styles.source}>{desktopSource}</div>
    <div className={styles.desktopTransport}><PlayerTransport variant="Bar" /></div>
    <div className={styles.listening}><PlayerSeek active={presentation.visible} /></div>
    <PlayerUtilities variant="Bar" className={styles.options} upNext={openQueue} {...utilities} />
  </>;

  return <>
    <PlayerKeys />
    <span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    <div ref={slotRef} className={styles.slot} data-reader-composition={readerComposition || undefined} hidden={suppressed} inert={suppressed || undefined}
      onFocusCapture={event => { focusedControl.current = event.target; sourceOpened.current = false; }}
      onBlurCapture={event => { if (event.relatedTarget !== null) focusedControl.current = null; }}>
      <footer ref={setFooter} id={isMobile ? undefined : presentation.regionId} tabIndex={isMobile ? undefined : -1} className={`${styles.surface} ${isMobile ? styles.mini : styles.bar}`}
        role="region" aria-label="media player">
        {contents}
      </footer>
      {overlays}
      <PickerSurface active={!isMobile && presentation.visible && queueOpen} onClose={() => setQueueOpen(false)} title="up next"
        anchor={() => returnFocus(queueRef.current)} returnFocusFallback={() => returnFocus(null)} placement="above"
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
        returnFocusTo={() => returnFocus(loaded !== null ? openerRef.current ?? queueRef.current : queueRef.current)}
        returnFocusFallback={() => returnFocus(null)}
        announce={setAnnouncement} runtime={linkRuntime} onOpened={opened}>
        {sheetPlayerContent}
      </PlayerSheet>
    </div>
  </>;
}
