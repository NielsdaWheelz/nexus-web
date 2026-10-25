"use client";

/** The complete occurrence index renders a measured window of ordinary rows.
 * Identity follows nearby and current/focused/open occurrences.
 * Every edit captures the displayed manifest's authority; playback owns feedback. */
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type MouseEvent, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, Ellipsis, Pause, Play, Trash2, ListStart } from "lucide-react";
import Button from "@/components/ui/Button";
import ResourceList from "@/components/ui/ResourceList";
import ResourceRow from "@/components/ui/ResourceRow";
import ActionMenu from "@/components/ui/ActionMenu";
import MediaIdentity, { MediaTitle } from "@/components/media/MediaIdentity";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { useMediaSummaryIds } from "@/lib/media/MediaSummaryProvider";
import type { MediaSubject, MediaSummary } from "@/lib/media/mediaSummary";
import { useCatalogState } from "@/lib/catalog/provider";
import { catalogMedia } from "@/lib/catalog/selectors";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import { useLocalContent } from "@/lib/offline/localContent";
import { usePlayerCommands, usePlayerSession } from "@/lib/player/playerRuntime";
import type { QueueCommand, QueueEntry, QueueManifest, QueueRequest } from "@/lib/player/queue";
import { activateTargetAnchor, type TargetLinkActivationRuntime } from "@/lib/panes/targetLinkActivation";
import { useQueueWindow } from "./useQueueWindow";
import styles from "./Player.module.css";

type FocusRecovery = {
  readonly queueId: string;
  readonly ids: readonly string[];
  readonly trigger: Element | null;
  readonly opener: Element | null;
  readonly accepted: boolean;
};

type Send = (request: QueueRequest, focus: readonly string[] | null, message: string | null) => Promise<boolean>;

const QueueRow = memo(function QueueRow({ entry, index, manifest, currentIndex, current, initialTarget, playing, failed, ready, summary, title, send, rowElement, menuChanged }: {
  readonly entry: QueueEntry;
  readonly index: number;
  readonly manifest: QueueManifest;
  readonly currentIndex: number | null;
  readonly current: boolean;
  readonly initialTarget: boolean;
  readonly playing: boolean;
  readonly failed: boolean;
  readonly ready: boolean;
  readonly summary: MediaSummary | null;
  readonly title: string;
  readonly send: Send;
  readonly rowElement: (entryId: string) => HTMLElement | null;
  readonly menuChanged: (entryId: string, open: boolean) => void;
}) {
  const subject: MediaSubject | null = summary === null ? null : { kind: "Stored", summary };
  const dispatch = (command: QueueCommand, focus: readonly string[] | null, message: string | null) =>
    send({ queue_id: manifest.queue_id, expected_revision: manifest.revision, command }, focus, message);
  const move = (beforeEntryId: string | null, message: string) => {
    void dispatch({ kind: "move-before", entry_id: entry.id, before_entry_id: beforeEntryId }, [entry.id], message);
  };
  const action = (id: string, label: string, icon: ReactElement, onSelect: () => void): ActionDescriptor => ({
    kind: "command", id, label, icon, disabled: !ready,
    disabledReason: ready ? undefined : "wait for the queue change to finish", onSelect,
  });
  const future = currentIndex !== null && index > currentIndex;
  const options: ActionDescriptor[] = [];
  if (future && index > currentIndex + 1) {
    options.push(action("next", "play next", <ListStart />, () => move(manifest.entries[currentIndex + 1]!.id, `“${title}” moved next`)));
    options.push(action("earlier", "move earlier", <ArrowUp />, () => move(manifest.entries[index - 1]!.id, `“${title}” moved earlier`)));
  }
  if (future && index < manifest.entries.length - 1)
    options.push(action("later", "move later", <ArrowDown />, () => move(manifest.entries[index + 2]?.id ?? null, `“${title}” moved later`)));
  if (future || failed) options.push(action("remove", "remove from queue", <Trash2 />, () => {
    const neighbors = [manifest.entries[index + 1], manifest.entries[index - 1]].flatMap(item => item === undefined ? [] : [item.id]);
    void dispatch({ kind: "remove", entry_id: entry.id, failed_current: failed }, neighbors, `removed “${title}” from queue`);
  }));
  const returnFocus = () => rowElement(entry.id)?.querySelector<HTMLElement>('[data-queue-action="more"]')
    ?? rowElement(entry.id)?.querySelector<HTMLElement>("[data-row-focusable]") ?? null;
  return <ResourceRow density="compact" primary={{ kind: "link", href: `/media/${entry.media_id}` }}
    title={subject === null ? title : <MediaTitle subject={subject} />}
    content={{ kind: "Index", metadata: subject === null ? null : <MediaIdentity subject={subject} returnFocus={returnFocus} /> }} selected={current}
    rootProps={{ "data-collection-row-id": entry.id, "aria-current": current ? "true" : undefined,
      "aria-posinset": index + 1, "aria-setsize": manifest.entries.length,
      "data-queue-initial-target": initialTarget ? "true" : undefined }}
    controls={<>
      <Button iconOnly icon={playing ? <Pause /> : <Play />} aria-label={`${failed ? "retry" : playing ? "pause" : "play"} “${title}”`}
        data-queue-entry={entry.id} data-queue-action="play" aria-disabled={!ready || undefined}
        onClick={() => { void dispatch({ kind: "select", entry_id: entry.id, play: !playing, position_ms: null }, null, null); }} />
      {options.length > 0 ? <ActionMenu returnFocusTo={returnFocus} label={`more actions for “${title}”`}
        triggerAttributes={{ "data-queue-entry": entry.id, "data-queue-action": "more" }}
        triggerDisabled={!ready} triggerDisabledReason="wait for the queue change to finish"
        onOpenChange={open => menuChanged(entry.id, open)}
        renderTrigger={props => <Button {...props} iconOnly icon={<Ellipsis />} />}
        source={{ kind: "Immediate", subjectKey: `queue:${manifest.queue_id}:${manifest.revision}:${entry.id}:${ready}`, title: "queue actions",
          content: { sections: [{ id: "Queue", label: null, options }] } }} /> : null}
    </>} />;
});

export default function QueuePanel({ announce, scrollport, runtime, onOpened, revealOnOpen }: {
  readonly announce: (message: string) => void;
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
  const ready = queue.known && queue.phase === "Ready" && state.kind !== "Unavailable" && queue.index.kind === "Ready"
    && manifest?.queue_id === header?.queue_id && manifest?.revision === header?.revision;
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
  const loadedDescriptor = state.kind === "Loaded" && state.source.kind === "Episode" ? state.source.descriptor : null;
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
  }, [focused, menu, currentIndex, queue.failure, manifest, rowElement]);

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

  const send = useCallback<Send>(async (request, focus, message) => {
    const current = authority.current;
    if (!current.ready || current.header?.queue_id !== request.queue_id || current.header.revision !== request.expected_revision) return false;
    const recovery: FocusRecovery | null = focus === null ? null : { queueId: request.queue_id, ids: focus, trigger: document.activeElement,
      opener: ("entry_id" in request.command ? rowElement(request.command.entry_id)?.querySelector('[data-queue-action="more"]') : null) ?? document.activeElement,
      accepted: false };
    if (recovery !== null) setPendingFocus(recovery);
    try {
      await liveCommands.current.queueCommand(request);
      if (authority.current.header?.queue_id !== request.queue_id) return true;
      if (message !== null) announce(message);
      if (recovery !== null) setPendingFocus(pending => pending === recovery ? { ...recovery, accepted: true } : pending);
      return true;
    } catch {
      // The command owner reports modeled refusals and defects before rejecting.
      if (recovery !== null) setPendingFocus(pending => pending === recovery ? null : pending);
      return false;
    }
  }, [announce, rowElement]);

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
    {!empty && manifest === null && queue.index.kind !== "Failed" ? <p>loading queue…</p> : null}
    {!empty && queue.index.kind === "Failed" ? <FeedbackNotice announcement="None" content={{ tone: "Warning", title: "couldn’t load queue" }}
      actions={[{ label: "retry", onClick: commands.retryQueueIndex }]} /> : null}
    {online && summaries.error !== null ? <FeedbackNotice announcement="None" content={{ tone: "Warning", title: "episode details unavailable" }} actions={[{ label: "retry", onClick: summaries.retry }]} /> : null}
    {empty ? <p>nothing queued</p> : null}
    {manifest !== null ? <ResourceList key={manifest.queue_id} ariaLabel="queued episodes" busy={!ready || !queueWindow.geometryReady}>
      {queueWindow.rows.map(({ entry, index, gap }) => {
        const summary = (online ? summaries.resolve(entry.media_id) : null) ?? (catalog.data === null ? null : catalogMedia(catalog.data, entry.media_id));
        const title = summary?.title ?? downloadTitles.get(entry.media_id) ?? (loadedDescriptor?.media_id === entry.media_id ? loadedDescriptor.title : null) ?? (online && summaries.pending(entry.media_id) ? "loading episode…" : "episode details unavailable");
        const current = header?.queue_id === manifest.queue_id && entry.id === header.current_entry_id;
        return <Fragment key={entry.id}>
          {gap > 0 && queueWindow.height !== null ? <li role="presentation" aria-hidden="true" className={styles.queueGap} style={{ blockSize: gap * queueWindow.height }} /> : null}
          <QueueRow entry={entry} index={index} manifest={manifest} currentIndex={currentIndex} current={current}
          initialTarget={queueWindow.geometryReady && (current || header?.current_entry_id === null && index === manifest.entries.length - 1)}
          playing={entry.id === playingEntryId} failed={current && queue.failure?.kind === "Episode" && queue.failure.entry_id === entry.id}
          ready={ready} summary={summary} title={title} send={send} rowElement={rowElement} menuChanged={menuChanged} />
        </Fragment>;
      })}
    </ResourceList> : null}
  </section>;
}
