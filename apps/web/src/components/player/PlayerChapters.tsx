"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useOutcome } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import collection from "@/components/ui/Collection.module.css";
import { readerDestinationHref } from "@/app/(authenticated)/media/[id]/hostedReader";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { apiFetch, isApiError } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { readerDocument, transcriptUnitAtTime } from "@/lib/documentReader/model";
import { formatClock } from "@/lib/formatClock";
import { openAsyncResult, type OpenResult } from "@/lib/panes/openResult";
import { useCurrentChapter, usePlayerSession, type PlayerState } from "@/lib/player/playerRuntime";
import { cx } from "@/lib/ui/cx";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import styles from "./PlayerChapters.module.css";

/**
 * The one chapters panel: a desktop popup or embedded in the sheet, in the same order with the
 * same marks. It renders with the chapter, never with the clock. A row acts only for the subject
 * it was rendered for; chapter activation always seeks through `onSeek`.
 */
export default function PlayerChapters({ loaded, presentation, onSeek, onOpened }: {
  readonly loaded: Extract<PlayerState, { kind: "Loaded" }>;
  readonly presentation: "Popup" | "Embedded";
  readonly onSeek: (startMs: number) => void;
  readonly onOpened: () => void;
}) {
  const { playbackSubject } = usePlayerSession();
  const subject = useRef(playbackSubject);
  subject.current = playbackSubject;
  useLayoutEffect(() => {
    subject.current = playbackSubject;
    return () => { subject.current = null; };
  }, [playbackSubject]);
  const current = useCurrentChapter();
  const episode = loaded.source.descriptor;
  const popup = presentation === "Popup";
  return <section className={cx(styles.panel, popup ? styles.popup : styles.embedded)} aria-label="chapters">
    <h2 className={styles.panelTitle}>chapters</h2>
    <ol className={popup ? collection.contentViewport : styles.chapters} data-collection-viewport={popup ? "" : undefined}>
      {episode.chapters.map(chapter => <ChapterRow key={`${episode.media_id}:${chapter.start_ms}:${chapter.title}`} mediaId={episode.media_id} title={episode.title}
        chapter={chapter} current={current?.start_ms === chapter.start_ms} subject={subject} expectedSubject={playbackSubject} onSeek={onSeek} onOpened={onOpened} />)}
    </ol>
  </section>;
}

/** Only opening reads transcript availability; ordinary chapter activation remains a seek. */
function ChapterRow({ mediaId, title, chapter, current, subject, expectedSubject, onSeek, onOpened }: {
  readonly mediaId: string;
  readonly title: string;
  readonly chapter: Schema<"ChapterOut">;
  readonly current: boolean;
  readonly subject: RefObject<string | null>;
  readonly expectedSubject: string | null;
  readonly onSeek: (startMs: number) => void;
  readonly onOpened: () => void;
}) {
  const { ctx } = useActionRuntime();
  const { say, fail } = useOutcome();
  const [opening, setOpening] = useState(false);
  const resolve = async (signal: AbortSignal): Promise<OpenResult | null> => {
    try {
      const { data } = await apiFetch<ApiJson<"/media/{media_id}/reader", "get">>(`/api/media/${mediaId}/reader`, { signal });
      if (signal.aborted) return null;
      const doc = readerDocument(data);
      if (doc.kind !== "text" || doc.format !== "transcript" || !transcriptUnitAtTime(doc.units, chapter.start_ms)) return null;
      const href = readerDestinationHref(mediaId, { source_identity: doc.identity, target: { kind: "time", ms: chapter.start_ms } });
      return href ? { target: { href, labelHint: title }, title: "chapter transcript ready", openLabel: "read from here" } : null;
    } catch (error) {
      if (isApiError(error) && ["E_MEDIA_NOT_READY", "E_MEDIA_NOT_FOUND", "E_INVALID_KIND"].includes(error.code)) return null;
      throw error;
    }
  };
  const report = (error: unknown) => {
    if (ctx.sessionSignal().aborted || handleUnauthenticatedApiError(error)) return;
    fail(error, `couldn’t open the transcript for “${chapter.title}”.`);
  };
  const seek = (event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Consume" || expectedSubject === null || subject.current !== expectedSubject) return;
    onSeek(chapter.start_ms);
  };
  const read = (event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Consume" || opening || expectedSubject === null || subject.current !== expectedSubject) return;
    const originPaneId = ctx.workspace().state.active_primary_pane_id;
    setOpening(true);
    void openAsyncResult({ ctx, originPaneId, intent: activation.intent, subject: chapter.title,
      mayOpen: () => subject.current === expectedSubject,
      onOpened,
      create: async () => {
        const result = await resolve(ctx.sessionSignal());
        if (!ctx.sessionSignal().aborted && result === null) say({ fact: `no transcript for “${chapter.title}”.` });
        return result;
      },
    }).catch(report).finally(() => setOpening(false));
  };
  const time = formatClock(chapter.start_ms / 1000);
  return <li className={styles.chapterRow}>
    <button type="button" className={`${collection.row} ${styles.chapter}`} aria-current={current ? "true" : undefined}
      aria-label={`seek to ${chapter.title}, ${time}`} disabled={expectedSubject === null} onClick={seek} onKeyDown={seek}>
      <span>{chapter.title}</span>
      <span className={styles.time}>{time}</span>
    </button>
    <Button className={styles.read} aria-label={`read from here: ${chapter.title}, ${time}`}
      aria-busy={opening} aria-disabled={opening || expectedSubject === null} onClick={read} onKeyDown={read}>read from here</Button>
  </li>;
}
