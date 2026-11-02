"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FeedbackFailure, useFeedbackOccurrence, type FeedbackContent } from "@/components/feedback/Feedback";
import ActionMenu from "@/components/ui/ActionMenu";
import collection from "@/components/ui/Collection.module.css";
import { readerDestinationHref } from "@/app/(authenticated)/media/[id]/hostedReader";
import { ACTION_CATALOG } from "@/lib/actions/catalog";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { apiFetch, apiTransportFeedback, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { readerDocument, transcriptUnitAtTime } from "@/lib/documentReader/model";
import { formatClock } from "@/lib/formatClock";
import { openAsyncResult, type OpenResult } from "@/lib/panes/openResult";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { useCurrentChapter, usePlayerSession, type PlayerState } from "@/lib/player/playerRuntime";
import type { PreparationState } from "@/lib/ui/actionDescriptor";
import { cx } from "@/lib/ui/cx";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import styles from "./PlayerChapters.module.css";

/**
 * The one chapters panel: a desktop popup or embedded in the sheet, in the same order with the
 * same marks. It renders with the chapter, never with the clock. A row acts only for the subject
 * it was rendered for; a plain activation seeks through `onSeek`.
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
    {current ? <p className={styles.eyebrow}>current chapter: {current.title}</p> : null}
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
  const [preparation, setPreparation] = useState<PreparationState>(null);
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  const [opening, setOpening] = useState(false);
  const occurrence = useFeedbackOccurrence(failure !== null || opening, expectedSubject);
  const resolve = async (signal: AbortSignal): Promise<OpenResult | null> => {
    try {
      const { data } = await apiFetch<ApiJson<"/media/{media_id}/reader", "get">>(`/api/media/${mediaId}/reader`, { signal });
      if (signal.aborted) return null;
      const doc = readerDocument(data);
      if (doc.kind !== "text" || doc.format !== "transcript" || !transcriptUnitAtTime(doc.units, chapter.start_ms)) return null;
      const href = readerDestinationHref(mediaId, { source_identity: doc.identity, target: { kind: "time", ms: chapter.start_ms } });
      return href ? { target: { href, labelHint: title }, title: "chapter transcript ready", openLabel: "open chapter" } : null;
    } catch (error) {
      if (isApiError(error) && ["E_MEDIA_NOT_READY", "E_MEDIA_NOT_FOUND", "E_INVALID_KIND"].includes(error.code)) return null;
      throw error;
    }
  };
  const report = (error: unknown) => {
    if (ctx.sessionSignal().aborted || handleUnauthenticatedApiError(error)) return;
    if (!isApiError(error) || isSameSystemApiDefect(error)) { ctx.reportDefect({ error }); return; }
    setFailure(apiTransportFeedback(error, "couldn’t open chapter transcript") ?? { tone: "Warning", title: "couldn’t open chapter transcript", requestId: error.requestId });
  };
  const activate = (event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Consume" || expectedSubject === null || subject.current !== expectedSubject) return;
    if (activation.intent === "default") {
      onSeek(chapter.start_ms);
      return;
    }
    const originPaneId = ctx.workspace().state.active_primary_pane_id;
    setOpening(true);
    void openAsyncResult({ ctx, originPaneId, intent: "new_pane", subject: chapter.title,
      mayOpen: () => subject.current === expectedSubject,
      onOpened,
      create: async () => {
        const result = await resolve(ctx.sessionSignal());
        if (!ctx.sessionSignal().aborted) setFailure(result ? null : {tone: "Warning", title: "no transcript at this time", message: chapter.title});
        return result;
      },
    }).catch(report).finally(() => setOpening(false));
  };
  return <li className={styles.chapterRow}>
    {failure ? <FeedbackFailure scope="Local" occurrence={occurrence} content={failure} announcement="Polite" /> : null}
    <button type="button" className={`${collection.row} ${styles.chapter}`} aria-current={current ? "true" : undefined}
      aria-busy={opening} disabled={expectedSubject === null} onClick={activate} onKeyDown={activate}>
      <span>{chapter.title}</span>
      <span className={styles.time}>{formatClock(chapter.start_ms / 1000)}</span>
    </button>
    <ActionMenu label={`more actions for ${chapter.title}`} triggerDisabled={expectedSubject === null} source={{ kind: "Prepared", initial: { sections: [] },
      subjectKey: `chapter:${mediaId}:${expectedSubject}:${chapter.start_ms}`, title: chapter.title, state: preparation,
      prepare(signal) {
        setPreparation({ kind: "Loading", request: signal });
        void resolve(signal).then((result) => {
          if (signal.aborted) return;
          const href = result?.target.href ?? null;
          setPreparation({ kind: "Ready", request: signal, content: { sections: [{ id: "Open", label: null, options: [{
            kind: "link", id: "OpenInPane", label: ACTION_CATALOG.OpenInNewPane.label, icon: <ACTION_CATALOG.OpenInNewPane.icon size={16} aria-hidden="true" />,
            ...(href === null ? { href: null, disabled: true as const } : { href }),
            disabledReason: href === null ? "no transcript at this time" : undefined,
            onActivate(event) {
              const activation = workspaceTargetActivationIntent(event);
              if (activation.kind === "Unowned") return "unhandled";
              if (subject.current !== expectedSubject) { event.preventDefault(); return "consumed"; }
              const workspace = ctx.workspace();
              const originPaneId = workspace.state.active_primary_pane_id;
              const handled = activateTargetLink({ event, target: result?.target ?? null,
                runtime: { activateTarget: (request) => workspace.activateWorkspaceTarget({ ...request, originPaneId, disposition: { kind: "Fork" } }) } });
              if (handled === "handled-default" || handled === "handled-new-pane") onOpened();
              return handled;
            },
          }] }] } });
        }).catch((error: unknown) => {
          if (signal.aborted || handleUnauthenticatedApiError(error)) return;
          if (!isApiError(error) || isSameSystemApiDefect(error)) { ctx.reportDefect({ error }); return; }
          setPreparation({ kind: "Failed", request: signal, feedback: apiTransportFeedback(error, "couldn’t load chapter transcript") ?? { tone: "Warning", title: "couldn’t load chapter transcript", requestId: error.requestId } });
        });
      },
    }} />
  </li>;
}
