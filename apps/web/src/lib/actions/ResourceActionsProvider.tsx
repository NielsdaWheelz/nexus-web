"use client";

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  useFeedback,
  type FeedbackContextValue,
} from "@/components/feedback/Feedback";
import { actionFailure, type ActionId } from "@/lib/actions/catalog";
import {
  projectLecternAction,
  type ActionCommand,
} from "@/lib/actions/project";
import { ResourceOverlays } from "@/lib/actions/ResourceOverlays";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useConsumptionCommands } from "@/lib/consumption/state";
import { useAdmissionRecovery } from "@/lib/media/AdmissionRecoveryProvider";
import { setChatCommandAccount } from "@/lib/chat/commands";
import { compareRevision } from "@/lib/collections/order";
import { useChatCommandFeedback } from "@/lib/chat/commandFeedback";
import {
  useLectern,
  useLecternCommands,
} from "@/lib/lectern/lectern";
import { useLibraryPlacementController } from "@/lib/libraries/placementController";
import {
  offlineAvailable,
  useOfflineSnapshot,
  type OfflineItem,
} from "@/lib/offline/bridge";
import {
  usePlayerCommands,
  usePlayerSession,
} from "@/lib/player/playerRuntime";
import { useConnectivity } from "@/lib/renderEnvironment/connectivity";
import {
  useLinkComposer,
  type LinkComposer,
} from "@/lib/resourceGraph/useLinkComposer";
import { useShareController } from "@/lib/sharing/controller";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import {
  useLatestWorkspace,
  type WorkspaceStoreValue,
} from "@/lib/workspace/store";

/** The one overlay a verb can open; it loads its own facts by id. */
export type Overlay =
  | { readonly kind: "Authors"; readonly mediaId: string }
  | {
      readonly kind: "Metadata";
      readonly mediaId: string;
      readonly returnFocusTo: HTMLElement | null;
      readonly fallback: () => HTMLElement | null;
    }
  | { readonly kind: "LibrarySettings"; readonly libraryId: string }
  | { readonly kind: "PodcastSettings"; readonly podcastId: string }
  | { readonly kind: "Subscribe"; readonly podcastId: string };

/** Everything a verb reads or calls; it changes only when one of those facts does. */
export interface ActionContext {
  /** Whether this account's action owner is still mounted. */
  readonly isActive: () => boolean;
  readonly accountId: string;
  readonly online: boolean;
  readonly offline:
    | { readonly kind: "Unavailable" | "Loading" }
    | { readonly kind: "Ready"; readonly items: readonly OfflineItem[] };
  /** Shared lectern facts and the existing conditional-command owner. */
  readonly lectern: {
    readonly read: ReturnType<typeof useLectern>;
  } & ReturnType<typeof useLecternCommands>;
  readonly player: {
    readonly state: ReturnType<typeof usePlayerSession>["state"];
    readonly commands: ReturnType<typeof usePlayerCommands>;
  };
  /** The workspace when a verb runs; menus do not re-render on its changes. */
  readonly workspace: () => WorkspaceStoreValue;
  /** A command captures this provider lifetime before awaiting its result. */
  readonly sessionSignal: () => AbortSignal;
  readonly feedback: FeedbackContextValue;
  readonly linkComposer: LinkComposer;
  readonly openShare: ReturnType<typeof useShareController>["openShare"];
  readonly openLibraryPlacement: ReturnType<
    typeof useLibraryPlacementController
  >["openLibraryPlacement"];
  readonly consumption: ReturnType<typeof useConsumptionCommands>["commands"];
  readonly admissions: ReturnType<typeof useAdmissionRecovery>;
  readonly observeChatCommand: ReturnType<typeof useChatCommandFeedback>["observe"];
  readonly overlays: { readonly open: (overlay: Overlay) => void };
}

interface Runtime {
  readonly ctx: ActionContext;
  readonly run: (command: ActionCommand) => void;
  readonly busy: BusyKeys;
}

interface BusyKeys {
  readonly keys: () => ReadonlySet<string>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly set: (key: string, on: boolean) => void;
}

const RuntimeContext = createContext<Runtime | null>(null);

export function useActionRuntime(): Runtime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("ResourceActionsProvider is missing");
  return runtime;
}

/** The link composer the action overlays host; panes open links through it. */
export function useLinkComposerHost(): LinkComposer {
  return useActionRuntime().ctx.linkComposer;
}

/** The tracked verbs of `ref` now running: a reopened menu shows them busy. */
export function useBusyActionIds(ref: string | null): ReadonlySet<ActionId> {
  const { busy } = useActionRuntime();
  const keys = useSyncExternalStore(busy.subscribe, busy.keys, busy.keys);
  return useMemo(() => {
    const prefix = `${ref}|`;
    return new Set(
      [...keys]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length) as ActionId),
    );
  }, [keys, ref]);
}

/** An explicit add uses shared facts; mounting a row never reads its action menu. */
export function useLecternAddAction({
  mediaId, title,
}: {
  readonly mediaId: string;
  readonly title: string;
}):
  | { readonly kind: "Loading" }
  | { readonly kind: "Failed"; readonly retry: () => void; readonly busy: boolean }
  | { readonly kind: "Present" }
  | {
      readonly kind: "Action";
      readonly action: Extract<ActionDescriptor, { kind: "command" }>;
      readonly busy: boolean;
    } {
  const { ctx, run } = useActionRuntime();
  const busy = useBusyActionIds(`media:${mediaId}`);
  const { read, pending, receipts } = ctx.lectern;
  const request = pending.get(mediaId);
  if (!request) {
    const receipt = receipts.get(mediaId);
    if (receipt && (
      read.status !== "ready" ||
      compareRevision(receipt.order_revision, read.data.order_revision) > 0
    )) {
      if (receipt.present) return { kind: "Present" };
    } else if (read.status === "ready") {
      if (read.data.items.some((item) => item.media_summary.media_id === mediaId))
        return { kind: "Present" };
    } else if (read.status === "failed") {
      return { kind: "Failed", retry: read.refetch, busy: read.retrying };
    } else return { kind: "Loading" };
  }
  return {
    kind: "Action",
    action: projectLecternAction({
      mediaId, title, intent: "Ensure", blocked: null, ctx, busy, run,
    }),
    busy: (request !== undefined && request.phase !== "Unconfirmed") ||
      busy.has("LecternMembership"),
  };
}

function createBusyKeys(): BusyKeys {
  let keys: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  return {
    keys: () => keys,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(key, on) {
      const next = new Set(keys);
      if (on) next.add(key);
      else next.delete(key);
      keys = next;
      for (const listener of listeners) listener();
    },
  };
}

/**
 * The shell's one action runtime: the facts every verb reads, the busy set,
 * confirmation and failure reporting, and the overlays verbs open.
 */
export default function ResourceActionsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { accountId } = useAuthenticatedAccount();
  useLayoutEffect(() => {
    setChatCommandAccount(accountId);
  }, [accountId]);
  const workspace = useLatestWorkspace();
  const [session] = useState(() => ({ controller: new AbortController() }));
  useLayoutEffect(() => {
    const controller = new AbortController();
    session.controller = controller;
    return () => controller.abort();
  }, [session]);
  const feedback = useFeedback();
  const read = useLectern();
  const commands = useLecternCommands();
  const lectern = useMemo(
    () => ({ read, ...commands }),
    [read, commands],
  );
  const playerSession = usePlayerSession();
  const playerCommands = usePlayerCommands();
  const offlineSnapshot = useOfflineSnapshot();
  const online = useConnectivity() === "Online";
  const linkComposer = useLinkComposer();
  const { openShare } = useShareController();
  const { openLibraryPlacement } = useLibraryPlacementController();
  const consumption = useConsumptionCommands();
  const admissions = useAdmissionRecovery();
  const { observe: observeChatCommand, feedback: chatCommandFeedback } = useChatCommandFeedback();
  const [busy] = useState(createBusyKeys);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [overlay, setOverlay] = useState<
    (Overlay & { key: number; open: boolean; opener: HTMLElement | null }) | null
  >(null);

  // One overlay at a time; the metadata overlay closes through its exit.
  const open = useCallback((next: Overlay) => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setOverlay((current) =>
      current?.open
        ? current
        : { ...next, key: (current?.key ?? 0) + 1, open: true, opener },
    );
  }, []);
  const close = useCallback(
    () =>
      setOverlay((current) =>
        current?.kind === "Metadata" ? { ...current, open: false } : null,
      ),
    [],
  );
  const ctx = useMemo(
    (): ActionContext => ({
      isActive: () => !session.controller.signal.aborted,
      accountId,
      online,
      offline: !offlineAvailable
        ? { kind: "Unavailable" }
        : offlineSnapshot === null
          ? { kind: "Loading" }
          : { kind: "Ready", items: offlineSnapshot.items },
      lectern,
      player: { state: playerSession.state, commands: playerCommands },
      workspace,
      sessionSignal: () => session.controller.signal,
      feedback,
      linkComposer,
      openShare,
      openLibraryPlacement,
      consumption: consumption.commands,
      admissions,
      observeChatCommand,
      overlays: { open },
    }),
    [
      accountId,
      online,
      offlineSnapshot,
      lectern,
      playerSession.state,
      playerCommands,
      workspace,
      session,
      feedback,
      linkComposer,
      openShare,
      openLibraryPlacement,
      consumption.commands,
      admissions,
      observeChatCommand,
      open,
    ],
  );

  const run = useCallback(
    (command: ActionCommand) => {
      const signal = session.controller.signal;
      if (signal.aborted) return;
      const key = `${command.ref}|${command.id}`;
      if (command.tracked && busy.keys().has(key)) return;
      if (command.confirmation) {
        const { title, body } = command.confirmation;
        const text = body.replaceAll("{title}", command.title);
        if (!window.confirm(`${title}\n\n${text}`)) return;
      }
      if (command.tracked) busy.set(key, true);
      void (async () => {
        try {
          await command.execute();
        } catch (error) {
          if (signal.aborted) return;
          if (handleUnauthenticatedApiError(error)) return;
          if (!isApiError(error) || isSameSystemApiDefect(error))
            return setDefect({ error });
          feedback.offer({
            key: `resource-action:${command.ref}:${command.id}`,
            announcement: "Polite",
            content: actionFailure(command.id, command.label, error),
          });
        } finally {
          if (command.tracked) busy.set(key, false);
        }
      })();
    },
    [busy, feedback, session],
  );
  const runtime = useMemo(() => ({ ctx, run, busy }), [ctx, run, busy]);

  if (defect) throw defect.error;
  return (
    <RuntimeContext.Provider value={runtime}>
      {children}
      {chatCommandFeedback}
      {consumption.feedback}
      {linkComposer.feedback}
      <ResourceOverlays
        overlay={overlay}
        close={close}
        linkComposer={linkComposer}
      />
    </RuntimeContext.Provider>
  );
}
