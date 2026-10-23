"use client";

/** The queue displays occurrences from the current cursor forward. Its viewport
 * never requests preceding history; all edits go through the player's revision owner. */
import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { ArrowDown, ArrowUp, Play, Trash2, ListStart } from "lucide-react";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import ResourceRow from "@/components/ui/ResourceRow";
import SortableList from "@/components/sortable/SortableList";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import type { CollectionRowView, OrderPresentation } from "@/lib/collections/types";
import { useMediaSummaryIds } from "@/lib/media/MediaSummaryProvider";
import { usePlayerCommands, usePlayerSession } from "@/lib/player/playerRuntime";
import type { QueueCommand, QueueEntry, QueueSource } from "@/lib/player/queue";
import styles from "./Player.module.css";

const SORT_LABELS = {
  added_asc: "oldest added", added_desc: "newest added", title_asc: "title a–z", title_desc: "title z–a",
  creator_asc: "creator a–z", creator_desc: "creator z–a", published_asc: "oldest published", published_desc: "newest published",
  remaining_asc: "least time remaining", remaining_desc: "most time remaining",
  newest: "newest episodes", oldest: "oldest episodes", duration_asc: "shortest first", duration_desc: "longest first",
};

function sourceHref(source: QueueSource): string {
  const params = new URLSearchParams();
  if (source.sort !== null) params.set("sort", source.sort);
  switch (source.kind) {
    case "Lectern": return `/lectern?${params}`;
    case "Library":
      if (source.entry_type !== null) params.set("entry_type", source.entry_type);
      if (source.projection !== null) params.set("projection", source.projection);
      if (source.completion !== null) params.set("completion", source.completion);
      return `/libraries/${source.library_id}?${params}`;
    case "Podcast":
      params.set("state", source.state);
      return `/podcasts/${source.podcast_id}?${params}`;
  }
}

export function QueueStatus() {
  const { queue } = usePlayerSession();
  const commands = usePlayerCommands();
  return <>
    {queue.phase === "Preparing" ? <FeedbackStatus announcement="None" content={{ tone: "Neutral", title: "preparing queue…" }} actions={[{ label: "cancel", onClick: commands.cancelQueuePreparation }]} /> : null}
    {queue.phase === "Saving" ? <FeedbackStatus announcement="None" content={{ tone: "Neutral", title: "saving queue…" }} /> : null}
    {queue.phase === "Uncertain" ? <FeedbackNotice announcement="None" content={{ tone: "Warning", title: "couldn’t confirm queue change" }} actions={[{ label: "check", onClick: commands.checkQueue }]} /> : null}
    {queue.phase === "Unavailable" ? <FeedbackNotice announcement="None" content={{ tone: "Warning", title: "player unavailable", message: "open nexus in a browser with web locks and broadcast channels to play audio" }} /> : null}
    {queue.error !== null && queue.failure?.kind !== "Episode" && queue.phase !== "Uncertain" && queue.phase !== "Unavailable" ? <FeedbackNotice announcement="None" content={{ tone: "Warning", title: queue.error }} actions={[{ label: "retry", onClick: commands.checkQueue }]} /> : null}
    {queue.canRestore ? <FeedbackNotice announcement="None" content={{ tone: "Neutral", title: "queue replaced" }} actions={[{ label: "restore previous queue", onClick: commands.restoreQueue }]} /> : null}
  </>;
}

export default function QueuePanel({ announce, scrollport }: { readonly announce: (message: string) => void; readonly scrollport: () => HTMLElement | null }) {
  const { queue, state } = usePlayerSession();
  const commands = usePlayerCommands();
  const header = queue.header;
  const root = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const pendingFocus = useRef<{ entryId: string | null; action: string } | null>(null);
  const [prefix, setPrefix] = useState(100);
  const [paging, setPaging] = useState(false);
  const [pageError, setPageError] = useState(false);
  const [commandFailed, setCommandFailed] = useState(false);
  const firstUpcoming = header?.current_index === null || header === null ? header?.count ?? 0 : header.current_index + 1;
  const upcoming = queue.entries.filter((_, index) => index + queue.offset >= firstUpcoming).slice(0, prefix);
  const current = header?.current_entry ?? null;
  const visible = current === null ? upcoming : [current, ...upcoming];
  const summaries = useMediaSummaryIds(visible.map(entry => entry.media_id));
  const ready = queue.phase === "Ready";
  const failure = queue.failure?.kind === "Episode" && queue.failure.entry_id === current?.id ? queue.failure : null;
  const failed = failure !== null;
  useLayoutEffect(() => { setPrefix(100); setPageError(false); }, [header?.queue_id, header?.current_entry_id]);
  useLayoutEffect(() => {
    if (!ready || pendingFocus.current === null) return;
    const pending = pendingFocus.current;
    pendingFocus.current = null;
    const target = [...root.current!.querySelectorAll<HTMLButtonElement>("button[data-queue-entry]")]
      .find(button => button.dataset.queueEntry === pending.entryId && button.dataset.queueAction === pending.action);
    (target ?? heading.current)?.focus({ preventScroll: true });
  }, [header?.revision, ready]);

  const send = async (command: QueueCommand) => {
    if (header === null) return false;
    setCommandFailed(false);
    try {
      await commands.queueCommand({ queue_id: header.queue_id, expected_revision: header.revision, command });
      return true;
    } catch {
      setCommandFailed(true);
      return false;
    }
  };
  const move = (entryId: string, beforeEntryId: string | null) =>
    send({ kind: "move-before", entry_id: entryId, before_entry_id: beforeEntryId });
  const select = (entryId: string) => { void send({ kind: "select", entry_id: entryId, play: true, position_ms: null }); };
  const remove = async (entry: QueueEntry, position: number) => {
    const index = queue.entries.findIndex(item => item.id === entry.id);
    const next = queue.entries[index + 1] ?? queue.entries[index - 1] ?? null;
    pendingFocus.current = { entryId: next?.id ?? null, action: "remove" };
    if (await send({ kind: "remove", entry_id: entry.id, failed_current: failure?.entry_id === entry.id }))
      announce(`removed position ${position} from queue`);
    else pendingFocus.current = { entryId: entry.id, action: "remove" };
  };
  const rows: CollectionRowView[] = upcoming.map(entry => ({
    id: entry.id, kind: "podcast_episode", primary: { kind: "link", href: `/media/${entry.media_id}` },
    title: { text: summaries.resolve(entry.media_id)?.title ?? (summaries.pending(entry.media_id) ? "loading episode…" : "episode unavailable") },
    contributors: [], publicationDate: null, context: null, activity: null, exceptionalStatus: null,
    resourceRef: null, selected: false,
  }));
  const order: OrderPresentation = { scopeKey: header?.queue_id ?? "empty-queue", state: ready && header !== null ? {
    kind: "Ready", revision: header.revision, move: async input => {
      let before = input.beforeId;
      if (before === null) {
        const boundary = firstUpcoming + upcoming.length;
        const following = queue.entries[boundary - queue.offset];
        if (boundary < header.count && following === undefined) {
          announce("show more episodes before moving to this boundary");
          return "Rejected";
        }
        before = following?.id ?? null;
      }
      return await move(input.itemId, before) ? "Acknowledged" : "Rejected";
    },
  } : { kind: "Saving" } };
  const render = (entry: QueueEntry, position: number, isCurrent: boolean) => {
    const title = summaries.resolve(entry.media_id)?.title ?? (summaries.pending(entry.media_id) ? "loading episode…" : "episode unavailable");
    const name = `${title}, position ${position}`;
    const index = upcoming.findIndex(item => item.id === entry.id);
    const successor = queue.entries[queue.entries.findIndex(item => item.id === entry.id) + 2];
    const laterUnknown = position + 1 < (header?.count ?? 0) && successor === undefined;
    const action = (kind: string, label: string, icon: ReactElement, invoke: () => void, disabled = false) => <Button
      key={kind} iconOnly icon={icon} size="comfortable" aria-label={`${label}: ${name}`}
      data-queue-entry={entry.id} data-queue-action={kind}
      aria-disabled={!ready || disabled || undefined}
      onClick={() => { if (ready && !disabled) invoke(); }} />;
    return <ResourceRow media as="div" primary={{ kind: "link", href: `/media/${entry.media_id}` }} title={<>{title}<span className="sr-only">, position {position}</span></>}
      supporting={<p className={styles.eyebrow}>position {position} of {header?.count ?? 0}</p>}
      rootProps={{ "data-collection-row-id": entry.id, "aria-current": isCurrent ? "true" : undefined, "aria-label": name }}
      primaryControl={action("play", failed && isCurrent ? "retry" : "play", <Play />, () => select(entry.id))}
      actions={!isCurrent ? <div className={styles.queueActions}>
        {action("next", "play next", <ListStart />, () => { void move(entry.id, upcoming[0]?.id ?? null); }, index === 0)}
        {action("earlier", "move earlier", <ArrowUp />, () => {
          pendingFocus.current = { entryId: entry.id, action: "earlier" };
          void move(entry.id, upcoming[index - 1]!.id).then(accepted => { if (accepted) announce(`“${title}” moved earlier`); });
        }, index === 0)}
        {action("later", "move later", <ArrowDown />, () => {
          pendingFocus.current = { entryId: entry.id, action: "later" };
          void move(entry.id, successor?.id ?? null).then(accepted => { if (accepted) announce(`“${title}” moved later`); });
        }, position === (header?.count ?? 0) || laterUnknown)}
        {action("remove", "remove from queue", <Trash2 />, () => { void remove(entry, position); })}
      </div> : failed ? <Button data-queue-entry={entry.id} data-queue-action="remove" aria-label={`remove from queue: ${name}`} onClick={() => { void remove(entry, position); }} disabled={!ready}>remove from queue</Button> : null}
    />;
  };
  const remaining = Math.max(0, (header?.count ?? 0) - firstUpcoming);
  return <section ref={root} className={styles.queuePanel} aria-label="up next">
    <h2 ref={heading} tabIndex={-1} className={styles.panelTitle}>up next</h2>
    <QueueStatus />
    {commandFailed ? <FeedbackNotice announcement="None" content={{ tone: "Warning", title: "couldn’t change queue", message: "try the queue action again" }} /> : null}
    {header?.source ? <div>
      <ButtonLink href={sourceHref(header.source)}>{header.source.kind === "Lectern" ? "started from lectern" : `started from “${header.source.label}”`}</ButtonLink>
      <p className={styles.eyebrow}>{[header.source.sort === null ? header.source.kind === "Lectern" ? "custom order" : "default order" : SORT_LABELS[header.source.sort], header.source.query ? `filter: ${header.source.query}` : null,
        header.source.kind === "Library" ? [header.source.entry_type?.replaceAll("_", " "), header.source.projection?.replaceAll("_", " "), header.source.completion].filter(Boolean).join(" · ") : header.source.kind === "Podcast" ? header.source.state.replaceAll("_", " ") : null].filter(Boolean).join(" · ")}</p>
    </div> : <p className={styles.eyebrow}>custom queue</p>}
    <p className={styles.eyebrow}>{header?.count ?? 0} queued · {remaining} upcoming</p>
    {summaries.error !== null ? <FeedbackNotice announcement="None" content={{ tone: "Warning", title: "episodes couldn’t be loaded" }} actions={[{ label: "retry", onClick: summaries.retry }]} /> : null}
    {failure !== null && current !== null ? <FeedbackNotice announcement="None" content={{ tone: "Warning", title: failure.title === null ? "episode unavailable" : `couldn’t play “${failure.title}”` }} actions={[
      { label: "retry", onClick: () => select(current.id) },
      { label: "skip", onClick: () => { const next = upcoming[0]; if (next === undefined) commands.next(); else select(next.id); } },
    ]} /> : null}
    {current !== null ? <div><h3 className={styles.panelTitle}>current</h3>{render(current, (header?.current_index ?? 0) + 1, true)}</div> : <p>{header && header.count > 0 ? "queue finished" : "nothing queued"}</p>}
    {upcoming.length > 0 ? <div><h3 className={styles.panelTitle}>upcoming</h3>
      <SortableList items={rows} order={order} ariaLabel="upcoming episodes" scrollport={scrollport}
        onAnnouncement={announce} renderItem={row => {
          const index = upcoming.findIndex(entry => entry.id === row.id);
          return render(upcoming[index]!, firstUpcoming + index + 1, false);
        }} />
    </div> : null}
    {upcoming.length < remaining ? <Button disabled={paging} onClick={() => {
      setPaging(true); setPageError(false);
      const next = prefix + 100;
      const loaded = queue.offset + queue.entries.length - firstUpcoming;
      void (loaded < next ? commands.queuePage() : Promise.resolve()).then(() => setPrefix(next), () => setPageError(true)).finally(() => setPaging(false));
    }}>{paging ? "loading episodes…" : pageError ? "retry loading episodes" : "show more episodes"}</Button> : null}
    <div className={styles.queueActions}>
      <Button onClick={commands.previous} disabled={!ready || header === null || header.count === 0}>previous</Button>
      {current !== null && state.kind === "Absent" ? <Button onClick={commands.resume} disabled={!ready}>resume</Button> : null}
      <Button onClick={commands.stop} disabled={!ready || header === null}>stop playback</Button>
      <Button onClick={commands.clearQueue} disabled={!ready || header === null || header.count === 0}>clear queue</Button>
    </div>
  </section>;
}
