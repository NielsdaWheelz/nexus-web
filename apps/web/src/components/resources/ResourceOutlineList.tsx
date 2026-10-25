"use client";

import Button from "@/components/ui/Button";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {usePaneOutlineCommands} from "@/lib/panes/paneChrome";
import {hasActiveInteractionOwner, useInteractionOwner} from "@/lib/ui/overlay";
import {usePaneIsActive} from "@/lib/panes/paneRuntime";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import {FeedbackNotice} from "@/components/feedback/Feedback";
import {useOutlineChildren, type OutlineChildrenDescriptor} from "@/lib/resourceGraph/useOutlineChildren";
import type {
  OutlineBranch,
  OutlineTarget,
} from "@/lib/resources/outlineProjection";
import {
  useOutlineSession,
  type OutlineSession,
} from "@/lib/notes/useOutlineSession";
import styles from "./ResourceOutline.module.css";

export const OutlineSessionContext = createContext<OutlineSession | null>(null);
const ObservedSession = createContext<OutlineSession | null>(null);

/** The whole editing surface, including root bodies and route masthead. */
export function OutlineSessionScope({
  session,
  children,
}: {
  session: OutlineSession;
  children: ReactNode;
}) {
  const inherited = useContext(ObservedSession);
  return inherited === session ? (
    <>{children}</>
  ) : (
    <ObservedOutlineSession session={session}>
      {children}
    </ObservedOutlineSession>
  );
}

function ObservedOutlineSession({
  session,
  children,
}: {
  session: OutlineSession;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const markInteraction = session.markInteraction;
  const runtime = usePaneRuntime();
  const active = usePaneIsActive();
  const interactionOwner = useInteractionOwner();
  const latest = useRef(session);
  latest.current = session;
  useEffect(() => {if (!active || interactionOwner !== null) latest.current.revokeCommands();}, [active, interactionOwner]);
  usePaneOutlineCommands(session.commandOwner && active && interactionOwner === null ? {
    session: session.scope, insertLabel: session.insertLabel,
    commandState: command => latest.current.commandState(command),
    executeCommand: command => latest.current.executeCommand(command),
    done: () => {
      const focused = document.activeElement;
      latest.current.revokeCommands();
      if (focused instanceof HTMLElement && root.current?.contains(focused)) focused.blur();
    },
  } : null);
  useEffect(() => {
    const mark = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const accessory = target.closest("[data-outline-commands]");
      if (accessory?.getAttribute("data-outline-commands") === latest.current.scope) return;
      const inside = root.current?.contains(target) ?? false;
      if (!inside && (event.type === "pointerdown" || event.type === "focusin")) latest.current.revokeCommands();
      if (inside && (event.type === "pointerdown" || event.type === "keydown" || event.type === "focusin"))
        markInteraction(target.closest("[data-outline-occurrence]")?.getAttribute("data-outline-occurrence") ?? null,
          event.type as "pointerdown" | "keydown" | "focusin");
      if (hasActiveInteractionOwner() && latest.current.commandOwner) latest.current.revokeCommands();
    };
    document.addEventListener("pointerdown", mark, true);
    document.addEventListener("keydown", mark, true);
    document.addEventListener("focusin", mark, true);
    return () => {
      document.removeEventListener("pointerdown", mark, true);
      document.removeEventListener("keydown", mark, true);
      document.removeEventListener("focusin", mark, true);
    };
  }, [markInteraction, runtime]);
  return (
    <ObservedSession value={session}>
      <OutlineSessionContext value={session}>
        <div ref={root} data-outline-session={session.scope}>
          {children}
          {session.failedIntents.length > 0 ? (
            <section aria-label="kept outline drafts">
              <p role="alert">this change was refused. your drafts are kept.</p>
              {session.failedIntents.map((intent, index) => (
                <div key={index}>
                  {intent.drafts.map((draft) => (
                    <pre key={draft.ref}>{draft.body.body_text}</pre>
                  ))}
                  {intent.problem ? <p>{intent.problem}</p> : null}
                  {index === 0 ? (
                    <Button
                      type="button"
                      disabled={intent.problem !== null}
                      onClick={session.retryFailed}
                    >
                      retry this change at the reviewed position
                    </Button>
                  ) : null}
                </div>
              ))}
            </section>
          ) : null}
        </div>
      </OutlineSessionContext>
    </ObservedSession>
  );
}

export const ResourceOutlineContext = createContext<{
  scope: string;
  view: { folds: ReadonlyMap<string, boolean> };
  viewLocked: boolean;
  childAvailability: ReturnType<typeof useOutlineChildren>["items"];
  registerChildren(key: string, descriptor: OutlineChildrenDescriptor): () => void;
  toggle(key: string, open: boolean): void;
  reveal(target: OutlineTarget): void;
} | null>(null);
export const ResourceBranch = createContext<OutlineBranch>({
  ancestors: new Map(),
  traversedEdgeIds: new Set(),
});

type Props = {
  children: ReactNode;
  after?: ReactNode;
  ariaLabel: string;
  scope: string;
  ancestorRef?: string;
  branch?: OutlineBranch;
  onRevealRoot?: () => void;
  busy?: boolean;
  viewLocked?: boolean;
};

/** Native lists share one visit's folds and reveal scope; ancestry follows occurrences. */
export default function ResourceOutlineList(props: Props) {
  const parent = useContext(ResourceOutlineContext);
  const inherited = useContext(ResourceBranch);
  const runtime = usePaneRuntime();
  if (parent)
    return (
      <ResourceBranch value={props.branch ?? inherited}>
        <ul
          className={styles.list}
          aria-label={props.ariaLabel}
          aria-busy={props.busy}
        >
          {props.children}
        </ul>
        {props.after}
      </ResourceBranch>
    );
  return (
    <RootList
      key={`${runtime?.visitId ?? "outside"}:${props.scope}`}
      {...props}
    />
  );
}

function RootList(props: Props) {
  const session = useContext(OutlineSessionContext);
  return session ? (
    <OutlineSessionScope session={session}>
      <SessionList {...props} session={session} />
    </OutlineSessionScope>
  ) : (
    <StandaloneList {...props} />
  );
}

function StandaloneList(props: Props) {
  const branch = useContext(ResourceBranch);
  const session = useOutlineSession({
    scope: props.scope,
    inheritedBranch: props.branch ?? branch,
  });
  return (
    <OutlineSessionScope session={session}>
      <SessionList {...props} session={session} />
    </OutlineSessionScope>
  );
}

function SessionList({
  children, after, ariaLabel, scope, ancestorRef, branch: suppliedBranch,
  onRevealRoot, busy, viewLocked = false, session,
}: Props & { session: OutlineSession }) {
  const inherited = useContext(ResourceBranch);
  const root = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const [descriptors, setDescriptors] = useState<ReadonlyMap<string, OutlineChildrenDescriptor>>(() => new Map());
  const registerChildren = useCallback((key: string, descriptor: OutlineChildrenDescriptor) => {
    const registration = {...descriptor};
    setDescriptors(current => new Map(current).set(key, registration));
    return () => setDescriptors(current => {
      if (current.get(key) !== registration) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }, []);
  const availability = useOutlineChildren(scope, descriptors);
  const reveal = useCallback((target: OutlineTarget) => {
    if (target.kind === "root") {
      if (onRevealRoot) onRevealRoot();
      else list.current?.focus();
      return;
    }
    root.current?.querySelector<HTMLElement>(
      `[data-outline-occurrence="${CSS.escape(target.key)}"] [data-row-focusable]`,
    )?.focus();
  }, [onRevealRoot]);
  const context = {
    scope, view: session.view, viewLocked, childAvailability: availability.items, registerChildren,
    toggle(key: string, open: boolean) {
      if (!viewLocked) session.toggle({key, open});
    },
    reveal,
  };
  const base = suppliedBranch ?? inherited;
  const branch = ancestorRef && !base.ancestors.has(ancestorRef)
    ? {...base, ancestors: new Map(base.ancestors).set(ancestorRef, {kind: "root"} as const)}
    : base;
  return <ResourceOutlineContext value={context}>
    <ResourceBranch value={branch}>
      <div ref={root} className={styles.outline} data-pane-return-scope={scope} data-outline-scope={scope}>
        {availability.error ? <FeedbackNotice content={{tone: "Warning", title: "couldn’t load outline structure",
          requestId: availability.error.requestId}} announcement="Polite"
          actions={[{label: "retry", onClick: availability.retry}]}/>
          : availability.loading ? <p role="status" className={styles.status}>loading outline structure…</p> : null}
        <ul ref={list} className={styles.list} aria-label={ariaLabel} aria-busy={busy} tabIndex={-1}>
          {children}
        </ul>
        {after}
      </div>
    </ResourceBranch>
  </ResourceOutlineContext>;
}
