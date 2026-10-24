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
  type FeedbackContent,
  type FeedbackActions,
  type FeedbackOffer,
  useWorkspaceCondition,
} from "@/components/feedback/Feedback";
import { createDestinationCreation, useDestinationCreation } from "@/components/libraries/useDestinationCreation";
import { useWorkGuard } from "@/lib/unsavedWork";
import type { MetadataSubject } from "./subjects";
import type { CollectionSelection, CollectionTarget } from "@/lib/consumption/api";
import type { EpisodeState } from "@/lib/podcasts/api";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { useMediaContinuationOwner } from "@/lib/actions/mediaContinuation";
import { actionFailure, type ActionId } from "@/lib/actions/catalog";
import {
  ResourceActionFailure,
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
import { usePodcastSettingsOwner } from "@/lib/podcasts/usePodcastSettingsSave";
import { usePodcastCommands } from "@/lib/podcasts/commands";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import type { PodcastTarget } from "@/lib/podcasts/api";
import { QueueCommandError } from "@/lib/player/queue";
import { usePodcastEpisodeCommands } from "@/lib/podcasts/episodeCommands";
import { installedApp, remoteReady } from "@/lib/native/admission";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import { useConnectivity } from "@/lib/renderEnvironment/connectivity";
import { useShareController } from "@/lib/sharing/controller";
import {
  useLatestWorkspace,
  type WorkspaceStoreValue,
} from "@/lib/workspace/store";

/** The one overlay a verb can open; it loads its own facts by id. */
export type Overlay =
  | {
      readonly kind: "Metadata";
      readonly subject: MetadataSubject;
      readonly returnFocusTo: HTMLElement | null;
      readonly fallback: ReturnFocusTarget;
    }
  | { readonly kind: "CollectionConsumption"; readonly selection: CollectionSelection; readonly desiredState: "finished" | "unread"; readonly title: string }
  | { readonly kind: "CollectionLectern"; readonly target: CollectionTarget; readonly title: string }
  | { readonly kind: "TranscribePodcastEpisodes"; readonly podcastId: string; readonly title: string; readonly state: EpisodeState }
  | { readonly kind: "LibrarySettings"; readonly libraryId: string }
  | { readonly kind: "PodcastSettings"; readonly podcastId: string }
  | { readonly kind: "PodcastLibraries"; readonly target: PodcastTarget; readonly title: string; readonly successFocus?: ReturnFocusTarget }
  | { readonly kind: "SubscribePodcast"; readonly target: PodcastTarget; readonly title: string; readonly libraryId: string | null; readonly onAccepted?: () => void }
  | { readonly kind: "ImportPodcastEpisodes"; readonly target: PodcastTarget; readonly title: string }
  | { readonly kind: "UnsubscribePodcast"; readonly podcastId: string; readonly title: string; readonly libraryId: string | null; readonly successFocus?: ReturnFocusTarget }
  | { readonly kind: "RemovePodcastEpisodes"; readonly podcastId: string; readonly title: string };

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
    readonly queue: ReturnType<typeof usePlayerSession>["queue"];
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
  readonly consumptionUndoItems: ReturnType<typeof useConsumptionCommands>["undoItems"];
  readonly podcastSettings: ReturnType<typeof usePodcastSettingsOwner>["commands"];
  readonly podcasts: ReturnType<typeof usePodcastCommands>["commands"];
  readonly podcastEpisodes: ReturnType<typeof usePodcastEpisodeCommands>["commands"];
  readonly admissions: ReturnType<typeof useMediaAdmissions>;
  readonly mediaContinuations: ReturnType<typeof useMediaContinuationOwner>;
  readonly observeChatCommand: ReturnType<typeof useChatCommandFeedback>["observe"];
  readonly podcastLibraryCreation: ReturnType<typeof useDestinationCreation>;
  readonly overlays: { readonly open: (overlay: Overlay, options?: { anchor: ReturnFocusTarget; returnFocusFallback: ReturnFocusTarget }) => void };
}

/** Server-only commands are fenced at invocation, including after confirmation.
 * Player/queue/download and authored journal operations retain their own policies. */
const REMOTE_ACTIONS: ReadonlySet<string> = new Set<ActionId>([
  "Metadata", "MarkCollectionFinished", "MarkCollectionUnread", "AddUnfinishedToLectern", "TranscribePodcastEpisodes", "LeaveLibrary", "Consumption", "ResetProgress", "LibraryPlacement", "LecternMembership",
  "SubscribePodcast", "UnsubscribePodcast", "PodcastLibraries", "ImportPodcastEpisodes", "RemovePodcastEpisodes",
  "RefreshPodcast", "Chat", "Share", "DownloadOriginal",
  "RetrySource", "RepairSource", "RepairSearch", "RefreshSource", "RetryUpload", "RetryMetadata",
  "ReviewMetadataResult", "LibrarySettings", "PodcastSettings", "RemoveUpload",
  "RemoveMedia", "DeleteLibrary", "DeleteConversation", "RerunMessage", "RegenerateMessage",
]);
export function resourceActionRequiresRemote(id: string, tracked = true): boolean {
  return REMOTE_ACTIONS.has(id.startsWith("View.") ? id.split(".")[1] : id) || id === "Transcript" && tracked;
}

interface Runtime {
  readonly ctx: ActionContext;
  readonly run: (command: ActionCommand) => void;
  readonly busy: BusyKeys;
  readonly defect: { error: unknown } | null;
  readonly overlayPresentation: ReactNode;
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

/** Render action overlays below workspace containment while retained commands survive. */
export function ResourceActionPresentation() {
  const { ctx, defect, overlayPresentation } = useActionRuntime();
  const failure = defect ?? ctx.lectern.defect;
  if (failure !== null) throw failure.error;
  return overlayPresentation;
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
  const connectivity = useConnectivity();
  const admission = useRemoteAdmission();
  const online = installedApp ? admission === "Ready" : connectivity === "Online";
  const { openShare } = useShareController();
  const { openLibraryPlacement } = useLibraryPlacementController();
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const consumption = useConsumptionCommands(setDefect);
  const admissions = useMediaAdmissions();
  const { observe: observeChatCommand, feedback: chatCommandFeedback } = useChatCommandFeedback();
  const [busy] = useState(createBusyKeys);
  const [attempts] = useState(() => new Map<string, { failure: FeedbackOffer | null }>());
  useLayoutEffect(() => () => {
    for (const attempt of attempts.values()) attempt.failure?.withdraw();
    attempts.clear();
  }, [attempts]);
  const [confirmation, setConfirmation] = useState<ActionCommand | null>(null);
  const podcastEpisodes = usePodcastEpisodeCommands(accountId, setDefect);
  const podcasts = usePodcastCommands(accountId, setDefect);
  const podcastSettings = usePodcastSettingsOwner(accountId, setDefect);
  const [destinationCreation] = useState(createDestinationCreation);
  const podcastLibraryCreation = useDestinationCreation(`podcast-libraries:${accountId}`, destinationCreation);
  const workGuard = useWorkGuard();
  useLayoutEffect(() => workGuard.register({ id: "podcast-library-creation", scope: { kind: "account" },
    subscribe: destinationCreation.subscribe,
    read: () => ({ changed: false, unconfirmed: destinationCreation.readUnconfirmed(), stopsBrowserWork: false }),
  }), [workGuard, destinationCreation]);
  useWorkspaceCondition("podcast-library-creation", !podcastLibraryCreation.status && podcastLibraryCreation.error === null ? null : {
    priority: "Write", announcement: "Polite", needsAttention: podcastLibraryCreation.error !== null,
    content: podcastLibraryCreation.error?.content ?? { tone: "Neutral", title: podcastLibraryCreation.status ?? "creating library…" },
    actions: podcastLibraryCreation.error?.retry ? [{ label: "retry library creation", onClick: podcastLibraryCreation.error.retry,
      busy: podcastLibraryCreation.error.busy, commandKey: podcastLibraryCreation.error.commandKey }] : undefined,
  });
  const [overlay, setOverlay] = useState<
    (Overlay & { key: number; open: boolean; anchor: ReturnFocusTarget; focusFallback: ReturnFocusTarget }) | null
  >(null);

  // One overlay at a time; the metadata overlay closes through its exit.
  const open = useCallback((next: Overlay, options?: { anchor: ReturnFocusTarget; returnFocusFallback: ReturnFocusTarget }) => {
    const opener =
      options !== undefined ? null : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const section = opener?.closest<HTMLElement>("section[tabindex]") ?? null;
    const paneId = opener?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId ?? null;
    const anchor = options?.anchor ?? (() => opener);
    const focusFallback = options?.returnFocusFallback ?? (() => section?.isConnected ? section : findPaneLandmarkFocusTarget(paneId));
    setOverlay((current) =>
      current?.open
        ? current
        : { ...next, key: (current?.key ?? 0) + 1, open: true, anchor, focusFallback },
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
      player: { queue: playerSession.queue, state: playerSession.state, pendingPlayback: playerSession.pendingPlayback, commands: playerCommands },
      workspace,
      sessionSignal: () => session.controller.signal,
      feedback,
      reportDefect: setDefect,
      openShare,
      openLibraryPlacement,
      consumption: consumption.commands,
      consumptionUndoItems: consumption.undoItems,
      admissions,
      podcastEpisodes: podcastEpisodes.commands,
      podcasts: podcasts.commands,
      podcastSettings: podcastSettings.commands,
      mediaContinuations,
      observeChatCommand,
      podcastLibraryCreation,
      overlays: { open },
    }),
    [
      accountId,
      online,
      offlineSnapshot,
      lectern,
      playerSession.queue,
      playerSession.state,
      playerSession.pendingPlayback,
      playerCommands,
      workspace,
      session,
      feedback,
      openShare,
      openLibraryPlacement,
      consumption.commands,
      consumption.undoItems,
      admissions,
      podcastEpisodes.commands,
      podcasts.commands,
      podcastSettings.commands,
      mediaContinuations,
      observeChatCommand,
      podcastLibraryCreation,
      open,
    ],
  );

  const run: (command: ActionCommand) => void = useCallback(
    (command: ActionCommand) => {
      const signal = session.controller.signal;
      if (signal.aborted) return;
      const key = `${command.ref}|${command.id}`;
      if (installedApp && !remoteReady() && resourceActionRequiresRemote(command.id, command.tracked)) {
        const attempt: { failure: FeedbackOffer | null } = { failure: null };
        attempts.set(key, attempt);
        attempt.failure = feedback.offer({ key: `resource-action:${command.ref}:${command.id}`, announcement: "Polite", needsAttention: true, undo: null,
          onDismiss: () => { if (attempts.get(key) === attempt) attempts.delete(key); }, content: { tone: "Neutral", title: "requires a connection" } });
        return;
      }
      if (command.tracked && busy.keys().has(key)) return;
      if (command.confirmation) {
        setConfirmation(command);
        return;
      }
      if (command.tracked) busy.set(key, true);
      // Admission and confirmation acknowledge the old refusal before this attempt.
      attempts.get(key)?.failure?.withdraw();
      const attempt: { failure: FeedbackOffer | null } = { failure: null };
      attempts.set(key, attempt);
      const offerFailure = (content: FeedbackContent, actions?: FeedbackActions) => {
        if (!signal.aborted && attempts.get(key) === attempt) attempt.failure = feedback.offer({
          key: `resource-action:${command.ref}:${command.id}`, content, actions,
          announcement: "Polite", needsAttention: true, undo: null,
          onDismiss: () => { if (attempts.get(key) === attempt) attempts.delete(key); },
        });
      };
      void (async () => {
        try {
          await command.execute();
        } catch (error) {
          if (signal.aborted || attempts.get(key) !== attempt) return;
          if (error instanceof ResourceActionFailure) {
            offerFailure(error.content);
            return;
          }
          if (error instanceof QueueCommandError) {
            offerFailure({ tone: "Warning", title: error.message });
            return;
          }
          if (error instanceof ProgressPreparationError) {
            offerFailure({ tone: "Warning", title: "progress couldn’t be saved", message: "this attempt did not send the state change. resolve the player or reader save before trying again." });
            return;
          }
          if (handleUnauthenticatedApiError(error)) return;
          if (!isApiError(error) || isSameSystemApiDefect(error))
            return setDefect({ error });
          offerFailure(actionFailure(command.id, command.label, error),
            command.id === "Playback" ? [{ label: "retry playback", onClick: () => run(command) }] : undefined);
        } finally {
          if (command.tracked) busy.set(key, false);
          if (attempts.get(key) === attempt && attempt.failure === null) attempts.delete(key);
        }
      })();
    },
    [attempts, busy, feedback, session],
  );
  const runtime = useMemo(() => ({
    ctx, run, busy, defect,
    overlayPresentation: <ResourceOverlays overlay={overlay} close={close} />,
  }), [ctx, run, busy, defect, overlay, close]);

  return (
    <RuntimeContext.Provider value={runtime}>
      {children}
      {chatCommandFeedback}
      {consumption.feedback}
      <Dialog open={confirmation !== null} title={confirmation?.confirmation?.title ?? "confirm change"} onClose={() => setConfirmation(null)}>
        {confirmation?.confirmation ? <>
          <p>{confirmation.confirmation.body.replaceAll("{title}", () => confirmation.title)}</p>
          <Button emphasis="strong" tone="danger" onClick={() => {
            const command = confirmation;
            setConfirmation(null);
            run({ ...command, confirmation: null });
          }}>{confirmation.label}</Button>{" "}
          <Button onClick={() => setConfirmation(null)}>cancel</Button>
        </> : null}
      </Dialog>
      {podcastEpisodes.feedback}
      {podcasts.feedback}
      {podcastSettings.feedback}
    </RuntimeContext.Provider>
  );
}
