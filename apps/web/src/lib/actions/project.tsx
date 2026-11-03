import type { Line } from "@/components/feedback/stage";
import { parseResourceRef, type ResourceRef } from "@/lib/resourceGraph/resourceRef";
import { assertNever } from "@/lib/assertNever";
import { installedApp, remoteAdmission, remoteReady } from "@/lib/native/admission";
import { createElement, type ReactElement } from "react";
import type { PodcastActionFacts, PodcastActionFocus } from "./inlineActions";
import PodcastSubscriptionIcon from "@/components/podcasts/PodcastSubscriptionIcon";
import type { MetadataSubject } from "./subjects";
import type { CollectionSelection, CollectionTarget } from "@/lib/consumption/api";
import type { EpisodeState } from "@/lib/podcasts/api";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import type { PodcastTarget } from "@/lib/podcasts/api";
import { Minus, Undo2, type LucideIcon } from "lucide-react";
import {
  ACTION_CATALOG,
  admissionReason,
  BLOCKED_COPY,
  type ActionId,
  type BlockedReason,
  type Confirmation,
} from "@/lib/actions/catalog";
import type {
  ActionContext,
  Overlay,
} from "@/lib/actions/ResourceActionsProvider";
import { settleDeletedResourcePanes } from "@/lib/actions/settleDeletedResource";
import { apiFetch, isStaleBuild } from "@/lib/api/client";
import { admissionReason as currentAdmissionReason, staleBuild, UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import type { ApiJson, Schema } from "@/lib/api/wire";
import {
  openConversationAbout,
  deleteConversation,
} from "@/lib/chat/conversationIndex";
import { getConversationCommands, readConversationTree, repeatMessage, sayRefusal, type CommandOutcome } from "@/lib/chat/commands";
import { conversationViewHref } from "@/lib/chat/view";
import { publishImportsInvalidation, recoverMedia } from "@/lib/imports/api";
import { lecternFull } from "@/lib/lectern/lectern";
import { deleteLibrary, leaveLibrary, placements } from "@/lib/libraries/api";
import { deleteMedia } from "@/lib/media/mediaLibraries";
import {
  metadataResearchLabel,
  metadataRetryBlockedCopy,
} from "@/lib/media/mediaMetadataCopy";
import {
  submitMetadataResultReview,
} from "@/lib/media/mediaMetadataOperations";
import { deletePage } from "@/lib/notes/api";
import { getWritingRuntime } from "@/lib/notes/runtime";
import { LocalMutationObservationError, localMutation, type LocalItem } from "@/lib/offline/localContent";
import type { PlaybackSource } from "./playbackSource";
import { queueBlock, type PlayerDescriptor } from "@/lib/player/playerRuntime";
import {
  requestPodcastRefresh,
} from "@/lib/podcasts/api";
import { activateResource } from "@/lib/resources/activation";
import { resourceShareTarget } from "@/lib/sharing/targets";
import { anchoredShareOpenOptions } from "@/lib/sharing/openOptions";
import type {
  ActionDescriptor,
  ActionSelectDetail,
} from "@/lib/ui/actionDescriptor";
import { openAsyncResult } from "@/lib/panes/openResult";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import {
  findPaneChromeFocusTarget,
  findPaneLandmarkFocusTarget,
} from "@/lib/workspace/paneDom";
import type {
  WorkspacePaneEntry,
  WorkspaceTargetActivationRequest,
} from "@/lib/workspace/targetActivation";

export type ResourceActions = Schema<"ResourceActionsOut">;
type Action = ResourceActions["actions"][number];
type DirectKind = Exclude<Schema<"SimpleAction">["kind"], "SubscribePodcast" | "UnsubscribePodcast" | "PodcastLibraries" | "AddUnfinishedToLectern" | "MarkCollectionFinished" | "MarkCollectionUnread" | "TranscribePodcastEpisodes">;

/** One chosen verb. The provider confirms it, tracks it busy and reports failure. */
export interface ActionCommand {
  readonly ref: string;
  readonly id: ActionId;
  readonly label: string;
  /** The resource's label, for `{title}` in the confirmation. */
  readonly title: string;
  readonly confirmation: Confirmation | null;
  /** A removal confirmation falls back here only when its opener disappeared. */
  readonly afterRemoval?: ReturnFocusTarget;
  /** Opening an overlay, navigating or handing a pane an entry is untracked. */
  readonly tracked: boolean;
  /** A raw, repeatable remote write whose outcome this execution owner retains. */
  readonly rawWrite?: true;
  /** Only an accepted raw write calls this, before later reads or navigation. Void proves nothing. */
  readonly execute: (acknowledged: () => void) => unknown;
}

/** A modeled local refusal, in its owner's words; the runtime says it where the verb was invoked. */
export class ResourceActionFailure extends Error {
  constructor(readonly line: Line) { super(line.fact); }
}

/** The native command left without a receipt; only its surviving account owner holds it. */
export class ResourceActionUnknown extends Error {
  constructor(readonly line: Line) { super(line.fact); }
}

interface Options {
  readonly state?: { readonly label: string; readonly icon: LucideIcon };
  /** A client fact blocking the verb; the server's reason wins. */
  readonly blocked?: BlockedReason;
  /** Copy that explains a block better than the generic reason. */
  readonly disabledReason?: string;
  /** That copy names a wait, for a screen reader alone. */
  readonly waiting?: boolean;
  readonly confirmation?: Confirmation | null;
  readonly tracked?: boolean;
  readonly afterRemoval?: ReturnFocusTarget;
  readonly rawWrite?: true;
}
type Verb = readonly [
  execute: (detail: ActionSelectDetail, acknowledged: () => void) => unknown,
  options?: Options,
];

/** Unknown membership cannot choose a write. Retained intent wins over a fresh choice. */
export function projectLecternAction({
  mediaId, title, intent, blocked, ctx, busy, run,
}: {
  readonly mediaId: string;
  readonly title: string;
  readonly intent: "Ensure" | "Remove" | null;
  readonly blocked: BlockedReason | null;
  readonly ctx: ActionContext;
  readonly busy: ReadonlySet<ActionId>;
  readonly run: (command: ActionCommand) => void;
}): Extract<ActionDescriptor, { kind: "command" }> & { readonly icon: ReactElement } {
  const request = ctx.lectern.pending.get(mediaId);
  const { read, revision, collectionPending } = ctx.lectern;
  const currentIntent = request?.intent.kind ?? intent ?? "Ensure";
  const needsRead = intent === null || revision === null;
  const disconnected = installedApp && !ctx.online;
  const retry = !disconnected && !request && collectionPending === null && blocked === null && !busy.has("LecternMembership") && needsRead && read.status === "failed";
  const state = ACTION_CATALOG.LecternMembership.states[currentIntent === "Ensure" ? "Absent" : "Present"];
  const label = request
    ? "retry"
    : disconnected ? "Lectern"
    : collectionPending !== null ? state.label
    : retry ? "Retry checking Lectern"
    : needsRead && blocked === null ? "Checking Lectern" : state.label;
  let disabledReason: string | undefined;
  let waiting = false;
  const wait = (reason: string) => { disabledReason = reason; waiting = true; };
  if (request && !remoteReady()) {
    disabledReason = currentAdmissionReason() ?? "checking your session.";
    waiting = remoteAdmission() === "Checking";
  } else if (disconnected) disabledReason = admissionReason();
  else if (request && request.phase !== "Unconfirmed") wait("a lectern change is in progress.");
  else if (busy.has("LecternMembership")) wait(BLOCKED_COPY.Busy);
  else if (!request) {
    if (blocked !== null) disabledReason = BLOCKED_COPY[blocked];
    else if (collectionPending?.phase === "Unconfirmed") disabledReason = "not sure an earlier lectern change saved.";
    else if (collectionPending !== null) wait("a lectern change is in progress.");
    else if (retry) disabledReason = "couldn’t load the lectern.";
    else if (needsRead) wait("checking the lectern.");
    else if (intent === "Ensure" && lecternFull(read)) disabledReason = BLOCKED_COPY.CapacityReached;
  }
  return {
    kind: "command",
    id: "LecternMembership",
    label,
    icon: createElement(state.icon, { size: 16, "aria-hidden": true }),
    disabled: retry ? read.retrying || undefined : disabledReason !== undefined || undefined,
    disabledReason,
    waiting: waiting || undefined,
    onSelect: () => {
      if (installedApp && !remoteReady()) return;
      if (retry) { if (!read.retrying) read.refetch(); return; }
      if (disabledReason !== undefined || (!request && intent === null)) return;
      run({
        ref: `media:${mediaId}`,
        id: "LecternMembership",
        label,
        title,
        confirmation: null,
        tracked: true,
        execute: () => request
          ? request.check()
          : intent === "Ensure"
            ? ctx.lectern.ensure({ mediaId, title })
            : ctx.lectern.remove({ mediaId, title }),
      });
    },
  };
}

/** The header and menu share one playback action; its descriptor is already owned by the caller. */
export function projectPlaybackAction({ mediaId, title, descriptor, blocked, playbackSource, ctx, run }: {
  readonly mediaId: string;
  readonly title: string;
  readonly descriptor: PlayerDescriptor | null;
  readonly blocked: BlockedReason | null;
  readonly playbackSource: PlaybackSource | null;
  readonly ctx: ActionContext;
  readonly run: (command: ActionCommand) => void;
}): Extract<ActionDescriptor, { kind: "command" }> & { readonly icon: ReactElement } {
  const player = ctx.player.state;
  const loaded = player.kind === "Loaded" && player.source.kind === "Episode" &&
    player.source.descriptor.media_id === mediaId;
  const pending = ctx.player.pendingPlayback?.kind === "Episode" && ctx.player.pendingPlayback.mediaId === mediaId;
  const phase = pending ? "Buffering" : loaded ? player.phase : "Idle";
  const pausing = phase === "Playing" || phase === "Buffering";
  const state = ACTION_CATALOG.Playback.states[phase];
  // Native plays a ready download from its own package; nothing remote gates that start.
  const downloaded = ctx.offline.kind === "Ready" && ctx.offline.items.some(item =>
    item.media_id === mediaId && item.kind === "podcast_episode" && item.state === "Ready" && item.package_id !== null);
  const needsRemote = installedApp && !loaded && !pending && !downloaded && descriptor === null;
  const disabledReason = blocked !== null ? BLOCKED_COPY[blocked]
    : player.kind === "Unavailable" && player.reason === "UpdateRequired" ? staleBuild()
    : needsRemote && !ctx.online ? admissionReason() : undefined;
  return {
    kind: "command", id: "Playback", label: state.label,
    icon: createElement(state.icon, { size: 16, "aria-hidden": true }),
    disabled: disabledReason !== undefined || undefined, disabledReason,
    onSelect: () => {
      if (needsRemote && !remoteReady()) return;
      run({
        ref: `media:${mediaId}`, id: "Playback", label: state.label, title,
        confirmation: null, tracked: false,
        execute: () => pausing ? ctx.player.commands.pause() :
          ctx.player.commands.playAudio({ mediaId, knownDescriptor: descriptor, positionMs: null, source: playbackSource === null ? null : () => playbackSource(mediaId), recapture: false }),
      });
    },
  };
}

function invocationFocus(trigger: HTMLElement | null, returnFocus?: ReturnFocusTarget) {
  const paneId = trigger?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId ?? null;
  return { anchor: () => trigger, returnFocusFallback: returnFocus ?? (() => findPaneLandmarkFocusTarget(paneId)) };
}

function metadataSubject(parsed: ResourceRef): MetadataSubject {
  switch (parsed.scheme) {
    case "media": return { kind: "Media", mediaId: parsed.id };
    case "podcast": return { kind: "Podcast", podcastId: parsed.id };
    case "library": return { kind: "Library", libraryId: parsed.id };
    case "evidence_span": case "content_chunk": case "highlight": case "page": case "note_block":
    case "fragment": case "conversation": case "message": case "oracle_reading": case "oracle_passage_anchor":
    case "external_snapshot": case "contributor":
    case "reader_apparatus_item": case "passage_anchor": throw new Error(`metadata has no subject for ${parsed.scheme}`);
    default: return assertNever(parsed.scheme);
  }
}

function collectionTarget(resource: ResourceRef): CollectionTarget {
  if (resource.scheme === "podcast") return { kind: "Podcast", podcast_id: resource.id };
  if (resource.scheme === "library") return { kind: "Library", library_id: resource.id };
  throw new Error(`collection action has no target for ${resource.scheme}`);
}

/** Whole and explicit filtered selections open the same reviewed account command. */
export function projectCollectionConsumptionAction({ selection, desiredState, title, blocked, ctx, run, returnFocus }: {
  selection: CollectionSelection; desiredState: "finished" | "unread"; title: string; blocked: BlockedReason | null;
  ctx: ActionContext; run(command: ActionCommand): void; returnFocus?: ReturnFocusTarget;
}): Extract<ActionDescriptor, { kind: "command" }> {
  const id = desiredState === "finished" ? "MarkCollectionFinished" : "MarkCollectionUnread";
  const entry = ACTION_CATALOG[id];
  const status = selection.kind === "Podcast" ? desiredState === "finished" ? "played" : "unplayed" : desiredState;
  const label = selection.kind === "Podcast" && selection.state !== "all"
    ? `Mark ${selection.state.replaceAll("_", " ")} episodes as ${status}…`
    : `Mark all ${status}…`;
  return { kind: "command", id: selection.kind === "Podcast" && selection.state !== "all" ? `View.${id}.${selection.state}` : id, label, icon: createElement(entry.icon, { size: 16, "aria-hidden": true }),
    disabled: blocked !== null || undefined, disabledReason: blocked === null ? undefined : BLOCKED_COPY[blocked],
    onSelect: ({ triggerEl }) => {
      if (blocked !== null) return;
      run({ ref: `collection:${JSON.stringify(selection)}`, id, label, title, confirmation: null, tracked: false,
        execute: () => ctx.overlays.open({ kind: "CollectionConsumption", selection, desiredState, title }, invocationFocus(triggerEl, returnFocus)) });
    },
  };
}

/** Transcript views retain their explicit state scope and existing admission owner. */
export function projectPodcastTranscriptAction({ podcastId, state, title, blocked, ctx, run, returnFocus }: {
  podcastId: string; state: EpisodeState; title: string; blocked: BlockedReason | null; ctx: ActionContext;
  run(command: ActionCommand): void; returnFocus?: ReturnFocusTarget;
}): Extract<ActionDescriptor, { kind: "command" }> {
  const id = "TranscribePodcastEpisodes";
  const entry = ACTION_CATALOG[id];
  const label = state === "all" ? entry.label : `Transcribe ${state.replaceAll("_", " ")} episodes…`;
  return { kind: "command", id: state === "all" ? id : `View.${id}.${state}`, label, icon: createElement(entry.icon, { size: 16, "aria-hidden": true }),
    disabled: blocked !== null || undefined, disabledReason: blocked === null ? undefined : BLOCKED_COPY[blocked],
    onSelect: ({ triggerEl }) => {
      if (blocked !== null) return;
      run({ ref: `podcast:${podcastId}`, id, label, title, confirmation: null, tracked: false,
        execute: () => ctx.overlays.open({ kind: "TranscribePodcastEpisodes", podcastId, state, title }, invocationFocus(triggerEl, returnFocus)) });
    },
  };
}

/** Supplied directory metadata and real URLs remain usable without write authority. */
export function projectPodcastDiscoveryActions({ subject, ctx, returnFocus }: {
  subject: Extract<MetadataSubject, { kind: "DiscoveryPodcast" | "DiscoveryPodcastPreview" }>;
  ctx: ActionContext; run(command: ActionCommand): void; returnFocus?: ReturnFocusTarget;
}): ActionDescriptor[] {
  const supplied = subject.kind === "DiscoveryPodcast" ? subject.candidate : subject.preview;
  const facts = supplied.kind_facts;
  const result: ActionDescriptor[] = [];
  if (facts.website_href !== null) result.push({ kind: "link", id: "OpenSource", label: ACTION_CATALOG.OpenSource.label,
    icon: createElement(ACTION_CATALOG.OpenSource.icon, { size: 16, "aria-hidden": true }), href: facts.website_href });
  result.push({ kind: "command", id: "Metadata", label: ACTION_CATALOG.Metadata.label,
    icon: createElement(ACTION_CATALOG.Metadata.icon, { size: 16, "aria-hidden": true }),
    onSelect: ({ triggerEl }) => {
      const focus = invocationFocus(triggerEl, returnFocus);
      const metadata: MetadataSubject = subject.kind === "DiscoveryPodcast" ? { kind: "DiscoveryPodcast", candidate: subject.candidate } : { kind: "DiscoveryPodcastPreview", preview: subject.preview };
      ctx.overlays.open({ kind: "Metadata", subject: metadata, returnFocusTo: triggerEl, fallback: focus.returnFocusFallback }, focus);
    },
  });
  result.push({ kind: "link", id: "OpenPodcastFeed", label: ACTION_CATALOG.OpenPodcastFeed.label,
    icon: createElement(ACTION_CATALOG.OpenPodcastFeed.icon, { size: 16, "aria-hidden": true }), href: facts.feed_href });

  return result;
}

/** observations choose the glyph; only ready facts authorize a reviewed command. */
export function projectPodcastSubscriptionAction({ target, title, facts, disabledReason, ctx, run, focus }: {
  readonly target: PodcastTarget;
  readonly title: string;
  readonly facts: PodcastActionFacts;
  readonly disabledReason: string | null;
  readonly ctx: ActionContext;
  readonly run: (command: ActionCommand) => void;
  readonly focus?: PodcastActionFocus;
}): Extract<ActionDescriptor, { kind: "command" }> & { readonly icon: ReactElement; readonly id: ActionId; readonly accessibleLabel: string } {
  let subscribed: boolean | null = null;
  let label: string;
  if (facts.kind === "Ready") {
    switch (facts.resolution.kind) {
      case "Canonical":
        target = { kind: "Canonical", podcast_id: facts.resolution.podcast_id };
        subscribed = facts.resolution.subscribed;
        label = ACTION_CATALOG[subscribed ? "UnsubscribePodcast" : "SubscribePodcast"].label;
        break;
      case "Discovery": subscribed = false; label = ACTION_CATALOG.SubscribePodcast.label; break;
      case "Unavailable":
        label = "Subscription unavailable";
        disabledReason = facts.resolution.reason === "NotFound" ? "this podcast is gone." : "this podcast link doesn’t work.";
        break;
      default: assertNever(facts.resolution);
    }
  } else {
    subscribed = facts.observedSubscribed;
    label = subscribed === null ? "Subscription status unknown" : subscribed ? "Last known subscribed" : "Last known not subscribed";
    disabledReason = facts.kind === "Failed" ? "couldn’t check the subscription." : "checking the subscription.";
  }
  const waiting = facts.kind === "Resolving" && !(installedApp && !ctx.online);
  disabledReason = installedApp && !ctx.online ? admissionReason() : disabledReason;
  const id = subscribed ? "UnsubscribePodcast" : "SubscribePodcast";
  const entry = ACTION_CATALOG[id];
  return {
    kind: "command", id, label,
    accessibleLabel: `${facts.kind === "Ready" && subscribed ? `Subscribed. ${label}` : label}: ${title}`,
    icon: createElement(PodcastSubscriptionIcon, {
      key: subscribed === null ? "Unknown" : "Known", // learning is no event: the remount skips the transition
      subscribed: subscribed === true,
    }), hasPopup: "dialog",
    disabled: disabledReason !== null || undefined, disabledReason: disabledReason ?? undefined, waiting: waiting || undefined,
    restoreFocusOnClose: false,
    onSelect: detail => {
      if (facts.kind !== "Ready" || disabledReason !== null) return;
      if (subscribed && target.kind !== "Canonical") throw new Error("a subscription requires canonical identity");
      const overlay: Overlay = subscribed && target.kind === "Canonical"
        ? { kind: "UnsubscribePodcast", podcastId: target.podcast_id, title, libraryId: null, successFocus: focus?.afterRemoval }
        : { kind: "SubscribePodcast", target, title, libraryId: null };
      const trigger = detail.triggerEl ?? focus?.trigger ?? null;
      run({ ref: `podcast:${target.kind === "Canonical" ? target.podcast_id : target.target}`, id, label: entry.label, title,
        confirmation: null, tracked: false,
        execute: () => ctx.overlays.open(overlay, focus === undefined ? undefined : { anchor: () => trigger, returnFocusFallback: focus.returnFocus }),
      });
    },
  };
}

export function projectPodcastLibrariesAction({ target, title, disabledReason, ctx, run, focus }: {
  readonly target: PodcastTarget; readonly title: string; readonly disabledReason: string | null;
  readonly ctx: ActionContext; readonly run: (command: ActionCommand) => void; readonly focus?: PodcastActionFocus;
}): Extract<ActionDescriptor, { kind: "command" }> & { readonly icon: ReactElement; readonly id: ActionId } {
  disabledReason = installedApp && !ctx.online ? admissionReason() : disabledReason;
  return {
    kind: "command", id: "PodcastLibraries", label: ACTION_CATALOG.PodcastLibraries.label,
    icon: createElement(ACTION_CATALOG.PodcastLibraries.icon, { size: 16, "aria-hidden": true }),
    disabled: disabledReason !== null || undefined, disabledReason: disabledReason ?? undefined, restoreFocusOnClose: false,
    onSelect: detail => {
      if (disabledReason !== null) return;
      const trigger = detail.triggerEl ?? focus?.trigger ?? null;
      const successFocus = focus?.afterRemoval;
      run({ ref: `podcast:${target.kind === "Canonical" ? target.podcast_id : target.target}`, id: "PodcastLibraries", label: ACTION_CATALOG.PodcastLibraries.label, title,
        confirmation: null, tracked: false,
        execute: () => ctx.overlays.open({ kind: "PodcastLibraries", target, title, successFocus },
          focus === undefined ? undefined : { anchor: () => trigger, returnFocusFallback: focus.returnFocus }),
      });
    },
  };
}

/** One named destination's removal; the existing review owns scope and acknowledgement. */
export function projectPodcastLibraryRemovalAction({ podcastId, title, libraryId, libraryName, canRemove, blocked, focus, ctx, run }: {
  readonly podcastId: string;
  readonly title: string;
  readonly libraryId: string;
  readonly libraryName: string;
  readonly canRemove: boolean;
  readonly blocked: BlockedReason | null;
  readonly focus: PodcastActionFocus;
  readonly ctx: ActionContext;
  readonly run: (command: ActionCommand) => void;
}): Extract<ActionDescriptor, { kind: "command" }> & { readonly icon: ReactElement; readonly accessibleLabel: string } {
  const label = `Remove from ${libraryName}`;
  const disabledReason = installedApp && !ctx.online ? admissionReason()
    : blocked !== null ? BLOCKED_COPY[blocked]
    : !canRemove ? "a library admin must remove this subscription." : undefined;
  return {
    kind: "command", id: "PodcastLibraryRemoval", label,
    accessibleLabel: `Remove ${title} from ${libraryName}`,
    icon: createElement(Minus, { size: 16, "aria-hidden": true }),
    disabled: disabledReason !== undefined || undefined, disabledReason, restoreFocusOnClose: false,
    onSelect: detail => {
      if (disabledReason !== undefined) return;
      const successFocus = focus.afterRemoval;
      const trigger = detail.triggerEl ?? focus.trigger;
      run({ ref: `podcast:${podcastId}`, id: "UnsubscribePodcast", label, title,
        confirmation: null, tracked: false,
        execute: () => ctx.overlays.open({ kind: "UnsubscribePodcast", podcastId, title, libraryId, successFocus },
          { anchor: () => trigger, returnFocusFallback: focus.returnFocus }),
      });
    },
  };
}

/**
 * One resource's menu: the server's verbs, labelled, ordered by the catalog,
 * separated by group and wired to their owners. Commands run only through `run`.
 */
export function projectResourceActions(
  facts: ResourceActions,
  ctx: ActionContext,
  busy: ReadonlySet<ActionId>,
  run: (command: ActionCommand) => void,
  boundPaneId: string | null,
  playbackSource: PlaybackSource | null,
  podcastFocus?: PodcastActionFocus,
): ActionDescriptor[] {
  const { ref, activation } = facts;
  const resource = parseResourceRef(ref);
  if (resource === null) throw new Error(`invalid resource action ref: ${ref}`);
  const id = resource.id;
  const returnFocus = podcastFocus?.returnFocus;
  // A verb acts from the pane active when it runs.
  const originPaneId = () => boundPaneId ?? ctx.workspace().state.active_primary_pane_id;
  const activate = (
    request: Omit<WorkspaceTargetActivationRequest, "originPaneId">,
  ) => {
    if (!ctx.isActive()) return;
    return ctx
      .workspace()
      .activateWorkspaceTarget({ ...request, originPaneId: originPaneId() });
  };

  const make = (
    actionId: ActionId,
    blocked: Action["blocked"],
    execute: (detail: ActionSelectDetail, acknowledged: () => void) => unknown,
    options: Options = {},
  ): Extract<ActionDescriptor, { kind: "command" }> => {
    const entry: {
      readonly label: string;
      readonly icon: LucideIcon;
      readonly group: string;
      readonly confirmation?: Confirmation;
    } = { ...ACTION_CATALOG[actionId], ...options.state };
    const reason = blocked ?? options.blocked;
    const disabledReason = busy.has(actionId)
      ? BLOCKED_COPY.Busy
      : (options.disabledReason ?? (reason && BLOCKED_COPY[reason]));
    const waiting = busy.has(actionId) || (options.disabledReason === undefined ? reason === "Loading" || reason === "Busy" : options.waiting === true);
    return {
      kind: "command",
      id: actionId,
      label: entry.label,
      icon: createElement(entry.icon, { size: 16, "aria-hidden": true }),
      tone: entry.group === "Danger" ? "danger" : "default",
      disabled: disabledReason !== undefined || undefined,
      disabledReason,
      waiting: waiting || undefined,
      hasPopup: actionId === "Share" ? "dialog" : undefined,
      onSelect: (detail) =>
        run({
          ref,
          id: actionId,
          label: entry.label,
          title: facts.label,
          confirmation: options.confirmation === undefined
            ? entry.confirmation ?? null
            : options.confirmation,
          tracked: options.tracked ?? true,
          rawWrite: options.rawWrite,
          afterRemoval: options.afterRemoval,
          execute: acknowledged => execute(detail, acknowledged),
        }),
    };
  };

  const link = (
    command: Extract<ActionDescriptor, { kind: "command" }>,
    href: string,
    disposition: "Follow" | "Fork" = "Follow",
  ): ActionDescriptor => {
    const { onSelect: _, state: __, ...presentation } = command;
    return {
      ...presentation, kind: "link", href,
      onActivate: event => activateTargetLink({
        event, runtime: { activateTarget: activate }, target: { href },
        onDefault: disposition === "Fork"
          ? () => activate({ target: { href }, disposition: { kind: "Fork" } })
          : undefined,
      }),
    };
  };

  const follow = (kind: "Follow" | "Fork") => ({ openIntent }: ActionSelectDetail) =>
    activateResource(activation, {
      disposition: { kind: openIntent === "new_pane" ? "Fork" : kind },
      activateTarget: activate,
    });
  // An edit whose state lives in a mounted pane: go there and hand it the entry.
  const entry = (paneEntry: WorkspacePaneEntry, options: Options = {}): Verb => [
    ({ openIntent }) =>
      activation.href !== null &&
      activate({
        target: { href: activation.href },
        disposition: { kind: openIntent === "new_pane" ? "Fork" : "Follow" },
        entry: paneEntry,
      }),
    { tracked: false, ...options },
  ];
  const deleted = (
    remove: (acknowledged: () => void) => Promise<unknown>,
    fallbackHref: string,
    rawWrite?: true,
  ): Verb => [
    async (_, acknowledged) => {
      await remove(acknowledged);
      if (!ctx.isActive()) return;
      settleDeletedResourcePanes({
        workspace: ctx.workspace(),
        deletedRef: ref,
        fallbackHref,
      });
    },
    { afterRemoval: podcastFocus?.afterRemoval, rawWrite },
  ];
  const deleteChat = async () => {
    const owner = getConversationCommands(ctx.accountId, id);
    const present = (outcome: CommandOutcome) => {
      if (!ctx.isActive()) return;
      if (outcome.kind === "Gone") {
        settleDeletedResourcePanes({ workspace: ctx.workspace(), deletedRef: ref, fallbackHref: "/conversations" });
      } else if (outcome.kind === "Failed") {
        sayRefusal(ctx.feedback, outcome);
      } else if (outcome.kind === "Pending") {
        ctx.observeChatCommand({ id, title: facts.label, owner, present });
      }
    };
    present(await deleteConversation(ctx.accountId, id));
  };
  const repeat = (operation: "rerun" | "regenerate", intent: OpenIntent) => {
    const route = activation.href === null ? null : resolvePaneRouteModel(activation.href);
    if (route?.id !== "conversation") throw new Error("A repeat action must name its conversation");
    const conversationId = route.params.id!;
    const owner = getConversationCommands(ctx.accountId, conversationId);
    const present = (outcome: CommandOutcome) => {
      if (!ctx.isActive()) return;
      if (outcome.kind === "Failed") {
        sayRefusal(ctx.feedback, outcome);
      } else if (outcome.kind === "Pending") {
        ctx.observeChatCommand({ id: conversationId, title: facts.label, owner, present,
          retry: requested => {
            const current = owner.getSnapshot();
            if (current.kind === "Idle" || current.command.kind !== "Repeat") return Promise.resolve();
            return open(requested === "new_pane" ? requested : current.command.openIntent,
              ctx.workspace().state.active_primary_pane_id, () => owner.retry(requested));
          },
        });
      }
    };
    const open = async (openIntent: OpenIntent, origin: string, command: () => Promise<CommandOutcome>): Promise<void> => {
      await openAsyncResult({
        ctx, originPaneId: origin, intent: openIntent, subject: facts.label,
        create: async () => {
          const outcome = await command();
          present(outcome);
          return outcome.kind === "Accepted" ? {
            target: { href: conversationViewHref(conversationId, outcome.receipt.outcome.assistant_message_id), labelHint: "Chat" },
            title: "response started", openLabel: "open",
          } : null;
        },
      });
    };
    return open(intent, originPaneId(), async () => {
      const tree = await readConversationTree(conversationId);
      if (!ctx.isActive()) return { kind: "Handled" };
      const message = tree?.messages.find(message => message.id === id);
      if (!tree || !message) return {
        kind: "Failed", feedback: { tone: "Warning", title: `couldn’t ${operation}.`, message: "that message is gone." }, rejection: null,
      };
      return repeatMessage(ctx.accountId, tree.conversation, message, operation, null, intent);
    });
  };
  const overlay = (next: Overlay): Verb => [
    ({ triggerEl }) => ctx.overlays.open(next, invocationFocus(triggerEl ?? podcastFocus?.trigger ?? null, returnFocus)),
    { tracked: false },
  ];
  const metadata = (triggerEl: HTMLElement | null) => {
    const focused = document.activeElement;
    const pane =
      triggerEl?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId ??
      originPaneId();
    ctx.overlays.open({
      kind: "Metadata",
      subject: metadataSubject(resource),
      returnFocusTo:
        resource.scheme !== "media" ? triggerEl : focused instanceof HTMLElement && focused !== document.body
          ? focused
          : triggerEl,
      fallback: returnFocus ?? (() => findPaneChromeFocusTarget(pane) ?? findPaneLandmarkFocusTarget(pane)),
    });
  };

  const { queue } = ctx.player;
  const queueBlocked = queueBlock(queue, ctx.player.state, "Queue");
  const append = (next: boolean) => {
    const entry = { id: crypto.randomUUID(), media_id: id };
    const header = queue.header;
    if (header === null) return ctx.player.commands.createQueue({ entry });
    return ctx.player.commands.queueCommand({ queue_id: header.queue_id, expected_revision: header.revision,
      command: { kind: next ? "insert-next" : "append", entry } });
  };
  const verbs: Record<DirectKind, Verb> = {
    Open: [follow("Follow"), { tracked: false }],
    OpenInNewPane: [follow("Fork"), { tracked: false }],
    Metadata: [
      ({ triggerEl }) => metadata(triggerEl),
      { tracked: false },
    ],
    AddToQueue: [() => append(false), { disabledReason: queueBlocked?.reason, waiting: queueBlocked?.waiting }],
    PlayNext: [() => append(true), { disabledReason: queueBlocked?.reason, waiting: queueBlocked?.waiting }],
    ResetProgress: [() => ctx.consumption.resetProgress(id)],
    LibraryPlacement: [
      ({ triggerEl }) => {
        const paneId = triggerEl?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId ?? originPaneId();
        const anchor = () => triggerEl;
        const fallback = () => findPaneLandmarkFocusTarget(paneId);
        ctx.openLibraryPlacement(
          [{ kind: "Media", id }],
          { anchor, returnFocusFallback: fallback },
        );
      },
      { tracked: false },
    ],
    Share: [
      ({ triggerEl }) => {
        const paneId = triggerEl?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId ?? originPaneId();
        ctx.openShare(resourceShareTarget(ref), anchoredShareOpenOptions(triggerEl, () => findPaneLandmarkFocusTarget(paneId)));
      },
      { tracked: false },
    ],
    Chat: [
      ({ openIntent }) =>
        openConversationAbout({ ctx, ref, originPaneId: originPaneId(), intent: openIntent, subject: facts.label }),
    ],
    DownloadOriginal: [
      async () => {
        const response = await apiFetch<
          ApiJson<"/media/{media_id}/file", "get">
        >(`/api/media/${id}/file`, { cache: "no-store" });
        if (!ctx.isActive()) return;
        window.location.assign(response.data.url);
      },
    ],
    LeaveLibrary: deleted(async acknowledged => { await leaveLibrary(id); acknowledged(); }, "/libraries", true),
    LibrarySettings: overlay({ kind: "LibrarySettings", libraryId: id }),
    PodcastSettings: overlay({ kind: "PodcastSettings", podcastId: id }),
    AddEpisodeToAll: [async () => {
      if (ctx.podcasts.pending(`episode-save:${id}`) !== null) return;
      const snapshot = await placements({ kind: "Media", id }, ctx.sessionSignal());
      if (!ctx.isActive() || snapshot.all_membership.included) return;
      await ctx.podcasts.submit({ subject: `episode-save:${id}`, title: facts.label, library: null, command: {
        kind: "EpisodeSave", mediaId: id, libraryId: snapshot.all_membership.library_id,
        body: { included: true, expected_order_revision: snapshot.all_membership.order_revision,
          expected_removal_revision: snapshot.removal_revision },
      } });
    }],
    RemoveEpisodeFromAll: overlay({ kind: "RemoveEpisodeFromAll", mediaId: id, title: facts.label }),
    RemovePodcastEpisodes: overlay({ kind: "RemovePodcastEpisodes", podcastId: id, title: facts.label }),
    RefreshPodcast: [async (_, acknowledged) => {
      await requestPodcastRefresh({ kind: "Podcast", podcast_id: id });
      acknowledged();
    }, { rawWrite: true }],
    RemoveMedia: deleted(async acknowledged => {
      await deleteMedia(id);
      acknowledged();
      if (ctx.isActive()) ctx.mediaContinuations.forgetDeletedMedia(id);
    }, "/libraries", true),
    DeleteLibrary: deleted(async acknowledged => { await deleteLibrary(id); acknowledged(); }, "/libraries", true),
    DeleteConversation: [deleteChat, { confirmation: null }],
    DeletePage: deleted(() => deletePage(getWritingRuntime(ctx.accountId), id), "/notes"),
    EditPageTitle: entry({ kind: "EditPageTitle", pageId: id }),
    EditNoteBody: entry({ kind: "EditNoteBody", noteBlockId: id }),
    EditHighlight: entry({ kind: "EditHighlight", highlightId: id }),
    EditHighlightBounds: entry({
      kind: "EditHighlightBounds",
      highlightId: id,
    }),
    DeleteHighlight: entry({ kind: "DeleteHighlight", highlightId: id }),
    // The highlight pane owns its annotation field.
    EditHighlightAnnotation: entry({ kind: "EditHighlightAnnotation", highlightId: id }),
    ForkMessage: entry({ kind: "ForkMessage", messageId: id }),
    RerunMessage: [({ openIntent }) => repeat("rerun", openIntent)],
    RegenerateMessage: [({ openIntent }) => repeat("regenerate", openIntent)],
    DeleteMessage: entry({ kind: "DeleteMessage", messageId: id }, { confirmation: null }),
  };

  // A present download's commands are device actions, composed beside these remote facts.
  const download = (action: Extract<Action, { kind: "Download" }>): ActionDescriptor | null =>
    ctx.offline.kind === "Ready" && ctx.offline.items.some(item => item.media_id === id) ? null
      : projectDownloadActions({ mediaId: id, title: facts.label, ctx, busy, run, server: action })[0] ?? null;

  const pendingAdmission = (
    kind: "SourceRefresh" | "MetadataResearch",
    actionId: "RefreshSource" | "RetryMetadata",
  ): ActionDescriptor | null => {
    const pending = ctx.admissions.pending(kind, id);
    if (pending === null) return null;
    if (isStaleBuild(pending.error)) {
      const reload = ctx.remedy === "Reload";
      return make(actionId, null, () => { if (reload) window.location.reload(); }, {
        state: { label: reload ? "Reload" : "Update Nexus", icon: ACTION_CATALOG.RefreshSource.icon },
        disabledReason: reload ? undefined : staleBuild(),
        tracked: false,
      });
    }
    const sending = pending.kind === "sending";
    return make(actionId, null, () => ctx.admissions.retry(pending.key), {
      state: { label: "Retry", icon: ACTION_CATALOG[actionId].icon },
      tracked: false,
      disabledReason: sending ? "already sending." : !ctx.online ? admissionReason() : undefined,
      waiting: sending,
    });
  };

  const project = (action: Action): ActionDescriptor | null => {
    const { blocked } = action;
    switch (action.kind) {
      case "OpenSource":
      case "OpenPodcastFeed": {
        return link(make(action.kind, blocked, () => {}), action.href);
      }
      case "Playback":
        return projectPlaybackAction({ mediaId: id, title: facts.label,
          descriptor: action.player_descriptor, blocked, playbackSource, ctx, run });
      case "Consumption": {
        const { finished, episode } = action;
        const states = ACTION_CATALOG.Consumption.states;
        return make(
          "Consumption",
          blocked,
          () =>
            finished
              ? ctx.consumption.markUnread(id)
              : ctx.consumption.finish(id, { title: facts.label, leaveLectern: false }),
          {
            state: episode
              ? finished
                ? states.EpisodePlayed
                : states.EpisodeUnplayed
              : finished
                ? states.DocumentFinished
                : states.DocumentIncomplete,
          },
        );
      }
      case "Transcript": {
        const { state } = action;
        const opens =
          state === "ready" ||
          state === "partial" ||
          state === "queued" ||
          state === "running";
        const descriptor = make(
          "Transcript",
          blocked,
          opens
            ? follow("Follow")
            : async (_, acknowledged) => {
                await apiFetch(`/api/media/${id}/transcript/request`, {
                  method: "POST",
                });
                acknowledged();
                if (!ctx.isActive()) return;
                // Imports shows the transcript's work; open panes follow it again.
                publishImportsInvalidation();
              },
          {
            state: ACTION_CATALOG.Transcript.states[state],
            tracked: !opens,
            rawWrite: opens ? undefined : true,
            blocked:
              state === "queued" || state === "running"
                ? "Processing"
                : state === "unavailable"
                  ? "TemporarilyUnavailable"
                  : undefined,
          },
        );
        return opens && activation.kind === "route" && activation.href !== null ? link(descriptor, activation.href) : descriptor;
      }
      case "Download":
        return download(action);
      case "LecternMembership": {
        return projectLecternAction({
          mediaId: id, title: facts.label,
          intent: action.lectern_item_id === null ? "Ensure" : "Remove",
          blocked, ctx, busy, run,
        });
      }
      case "TranscribePodcastEpisodes":
        return projectPodcastTranscriptAction({ podcastId: id, state: "all", title: facts.label, blocked, ctx, run, returnFocus });
      case "MarkCollectionFinished":
      case "MarkCollectionUnread": {
        const target = collectionTarget(resource);
        return projectCollectionConsumptionAction({ selection: target.kind === "Podcast" ? { ...target, state: "all" } : target, desiredState: action.kind === "MarkCollectionFinished" ? "finished" : "unread", title: facts.label, blocked, ctx, run, returnFocus });
      }
      case "AddUnfinishedToLectern": {
        const target = collectionTarget(resource);
        const label = target.kind === "Podcast" ? "Add unfinished episodes to Lectern…" : ACTION_CATALOG.AddUnfinishedToLectern.label;
        return make(action.kind, blocked, ({ triggerEl }) => ctx.overlays.open({ kind: "CollectionLectern", target, title: facts.label }, invocationFocus(triggerEl, returnFocus)),
          { tracked: false, state: { label, icon: ACTION_CATALOG.AddUnfinishedToLectern.icon } });
      }
      case "SubscribePodcast":
      case "UnsubscribePodcast":
        return projectPodcastSubscriptionAction({
          target: { kind: "Canonical", podcast_id: id }, title: facts.label, focus: podcastFocus,
          facts: { kind: "Ready", resolution: { kind: "Canonical", podcast_id: id, subscribed: action.kind === "UnsubscribePodcast" } },
          disabledReason: blocked === null ? null : BLOCKED_COPY[blocked], ctx, run,
        });
      case "PodcastLibraries":
        return projectPodcastLibrariesAction({ target: { kind: "Canonical", podcast_id: id }, title: facts.label, disabledReason: blocked === null ? null : BLOCKED_COPY[blocked], ctx, run, focus: podcastFocus });
      case "RetryMetadata": {
        const recovery = pendingAdmission("MetadataResearch", "RetryMetadata");
        if (recovery !== null) return recovery;
        const { retry } = action;
        return make(
          "RetryMetadata",
          blocked,
          async () => {
            if (retry.status !== "allowed") return;
            const result = await ctx.admissions.admit({ kind: "MetadataResearch", mediaId: id, request: { expected_job_id: retry.expected_job_id } });
            if (!ctx.isActive()) return;
            if (result.kind === "LocalFailure") throw new ResourceActionFailure({ fact: result.content.title, reason: result.content.message });
          },
          {
            tracked: false,
            state: {
              label: metadataResearchLabel(null, retry.purpose),
              icon: ACTION_CATALOG.RetryMetadata.icon,
            },
            blocked: ctx.online ? undefined : "RequiresOnline",
            disabledReason:
              retry.status === "blocked"
                ? metadataRetryBlockedCopy(retry)
                : undefined,
          },
        );
      }
      case "RefreshSource": {
        const recovery = pendingAdmission("SourceRefresh", "RefreshSource");
        if (recovery !== null) return recovery;
        return make(
          "RefreshSource",
          blocked,
          async () => {
            if (action.expected_attempt_id === null) return;
            const result = await ctx.admissions.admit({ kind: "SourceRefresh", mediaId: id, request: { expected_attempt_id: action.expected_attempt_id } });
            if (!ctx.isActive()) return;
            if (result.kind === "LocalFailure") throw new ResourceActionFailure({ fact: result.content.title, reason: result.content.message });
          },
          {
            tracked: false,
            blocked: ctx.online ? undefined : "RequiresOnline",
            // the server's reason decides first
            disabledReason: blocked !== null ? BLOCKED_COPY[blocked]
              : action.expected_attempt_id === null ? "available once this source finishes processing." : undefined,
          },
        );
      }
      case "ReviewMetadataResult":
        return make("ReviewMetadataResult", blocked, (_, acknowledged) =>
          submitMetadataResultReview(id, action.job_id, acknowledged), { rawWrite: true });
      case "Recovery":
        if (action.offer.kind === "BrowserCapture") return { kind: "link", id: "BrowserCapture", label: ACTION_CATALOG.BrowserCapture.label,
          icon: createElement(ACTION_CATALOG.BrowserCapture.icon, { size: 16, "aria-hidden": true }), href: action.offer.source_url, target: "_blank" };
        const offer = action.offer;
        return make(offer.kind, blocked, async (_, acknowledged) => {
          await recoverMedia(id, offer);
          acknowledged();
        }, { rawWrite: true });
      default: {
        const [execute, options] = verbs[action.kind];
        const descriptor = make(action.kind, blocked, execute, options);
        return (action.kind === "Open" || action.kind === "OpenInNewPane") && activation.kind === "route" && activation.href !== null
          ? link(descriptor, activation.href, action.kind === "OpenInNewPane" ? "Fork" : "Follow")
          : descriptor;
      }
    }
  };

  // Catalog order is menu order; a separator starts each new group.
  const byId = new Map(
    facts.actions.flatMap((action) => {
      const descriptor = project(action);
      return descriptor === null ? [] : [[descriptor.id, descriptor] as const];
    }),
  );
  if (byId.has("BrowserCapture")) byId.delete("OpenSource");
  const playback = facts.actions.find(action => action.kind === "Playback");
  if (playback !== undefined && playback.kind === "Playback" && playbackSource !== null) {
    byId.set("PlayFromHere", make("PlayFromHere", playback.blocked, () => ctx.player.commands.playAudio({
      mediaId: id, knownDescriptor: playback.player_descriptor, positionMs: null, source: () => playbackSource(id), recapture: true,
    })));
  }
  const player = ctx.player.state;
  const pendingPlayback = ctx.player.pendingPlayback;
  if (!facts.missing && ref.startsWith("media:") && !byId.has("Playback") && (
    player.kind === "Loaded" && player.source.kind === "Episode" && player.source.descriptor.media_id === id ||
    pendingPlayback?.kind === "Episode" && pendingPlayback.mediaId === id
  )) byId.set("Playback", projectPlaybackAction({ mediaId: id, title: facts.label, descriptor: null, blocked: null, playbackSource, ctx, run }));
  const menu: ActionDescriptor[] = [];
  let group: string | undefined;
  for (const [actionId, catalogEntry] of Object.entries(ACTION_CATALOG)) {
    const descriptor = byId.get(actionId);
    if (!descriptor) continue;
    const separatorBefore = group !== undefined && group !== catalogEntry.group;
    menu.push({ ...descriptor, separatorBefore: separatorBefore || undefined });
    group = catalogEntry.group;
  }
  const undoTarget = resource.scheme === "media" ? { kind: "Media" as const, mediaId: id }
    : resource.scheme === "library" ? { kind: "Library" as const, library_id: id }
    : resource.scheme === "podcast" ? { kind: "Podcast" as const, podcast_id: id } : null;
  if (undoTarget !== null) menu.push(...projectConsumptionUndoActions(undoTarget, ctx));
  return menu;
}

/** Local exact inverses belong to their subject; the server action catalog stays unchanged. */
export function projectConsumptionUndoActions(target: ActionContext["consumptionUndoItems"][number]["target"], ctx: ActionContext): ActionDescriptor[] {
  return ctx.consumptionUndoItems.filter(item => {
    if (item.target.kind === "Media") return target.kind === "Media" && item.target.mediaId === target.mediaId;
    if (item.target.kind === "Library") return target.kind === "Library" && item.target.library_id === target.library_id;
    return target.kind === "Podcast" && item.target.podcast_id === target.podcast_id;
  }).map(item => {
    const disabledReason = !ctx.online ? admissionReason() : undefined;
    return { kind: "command", id: `ConsumptionUndo:${item.commandKey}`, label: item.actionLabel, icon: createElement(Undo2, { size: 16, "aria-hidden": true }),
      disabled: disabledReason !== undefined || item.phase === "Sending", disabledReason, busy: item.phase === "Sending",
      onSelect: () => { if (disabledReason === undefined && item.phase !== "Sending") ctx.consumption.undo(item.commandKey); },
    };
  });
}

/**
 * Download commands. A present item's commands (cancel, retry, remove) are device
 * actions from the current local index and need no remote facts; only acquiring an
 * absent item uses the server's `Download` fact and current admission. The native
 * owner resolves the episode's audio itself; the title is only a provisional label.
 */
export function projectDownloadActions(input: {
  readonly mediaId: string;
  readonly title: string;
  readonly ctx: ActionContext;
  readonly busy: ReadonlySet<ActionId>;
  readonly run: (command: ActionCommand) => void;
  readonly server: Extract<Action, { kind: "Download" }> | null;
}): Extract<ActionDescriptor, { kind: "command" }>[] {
  const { mediaId, title, ctx, busy, run, server } = input;
  const states = ACTION_CATALOG.Download.states;
  const command = (
    state: { readonly label: string; readonly icon: LucideIcon },
    execute: () => Promise<void>,
    options: { readonly id?: string; readonly confirmation?: Confirmation; readonly disabledReason?: string; readonly waiting?: boolean; readonly tone?: "danger" } = {},
  ): Extract<ActionDescriptor, { kind: "command" }> => {
    const disabledReason = busy.has("Download") ? BLOCKED_COPY.Busy : options.disabledReason;
    return {
      kind: "command", id: options.id ?? "Download", label: state.label, icon: createElement(state.icon, { size: 16, "aria-hidden": true }),
      tone: options.tone ?? "default", disabled: disabledReason !== undefined || undefined, disabledReason,
      waiting: busy.has("Download") || options.waiting || undefined,
      onSelect: () => run({ ref: `media:${mediaId}`, id: "Download", label: state.label, title,
        confirmation: options.confirmation ?? null, tracked: true, execute }),
    };
  };
  // Android answers on the bridge; its modeled refusal is an advisory.
  const mutate = (op: string, args: Record<string, unknown>) => async () => {
    try {
      await localMutation(op, args);
    } catch (error) {
      if (!ctx.isActive()) return;
      if (error instanceof LocalMutationObservationError) {
        if (error.observation.receipt !== null) return;
        throw new ResourceActionUnknown({ fact: `not sure the download change for “${title}” saved.`, reason: UNKNOWN_OUTCOME_REASON });
      }
      const code = error instanceof Error ? error.message : "";
      throw new ResourceActionFailure(code === "Storage" ? { fact: `couldn’t download “${title}”.`, reason: "this device is out of storage." }
        : { fact: `couldn’t change the download of “${title}”.`, reason: code === "Unsupported" ? "this item can’t be downloaded."
          : code === "Scheduler" ? "android couldn’t schedule it." : undefined });
    }
  };
  const { offline } = ctx;
  if (offline.kind !== "Ready") {
    if (server === null) return [];
    return [command(ACTION_CATALOG.Download, async () => {}, {
      disabledReason: offline.kind === "Loading" ? BLOCKED_COPY.Loading : BLOCKED_COPY.UnsupportedOnDevice, waiting: offline.kind === "Loading" })];
  }
  const item: LocalItem | undefined = offline.items.find(candidate => candidate.media_id === mediaId);
  const remove = mutate("remove", { media_id: mediaId });
  switch (item?.state) {
    case undefined: {
      if (server === null) return [];
      const subject = server.media_kind === "podcast_episode"
        ? { kind: "Episode", media_id: mediaId, title: server.title }
        : { kind: "ReadingCopy", media_id: mediaId, media_kind: server.media_kind, title: server.title };
      const reason = server.blocked !== null ? BLOCKED_COPY[server.blocked] : !ctx.online ? BLOCKED_COPY.RequiresOnline : undefined;
      return [command(ACTION_CATALOG.Download, mutate("enqueue", { subject }), {
        disabledReason: reason,
        confirmation: server.media_kind === "web_article"
          ? { title: "Download text-only copy?", body: "Downloaded web articles include readable text but not images." } : undefined,
      })];
    }
    case "Queued":
    case "Downloading":
      return [command(states.Downloading, mutate("cancel", { media_id: mediaId }))];
    case "Ready":
      return [command(states.Ready, remove, { tone: "danger",
        confirmation: item.progress !== null && item.progress.kind !== "Canonical" ? {
          title: "Remove downloaded copy?",
          body: "Remove this copy and its position saved on this device. That position has not reached Nexus.",
        } : undefined })];
    case "Failed":
      return [
        command(states.Failed, mutate("retry", { media_id: mediaId })),
        command(states.Ready, remove, { id: "Download.Remove", tone: "danger" }),
      ];
    case "Removing":
      return [command(states.Ready, remove, { disabledReason: `removal waits until this ${item.kind === "podcast_episode" ? "episode" : "copy"} is closed.` })];
  }
}
