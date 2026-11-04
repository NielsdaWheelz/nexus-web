"use client";

/** The complete occurrence index renders a measured window of ordinary rows.
 * Identity follows nearby and current/focused/open occurrences.
 * Every edit captures the displayed manifest's authority; playback owns feedback, and an edit's
 * success says nothing: focus lands on the moved row or a neighbour, whose position is read. */
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type MouseEvent, type KeyboardEvent } from "react";
import Button from "@/components/ui/Button";
import Artwork, { remoteArtwork } from "@/components/ui/Artwork";
import ResourceList from "@/components/ui/ResourceList";
import ResourceRow from "@/components/ui/ResourceRow";
import ActionMenu from "@/components/ui/ActionMenu";
import { MediaTitle } from "@/components/media/MediaIdentity";
import IndexBibliography from "@/components/resources/IndexBibliography";
import { Fact, Failed } from "@/components/feedback/Fact";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { useMediaSummaryIds } from "@/lib/media/MediaSummaryProvider";
import type { MediaSubject, MediaSummary } from "@/lib/media/mediaSummary";
import { mediaByline } from "@/lib/media/mediaByline";
import * as Icon from "@/lib/ui/icons";
import { useCatalogState } from "@/lib/catalog/provider";
import { catalogMedia } from "@/lib/catalog/selectors";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import { useLocalContent } from "@/lib/offline/localContent";
import { playingEpisode, queueBlock, usePlayerCommands, usePlayerSession, type QueueBlock } from "@/lib/player/playerRuntime";
import { QueueCommandError, type QueueCommand, type QueueEntry, type QueueManifest, type QueueRequest } from "@/lib/player/queue";
import { activateTargetAnchor, type TargetLinkActivationRuntime } from "@/lib/panes/targetLinkActivation";
import { useQueueWindow } from "./useQueueWindow";
import styles from "./QueuePanel.module.css";

type FocusRecovery = {
  readonly queueId: string;
  readonly ids: readonly string[];
  readonly trigger: Element | null;
  readonly opener: Element | null;
  readonly accepted: boolean;
};

type Send = (request: QueueRequest, focus: readonly string[] | null) => Promise<boolean>;

const QueueRow = memo(function QueueRow({ entry, index, manifest, currentIndex, current, initialTarget, playing, failed, blocked, summary, title, send, rowElement, menuChanged }: {
  readonly entry: QueueEntry;
  readonly index: number;
  readonly manifest: QueueManifest;
  readonly currentIndex: number | null;
  readonly current: boolean;
  readonly initialTarget: boolean;
  readonly playing: boolean;
  readonly failed: boolean;
  readonly blocked: QueueBlock | null;
  readonly summary: MediaSummary | null;
  readonly title: string;
  readonly send: Send;
  readonly rowElement: (entryId: string) => HTMLElement | null;
  readonly menuChanged: (entryId: string, open: boolean) => void;
}) {
  const subject: MediaSubject | null = summary === null ? null : { kind: "Stored", summary };
  const dispatch = (command: QueueCommand, focus: readonly string[] | null) =>
    send({ queue_id: manifest.queue_id, expected_revision: manifest.revision, command }, focus);
  const move = (beforeEntryId: string | null) => {
    void dispatch({ kind: "move-before", entry_id: entry.id, before_entry_id: beforeEntryId }, [entry.id]);
  };
  const action = (id: string, label: string, icon: ReactElement | null, onSelect: () => void): ActionDescriptor => ({
    kind: "command", id, label, icon, disabled: blocked !== null, disabledReason: blocked?.reason, onSelect,
  });
  const future = currentIndex !== null && index > currentIndex;
  const options: ActionDescriptor[] = [];
  if (future && index > currentIndex + 1) {
    options.push(action("next", "play next", null, () => move(manifest.entries[currentIndex + 1]!.id)));
    options.push(action("earlier", "move earlier", <Icon.MoveUp />, () => move(manifest.entries[index - 1]!.id)));
  }
  if (future && index < manifest.entries.length - 1)
    options.push(action("later", "move later", <Icon.MoveDown />, () => move(manifest.entries[index + 2]?.id ?? null)));
  if (future || failed) options.push(action("remove", "remove from queue", null, () => {
    const neighbors = [manifest.entries[index + 1], manifest.entries[index - 1]].flatMap(item => item === undefined ? [] : [item.id]);
    void dispatch({ kind: "remove", entry_id: entry.id, failed_current: failed }, neighbors);
  }));
  const returnFocus = () => rowElement(entry.id)?.querySelector<HTMLElement>('[data-queue-action="more"]')
    ?? rowElement(entry.id)?.querySelector<HTMLElement>("[data-row-focusable]") ?? null;
  return <ResourceRow density="compact" primary={{ kind: "link", href: `/media/${entry.media_id}` }}
    leadingVisual={<Artwork size={44} title={summary === null ? "" : summary.show?.title ?? summary.title} source={remoteArtwork(summary?.show?.image_url ?? null)} />}
    title={subject === null ? title : <MediaTitle subject={subject} />}
    content={{ kind: "Index", metadata: summary === null || summary.show === null ? null : <IndexBibliography byline={mediaByline(summary, null)} originalPublishedDate={null} returnFocus={returnFocus} /> }} selected={current}
    rootProps={{ "data-collection-row-id": entry.id, "aria-current": current ? "true" : undefined,
      "aria-posinset": index + 1, "aria-setsize": manifest.entries.length,
      "data-queue-initial-target": initialTarget ? "true" : undefined }}
    controls={<>
      <Button iconOnly icon={playing ? <Icon.Pause /> : <Icon.Play />} aria-label={`${failed ? "retry" : playing ? "pause" : "play"} “${title}”`}
        data-queue-entry={entry.id} data-queue-action="play" aria-disabled={blocked !== null || undefined}
        onClick={() => { void dispatch({ kind: "select", entry_id: entry.id, play: !playing, position_ms: null }, null); }} />
      {options.length > 0 ? <ActionMenu returnFocusTo={returnFocus} label={`more actions for “${title}”`}
        triggerAttributes={{ "data-queue-entry": entry.id, "data-queue-action": "more" }}
        triggerDisabled={blocked !== null} triggerDisabledReason={blocked?.reason}
        onOpenChange={open => menuChanged(entry.id, open)}
        renderTrigger={props => <Button {...props} iconOnly icon={<Icon.More />} />}
        source={{ kind: "Immediate", subjectKey: `queue:${manifest.queue_id}:${manifest.revision}:${entry.id}:${blocked?.reason}`, title: "queue actions",
          content: { sections: [{ id: "Queue", label: null, options }] } }} /> : null}
    </>} />;
});

export default function QueuePanel({ scrollport, runtime, onOpened, revealOnOpen }: {
  readonly scrollport: (section: HTMLElement) => HTMLElement | null;
  readonly runtime: TargetLinkActivationRuntime;
  readonly onOpened: () => void;
  readonly revealOnOpen: boolean;
}) {
  const { queue, state, playingEntryId } = usePlayerSession();
  const commands = usePlayerCommands();
  const liveCommands = useRef(commands);
  liveCommands.current = commands;
  const header = queue.header;
  const manifest = queue.index.kind === "Ready" ? queue.index.snapshot : queue.index.previous;
  const blocked = queueBlock(queue, state, "Rows");
  const ready = blocked === null;
  const authority = useRef({ ready, header });
  useLayoutEffect(() => {
    authority.current = { ready, header };
    return () => { authority.current = { ready: false, header: null }; };
  }, [ready, header]);
  const root = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [pendingFocus, setPendingFocus] = useState<FocusRecovery | null>(null);
  const [focused, setFocused] = useState<{ id: string; more: boolean } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const authoritativeEmpty = queue.known && (header === null || header.count === 0);
  const lateReveal = useRef(revealOnOpen && !authoritativeEmpty);
  const openingEntryId = header?.current_entry_id ?? manifest?.entries.at(-1)?.id ?? null;
  const queueWindow = useQueueWindow({ manifest, root, scrollport, openingEntryId: lateReveal.current ? openingEntryId : null,
    focusedEntryId: focused?.id ?? null, menuEntryId: menu, recoveryEntryIds: pendingFocus?.ids ?? [] });
  const entries = queueWindow.byId;
  const rowElement = queueWindow.rowElement;
  const currentIndex = header !== null && header.queue_id === manifest?.queue_id && header.current_entry_id !== null
    ? entries.get(header.current_entry_id)?.index ?? null : null;
  const online = useRemoteAdmission() === "Ready";
  const catalog = useCatalogState();
  const downloads = useLocalContent();
  const loadedDescriptor = playingEpisode(state);
  const downloadTitles = useMemo(() => new Map(downloads.index?.items.map(item => [item.media_id, item.title]) ?? []), [downloads.index]);
  const mediaIds = queueWindow.demand.map(entry => entry.media_id);
  const currentEntry = header?.current_entry_id === null || header === null ? null : entries.get(header.current_entry_id)?.entry;
  if (currentEntry !== null && currentEntry !== undefined) mediaIds.push(currentEntry.media_id);
  const summaries = useMediaSummaryIds(online ? mediaIds : []);
  const menuChanged = useCallback((id: string, open: boolean) => setMenu(current => open ? id : current === id ? null : current), []);

  useEffect(() => {
    if (!lateReveal.current) return;
    const cancel = () => { lateReveal.current = false; };
    const moved = (event: FocusEvent) => { if (event.target !== heading.current) cancel(); };
    document.addEventListener("wheel", cancel, { capture: true, passive: true });
    document.addEventListener("touchstart", cancel, { capture: true, passive: true });
    document.addEventListener("pointerdown", cancel, true);
    document.addEventListener("keydown", cancel, true);
    document.addEventListener("focusin", moved, true);
    window.addEventListener("blur", cancel);
    return () => {
      cancel();
      document.removeEventListener("wheel", cancel, true);
      document.removeEventListener("touchstart", cancel, true);
      document.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("keydown", cancel, true);
      document.removeEventListener("focusin", moved, true);
      window.removeEventListener("blur", cancel);
    };
  }, []);

  useEffect(() => {
    if (!lateReveal.current || !queueWindow.geometryReady) return;
    const target = openingEntryId === null ? authoritativeEmpty ? heading.current : null : rowElement(openingEntryId)?.querySelector<HTMLElement>("[data-row-focusable]");
    if (target === null || target === undefined) return;
    lateReveal.current = false;
    target.scrollIntoView({ block: "center" });
    target.focus({ preventScroll: true });
  }, [manifest, openingEntryId, authoritativeEmpty, queueWindow.geometryReady, rowElement]);

  useLayoutEffect(() => {
    const entryId = focused?.more ? focused.id : menu;
    if (entryId === null) return;
    const row = rowElement(entryId);
    if (row?.querySelector('[data-queue-action="more"]')) return;
    if (document.activeElement === document.body || row?.contains(document.activeElement))
      row?.querySelector<HTMLElement>("[data-row-focusable]")?.focus({ preventScroll: true });
  }, [focused, menu, currentIndex, queue.error, manifest, rowElement]);

  useLayoutEffect(() => {
    const pending = pendingFocus;
    if (pending === null) return;
    if (pending.queueId !== header?.queue_id) { setPendingFocus(null); return; }
    if (!pending.accepted || !ready || !queueWindow.geometryReady) return;
    const active = document.activeElement;
    if (active === document.body || active === pending.trigger || active === pending.opener) {
      const target = pending.ids.map(id => {
        const row = rowElement(id);
        return row?.querySelector<HTMLElement>('[data-queue-action="more"]')
          ?? row?.querySelector<HTMLElement>('[data-queue-action="play"]')
          ?? row?.querySelector<HTMLElement>("[data-row-focusable]");
      }).find(node => node !== null && node !== undefined) ?? heading.current;
      target?.scrollIntoView({ block: "nearest", inline: "nearest" });
      target?.focus({ preventScroll: true });
    }
    setPendingFocus(null);
  }, [pendingFocus, header?.queue_id, ready, queueWindow.geometryReady, rowElement]);

  const send = useCallback<Send>(async (request, focus) => {
    const current = authority.current;
    if (!current.ready || current.header?.queue_id !== request.queue_id || current.header.revision !== request.expected_revision) return false;
    const recovery: FocusRecovery | null = focus === null ? null : { queueId: request.queue_id, ids: focus, trigger: document.activeElement,
      opener: ("entry_id" in request.command ? rowElement(request.command.entry_id)?.querySelector('[data-queue-action="more"]') : null) ?? document.activeElement,
      accepted: false };
    if (recovery !== null) setPendingFocus(recovery);
    // The player says a refusal; focus stays where it was.
    if (await liveCommands.current.queueCommand(request) === "Refused") {
      if (recovery !== null) setPendingFocus(pending => pending === recovery ? null : pending);
      return false;
    }
    if (authority.current.header?.queue_id !== request.queue_id) return true;
    if (recovery !== null) setPendingFocus(pending => pending === recovery ? { ...recovery, accepted: true } : pending);
    return true;
  }, [rowElement]);

  const activateAnchor = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    const element = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!(element instanceof HTMLAnchorElement)) return;
    const result = activateTargetAnchor({ event, anchor: element, runtime });
    if (result === "handled-default" || result === "handled-new-pane") onOpened();
  };
  const empty = authoritativeEmpty || manifest?.entries.length === 0;
  return <section ref={root} className={styles.queuePanel} aria-label="up next" data-queue-id={manifest?.queue_id}
    onClickCapture={activateAnchor} onKeyDownCapture={activateAnchor}
    onFocusCapture={event => {
      const row = event.target.closest<HTMLElement>("[data-collection-row-id]");
      setFocused(row ? { id: row.dataset.collectionRowId!, more: event.target.dataset.queueAction === "more" } : null);
    }} onBlurCapture={event => {
      if (event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget)) setFocused(null);
    }}>
    <h2 ref={heading} tabIndex={-1} className={styles.panelTitle}>up next</h2>
    {manifest !== null || queue.index.kind !== "Failed" ? null : queue.index.error instanceof QueueCommandError
      ? queue.index.error.line === null ? null : <Fact line={queue.index.error.line}
        verbs={[{ label: "retry", commandKey: "retry queued episodes", run: () => void commands.retryQueueIndex() }]} />
      : <Failed error={queue.index.error} noun="queued episodes" retry={{ run: () => void commands.retryQueueIndex() }} />}
    {empty ? <Fact line={{ fact: "nothing queued" }} /> : null}
    {manifest !== null ? <ResourceList key={manifest.queue_id} ariaLabel="queued episodes" busy={!ready || !queueWindow.geometryReady}>
      {queueWindow.rows.map(({ entry, index, gap }) => {
        const summary = (online ? summaries.resolve(entry.media_id) : null) ?? (catalog.data === null ? null : catalogMedia(catalog.data, entry.media_id));
        const title = summary?.title ?? downloadTitles.get(entry.media_id) ?? (loadedDescriptor?.media_id === entry.media_id ? loadedDescriptor.title : null) ?? (online && summaries.pending(entry.media_id) ? "loading episode…" : "episode details unavailable");
        const current = header?.queue_id === manifest.queue_id && entry.id === header.current_entry_id;
        return <Fragment key={entry.id}>
          {gap > 0 && queueWindow.height !== null ? <li role="presentation" aria-hidden="true" className={styles.queueGap} style={{ blockSize: gap * queueWindow.height }} /> : null}
          <QueueRow entry={entry} index={index} manifest={manifest} currentIndex={currentIndex} current={current}
          initialTarget={queueWindow.geometryReady && (current || header?.current_entry_id === null && index === manifest.entries.length - 1)}
          playing={entry.id === playingEntryId} failed={current && queue.error?.kind === "Episode" && queue.error.entry_id === entry.id}
          blocked={blocked} summary={summary} title={title} send={send} rowElement={rowElement} menuChanged={menuChanged} />
        </Fragment>;
      })}
    </ResourceList> : null}
  </section>;
}
