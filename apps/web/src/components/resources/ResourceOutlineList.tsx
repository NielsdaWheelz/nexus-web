"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useEffect,
  useLayoutEffect,
  type ReactNode,
} from "react";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import type {
  OutlineBranch,
  OutlineTarget,
} from "@/lib/resources/outlineProjection";
import {
  useOutlineSession,
  type OutlinePlacement,
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
  useEffect(() => {
    const mark = (event: Event) => {
      const target = event.target;
      const key =
        event.type === "focusin" &&
        target instanceof Element &&
        root.current?.contains(target)
          ? (target
              .closest("[data-reference-editor]")
              ?.closest("[data-outline-occurrence]")
              ?.getAttribute("data-outline-occurrence") ?? null)
          : null;
      if (
        event.type === "pointerdown" ||
        event.type === "keydown" ||
        event.type === "focusin"
      )
        markInteraction(key, event.type);
    };
    document.addEventListener("pointerdown", mark, true);
    document.addEventListener("keydown", mark, true);
    document.addEventListener("focusin", mark, true);
    return () => {
      document.removeEventListener("pointerdown", mark, true);
      document.removeEventListener("keydown", mark, true);
      document.removeEventListener("focusin", mark, true);
    };
  }, [markInteraction]);
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
                    <button
                      type="button"
                      disabled={intent.problem !== null}
                      onClick={session.retryFailed}
                    >
                      retry this change at the reviewed position
                    </button>
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

type View = { folds: ReadonlyMap<string, boolean>; focused: string | null };
export const ResourceOutlineContext = createContext<{
  scope: string;
  view: View;
  viewLocked: boolean;
  placementDrag: { current: OutlinePlacement | null };
  toggle(key: string, open: boolean): void;
  focus(key: string): void;
  showAll(): void;
  reveal(target: OutlineTarget): void;
  focusedRowRemoved(key: string, row: HTMLElement): void;
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
  onFocusChange?: (focused: string | null) => void;
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
  children,
  after,
  ariaLabel,
  scope,
  ancestorRef,
  branch: suppliedBranch,
  onRevealRoot,
  onFocusChange,
  busy,
  viewLocked = false,
  session,
}: Props & { session: OutlineSession }) {
  const inherited = useContext(ResourceBranch);
  const {
    view,
    focusBranch,
    showAll: showSessionItems,
    toggle: toggleSession,
  } = session;
  const placementDrag = useRef<OutlinePlacement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const focusedKey = useRef(view.focused);
  const pendingFocus = useRef<{ key: string; previous: Element | null } | null>(
    null,
  );
  const focusChanged = useRef(onFocusChange);
  const locked = useRef(viewLocked);
  locked.current = viewLocked;
  focusChanged.current = onFocusChange;
  const reveal = useCallback(
    (target: OutlineTarget) => {
      if (target.kind === "root" && view.focused === null && onRevealRoot) {
        onRevealRoot();
        return;
      }
      const key = target.kind === "occurrence" ? target.key : view.focused;
      const occurrence =
        key === null
          ? list.current
          : root.current?.querySelector<HTMLElement>(
              `[data-outline-occurrence="${CSS.escape(key)}"]`,
            );
      if (!occurrence) return;
      const control =
        key === null || occurrence.matches("[data-row-focusable]")
          ? occurrence
          : occurrence.querySelector<HTMLElement>("[data-row-focusable]");
      control?.focus();
    },
    [onRevealRoot, view.focused],
  );
  const focus = useCallback(
    (focused: string) => {
      if (locked.current) return;
      pendingFocus.current = { key: focused, previous: document.activeElement };
      focusBranch(focused);
    },
    [focusBranch],
  );
  const showAll = useCallback(() => {
    if (locked.current) return;
    showSessionItems();
  }, [showSessionItems]);
  const focusedRowRemoved = useCallback(
    (key: string, row: HTMLElement) => {
      const previous = document.activeElement;
      const ownedFocus = previous !== null && root.current?.contains(previous);
      // A committed removal ends focus; an initial lazy restoration or ref reattachment does not.
      queueMicrotask(() => {
        const scope = root.current;
        if (
          !scope?.isConnected ||
          focusedKey.current !== key ||
          row.isConnected ||
          scope.querySelector(`[data-outline-occurrence="${CSS.escape(key)}"]`)
        )
          return;
        showSessionItems();
        if (
          ownedFocus &&
          (document.activeElement === previous ||
            (document.activeElement === document.body &&
              !previous?.isConnected))
        )
          list.current?.focus();
      });
    },
    [showSessionItems],
  );
  useLayoutEffect(() => {
    focusedKey.current = view.focused;
    const pending = pendingFocus.current;
    pendingFocus.current = null;
    if (
      pending &&
      (document.activeElement === pending.previous ||
        (document.activeElement === document.body &&
          !pending.previous?.isConnected))
    )
      reveal({ kind: "occurrence", key: pending.key });
  }, [reveal, view]);
  useLayoutEffect(() => {
    focusChanged.current?.(view.focused);
  }, [view.focused]);
  const context = useMemo(
    () => ({
      scope,
      view,
      viewLocked,
      placementDrag,
      toggle: (key: string, open: boolean) => {
        if (!locked.current) toggleSession({ key, open });
      },
      focus,
      showAll,
      reveal,
      focusedRowRemoved,
    }),
    [
      scope,
      focus,
      focusedRowRemoved,
      reveal,
      showAll,
      view,
      viewLocked,
      toggleSession,
    ],
  );
  const branch = useMemo(() => {
    const base = suppliedBranch ?? inherited;
    return ancestorRef && !base.ancestors.has(ancestorRef)
      ? {
          ...base,
          ancestors: new Map(base.ancestors).set(ancestorRef, {
            kind: "root",
          } as const),
        }
      : base;
  }, [ancestorRef, inherited, suppliedBranch]);
  return (
    <ResourceOutlineContext value={context}>
      <ResourceBranch value={branch}>
        <div
          ref={root}
          className={styles.outline}
          data-pane-return-scope={scope}
          data-outline-scope={scope}
        >
          {view.focused !== null ? (
            <button
              type="button"
              className={styles.textButton}
              disabled={viewLocked}
              onClick={() => {
                pendingFocus.current = {
                  key: view.focused!,
                  previous: document.activeElement,
                };
                showAll();
              }}
            >
              back to all items
            </button>
          ) : null}
          <ul
            ref={list}
            className={styles.list}
            aria-label={ariaLabel}
            aria-busy={busy}
            tabIndex={-1}
          >
            {children}
          </ul>
          {after}
        </div>
      </ResourceBranch>
    </ResourceOutlineContext>
  );
}
