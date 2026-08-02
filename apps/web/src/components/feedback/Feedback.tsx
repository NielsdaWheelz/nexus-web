"use client";

import {
  Circle,
  CircleCheckBig,
  Info,
  OctagonAlert,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";
import Button from "@/components/ui/Button";
import {
  ClipboardWriteUnavailableError,
  copyText,
} from "@/lib/ui/copyText";
import styles from "./Feedback.module.css";

export type FeedbackTone = "Neutral" | "Info" | "Success" | "Warning" | "Danger";

export type FeedbackAnnouncement = "None" | "Polite" | "Assertive";

export interface FeedbackContent {
  tone: FeedbackTone;
  title: string;
  message?: string;
  requestId?: string;
}

export interface FeedbackAction {
  label: string;
  onClick: () => void;
}

export type FeedbackActions =
  | readonly [FeedbackAction]
  | readonly [FeedbackAction, FeedbackAction];

export type DetachedFeedback =
  | {
      kind: "Hud";
      key?: string;
      content: FeedbackContent;
      actions?: FeedbackActions;
    }
  | {
      kind: "Persistent";
      key: string;
      content: FeedbackContent;
      announcement: "Polite" | "Assertive";
      actions?: FeedbackActions;
    };

export interface FeedbackContextValue {
  publish(signal: DetachedFeedback): void;
  resolve(key: string): void;
  suppress(key: string): () => void;
}

type SignalRecordBase = {
  id: number;
  key?: string;
  content: FeedbackContent;
  actions?: FeedbackActions;
  revision: number;
  announcedRevision: number;
};

type HudRecord = SignalRecordBase & {
  kind: "Hud";
  remainingMs: number;
};

type PersistentRecord = SignalRecordBase & {
  kind: "Persistent";
  key: string;
  announcement: "Polite" | "Assertive";
};

type SignalRecord = HudRecord | PersistentRecord;
type PauseReason = "Hover" | "Focus";
type TimerState = {
  handle: ReturnType<typeof setTimeout>;
  startedAt: number;
};
type DetachedAnnouncement = {
  sequence: number;
  policy: "Polite" | "Assertive";
  text: string;
};

const HUD_WITHOUT_ACTIONS_MS = 5_000;
const HUD_WITH_ACTIONS_MS = 10_000;
const MAX_HUDS = 3;

const FeedbackContext = createContext<FeedbackContextValue | null>(null);

function toneIcon(tone: FeedbackTone): ReactNode {
  switch (tone) {
    case "Neutral":
      return <Circle size={15} aria-hidden="true" />;
    case "Info":
      return <Info size={16} aria-hidden="true" />;
    case "Success":
      return <CircleCheckBig size={16} aria-hidden="true" />;
    case "Warning":
      return <TriangleAlert size={16} aria-hidden="true" />;
    case "Danger":
      return <OctagonAlert size={16} aria-hidden="true" />;
  }
}

function announcementRole(
  announcement: FeedbackAnnouncement,
): "status" | "alert" | undefined {
  switch (announcement) {
    case "None":
      return undefined;
    case "Polite":
      return "status";
    case "Assertive":
      return "alert";
  }
}

function signalAnnouncement(record: SignalRecord): "Polite" | "Assertive" {
  return record.kind === "Hud" ? "Polite" : record.announcement;
}

function announcementText(content: FeedbackContent): string {
  return content.message ? `${content.title}. ${content.message}` : content.title;
}

function hasSameContent(left: FeedbackContent, right: FeedbackContent): boolean {
  return (
    left.tone === right.tone &&
    left.title === right.title &&
    left.message === right.message &&
    left.requestId === right.requestId
  );
}

function hasSameActions(
  left: FeedbackActions | undefined,
  right: FeedbackActions | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.length === right.length &&
    left.every((action, index) => action.label === right[index]?.label)
  );
}

function hasSamePresentation(record: SignalRecord, signal: DetachedFeedback): boolean {
  if (record.kind !== signal.kind) return false;
  if (!hasSameContent(record.content, signal.content)) return false;
  if (!hasSameActions(record.actions, signal.actions)) return false;
  if (record.kind === "Hud") return signal.kind === "Hud";
  return signal.kind === "Persistent" && record.announcement === signal.announcement;
}

function feedbackDuration(actions: FeedbackActions | undefined): number {
  return actions === undefined ? HUD_WITHOUT_ACTIONS_MS : HUD_WITH_ACTIONS_MS;
}

function Diagnostics({
  requestId,
  parentOwnsAnnouncement,
}: {
  requestId: string;
  parentOwnsAnnouncement: boolean;
}) {
  const text = `Nexus request ID: ${requestId}`;
  const [copyUnavailable, setCopyUnavailable] = useState(false);
  const [asyncDefect, setAsyncDefect] = useState<{ error: unknown } | null>(null);
  const copy = async () => {
    try {
      await copyText(text);
      setCopyUnavailable(false);
    } catch (error) {
      if (error instanceof ClipboardWriteUnavailableError) {
        setCopyUnavailable(true);
        return;
      }
      setAsyncDefect({ error });
    }
  };

  if (asyncDefect !== null) throw asyncDefect.error;

  return (
    <details className={styles.diagnostics}>
      <summary>Diagnostics</summary>
      <div className={styles.diagnosticsBody}>
        <code>{text}</code>
        <Button variant="ghost" size="sm" onClick={() => void copy()}>
          {copyUnavailable ? "Retry" : "Copy diagnostics"}
        </Button>
      </div>
      {copyUnavailable ? (
        <p
          className={styles.diagnosticsError}
          role={parentOwnsAnnouncement ? undefined : "alert"}
        >
          Diagnostics couldn’t be copied.
        </p>
      ) : null}
    </details>
  );
}

function SignalArticle({
  content,
  actions,
  children,
  className,
  role,
  onAction,
  onDismiss,
  onMouseEnter,
  onMouseLeave,
  onFocusCapture,
  onBlurCapture,
}: {
  content: FeedbackContent;
  actions?: FeedbackActions;
  children?: ReactNode;
  className?: string;
  role?: "status" | "alert";
  onAction(actionIndex: number): void;
  onDismiss?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onFocusCapture?: () => void;
  onBlurCapture?: (event: FocusEvent<HTMLElement>) => void;
}) {
  return (
    <article
      className={[styles.signal, styles[content.tone], className]
        .filter(Boolean)
        .join(" ")}
      role={role}
      aria-atomic={role === undefined ? undefined : "true"}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
    >
      <div className={styles.toneMark}>
        <span className={styles.icon}>{toneIcon(content.tone)}</span>
        <span className={styles.toneLabel}>{content.tone}</span>
      </div>
      <div className={styles.body}>
        <p className={styles.title}>{content.title}</p>
        {content.message ? <p className={styles.message}>{content.message}</p> : null}
        {children ? <div className={styles.supporting}>{children}</div> : null}
        {content.requestId ? (
          <Diagnostics
            requestId={content.requestId}
            parentOwnsAnnouncement={role !== undefined}
          />
        ) : null}
        {actions ? (
          <div className={styles.actions}>
            {actions.map((action, index) => (
              <Button
                key={`${index}-${action.label}`}
                variant="secondary"
                size="sm"
                onClick={() => onAction(index)}
              >
                {action.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      {onDismiss ? (
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          className={styles.dismiss}
          onClick={onDismiss}
          aria-label={`Dismiss ${content.title}`}
        >
          <X size={16} aria-hidden="true" />
        </Button>
      ) : null}
    </article>
  );
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [records, setRecords] = useState<SignalRecord[]>([]);
  const recordsRef = useRef<SignalRecord[]>([]);
  const nextIdRef = useRef(1);
  const timersRef = useRef<Map<number, TimerState>>(new Map());
  const interactionPausesRef = useRef<Map<number, Set<PauseReason>>>(new Map());
  const suppressionCountsRef = useRef<Map<string, number>>(new Map());
  const [, setSuppressionEpoch] = useState(0);
  const announcementSequenceRef = useRef(0);
  const [detachedAnnouncement, setDetachedAnnouncement] =
    useState<DetachedAnnouncement | null>(null);

  const commit = useCallback((nextRecords: SignalRecord[]) => {
    recordsRef.current = nextRecords;
    setRecords(nextRecords);
  }, []);

  const clearTimer = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer === undefined) return;
    clearTimeout(timer.handle);
    timersRef.current.delete(id);
  }, []);

  const removeRecord = useCallback(
    (id: number) => {
      clearTimer(id);
      interactionPausesRef.current.delete(id);
      const nextRecords = recordsRef.current.filter((record) => record.id !== id);
      if (nextRecords.length !== recordsRef.current.length) commit(nextRecords);
    },
    [clearTimer, commit],
  );

  const isSuppressed = useCallback((key: string | undefined): boolean => {
    return Boolean(key && (suppressionCountsRef.current.get(key) ?? 0) > 0);
  }, []);

  const scheduleHud = useCallback(
    (id: number) => {
      clearTimer(id);
      const record = recordsRef.current.find(
        (candidate): candidate is HudRecord =>
          candidate.id === id && candidate.kind === "Hud",
      );
      if (record === undefined || record.remainingMs <= 0) return;
      if (document.visibilityState === "hidden") return;
      if (isSuppressed(record.key)) return;
      if ((interactionPausesRef.current.get(id)?.size ?? 0) > 0) return;

      timersRef.current.set(id, {
        startedAt: Date.now(),
        handle: setTimeout(() => removeRecord(id), record.remainingMs),
      });
    },
    [clearTimer, isSuppressed, removeRecord],
  );

  const pauseHud = useCallback(
    (id: number) => {
      const timer = timersRef.current.get(id);
      if (timer === undefined) return;
      const elapsedMs = Math.max(0, Date.now() - timer.startedAt);
      clearTimer(id);
      const nextRecords = recordsRef.current.flatMap((record) => {
        if (record.id !== id || record.kind !== "Hud") return [record];
        const remainingMs = Math.max(0, record.remainingMs - elapsedMs);
        return remainingMs === 0 ? [] : [{ ...record, remainingMs }];
      });
      commit(nextRecords);
    },
    [clearTimer, commit],
  );

  const announce = useCallback((record: SignalRecord) => {
    announcementSequenceRef.current += 1;
    setDetachedAnnouncement({
      sequence: announcementSequenceRef.current,
      policy: signalAnnouncement(record),
      text: announcementText(record.content),
    });
  }, []);

  const publish = useCallback(
    (signal: DetachedFeedback) => {
      const existing =
        signal.key === undefined
          ? undefined
          : recordsRef.current.find((record) => record.key === signal.key);

      if (existing && hasSamePresentation(existing, signal)) {
        // Keep behavior closures fresh without mutating the rendered presentation.
        recordsRef.current = recordsRef.current.map((record) =>
          record.id === existing.id ? { ...record, actions: signal.actions } : record,
        );
        return;
      }

      const id = existing?.id ?? nextIdRef.current++;
      const revision = (existing?.revision ?? 0) + 1;
      const suppressed = isSuppressed(signal.key);
      const announcedRevision = suppressed ? (existing?.announcedRevision ?? 0) : revision;
      let nextRecord: SignalRecord;

      if (signal.kind === "Hud") {
        nextRecord = {
          id,
          kind: "Hud",
          key: signal.key,
          content: signal.content,
          actions: signal.actions,
          revision,
          announcedRevision,
          remainingMs: feedbackDuration(signal.actions),
        };
      } else {
        nextRecord = {
          id,
          kind: "Persistent",
          key: signal.key,
          content: signal.content,
          actions: signal.actions,
          announcement: signal.announcement,
          revision,
          announcedRevision,
        };
      }

      if (existing) {
        clearTimer(existing.id);
        if (existing.kind !== signal.kind) interactionPausesRef.current.delete(existing.id);
      }

      let nextRecords = existing
        ? recordsRef.current.map((record) => (record.id === id ? nextRecord : record))
        : [...recordsRef.current, nextRecord];
      const visibleHudRecords = nextRecords.filter(
        (record): record is HudRecord =>
          record.kind === "Hud" && !isSuppressed(record.key),
      );
      if (visibleHudRecords.length > MAX_HUDS) {
        const evictedId = visibleHudRecords[0].id;
        clearTimer(evictedId);
        interactionPausesRef.current.delete(evictedId);
        nextRecords = nextRecords.filter((record) => record.id !== evictedId);
      }

      commit(nextRecords);
      if (!suppressed) announce(nextRecord);
      if (nextRecord.kind === "Hud" && nextRecords.some((record) => record.id === id)) {
        scheduleHud(id);
      }
    },
    [announce, clearTimer, commit, isSuppressed, scheduleHud],
  );

  const resolve = useCallback(
    (key: string) => {
      const record = recordsRef.current.find((candidate) => candidate.key === key);
      if (record) removeRecord(record.id);
    },
    [removeRecord],
  );

  const suppress = useCallback(
    (key: string) => {
      const previousCount = suppressionCountsRef.current.get(key) ?? 0;
      suppressionCountsRef.current.set(key, previousCount + 1);
      if (previousCount === 0) {
        const record = recordsRef.current.find((candidate) => candidate.key === key);
        if (record?.kind === "Hud") {
          pauseHud(record.id);
          interactionPausesRef.current.delete(record.id);
        }
        // pauseHud has no state update when the HUD was already paused.
        setSuppressionEpoch((epoch) => epoch + 1);
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = suppressionCountsRef.current.get(key) ?? 0;
        if (count > 1) {
          suppressionCountsRef.current.set(key, count - 1);
          return;
        }

        suppressionCountsRef.current.delete(key);
        const record = recordsRef.current.find((candidate) => candidate.key === key);
        if (record === undefined) {
          setSuppressionEpoch((epoch) => epoch + 1);
          return;
        }

        let nextRecords = recordsRef.current;
        if (record.kind === "Hud") {
          const visibleHudRecords = nextRecords.filter(
            (candidate): candidate is HudRecord =>
              candidate.kind === "Hud" && !isSuppressed(candidate.key),
          );
          if (visibleHudRecords.length > MAX_HUDS) {
            const evictedRecord = visibleHudRecords.find(
              (candidate) => candidate.id !== record.id,
            );
            if (evictedRecord !== undefined) {
              clearTimer(evictedRecord.id);
              interactionPausesRef.current.delete(evictedRecord.id);
              nextRecords = nextRecords.filter(
                (candidate) => candidate.id !== evictedRecord.id,
              );
            }
          }
        }

        if (record.announcedRevision < record.revision) {
          const restoredRecord = {
            ...record,
            announcedRevision: record.revision,
          } as SignalRecord;
          commit(
            nextRecords.map((candidate) =>
              candidate.id === restoredRecord.id ? restoredRecord : candidate,
            ),
          );
          announce(restoredRecord);
        } else if (nextRecords !== recordsRef.current) {
          commit(nextRecords);
        } else {
          setSuppressionEpoch((epoch) => epoch + 1);
        }

        if (record.kind === "Hud") scheduleHud(record.id);
      };
    },
    [announce, clearTimer, commit, isSuppressed, pauseHud, scheduleHud],
  );

  const setPauseReason = useCallback(
    (id: number, reason: PauseReason, paused: boolean) => {
      const reasons = interactionPausesRef.current.get(id) ?? new Set<PauseReason>();
      if (paused) {
        if (reasons.has(reason)) return;
        reasons.add(reason);
        interactionPausesRef.current.set(id, reasons);
        pauseHud(id);
        return;
      }

      reasons.delete(reason);
      if (reasons.size === 0) {
        interactionPausesRef.current.delete(id);
        scheduleHud(id);
      } else {
        interactionPausesRef.current.set(id, reasons);
      }
    },
    [pauseHud, scheduleHud],
  );

  const runAction = useCallback(
    (id: number, actionIndex: number) => {
      const record = recordsRef.current.find((candidate) => candidate.id === id);
      const action = record?.actions?.[actionIndex];
      if (record === undefined || action === undefined) return;
      if (record.kind === "Persistent") {
        action.onClick();
        return;
      }
      try {
        action.onClick();
      } finally {
        removeRecord(id);
      }
    },
    [removeRecord],
  );

  useEffect(() => {
    const timers = timersRef.current;
    const handleVisibilityChange = () => {
      for (const record of recordsRef.current) {
        if (record.kind !== "Hud") continue;
        if (document.visibilityState === "hidden") pauseHud(record.id);
        else scheduleHud(record.id);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      for (const timer of timers.values()) clearTimeout(timer.handle);
      timers.clear();
    };
  }, [pauseHud, scheduleHud]);

  const value = useMemo(
    () => ({ publish, resolve, suppress }),
    [publish, resolve, suppress],
  );
  const visibleRecords = records.filter((record) => !isSuppressed(record.key));

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <div
        className={styles.announcer}
        aria-label="Detached feedback announcements"
        aria-live={
          detachedAnnouncement?.policy === "Assertive" ? "assertive" : "polite"
        }
        aria-atomic="true"
      >
        {detachedAnnouncement ? (
          <span key={detachedAnnouncement.sequence}>{detachedAnnouncement.text}</span>
        ) : null}
      </div>
      <div className={styles.persistentRail} aria-label="Persistent feedback">
        {visibleRecords
          .filter((record): record is PersistentRecord => record.kind === "Persistent")
          .map((record) => (
            <SignalArticle
              key={record.id}
              content={record.content}
              actions={record.actions}
              className={styles.persistent}
              onAction={(actionIndex) => runAction(record.id, actionIndex)}
            />
          ))}
      </div>
      <div className={styles.hudViewport} aria-label="HUD feedback">
        {visibleRecords
          .filter((record): record is HudRecord => record.kind === "Hud")
          .map((record) => (
            <SignalArticle
              key={record.id}
              content={record.content}
              actions={record.actions}
              className={styles.hud}
              onAction={(actionIndex) => runAction(record.id, actionIndex)}
              onDismiss={() => removeRecord(record.id)}
              onMouseEnter={() => setPauseReason(record.id, "Hover", true)}
              onMouseLeave={() => setPauseReason(record.id, "Hover", false)}
              onFocusCapture={() => setPauseReason(record.id, "Focus", true)}
              onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  setPauseReason(record.id, "Focus", false);
                }
              }}
            />
          ))}
      </div>
    </FeedbackContext.Provider>
  );
}

export function useFeedback(): FeedbackContextValue {
  const context = useContext(FeedbackContext);
  if (context === null) {
    throw new Error("useFeedback must be used within a FeedbackProvider");
  }
  return context;
}

export function FeedbackNotice({
  content,
  announcement,
  actions,
  children,
}: {
  content: FeedbackContent;
  announcement: FeedbackAnnouncement;
  actions?: FeedbackActions;
  children?: ReactNode;
}) {
  return (
    <SignalArticle
      content={content}
      actions={actions}
      className={styles.notice}
      role={announcementRole(announcement)}
      onAction={(actionIndex) => actions?.[actionIndex]?.onClick()}
    >
      {children}
    </SignalArticle>
  );
}

export function FieldFeedback({
  id,
  content,
}: {
  id: string;
  content: FeedbackContent | null;
}) {
  if (content === null) return null;
  return (
    <div id={id} className={`${styles.field} ${styles[content.tone]}`}>
      {content.title}
    </div>
  );
}
