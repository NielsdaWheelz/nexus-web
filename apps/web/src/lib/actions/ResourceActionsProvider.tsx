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
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { useMediaContinuationOwner } from "@/lib/actions/mediaContinuation";
import { actionFailure, type ActionId } from "@/lib/actions/catalog";
import {
  type ActionCommand,
} from "@/lib/actions/project";
import { ResourceOverlays } from "@/lib/actions/ResourceOverlays";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { ProgressPreparationError } from "@/lib/consumption/progressFence";
import { useConsumptionCommands } from "@/lib/consumption/state";
import { useMediaAdmissions } from "@/lib/media/admissions";
import { setChatCommandAccount } from "@/lib/chat/commands";
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
import { usePodcastEpisodeCommands } from "@/lib/podcasts/episodeCommands";
import { useConnectivity } from "@/lib/renderEnvironment/connectivity";
import { useShareController } from "@/lib/sharing/controller";
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
    readonly pendingPlayback: ReturnType<typeof usePlayerSession>["pendingPlayback"];
    readonly commands: ReturnType<typeof usePlayerCommands>;
  };
  /** The workspace when a verb runs; menus do not re-render on its changes. */
  readonly workspace: () => WorkspaceStoreValue;
  /** A command captures this provider lifetime before awaiting its result. */
  readonly sessionSignal: () => AbortSignal;
  readonly feedback: FeedbackContextValue;
  readonly reportDefect: (failure: { error: unknown }) => void;
  readonly openShare: ReturnType<typeof useShareController>["openShare"];
  readonly openLibraryPlacement: ReturnType<
    typeof useLibraryPlacementController
  >["openLibraryPlacement"];
  readonly consumption: ReturnType<typeof useConsumptionCommands>["commands"];
  readonly podcastEpisodes: ReturnType<typeof usePodcastEpisodeCommands>["commands"];
  readonly admissions: ReturnType<typeof useMediaAdmissions>;
  readonly mediaContinuations: ReturnType<typeof useMediaContinuationOwner>;
  readonly observeChatCommand: ReturnType<typeof useChatCommandFeedback>["observe"];
  readonly overlays: { readonly open: (overlay: Overlay) => void };
}

interface Runtime {
  readonly ctx: ActionContext;
  readonly run: (command: ActionCommand) => void;
  readonly busy: BusyKeys;
  readonly defect: { error: unknown } | null;
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

/** Render beneath workspace containment so account command recovery stays mounted. */
export function ResourceActionDefect() {
  const { defect } = useActionRuntime();
  if (defect !== null) throw defect.error;
  return null;
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
  const { openShare } = useShareController();
  const { openLibraryPlacement } = useLibraryPlacementController();
  const consumption = useConsumptionCommands();
  const admissions = useMediaAdmissions();
  const { observe: observeChatCommand, feedback: chatCommandFeedback } = useChatCommandFeedback();
  const [busy] = useState(createBusyKeys);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [confirmation, setConfirmation] = useState<ActionCommand | null>(null);
  const podcastEpisodes = usePodcastEpisodeCommands(accountId, setDefect);
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
      setOverlay((current) => {
        if (current !== overlay) return current;
        return current?.kind === "Metadata" ? { ...current, open: false } : null;
      }),
    [overlay],
  );
  const mediaContinuations = useMediaContinuationOwner({
    isActive: () => !session.controller.signal.aborted,
    sessionSignal: () => session.controller.signal,
    lectern, reportDefect: setDefect, workspace,
  });
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
      player: { state: playerSession.state, pendingPlayback: playerSession.pendingPlayback, commands: playerCommands },
      workspace,
      sessionSignal: () => session.controller.signal,
      feedback,
      reportDefect: setDefect,
      openShare,
      openLibraryPlacement,
      consumption: consumption.commands,
      admissions,
      podcastEpisodes: podcastEpisodes.commands,
      mediaContinuations,
      observeChatCommand,
      overlays: { open },
    }),
    [
      accountId,
      online,
      offlineSnapshot,
      lectern,
      playerSession.state,
      playerSession.pendingPlayback,
      playerCommands,
      workspace,
      session,
      feedback,
      openShare,
      openLibraryPlacement,
      consumption.commands,
      admissions,
      podcastEpisodes.commands,
      mediaContinuations,
      observeChatCommand,
      open,
    ],
  );

  const run: (command: ActionCommand) => void = useCallback(
    (command: ActionCommand) => {
      const signal = session.controller.signal;
      if (signal.aborted) return;
      const key = `${command.ref}|${command.id}`;
      if (command.tracked && busy.keys().has(key)) return;
      if (command.confirmation) {
        setConfirmation(command);
        return;
      }
      if (command.tracked) busy.set(key, true);
      void (async () => {
        try {
          await command.execute();
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof ProgressPreparationError) {
            feedback.offer({ key: `resource-action:${command.ref}:${command.id}`, announcement: "Polite", content: { tone: "Warning", title: "progress couldn’t be saved", message: "this attempt did not send the state change. resolve the player or reader save before trying again." } });
            return;
          }
          if (handleUnauthenticatedApiError(error)) return;
          if (!isApiError(error) || isSameSystemApiDefect(error))
            return setDefect({ error });
          feedback.offer({
            key: `resource-action:${command.ref}:${command.id}`,
            announcement: "Polite",
            content: command.id === "Playback" ? {
              tone: "Warning", title: error.code === "E_AUDIO_UNAVAILABLE" ? "audio unavailable" : "couldn’t start playback",
              requestId: error.requestId,
            } : actionFailure(command.id, command.label, error),
            actions: command.id === "Playback" ? [{ label: "retry playback", onClick: () => run(command) }] : undefined,
          });
        } finally {
          if (command.tracked) busy.set(key, false);
        }
      })();
    },
    [busy, feedback, session],
  );
  const runtime = useMemo(() => ({ ctx, run, busy, defect }), [ctx, run, busy, defect]);

  return (
    <RuntimeContext.Provider value={runtime}>
      {children}
      {chatCommandFeedback}
      {consumption.feedback}
      <Dialog open={confirmation !== null} title={confirmation?.confirmation?.title ?? "confirm change"} onClose={() => setConfirmation(null)}>
        {confirmation?.confirmation ? <>
          <p>{confirmation.confirmation.body.replaceAll("{title}", () => confirmation.title)}</p>
          <Button variant="danger" onClick={() => {
            const command = confirmation;
            setConfirmation(null);
            run({ ...command, confirmation: null });
          }}>{confirmation.label}</Button>{" "}
          <Button variant="ghost" onClick={() => setConfirmation(null)}>cancel</Button>
        </> : null}
      </Dialog>
      {podcastEpisodes.feedback}
      <ResourceOverlays
        overlay={overlay}
        close={close}
      />
    </RuntimeContext.Provider>
  );
}
