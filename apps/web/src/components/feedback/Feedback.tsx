"use client";

import { Check, ChevronDown, Info, OctagonAlert, TriangleAlert, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import type { TargetLinkActivationResult } from "@/lib/panes/targetLinkActivation";
import { ClipboardWriteUnavailableError, copyText } from "@/lib/ui/copyText";
import { hasActiveModal, OverlayContext } from "@/lib/ui/overlay";
import { workspaceTargetActivationIntent, type OpenIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { createWorkspaceSignals } from "./workspaceSignals";
import { ActivitySurface } from "./Activity";
import WorkspaceFeedback from "./WorkspaceFeedback";
import styles from "./Feedback.module.css";

export type FeedbackTone = "Neutral" | "Info" | "Success" | "Warning" | "Danger";
export type FeedbackAnnouncement = "None" | "Polite" | "Assertive";
export interface FeedbackContent {
  tone: FeedbackTone;
  title: string;
  message?: string;
  requestId?: string;
  /** Only a page reload can continue: the signal offers that alone, never its owner's actions. */
  reload?: true;
}
/** commandKey preserves an exact frozen command across offer/condition handoffs. */
export type FeedbackAction =
  | { label: string; onClick: (intent: OpenIntent) => void; busy?: boolean; disabledReason?: string; commandKey?: string; href?: never; onActivate?: never }
  | { label: string; href: string; onActivate?: (event: TargetActivationEvent) => TargetLinkActivationResult; onClick?: never; busy?: boolean; disabledReason?: string; commandKey?: never };
export type FeedbackActions = readonly [FeedbackAction] | readonly [FeedbackAction, FeedbackAction];
export interface FeedbackProps {
  content: FeedbackContent;
  announcement: FeedbackAnnouncement;
  actions?: FeedbackActions;
  disclosure?: "Anchored";
  returnFocus?: () => HTMLElement | null;
}
export type FeedbackNoticeProps = FeedbackProps & {
  occurrence?: object;
  onDismiss?: () => void;
};
export type WorkspaceNotice = FeedbackProps & { needsAttention: boolean };
export interface WorkspaceCondition extends WorkspaceNotice {
  priority: "Write" | "Action" | "Status";
}
export type OfferInput = WorkspaceNotice & {
  key: string;
  undo: "Invite" | "Retain" | null;
  onDismiss: (() => void) | null;
};
export interface FeedbackOffer {
  update(notice: WorkspaceNotice): void;
  withdraw(): void;
}
export interface FeedbackContextValue {
  receipt(content: Pick<FeedbackContent, "tone" | "title">): void;
  /** settlement removes its current condition; the short fact is presentation only. */
  settleCondition(input: { key: string; content: Pick<FeedbackContent, "tone" | "title"> }): void;
  offer(input: OfferInput): FeedbackOffer;
}
export const FeedbackContext = createContext<ReturnType<typeof createWorkspaceSignals> | null>(null);
const Scope = createContext<{ active: boolean; mayRestoreFocus: () => boolean; returnFocus: () => HTMLElement | null } | null>(null);

/** The existing pane projects its focus target and announcement permission. */
export function FeedbackScope({ active, returnFocus, children }: {
  active: boolean;
  returnFocus: () => HTMLElement | null;
  children: ReactNode;
}) {
  const currentActive = useRef(active);
  currentActive.current = active;
  const mayRestoreFocus = useCallback(() => currentActive.current, []);
  const value = useMemo(() => ({ active, mayRestoreFocus, returnFocus }), [active, mayRestoreFocus, returnFocus]);
  return <Scope value={value}>{children}</Scope>;
}

const ICONS = { Neutral: null, Info, Success: Check, Warning: TriangleAlert, Danger: OctagonAlert };
const RELOAD: FeedbackActions = [{ label: "reload app", onClick: () => window.location.reload() }];

/** One account's presentation. The geometry provider is above this owner. */
export function FeedbackProvider({ children, returnFocus }: {
  children: ReactNode;
  returnFocus?: () => HTMLElement | null;
}) {
  const [signals] = useState(createWorkspaceSignals);
  useLayoutEffect(() => {
    signals.resume();
    return signals.dispose;
  }, [signals]);
  useEffect(() => {
    document.addEventListener("visibilitychange", signals.visibilityChanged);
    return () => document.removeEventListener("visibilitychange", signals.visibilityChanged);
  }, [signals]);
  return <FeedbackContext value={signals}>
    <div className={styles.viewport} data-workspace-feedback-root>{children}</div>
    <WorkspaceFeedback signals={signals} fallbackFocus={returnFocus} />
    <ActivitySurface signals={signals} fallbackFocus={returnFocus} />
  </FeedbackContext>;
}

export function useFeedback(): FeedbackContextValue {
  const signals = useContext(FeedbackContext);
  if (!signals) throw new Error("useFeedback must be used within a FeedbackProvider");
  return signals;
}

/** Updating content does not tear down its registration or focused action. */
export function useWorkspaceCondition(key: string, notice: WorkspaceCondition | null): void {
  const signals = useContext(FeedbackContext);
  if (!signals) throw new Error("useWorkspaceCondition must be used within a FeedbackProvider");
  const [token] = useState(() => ({}));
  const attached = useRef<{ owner: typeof signals; key: string } | null>(null);
  useLayoutEffect(() => { signals.condition(key, token, notice); }, [signals, key, token, notice]);
  useLayoutEffect(() => {
    const attachment = { owner: signals, key };
    attached.current = attachment;
    return () => {
      if (attached.current === attachment) attached.current = null;
      // StrictMode reattaches this owner/key before the microtask. A real
      // departure still withdraws, fenced against a newer publication.
      queueMicrotask(() => {
        if (attached.current?.owner !== signals || attached.current.key !== key)
          signals.withdrawCondition(key, token);
      });
    };
  }, [signals, key, token]);
}

export function FeedbackStatus(props: FeedbackProps) {
  return <Signal {...props} className={styles.status} />;
}
export function FeedbackNotice({ occurrence, ...props }: FeedbackNoticeProps) {
  return <Signal {...props} announcementOccurrence={occurrence} className={styles.notice} />;
}
export function FeedbackState(props: FeedbackProps) {
  return <Signal {...props} className={styles.state} surfaceState />;
}
export function FieldFeedback({ id, content }: { id: string; content: FeedbackContent | null }) {
  return content ? <div id={id} className={`${styles.field} ${styles[content.tone]}`}>
    {content.title}
    {content.message ? ` ${content.message}` : null}
  </div> : null;
}

export function Signal({
  content, announcement, actions, disclosure, returnFocus, className,
  onDismiss, dismissLabel, dismissBlocked, activityId, plain = false, focusable = false, surfaceState = false, occurrence, announcementOccurrence, onNavigate: navigation,
}: FeedbackProps & {
  className: string;
  onDismiss?: () => void;
  dismissLabel?: string;
  dismissBlocked?: boolean;
  activityId?: number;
  plain?: boolean;
  focusable?: boolean;
  surfaceState?: boolean;
  occurrence?: object;
  announcementOccurrence?: object;
  onNavigate?: () => void;
}) {
  const scope = useContext(Scope);
  const overlay = useContext(OverlayContext);
  const [expanded, setExpanded] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [summaryElement, setSummaryElement] = useState<HTMLDivElement | null>(null);
  const root = useRef<HTMLElement | null>(null);
  const details = useRef<HTMLDivElement | null>(null);
  const fallback = overlay ? () => overlay.element : scope?.returnFocus;
  const mayRestoreFocus = scope?.mayRestoreFocus;
  const returnTo = useRef(returnFocus ?? fallback);
  const navigated = useRef(false);
  returnTo.current = returnFocus ?? fallback;
  const id = useId();
  const titleId = useId();
  const primaryReasonId = useId();
  const secondaryReasonId = useId();
  const shown = content.reload ? RELOAD : actions;
  const primary = shown?.[0];
  const secondary = shown?.[1];
  const hasDetails = Boolean(content.message || content.requestId || secondary);
  const open = expanded && hasDetails;
  const changeExpanded = (next: boolean) => {
    if (next) navigated.current = false;
    setExpanded(next);
  };
  const onNavigate = () => { navigated.current = true; changeExpanded(false); navigation?.(); };
  useLayoutEffect(() => () => {
    if (navigated.current) return;
    const focused = document.activeElement;
    if (!root.current?.contains(focused) && !details.current?.contains(focused)) return;
    queueMicrotask(() => {
      // A command may have handed activation away before its notice unmounted.
      if (mayRestoreFocus && !mayRestoreFocus()) return;
      const current = document.activeElement;
      if (current !== focused && current !== document.body && current?.isConnected) return;
      const target = returnTo.current?.();
      if (hasActiveModal() && (!target || !overlay?.element?.contains(target))) return;
      if (target?.isConnected && !target.closest("[hidden], [inert]")) target.focus({ preventScroll: true });
    });
  }, [overlay, mayRestoreFocus]);
  const Icon = plain ? null : ICONS[content.tone];
  const Title = surfaceState ? "h2" : "p";
  const body = <div ref={details} className={styles.details}>
    {content.message ? <p className={styles.message}>{content.message}</p> : null}
    {secondary ? <div className={styles.secondary}>
      <Action action={secondary} reasonId={secondaryReasonId} contextId={titleId} occurrence={occurrence} onNavigate={onNavigate} />
    </div> : null}
    {content.requestId ? <Diagnostics requestId={content.requestId} /> : null}
  </div>;
  return <article
    ref={root}
    className={`${styles.signal} ${styles[content.tone]} ${className}`}
    tabIndex={focusable ? -1 : undefined}
    data-activity-entry={activityId}
    aria-labelledby={titleId}
  >
    <div ref={setSummaryElement} className={styles.summary}>
      {Icon ? <Icon className={styles.icon} size={16} aria-hidden="true" /> : null}
      <Title id={titleId} className={styles.title}>{content.title}</Title>
      <div className={styles.controls}>
        {primary ? <Action action={primary} reload={content.reload} reasonId={primaryReasonId} contextId={titleId} occurrence={occurrence} onNavigate={onNavigate} /> : null}
        {hasDetails ? <Button
          ref={setAnchor}
          className={styles.control}
          aria-expanded={open}
          aria-controls={id}
          aria-label={`details: ${content.title}`}
          onClick={() => changeExpanded(!open)}
        >
          details
          <ChevronDown size={14} aria-hidden="true" className={open ? `${styles.chevron} ${styles.expanded}` : styles.chevron} />
        </Button> : null}
        {onDismiss ? <Button
          className={styles.control}
          iconOnly
          icon={<X />}
          aria-label={dismissLabel ?? `dismiss: ${content.title}`}
          aria-disabled={(dismissBlocked ?? actions?.some((action) => action.busy)) || undefined}
          onClick={() => onDismiss()}
        /> : null}
      </div>
    </div>
    {disclosure === "Anchored" ? <FloatingActionSurface
      open={open}
      id={id}
      disclosure
      anchor={summaryElement}
      disclosureTrigger={anchor}
      align="end"
      placement="below"
      flip
      role="group"
      label={`details: ${content.title}`}
      className={styles.floatingDetails}
      onDismiss={() => changeExpanded(false)}
      skipReturnFocus={() => navigated.current}
    >{body}</FloatingActionSurface> : <div id={id} hidden={!open}>{body}</div>}
    <Announcement text={content.title} level={scope?.active === false ? "None" : announcement} occurrence={announcementOccurrence} />
  </article>;
}

function Action({ action, reload, reasonId, contextId, occurrence, onNavigate }: {
  action: FeedbackAction;
  reload?: true;
  reasonId: string;
  contextId: string;
  occurrence?: object;
  onNavigate: () => void;
}) {
  const [held, setHeld] = useState<{ action: FeedbackAction; occurrence?: object } | null>(null);
  const interaction = useRef({ pointer: false, focus: false });
  const replaced = !reload && held !== null && (
    held.action.commandKey !== undefined || action.commandKey !== undefined
      ? held.action.commandKey !== action.commandKey
      : held.action.label !== action.label || held.action.href !== action.href ||
        (held.occurrence !== undefined && occurrence !== undefined && held.occurrence !== occurrence)
  );
  const shown = replaced ? held.action : action;
  const reason = replaced ? "this action is no longer available" : shown.disabledReason;
  const blocked = Boolean(reason || shown.busy);
  const hold = (kind: "pointer" | "focus", value: boolean) => {
    interaction.current[kind] = value;
    if (value) setHeld((current) => current ?? { action, occurrence });
    else if (!interaction.current.pointer && !interaction.current.focus) setHeld(null);
  };
  const events = {
    onMouseEnter: () => hold("pointer", true),
    onMouseLeave: () => hold("pointer", false),
    onFocus: () => hold("focus", true),
    onBlur: () => hold("focus", false),
  };
  // A blocked control stops activation before this runs; a blocked link has no href.
  const activate = (event: TargetActivationEvent) => {
    if (shown.href !== undefined) {
      const result = shown.onActivate?.(event);
      if (result === "handled-default" || result === "handled-new-pane") onNavigate();
      return;
    }
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Open") shown.onClick(activation.intent);
  };
  return <div className={styles.action}>
    {shown.href !== undefined ? <ButtonLink
      {...events}
      href={shown.href}
      className={styles.control}
      data-workspace-rich-target={shown.onActivate ? "true" : undefined}
      aria-disabled={blocked || undefined}
      aria-busy={shown.busy || undefined}
      aria-describedby={reason ? `${contextId} ${reasonId}` : contextId}
      onClick={activate}
      onKeyDown={activate}
    >{shown.label}</ButtonLink> : <Button
      {...events}
      className={styles.control}
      aria-busy={shown.busy || undefined}
      aria-disabled={blocked || undefined}
      aria-describedby={reason ? `${contextId} ${reasonId}` : contextId}
      onClick={activate}
      onKeyDown={activate}
    >{shown.label}</Button>}
    {reason ? <p id={reasonId} className={styles.reason}>{reason}</p> : null}
  </div>;
}

/** Only the short fact is live; controls and disclosure never enter the live region. */
export function Announcement({ text, level, deferred = false, occurrence }: {
  text: string; level: FeedbackAnnouncement; deferred?: boolean; occurrence?: object;
}) {
  // A new local occurrence keeps the live region empty for a rendered frame.
  const [spoken, setSpoken] = useState<{ text: string; occurrence?: object }>({ text: "" });
  const suppressed = useRef<{ text: string; occurrence?: object } | null>(null);
  const delivered = useRef<object | null>(null);
  useEffect(() => {
    if (deferred) {
      suppressed.current = { text, occurrence };
      setSpoken({ text: "" });
      return;
    }
    if (suppressed.current?.text === text && suppressed.current.occurrence === occurrence) return;
    suppressed.current = null;
    if (occurrence !== undefined && delivered.current === occurrence) return;
    const next = { text: level === "None" ? "" : text, occurrence };
    if (occurrence === undefined || level === "None") {
      setSpoken(next);
      return;
    }
    let publication: number | null = null;
    const empty = requestAnimationFrame(() => {
      publication = requestAnimationFrame(() => { delivered.current = occurrence ?? null; setSpoken(next); });
    });
    return () => {
      cancelAnimationFrame(empty);
      if (publication !== null) cancelAnimationFrame(publication);
    };
  }, [text, level, deferred, occurrence]);
  if (level === "None") return null;
  return <span
    className="sr-only"
    role={level === "Assertive" ? "alert" : "status"}
    aria-live={deferred ? "off" : level === "Assertive" ? "assertive" : "polite"}
    aria-atomic="true"
  >{occurrence !== undefined && spoken.occurrence !== occurrence ? "" : spoken.text}</span>;
}

function Diagnostics({ requestId }: { requestId: string }) {
  const [result, setResult] = useState<{ requestId: string; state: "Copied" | "Failed" } | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  if (defect) throw defect.error;
  const state = result?.requestId === requestId ? result.state : "Ready";
  const copy = () => copyText(`Nexus request ID: ${requestId}`).then(
    () => setResult({ requestId, state: "Copied" }),
    (error: unknown) => error instanceof ClipboardWriteUnavailableError ? setResult({ requestId, state: "Failed" }) : setDefect({ error }),
  );
  return <div className={styles.diagnostics}>
    <div className={styles.diagnosticsBody}>
      <code>request id: {requestId}</code>
      <Button className={styles.control} onClick={() => void copy()}>copy diagnostics</Button>
    </div>
    <span className={styles.reason} role="status">{state === "Copied" ? "copied" : state === "Failed" ? "diagnostics couldn’t be copied; select the request id to copy it." : ""}</span>
  </div>;
}
