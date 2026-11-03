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
  Hold,
  useOutcome,
  useResendFeedback,
  type Outcome,
} from "@/components/feedback/Feedback";
import type { Line, Retract } from "@/components/feedback/stage";
import { createDestinationCreation, useDestinationCreation } from "@/components/libraries/useDestinationCreation";
import { useWorkGuard } from "@/lib/unsavedWork";
import type { MetadataSubject } from "./subjects";
import type { CollectionSelection, CollectionTarget } from "@/lib/consumption/api";
import type { EpisodeState } from "@/lib/podcasts/api";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { useMediaContinuationOwner } from "@/lib/actions/mediaContinuation";
import { actionOutcome, type ActionId } from "@/lib/actions/catalog";
import {
  ResourceActionFailure,
  ResourceActionUnknown,
  type ActionCommand,
} from "@/lib/actions/project";
import { ResourceOverlays } from "@/lib/actions/ResourceOverlays";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { ProgressPreparationError, PROGRESS_PREPARATION_FACT } from "@/lib/consumption/progressFence";
import { useConsumptionCommands } from "@/lib/consumption/state";
import { useMediaAdmissions } from "@/lib/media/admissions";
import { setChatCommandAccount } from "@/lib/chat/commands";
import { useConversationCreationOwner, type ConversationCreationInput } from "@/lib/chat/conversationIndex";
import { useChatCommandFeedback } from "@/lib/chat/commandFeedback";
import {
  useLectern,
  useLecternCommands,
} from "@/lib/lectern/lectern";
import type { LecternItem } from "@/lib/lectern/api";
import { useLibraryPlacementController } from "@/lib/libraries/placementController";
import {
  localContentAvailable,
  useLocalContent,
  type LocalItem,
} from "@/lib/offline/localContent";
import {
  usePlayerCommands,
  usePlayerSession,
} from "@/lib/player/playerRuntime";
import { ReaderSettingsFailure } from "@/lib/reader/ReaderContext";
import { usePodcastSettingsOwner } from "@/lib/podcasts/usePodcastSettingsSave";
import { usePodcastCommands } from "@/lib/podcasts/commands";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import type { PodcastTarget } from "@/lib/podcasts/api";
import { usePodcastEpisodeCommands } from "@/lib/podcasts/episodeCommands";
import { installedApp, subscribeAdmission, updateRemedy, type UpdateRemedy } from "@/lib/native/admission";
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
  | { readonly kind: "RemoveEpisodeFromAll"; readonly mediaId: string; readonly title: string }
  | { readonly kind: "UnsubscribePodcast"; readonly podcastId: string; readonly title: string; readonly libraryId: string | null; readonly successFocus?: ReturnFocusTarget }
  | { readonly kind: "RemovePodcastEpisodes"; readonly podcastId: string; readonly title: string };

/** Everything a verb reads or calls; it changes only when one of those facts does. */
export interface ActionContext {
  /** Whether this account's action owner is still mounted. */
  readonly isActive: () => boolean;
  readonly accountId: string;
  readonly online: boolean;
  /** What can replace a stale build now: a stale verb offers reload only under `Reload`. */
  readonly remedy: UpdateRemedy;
  readonly offline:
    | { readonly kind: "Unavailable" | "Loading" }
    | { readonly kind: "Ready"; readonly items: readonly LocalItem[] };
  /** Shared lectern facts and the existing conditional-command owner. */
  readonly lectern: {
    readonly read: ReturnType<typeof useLectern>;
    readonly itemsById: ReadonlyMap<string, LecternItem>;
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
  /** Results and chat outcomes after the invoker leaves. A verb's own failures are `run`'s,
   * spoken where it was invoked. */
  readonly feedback: Outcome;
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
  readonly createConversationAbout: (input: ConversationCreationInput) => Promise<void>;
  readonly observeChatCommand: ReturnType<typeof useChatCommandFeedback>["observe"];
  readonly podcastLibraryCreation: ReturnType<typeof useDestinationCreation>;
  readonly overlays: { readonly open: (overlay: Overlay, options?: { anchor: ReturnFocusTarget; returnFocusFallback: ReturnFocusTarget }) => void };
}

/** Server-only commands are fenced at invocation, including after confirmation.
 * Player/queue/download and live writing operations retain their own policies. */
const REMOTE_ACTIONS: ReadonlySet<string> = new Set<ActionId>([
  "Metadata", "MarkCollectionFinished", "MarkCollectionUnread", "AddUnfinishedToLectern", "TranscribePodcastEpisodes", "LeaveLibrary", "Consumption", "ResetProgress", "LibraryPlacement", "LecternMembership",
  "SubscribePodcast", "UnsubscribePodcast", "PodcastLibraries", "AddEpisodeToAll", "RemoveEpisodeFromAll", "RemovePodcastEpisodes",
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
  /** Runs a verb and reports its failure through `outcome`, the invoker's, so a row carries the
   * invoking pane's address. */
  readonly run: (command: ActionCommand, outcome: Outcome) => void;
  readonly busy: BusyKeys;
  readonly defect: { error: unknown } | null;
  readonly overlayPresentation: ReactNode;
  readonly retainedFeedback: ReactNode;
}

interface BusyKeys {
  readonly keys: () => ReadonlySet<string>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly set: (key: string, on: boolean) => void;
}

const RuntimeContext = createContext<Runtime | null>(null);

/** The runtime as its caller sees it: `run` speaks where the caller renders. */
export function useActionRuntime(): Omit<Runtime, "run"> & { readonly run: (command: ActionCommand) => void } {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("ResourceActionsProvider is missing");
  const outcome = useOutcome();
  const { run } = runtime;
  const invoked = useCallback((command: ActionCommand) => run(command, outcome), [run, outcome]);
  return useMemo(() => ({ ...runtime, run: invoked }), [runtime, invoked]);
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

/** One invocation owns its frozen command and any unresolved raw write. */
type Execution = {
  command: ActionCommand;
  outcome: Outcome;
  retract: Retract | null;
  phase: "Other" | "Running" | "Unknown" | "Acknowledged";
  line: Line | null;
  attempt: number;
  release(): void;
};

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
  const feedback = useOutcome();
  const resendFeedback = useResendFeedback();
  const read = useLectern();
  const commands = useLecternCommands();
  const observedItems = read.status === "ready" ? read.data.items : null;
  const itemsById = useMemo(() => new Map(observedItems?.map(item => [item.media_summary.media_id, item]) ?? []), [observedItems]);
  const lectern = useMemo(
    () => ({ read, itemsById, ...commands }),
    [read, itemsById, commands],
  );
  const playerSession = usePlayerSession();
  const playerCommands = usePlayerCommands();
  const localIndex = useLocalContent().index;
  const connectivity = useConnectivity();
  const admission = useRemoteAdmission();
  const online = installedApp ? admission === "Ready" : connectivity === "Online";
  const remedy = useSyncExternalStore(subscribeAdmission, updateRemedy, updateRemedy);
  const { openShare } = useShareController();
  const { openLibraryPlacement } = useLibraryPlacementController();
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const consumption = useConsumptionCommands(setDefect);
  const admissions = useMediaAdmissions();
  const { observe: observeChatCommand, feedback: chatCommandFeedback } = useChatCommandFeedback();
  const [busy] = useState(createBusyKeys);
  const busyKeys = useSyncExternalStore(busy.subscribe, busy.keys, busy.keys);
  const [attempts] = useState(() => new Map<string, Execution>());
  // Native receipt uncertainty is durable device work, outside remote write admission/guards.
  const [localUnknown, setLocalUnknown] = useState<ReadonlyMap<string, { readonly line: Line; readonly attempt: number }>>(new Map());
  useLayoutEffect(() => () => { for (const attempt of attempts.values()) attempt.release(); }, [attempts]);
  const [confirmation, setConfirmation] = useState<{ readonly command: ActionCommand; readonly outcome: Outcome } | null>(null);
  const podcastEpisodes = usePodcastEpisodeCommands(accountId, setDefect);
  const podcasts = usePodcastCommands(accountId, setDefect);
  const podcastSettings = usePodcastSettingsOwner(accountId, setDefect);
  const conversationCreation = useConversationCreationOwner(accountId);
  const [destinationCreation] = useState(createDestinationCreation);
  const podcastLibraryCreation = useDestinationCreation(`podcast-libraries:${accountId}`, destinationCreation);
  const workGuard = useWorkGuard();
  useLayoutEffect(() => workGuard.register({ id: "podcast-library-creation", scope: { kind: "account" },
    subscribe: destinationCreation.subscribe,
    read: () => ({ changed: false, unconfirmed: destinationCreation.readUnconfirmed(), stopsBrowserWork: false }),
  }), [workGuard, destinationCreation]);
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
    lectern, podcasts: podcasts.commands, reportDefect: setDefect, workspace,
  });
  const ctx = useMemo(
    (): ActionContext => ({
      isActive: () => !session.controller.signal.aborted,
      accountId,
      online,
      remedy,
      offline: !localContentAvailable
        ? { kind: "Unavailable" }
        : localIndex === null
          ? { kind: "Loading" }
          : { kind: "Ready", items: localIndex.items },
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
      createConversationAbout: conversationCreation.create,
      podcastLibraryCreation,
      overlays: { open },
    }),
    [
      accountId,
      online,
      remedy,
      localIndex,
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
      conversationCreation.create,
      mediaContinuations,
      observeChatCommand,
      podcastLibraryCreation,
      open,
    ],
  );

  const run: Runtime["run"] = useCallback(
    (command, outcome) => {
      const signal = session.controller.signal;
      if (signal.aborted) return;
      const key = `${command.ref}|${command.id}`;
      const workId = `resource-action:${key}`;
      const previous = attempts.get(key);
      if (previous?.phase === "Running" || command.tracked && busy.keys().has(key)) return;
      if (command.confirmation) {
        setConfirmation({ command, outcome });
        return;
      }
      const same = previous?.command === command;
      if (previous && previous.line !== null && !same &&
        !workGuard.confirmLoss({ scopes: [], ownerIds: [workId] })) return;
      previous?.retract?.();
      const attempt: Execution = {
        command, outcome, retract: null, phase: command.rawWrite ? "Running" : "Other",
        line: same ? previous!.line : null, attempt: same ? previous!.attempt : -1, release: () => {},
      };
      attempts.set(key, attempt);
      if (command.rawWrite) {
        attempt.release = workGuard.register({ id: workId, scope: { kind: "account" }, subscribe: busy.subscribe,
          read: () => ({ changed: false, unconfirmed: attempt.phase === "Running" || attempt.line !== null, stopsBrowserWork: false }),
        });
      }
      previous?.release();
      if (command.tracked || command.rawWrite || previous?.line) busy.set(key, command.tracked || command.rawWrite === true);
      const named = `“${command.label.replace(/…$/, "")}”`;
      const fact = `couldn’t complete ${named}.`;
      const report = (raise: () => Retract) => {
        if (!signal.aborted && attempts.get(key) === attempt) attempt.retract = raise();
      };
      void (async () => {
        try {
          await command.execute(() => {
            if (!command.rawWrite || signal.aborted || attempts.get(key) !== attempt) return;
            attempt.phase = "Acknowledged";
            attempt.line = null;
            busy.set(key, command.tracked);
          });
          if (!signal.aborted && attempts.get(key) === attempt && !command.rawWrite) setLocalUnknown(current => {
            if (!current.has(key)) return current;
            const next = new Map(current); next.delete(key); return next;
          });
        } catch (error) {
          if (signal.aborted || attempts.get(key) !== attempt) return;
          const replay = attempt.line !== null;
          if (replay) attempt.attempt += 1;
          if (error instanceof ResourceActionFailure) return report(() => outcome.say(error.line));
          if (error instanceof ResourceActionUnknown) {
            setLocalUnknown(current => new Map(current).set(key, { line: error.line, attempt: (current.get(key)?.attempt ?? -1) + 1 }));
            return;
          }
          if (error instanceof ProgressPreparationError) return report(() => outcome.say({ fact: PROGRESS_PREPARATION_FACT }));
          if (handleUnauthenticatedApiError(error)) return;
          if (!isApiError(error) || isSameSystemApiDefect(error)) return setDefect({ error });
          const failure = actionOutcome(command.id, command.label, command.title, error, command.rawWrite === true && attempt.phase !== "Acknowledged");
          if (failure.kind === "Unknown") {
            attempt.phase = "Unknown";
            if (attempt.line === null) { attempt.line = failure.line; attempt.attempt = 0; }
            return;
          }
          if (replay) return report(() => outcome.say({ fact: `couldn’t retry ${named}.` }));
          const retry = { label: "retry", commandKey: `retry ${key}`, run: () => run(command, outcome) };
          switch (failure.kind) {
            case "Domain": return report(() => outcome.say(failure.line, failure.retry ? [retry] : undefined));
            case "Transport": return report(() => outcome.fail(error, failure.fact, failure.retry ? retry : undefined));
          }
        } finally {
          if (attempt.phase === "Running") attempt.phase = attempt.line === null ? "Other" : "Unknown";
          if (command.tracked || command.rawWrite || previous?.line) busy.set(key, false);
          if (attempts.get(key) === attempt && attempt.line === null) {
            attempt.release();
            if (attempt.retract === null) attempts.delete(key);
          }
        }
      })();
    },
    [attempts, busy, session, workGuard],
  );
  const consumptionReviewKey = overlay?.kind === "CollectionConsumption"
    ? consumption.commands.pendingCollection(overlay.selection.kind === "Podcast"
      ? { kind: "Podcast", podcast_id: overlay.selection.podcast_id } : overlay.selection)?.commandKey : undefined;
  const lecternReview = overlay?.kind === "CollectionLectern" && lectern.collectionPending !== null &&
    (overlay.target.kind === "Library" && lectern.collectionPending.target.kind === "Library"
      ? overlay.target.library_id === lectern.collectionPending.target.library_id
      : overlay.target.kind === "Podcast" && lectern.collectionPending.target.kind === "Podcast" &&
        overlay.target.podcast_id === lectern.collectionPending.target.podcast_id);
  const runtime = useMemo(() => ({
    ctx, run, busy, defect,
    overlayPresentation: <ResourceOverlays overlay={overlay} close={close} />,
    retainedFeedback: <>{[...localUnknown].map(([key, held]) => <Hold key={key} id={key} attempt={held.attempt} line={held.line} />)}
      {[...attempts].filter(([, attempt]) => attempt.line !== null).map(([key, attempt]) => <Hold key={key} id={key} attempt={attempt.attempt}
        {...resendFeedback({ line: attempt.line!, resend: { label: "retry", commandKey: `retry ${key}`, busy: busyKeys.has(key),
          run: () => {
            if (attempts.get(key) === attempt && attempt.line !== null) run(attempt.command, attempt.outcome);
          } } })} />)}
      {chatCommandFeedback}{podcastSettings.feedback}{podcasts.feedback}{podcastEpisodes.feedback}{conversationCreation.feedback}
      {consumption.collectionFailures.filter(failure => failure.key !== consumptionReviewKey).map(failure =>
        <Hold key={failure.key} id={failure.key} attempt={failure.attempt} line={failure.line} verbs={failure.verbs} />)}
      {lectern.collectionFailure && !lecternReview ? <Hold id={lectern.collectionFailure.key} attempt={lectern.collectionFailure.attempt}
        line={lectern.collectionFailure.line} verbs={lectern.collectionFailure.verbs} /> : null}
      {podcastLibraryCreation.holds}</>,
  }), [ctx, run, busy, defect, overlay, close, localUnknown, attempts, busyKeys, chatCommandFeedback, podcastSettings.feedback, podcasts.feedback, podcastEpisodes.feedback, conversationCreation.feedback, consumption.collectionFailures, lectern.collectionFailure, consumptionReviewKey, lecternReview, podcastLibraryCreation.holds, resendFeedback]);

  return (
    <RuntimeContext.Provider value={runtime}>
      {children}
      <Dialog open={confirmation !== null} title={confirmation?.command.confirmation?.title ?? "confirm change"}
        returnFocusFallback={confirmation?.command.afterRemoval} onClose={() => setConfirmation(null)}>
        {confirmation?.command.confirmation ? <>
          <p>{confirmation.command.confirmation.body.replaceAll("{title}", () => confirmation.command.title)}</p>
          <Button emphasis="strong" tone="danger" onClick={() => {
            const { command, outcome } = confirmation;
            setConfirmation(null);
            run({ ...command, confirmation: null }, outcome);
          }}>{confirmation.command.label}</Button>{" "}
          <Button onClick={() => setConfirmation(null)}>cancel</Button>
        </> : null}
      </Dialog>
    </RuntimeContext.Provider>
  );
}

/** Account command owners' standing reports, mounted once, at the workspace. */
export function RetainedActionFeedback() {
  return <>{useActionRuntime().retainedFeedback}<ReaderSettingsFailure /></>;
}
