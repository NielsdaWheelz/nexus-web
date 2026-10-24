"use client";

import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Minus, Plus } from "lucide-react";
import Button from "@/components/ui/Button";
import ActionMenu from "@/components/ui/ActionMenu";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { apiFetch, apiTransportFeedback, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { readerDocument, transcriptUnitAtTime } from "@/lib/documentReader/model";
import { readerDestinationHref } from "@/app/(authenticated)/media/[id]/hostedReader";
import { openAsyncResult, type OpenResult } from "@/lib/panes/openResult";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import type { PreparationState } from "@/lib/ui/actionDescriptor";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { formatClock } from "@/lib/formatClock";
import {
  formatPlaybackRate,
  PLAYBACK_RATE_MAX,
  PLAYBACK_RATE_MIN,
  PLAYBACK_RATE_PRESETS,
  PLAYBACK_RATE_STEP,
  snapPlaybackRate,
  stepPlaybackRate,
} from "@/lib/player/playbackRate";
import {
  usePlayerCommands,
  usePlayerSession,
  usePlayerTimeline,
  type PlayerState,
} from "@/lib/player/playerRuntime";
import styles from "./Player.module.css";
import collection from "@/components/ui/Collection.module.css";

const same = (a: number, b: number) => Math.abs(a - b) < 0.0001;

export function PlaybackRateEditor({
  value,
  onChange,
  label,
}: {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly label: string;
}) {
  return (
    <div className={styles.editor}>
      <div className={styles.summary}>
        <span className={styles.eyebrow}>{label}</span>
        <strong className={styles.rateValue}>
          {formatPlaybackRate(value)}
        </strong>
      </div>
      <div
        className={styles.presets}
        role="group"
        aria-label={`${label} presets`}
      >
        {PLAYBACK_RATE_PRESETS.map((preset) => (
          <Button
            key={preset}
            size="comfortable"
            className={styles.preset}
            aria-pressed={same(value, preset)}
            onClick={() => onChange(preset)}
          >
            {formatPlaybackRate(preset)}
          </Button>
        ))}
      </div>
      <div className={styles.adjuster}>
        <Button
          size="comfortable"
          iconOnly
          icon={<Minus />}
          disabled={value <= PLAYBACK_RATE_MIN}
          aria-label={`Decrease ${label.toLocaleLowerCase()}`}
          onClick={() => onChange(stepPlaybackRate(value, -1))}
        />
        <input
          type="range"
          className={styles.rateRange}
          min={PLAYBACK_RATE_MIN}
          max={PLAYBACK_RATE_MAX}
          step={PLAYBACK_RATE_STEP}
          value={value}
          aria-label={label}
          aria-valuetext={
            same(value, 1)
              ? "Normal speed"
              : `${formatPlaybackRate(value).slice(0, -1)} times normal`
          }
          onChange={(event) =>
            onChange(snapPlaybackRate(Number(event.currentTarget.value)))
          }
        />
        <Button
          size="comfortable"
          iconOnly
          icon={<Plus />}
          disabled={value >= PLAYBACK_RATE_MAX}
          aria-label={`Increase ${label.toLocaleLowerCase()}`}
          onClick={() => onChange(stepPlaybackRate(value, 1))}
        />
      </div>
    </div>
  );
}

/** The caller owns capability, live effects and saved defaults. */
export function SkipSilenceField({
  checked,
  onChange,
  label,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
}) {
  const helpId = useId();
  return <label className={styles.silenceField}>
    <span className={styles.switch}>
      <input type="checkbox" aria-label={label} aria-describedby={helpId} checked={checked} onChange={event => onChange(event.currentTarget.checked)} />
      <span>{label}</span>
    </span>
    <span id={helpId} className={styles.eyebrow}>shorten quiet gaps between speech.</span>
  </label>;
}

/** Chapter navigation is shared by the desktop picker and now-playing sheet. */
export function ChapterList({ state, presentation, onOpened }: {
  readonly state: Extract<PlayerState, { kind: "Loaded" }>;
  readonly presentation: "popup" | "embedded";
  readonly onOpened: () => void;
}) {
  const { playbackSubject } = usePlayerSession();
  const subject = useRef(playbackSubject);
  subject.current = playbackSubject;
  useLayoutEffect(() => {
    subject.current = playbackSubject;
    return () => { subject.current = null; };
  }, [playbackSubject]);
  const { chapter: current } = usePlayerTimeline();
  if (state.source.kind !== "Episode") return null;
  const episode = state.source.descriptor;
  return <ol className={{ popup: collection.contentViewport, embedded: styles.chapters }[presentation]} data-collection-viewport={presentation === "popup" ? "" : undefined}>
    {episode.chapters.map(chapter => <ChapterRow key={`${episode.media_id}:${chapter.start_ms}:${chapter.title}`} mediaId={episode.media_id} title={episode.title}
      chapter={chapter} current={current?.start_ms === chapter.start_ms} subject={subject} expectedSubject={playbackSubject} onOpened={onOpened} />)}
  </ol>;
}

/** Only opening reads transcript availability; ordinary chapter activation remains a seek. */
function ChapterRow({ mediaId, title, chapter, current, subject, expectedSubject, onOpened }: {
  readonly mediaId: string;
  readonly title: string;
  readonly chapter: Schema<"ChapterOut">;
  readonly current: boolean;
  readonly subject: RefObject<string | null>;
  readonly expectedSubject: string | null;
  readonly onOpened: () => void;
}) {
  const commands = usePlayerCommands();
  const { ctx } = useActionRuntime();
  const [preparation, setPreparation] = useState<PreparationState>(null);
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
    ctx.feedback.offer({ key: `chapter:${mediaId}:${chapter.start_ms}`, announcement: "Polite",
      needsAttention: true, undo: null, onDismiss: null,
      content: apiTransportFeedback(error, "couldn’t open chapter transcript") ?? { tone: "Warning", title: "couldn’t open chapter transcript", requestId: error.requestId } });
  };
  const activate = (event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Consume" || expectedSubject === null || subject.current !== expectedSubject) return;
    if (activation.intent === "default") {
      commands.seekTo({ positionMs: chapter.start_ms, expectedSubject });
      return;
    }
    const originPaneId = ctx.workspace().state.active_primary_pane_id;
    void openAsyncResult({ ctx, originPaneId, intent: "new_pane", subject: chapter.title,
      mayOpen: () => subject.current === expectedSubject,
      onOpened,
      create: async () => {
        const result = await resolve(ctx.sessionSignal());
        if (!result && !ctx.sessionSignal().aborted) ctx.feedback.offer({ key: `chapter:${mediaId}:${chapter.start_ms}`, announcement: "Polite",
          needsAttention: false, undo: null, onDismiss: null,
          content: { tone: "Warning", title: "no transcript at this time", message: chapter.title } });
        return result;
      },
    }).catch(report);
  };
  return <li className={styles.chapterRow}>
    <button type="button" className={`${collection.row} ${styles.chapter}`} aria-current={current ? "true" : undefined}
      disabled={expectedSubject === null} onClick={activate} onKeyDown={activate}>
      <span>{chapter.title}</span>
      <span className={styles.time}>{formatClock(chapter.start_ms / 1000)}</span>
    </button>
    <ActionMenu label={`more actions for ${chapter.title}`} triggerDisabled={expectedSubject === null} source={{ kind: "Prepared",
      subjectKey: `chapter:${mediaId}:${expectedSubject}:${chapter.start_ms}`, title: chapter.title, state: preparation,
      prepare(signal) {
        setPreparation({ kind: "Loading", request: signal });
        void resolve(signal).then((result) => {
          if (signal.aborted) return;
          const href = result?.target.href ?? null;
          setPreparation({ kind: "Ready", request: signal, content: { sections: [{ id: "Open", label: null, options: [{
            kind: "link", id: "OpenInPane", label: "open in new pane",
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
