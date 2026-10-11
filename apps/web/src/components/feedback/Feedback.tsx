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
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type ReactNode,
} from "react";
import Button from "@/components/ui/Button";
import { ClipboardWriteUnavailableError, copyText } from "@/lib/ui/copyText";
import styles from "./Feedback.module.css";

export type FeedbackTone =
  "Neutral" | "Info" | "Success" | "Warning" | "Danger";
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
  readonly [FeedbackAction] | readonly [FeedbackAction, FeedbackAction];

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
}

const ICONS = {
  Neutral: Circle,
  Info,
  Success: CircleCheckBig,
  Warning: TriangleAlert,
  Danger: OctagonAlert,
};
const MAX_HUDS = 3;

type Entry = { readonly id: number; readonly signal: DetachedFeedback };
// A hud's clock: time left, when it last started running, and how many of hover and focus hold it.
type Clock = {
  remaining: number;
  startedAt: number | null;
  holds: number;
  timer?: ReturnType<typeof setTimeout>;
};
// The empty queue: the server snapshot, and the client's until the first publish.
const NO_SIGNALS: readonly Entry[] = [];

/**
 * The signal queue. Rendering reads `snapshot()`; clocks are internal. A hud
 * runs while nothing holds it and the document is visible, and leaves when its
 * time is spent; a persistent signal leaves only by `resolve` or its dismiss.
 */
function createSignals() {
  let signals = NO_SIGNALS;
  let nextId = 1;
  const clocks = new Map<number, Clock>();
  const listeners = new Set<() => void>();
  const commit = (next: readonly Entry[]) => {
    signals = next;
    listeners.forEach((listener) => listener());
  };
  const stop = (id: number) => {
    const clock = clocks.get(id);
    if (!clock || clock.startedAt === null) return;
    clearTimeout(clock.timer);
    clock.remaining -= Date.now() - clock.startedAt;
    clock.startedAt = null;
  };
  const run = (id: number) => {
    const clock = clocks.get(id);
    if (
      !clock ||
      clock.startedAt !== null ||
      clock.holds > 0 ||
      document.hidden
    )
      return;
    clock.startedAt = Date.now();
    clock.timer = setTimeout(() => remove(id), Math.max(0, clock.remaining));
  };
  const remove = (id: number) => {
    stop(id);
    clocks.delete(id);
    commit(signals.filter((entry) => entry.id !== id));
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => signals,
    publish(signal: DetachedFeedback) {
      const old =
        signal.key === undefined
          ? undefined
          : signals.find((entry) => entry.signal.key === signal.key);
      // A keyed publish of the same kind replaces in place: same id, same position, hover/focus holds kept.
      const id = old && old.signal.kind === signal.kind ? old.id : nextId++;
      if (old && old.id !== id) remove(old.id);
      stop(id);
      if (signal.kind === "Hud") {
        const holds = clocks.get(id)?.holds ?? 0;
        clocks.set(id, {
          remaining: signal.actions ? 10_000 : 5_000,
          startedAt: null,
          holds,
        });
      }
      let next = signals.some((entry) => entry.id === id)
        ? signals.map((entry) => (entry.id === id ? { id, signal } : entry))
        : [...signals, { id, signal }];
      const huds = next.filter(
        (entry) => entry.id !== id && entry.signal.kind === "Hud",
      );
      if (signal.kind === "Hud" && huds.length >= MAX_HUDS) {
        // The oldest hud nobody is reading leaves first; if every one is held, the oldest.
        const evicted =
          huds.find((entry) => clocks.get(entry.id)?.holds === 0) ?? huds[0];
        stop(evicted.id);
        clocks.delete(evicted.id);
        next = next.filter((entry) => entry !== evicted);
      }
      commit(next);
      run(id);
    },
    resolve(key: string) {
      signals
        .filter((entry) => entry.signal.key === key)
        .forEach((entry) => remove(entry.id));
    },
    dismiss: remove,
    // A hud action closes its hud even if it throws; a persistent action never closes it.
    act(id: number, index: number) {
      const entry = signals.find((candidate) => candidate.id === id);
      if (!entry) return;
      const action = entry.signal.actions?.[index];
      if (entry.signal.kind === "Persistent") {
        action?.onClick();
        return;
      }
      try {
        action?.onClick();
      } finally {
        remove(id);
      }
    },
    hold(id: number, delta: 1 | -1) {
      const clock = clocks.get(id);
      if (!clock) return;
      clock.holds = Math.max(0, clock.holds + delta);
      if (clock.holds > 0) stop(id);
      else run(id);
    },
    visibilityChanged() {
      clocks.forEach((_, id) => (document.hidden ? stop(id) : run(id)));
    },
    dispose() {
      clocks.forEach((clock) => clearTimeout(clock.timer));
    },
  };
}

const FeedbackContext = createContext<FeedbackContextValue | null>(null);
const RailContext = createContext<HTMLElement | null>(null);

/** The app's viewport: the application, then the persistent rail in flow; huds float above both. */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [queue] = useState(createSignals);
  const [rail, setRail] = useState<HTMLElement | null>(null);
  const signals = useSyncExternalStore(
    queue.subscribe,
    queue.snapshot,
    () => NO_SIGNALS,
  );
  useEffect(() => {
    document.addEventListener("visibilitychange", queue.visibilityChanged);
    return () => {
      document.removeEventListener("visibilitychange", queue.visibilityChanged);
      queue.dispose();
    };
  }, [queue]);

  // Edge entry and exit only: moving between a hud's own controls neither holds nor releases it.
  const crossing = (event: FocusEvent<HTMLElement>) =>
    !event.currentTarget.contains(event.relatedTarget);
  return (
    <FeedbackContext value={queue}>
      <RailContext value={rail}>
        <div className={styles.viewport}>
          <div className={styles.application}>
            {children}
            <section
              className={styles.huds}
              aria-label="Notifications"
              aria-live="polite"
            >
              {signals.map(({ id, signal }) =>
                signal.kind === "Hud" ? (
                  <Signal
                    key={id}
                    content={signal.content}
                    actions={signal.actions}
                    className={styles.hud}
                    onAction={(index) => queue.act(id, index)}
                    onDismiss={() => queue.dismiss(id)}
                    onMouseEnter={() => queue.hold(id, 1)}
                    onMouseLeave={() => queue.hold(id, -1)}
                    onFocus={(event) => crossing(event) && queue.hold(id, 1)}
                    onBlur={(event) => crossing(event) && queue.hold(id, -1)}
                  />
                ) : null,
              )}
            </section>
          </div>
          <section
            ref={setRail}
            className={styles.rail}
            aria-label="Notices"
            aria-live="polite"
          >
            {signals.map(({ id, signal }) =>
              signal.kind === "Persistent" ? (
                <Signal
                  key={id}
                  content={signal.content}
                  actions={signal.actions}
                  className={styles.persistent}
                  role={
                    signal.announcement === "Assertive" ? "alert" : undefined
                  }
                  onAction={(index) => queue.act(id, index)}
                  onDismiss={() => queue.dismiss(id)}
                />
              ) : null,
            )}
          </section>
        </div>
      </RailContext>
    </FeedbackContext>
  );
}

export function useFeedback(): FeedbackContextValue {
  const context = useContext(FeedbackContext);
  if (context === null)
    throw new Error("useFeedback must be used within a FeedbackProvider");
  return context;
}

/** The persistent rail, which the mobile viewport registers as a bottom surface. */
export function usePersistentFeedbackElement(): HTMLElement | null {
  return useContext(RailContext);
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
    <Signal
      content={content}
      actions={actions}
      className={styles.notice}
      role={
        announcement === "Polite"
          ? "status"
          : announcement === "Assertive"
            ? "alert"
            : undefined
      }
      onAction={(index) => actions?.[index]?.onClick()}
    >
      {children}
    </Signal>
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

function Signal({
  content,
  actions,
  className,
  role,
  children,
  onAction,
  onDismiss,
  ...hold
}: {
  content: FeedbackContent;
  actions?: FeedbackActions;
  className: string;
  role?: "status" | "alert";
  children?: ReactNode;
  onAction(index: number): void;
  onDismiss?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
}) {
  const Icon = ICONS[content.tone];
  return (
    <article
      className={`${styles.signal} ${styles[content.tone]} ${className}`}
      role={role}
      {...hold}
    >
      <div className={styles.toneMark}>
        <Icon size={content.tone === "Neutral" ? 15 : 16} aria-hidden="true" />
        <span className={styles.toneLabel}>{content.tone}</span>
      </div>
      <div className={styles.body}>
        <p className={styles.title}>{content.title}</p>
        {content.message ? (
          <p className={styles.message}>{content.message}</p>
        ) : null}
        {children ? <div className={styles.message}>{children}</div> : null}
        {content.requestId ? (
          <Diagnostics requestId={content.requestId} />
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
          onClick={onDismiss}
          aria-label={`Dismiss ${content.title}`}
        >
          <X size={16} aria-hidden="true" />
        </Button>
      ) : null}
    </article>
  );
}

function Diagnostics({ requestId }: { requestId: string }) {
  const text = `Nexus request ID: ${requestId}`;
  const [failed, setFailed] = useState(false);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  if (defect) throw defect.error;
  const copy = () =>
    copyText(text).then(
      () => setFailed(false),
      (error: unknown) =>
        error instanceof ClipboardWriteUnavailableError
          ? setFailed(true)
          : setDefect({ error }),
    );
  return (
    <details className={styles.diagnostics}>
      <summary>Diagnostics</summary>
      <div className={styles.diagnosticsBody}>
        <code>{text}</code>
        <Button variant="ghost" size="sm" onClick={() => void copy()}>
          {failed ? "Retry" : "Copy diagnostics"}
        </Button>
      </div>
      {failed ? (
        <p className={styles.diagnosticsError} role="status">
          Diagnostics couldn’t be copied.
        </p>
      ) : null}
    </details>
  );
}
