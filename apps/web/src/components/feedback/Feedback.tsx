"use client";

import { Check, ChevronDown, Info, OctagonAlert, TriangleAlert, X } from "lucide-react";
import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import Button from "@/components/ui/Button";
import { useCopyFeedback } from "@/components/ui/useCopyFeedback";
import ButtonLink from "@/components/ui/ButtonLink";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import type { TargetLinkActivationResult } from "@/lib/panes/targetLinkActivation";
import { ClipboardWriteUnavailableError } from "@/lib/ui/copyText";
import { hasActiveModal, OverlayContext, useInteractionOwner } from "@/lib/ui/overlay";
import { workspaceTargetActivationIntent, type OpenIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { Scope, Session, createFeedbackSet, createFeedbackSession, hostEligible, type FeedbackHost, type FeedbackScopeValue, type Failure } from "./scope";
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
/** commandKey names an exact command, so a held control never silently changes meaning. */
export type FeedbackAction =
  | { label: string; onClick: (intent: OpenIntent) => void; busy?: boolean; disabledReason?: string; commandKey?: string; copiedOccurrence?: object; href?: never; onActivate?: never }
  | { label: string; href: string; target?: "_blank"; onActivate?: (event: TargetActivationEvent) => TargetLinkActivationResult; onClick?: never; busy?: boolean; disabledReason?: string; commandKey?: never };
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
export interface FeedbackContextValue {
  /** One discrete action's outcome. Durable failures belong to their owner's surface.
   * The returned retraction withdraws it, waiting or visible, once its state resolves. */
  receipt(content: FeedbackContent, action?: FeedbackAction): () => void;
}
/** A host owns its mounted contributions; only its presenters subscribe. */
export function FeedbackScope({ host, children }: { host: FeedbackHost; children: ReactNode }) {
  const [scope] = useState<FeedbackScopeValue>(() => {
    const value: FeedbackScopeValue = { ...createFeedbackSet(), host, recovery: null, disclosure: null, disclosures: new Set(), disclosureTargets: new Set(), recoveryOpen: false, control: null,
      eligible: () => hostEligible(value), mayRestoreFocus: () => hostEligible(value), returnFocus: () => value.host.returnFocus() };
    return value;
  });
  useLayoutEffect(() => { scope.host = host; scope.changed(); }, [scope, host]);
  return <Scope value={scope}>{children}</Scope>;
}

/** Presentation identity follows the owner's unresolved condition, including its retry. */
export function useFeedbackOccurrence(active: boolean, identity?: unknown): object {
  const [current, setCurrent] = useState(() => ({ active, identity, occurrence: {} }));
  if (current.active === active && Object.is(current.identity, identity)) return current.occurrence;
  const next = { active, identity, occurrence: active && (!current.active || !Object.is(current.identity, identity)) ? {} : current.occurrence };
  setCurrent(next);
  return next.occurrence;
}

export type FeedbackFailureProps = FeedbackNoticeProps & {
  occurrence: object;
  scope: "Local" | "Account";
  announcementOccurrence?: object;
};
export function FeedbackFailure({ scope: placement, ...failure }: FeedbackFailureProps) {
  const session = useContext(Session);
  const scope = useContext(Scope);
  const [token] = useState(() => ({}));
  const owner = placement === "Account" ? session?.account : scope;
  if (!owner) throw new Error("feedback failure has no presentation owner");
  useLayoutEffect(() => { owner.publish(token, failure); });
  useLayoutEffect(() => () => owner.withdraw(token), [owner, token]);
  return null;
}
export function FeedbackBusy({ pending, subject }: { pending: boolean; subject?: unknown }) {
  const scope = useContext(Scope);
  const token = useFeedbackOccurrence(true, subject);
  useLayoutEffect(() => {
    if (!scope) return;
    scope.pending(token, pending);
    return () => scope.pending(token, false);
  }, [scope, token, pending]);
  return null;
}

/** One permanently reserved control in the host's existing controls. */
export function FeedbackRecoveryControl({ className, menu = false }: { className?: string; menu?: boolean }) {
  const scope = useContext(Scope);
  const session = useContext(Session);
  if (!scope || !session) return null;
  return <RecoveryControl scope={scope} session={session} className={className} menu={menu} />;
}
function RecoveryControl({ scope, session, className, menu }: {
  scope: FeedbackScopeValue; session: ReturnType<typeof createFeedbackSession>; className?: string; menu: boolean;
}) {
  useInteractionOwner();
  const local = useSyncExternalStore(scope.subscribe, scope.snapshot, scope.snapshot);
  const account = useSyncExternalStore(session.account.subscribe, session.account.snapshot, session.account.snapshot);
  const eligible = scope.eligible();
  const failures = [...new Map([...local.failures, ...account.failures].map(failure => [failure.occurrence, failure])).values()];
  const [open, setOpen] = useState(false);
  if (open && failures.length === 0) setOpen(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const layer = useRef<import("@/lib/ui/overlay").Layer | null>(null);
  useLayoutEffect(() => { scope.control = anchor; return () => { scope.control = null; }; }, [scope, anchor]);
  useLayoutEffect(() => { scope.recovery = open ? layer.current : null; scope.recoveryOpen = open; scope.changed(); return () => { scope.recovery = null; scope.recoveryOpen = false; }; }, [scope, open]);
  return <>
    <Button ref={setAnchor} className={className} role={menu ? "menuitem" : undefined} tabIndex={menu ? -1 : undefined} iconOnly icon={eligible && failures.length ? <OctagonAlert /> : <span />}
      aria-label="show recovery" tooltip={{ text: eligible && failures.length ? "show recovery" : "" }} aria-expanded={open && failures.length > 0} disabled={!eligible || !failures.length}
      aria-busy={local.pending !== null || undefined} busyKey={local.pending} onClick={() => setOpen(value => !value)} data-feedback-recovery="true" />
    <FloatingActionSurface open={open && failures.length > 0} disclosure feedback interactionLayer={layer}
      anchor={anchor} disclosureTrigger={anchor} align="end" placement="below" flip role="group" label="recovery" skipReturnFocus={() => !scope.eligible()}
      className={styles.recovery} onDismiss={() => setOpen(false)}>
      <div ref={element => { scope.disclosure = element; }} data-feedback-disclosure="true" className={styles.stack}>
        {failures.map(failure => <ControlledSignal key={session.key(failure.occurrence)} failure={failure} />)}
      </div>
    </FloatingActionSurface>
  </>;
}
export function ControlledSignal({ failure, onDismiss }: { failure: Failure; onDismiss?: () => void }) {
  return <Signal {...failure} occurrence={failure.occurrence} announcement="None" className={styles.transientSignal}
    disclosure="Anchored" onDismiss={onDismiss} />;
}
/** Speech belongs to the eligible scope, including when its card minimizes. */
export function FailureAnnouncement({ failure, session }: { failure: Failure; session: ReturnType<typeof createFeedbackSession> }) {
  const occurrence = failure.announcementOccurrence ?? failure.occurrence;
  return session.acknowledged.get(failure.occurrence) !== occurrence && session.spoken.get(failure.occurrence) !== occurrence
    ? <Announcement text={failure.content.title} level={failure.announcement} occurrence={occurrence}
      onPublish={() => session.spoken.set(failure.occurrence, occurrence)} /> : null;
}

const ICONS = { Neutral: null, Info, Success: Check, Warning: TriangleAlert, Danger: OctagonAlert };
const RELOAD: FeedbackActions = [{ label: "reload app", onClick: () => window.location.reload() }];

/** One account's presentation. The geometry provider is above this owner. */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [session] = useState(createFeedbackSession);
  const signals = session.transient;
  useLayoutEffect(() => { signals.resume(); return signals.dispose; }, [signals]);
  useEffect(() => {
    document.addEventListener("visibilitychange", signals.visibilityChanged);
    return () => document.removeEventListener("visibilitychange", signals.visibilityChanged);
  }, [signals]);
  return <Session value={session}>{children}</Session>;
}

export function useFeedback(): FeedbackContextValue {
  const session = useContext(Session);
  if (!session) throw new Error("useFeedback must be used within a FeedbackProvider");
  return session.transient;
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
  onDismiss, dismissLabel, dismissBlocked, plain = false, surfaceState = false, occurrence, announcementOccurrence, onNavigate: navigation,
}: FeedbackProps & {
  className: string;
  onDismiss?: () => void;
  dismissLabel?: string;
  dismissBlocked?: boolean;
  plain?: boolean;
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
          aria-label={`${open ? "show less" : "show more"}: ${content.title}`}
          onClick={() => changeExpanded(!open)}
        >
          {open ? "show less" : "show more"}
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
      feedback
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
    <Announcement text={content.title} level={scope !== null && !scope.eligible() ? "None" : announcement} occurrence={announcementOccurrence} />
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
      target={shown.target}
      rel={shown.target === "_blank" ? "noopener noreferrer" : undefined}
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
      icon={shown.href === undefined && shown.copiedOccurrence ? <Check /> : undefined}
      reserveIcon
      busyKey={action.commandKey ?? occurrence}
      aria-busy={shown.busy || undefined}
      aria-disabled={blocked || undefined}
      aria-describedby={reason ? `${contextId} ${reasonId}` : contextId}
      onClick={activate}
      onKeyDown={activate}
    >{shown.label}</Button>}
    {shown.href === undefined && shown.copiedOccurrence ? <Announcement text="copied" level="Polite" occurrence={shown.copiedOccurrence} /> : null}
    {reason ? <p id={reasonId} className={styles.reason}>{reason}</p> : null}
  </div>;
}

/** Only the short fact is live; controls and disclosure never enter the live region. */
export function Announcement({ text, level: requestedLevel, deferred = false, occurrence, onPublish }: {
  text: string; level: FeedbackAnnouncement; deferred?: boolean; occurrence?: object; onPublish?: () => void;
}) {
  const session = useContext(Session);
  const scope = useContext(Scope);
  useInteractionOwner();
  const level = scope !== null && !scope.eligible() ? "None" : requestedLevel;
  // A new local occurrence keeps the live region empty for a rendered frame.
  const [spoken, setSpoken] = useState<{ text: string; occurrence?: object }>({ text: "" });
  const suppressed = useRef<{ text: string; occurrence?: object } | null>(null);
  const delivered = useRef<object | null>(null);
  const publish = useRef(onPublish);
  publish.current = onPublish;
  useEffect(() => {
    if (deferred) {
      suppressed.current = { text, occurrence };
      setSpoken({ text: "" });
      return;
    }
    if (suppressed.current?.text === text && suppressed.current.occurrence === occurrence) return;
    suppressed.current = null;
    if (level === "None") { setSpoken({ text: "", occurrence }); return; }
    if (occurrence !== undefined && (delivered.current === occurrence || session?.spoken.get(occurrence) === occurrence)) return;
    const next = { text, occurrence };
    if (occurrence === undefined) {
      setSpoken(next);
      return;
    }
    let publication: number | null = null;
    const empty = requestAnimationFrame(() => {
      publication = requestAnimationFrame(() => { if (scope !== null && !scope.eligible()) return; delivered.current = occurrence ?? null; if (occurrence !== undefined) session?.spoken.set(occurrence, occurrence); setSpoken(next); publish.current?.(); });
    });
    return () => {
      cancelAnimationFrame(empty);
      if (publication !== null) cancelAnimationFrame(publication);
    };
  }, [text, level, deferred, occurrence, session, scope]);
  if (level === "None") return null;
  return <span
    className="sr-only"
    role={level === "Assertive" ? "alert" : "status"}
    aria-live={deferred ? "off" : level === "Assertive" ? "assertive" : "polite"}
    aria-atomic="true"
  >{occurrence !== undefined && spoken.occurrence !== occurrence ? "" : spoken.text}</span>;
}

function Diagnostics({ requestId }: { requestId: string }) {
  const copy = useCopyFeedback(requestId);
  const [failure, setFailure] = useState<{ requestId: string; occurrence: object } | null>(null);
  const failed = failure?.requestId === requestId;
  const occurrence = useFeedbackOccurrence(failed, requestId);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const text = useRef<HTMLElement>(null);
  if (defect) throw defect.error;
  const select = () => {
    if (!text.current) return;
    const range = document.createRange(); range.selectNodeContents(text.current);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  };
  const onCopy = () => {
    setFailure(null);
    void copy.copy(`Nexus request ID: ${requestId}`).catch((error: unknown) => {
      if (error instanceof ClipboardWriteUnavailableError) setFailure({ requestId, occurrence: {} }); else setDefect({ error });
    });
  };
  return <div className={styles.diagnostics}>
    <div className={styles.diagnosticsBody}>
      <code ref={text}>request id: {requestId}</code>
      <Button className={styles.control} icon={copy.copied ? <Check /> : <span />} onClick={onCopy}>copy diagnostics</Button>
    </div>
    {copy.occurrence ? <Announcement text="copied" level="Polite" occurrence={copy.occurrence} /> : null}
    {failed ? <FeedbackFailure scope="Local" occurrence={occurrence} announcementOccurrence={failure?.occurrence} content={{ tone: "Warning", title: "couldn’t copy diagnostics" }}
      announcement="Polite" actions={[{ label: "select request id", onClick: select }]} /> : null}
  </div>;
}
