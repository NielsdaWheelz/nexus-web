import { createElement } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ACTION_CATALOG,
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
import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import {
  createConversationAbout,
  deleteConversation,
} from "@/lib/chat/conversationIndex";
import { getConversationCommands, type CommandOutcome } from "@/lib/chat/commands";
import {
  artifactPaneHref,
  createDossierBuild,
  learnDossier,
} from "@/lib/dossiers/dossierApi";
import { publishImportsInvalidation, recoverMedia } from "@/lib/imports/api";
import { LECTERN_INTENT_COPY } from "@/lib/lectern/lectern";
import { deleteLibrary } from "@/lib/libraries/api";
import { deleteMedia } from "@/lib/media/mediaLibraries";
import {
  metadataResearchLabel,
  metadataRetryBlockedCopy,
} from "@/lib/media/mediaMetadataCopy";
import {
  submitMetadataResultReview,
} from "@/lib/media/mediaMetadataOperations";
import { deletePage } from "@/lib/notes/api";
import { offlineCall } from "@/lib/offline/bridge";
import { playingEpisode } from "@/lib/player/playerRuntime";
import {
  requestPodcastRefresh,
  retryPodcastSubscriptionBackfill,
  unsubscribeFromPodcast,
} from "@/lib/podcasts/api";
import { activateResource } from "@/lib/resources/activation";
import { resourceShareTarget } from "@/lib/sharing/targets";
import type {
  ActionDescriptor,
  ActionSelectDetail,
} from "@/lib/ui/actionDescriptor";
import { isEditableTarget } from "@/lib/ui/eventTarget";
import {
  getInteractiveOpenGeneration,
  hasActiveInteractionOwner,
} from "@/lib/ui/overlay";
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
type SimpleKind = Schema<"SimpleAction">["kind"];

/** One chosen verb. The provider confirms it, tracks it busy and reports failure. */
export interface ActionCommand {
  readonly ref: string;
  readonly id: ActionId;
  readonly label: string;
  /** The resource's label, for `{title}` in the confirmation. */
  readonly title: string;
  readonly confirmation: Confirmation | null;
  /** Opening an overlay, navigating or handing a pane an entry is untracked. */
  readonly tracked: boolean;
  readonly execute: () => unknown;
}

interface Options {
  readonly state?: { readonly label: string; readonly icon: LucideIcon };
  /** A client fact blocking the verb; the server's reason wins. */
  readonly blocked?: BlockedReason;
  /** Copy that explains a block better than the generic reason. */
  readonly disabledReason?: string;
  readonly confirmation?: Confirmation | null;
  readonly tracked?: boolean;
}
type Verb = readonly [
  execute: (detail: ActionSelectDetail) => unknown,
  options?: Options,
];

/** A direct add fixes Ensure; the menu may choose Remove. Pending intent wins. */
export function projectLecternAction({
  mediaId, title, intent, blocked, ctx, busy, run,
}: {
  readonly mediaId: string;
  readonly title: string;
  readonly intent: "Ensure" | "Remove";
  readonly blocked: BlockedReason | null;
  readonly ctx: ActionContext;
  readonly busy: ReadonlySet<ActionId>;
  readonly run: (command: ActionCommand) => void;
}): Extract<ActionDescriptor, { kind: "command" }> {
  const request = ctx.lectern.pending.get(mediaId);
  const currentIntent = request?.intent.kind ?? intent;
  const state = currentIntent === "Place"
    ? ACTION_CATALOG.PlayNext
    : ACTION_CATALOG.LecternMembership.states[
        currentIntent === "Ensure" ? "Absent" : "Present"
      ];
  const copy = LECTERN_INTENT_COPY[currentIntent];
  const label = request
    ? {
        Sending: `${copy.verb}…`,
        Checking: copy.check,
        Unconfirmed: copy.check,
      }[request.phase]
    : state.label;
  let disabledReason: string | undefined;
  if (request && request.phase !== "Unconfirmed")
    disabledReason = "wait for this lectern change to finish.";
  else if (busy.has("LecternMembership")) disabledReason = BLOCKED_COPY.Busy;
  else if (!request) {
    if (blocked !== null) disabledReason = BLOCKED_COPY[blocked];
    else if (ctx.lectern.revision === null)
      disabledReason = "load the current lectern before changing it.";
  }
  return {
    kind: "command",
    id: "LecternMembership",
    label,
    icon: createElement(state.icon, { size: 16, "aria-hidden": true }),
    disabled: disabledReason !== undefined || undefined,
    disabledReason,
    onSelect: () => run({
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
    }),
  };
}

/** Creating a result does not grant permission to interrupt a later task. */
async function openAsyncResult(
  ctx: ActionContext,
  subject: string,
  disposition: "Follow" | "Adopt",
  create: () => Promise<
    | {
        readonly href: string;
        readonly labelHint: string;
        readonly title: string;
        readonly openLabel: string;
      }
    | null
  >,
): Promise<void> {
  const origin = ctx.workspace();
  const originPaneId = origin.state.active_primary_pane_id;
  const generation = origin.foregroundGeneration;
  const overlayGeneration = getInteractiveOpenGeneration();
  const signal = ctx.sessionSignal();
  let relinquished = false;
  const subsequentInput = (event: Event) => {
    if (!event.isTrusted) return;
    if (
      event instanceof KeyboardEvent &&
      ["Alt", "AltGraph", "Control", "Meta", "Shift"].includes(event.key)
    )
      return;
    if (
      ["beforeinput", "input", "compositionstart"].includes(event.type) &&
      !isEditableTarget(event.target)
    )
      return;
    relinquished = true;
  };
  const events = [
    "pointerdown", "keydown", "beforeinput", "input", "compositionstart",
  ];
  for (const event of events)
    window.addEventListener(event, subsequentInput, { capture: true, signal });
  try {
    const result = await create();
    if (result === null || signal.aborted) return;
    const workspace = ctx.workspace();
    if (
      !relinquished &&
      generation === workspace.foregroundGeneration &&
      overlayGeneration === getInteractiveOpenGeneration() &&
      !hasActiveInteractionOwner()
    ) {
      workspace.activateWorkspaceTarget({
        originPaneId,
        target: { href: result.href, labelHint: result.labelHint },
        disposition: { kind: disposition },
      });
      return;
    }
    const key = `resource-action-result:${result.href}`;
    const offer = ctx.feedback.offer({
      key,
      content: { tone: "Success", title: result.title, message: subject },
      announcement: "Polite",
      actions: [
        {
          label: result.openLabel,
          commandKey: key,
          onClick: () => {
            if (signal.aborted) return;
            const current = ctx.workspace();
            current.activateWorkspaceTarget({
              originPaneId: current.state.active_primary_pane_id,
              target: { href: result.href, labelHint: result.labelHint },
              disposition: { kind: "Adopt" },
            });
            offer.withdraw();
          },
        },
      ],
      returnFocus: () => {
        if (signal.aborted) return null;
        const active = ctx.workspace().state.active_primary_pane_id;
        return (
          findPaneChromeFocusTarget(active) ?? findPaneLandmarkFocusTarget(active)
        );
      },
    });
  } finally {
    for (const event of events)
      window.removeEventListener(event, subsequentInput, true);
  }
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
): ActionDescriptor[] {
  const { ref, activation } = facts;
  const id = ref.slice(ref.indexOf(":") + 1);
  // A verb acts from the pane active when it runs.
  const originPaneId = () => ctx.workspace().state.active_primary_pane_id;
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
    execute: (detail: ActionSelectDetail) => unknown,
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
    return {
      kind: "command",
      id: actionId,
      label: entry.label,
      icon: createElement(entry.icon, { size: 16, "aria-hidden": true }),
      tone: entry.group === "Danger" ? "danger" : "default",
      disabled: disabledReason !== undefined || undefined,
      disabledReason,
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
          execute: () => execute(detail),
        }),
    };
  };

  const follow = (kind: "Follow" | "Fork") => () =>
    activateResource(activation, {
      disposition: { kind },
      activateTarget: activate,
    });
  // An edit whose state lives in a mounted pane: go there and hand it the entry.
  const entry = (paneEntry: WorkspacePaneEntry, options: Options = {}): Verb => [
    () =>
      activation.href !== null &&
      activate({
        target: { href: activation.href },
        disposition: { kind: "Follow" },
        entry: paneEntry,
      }),
    { tracked: false, ...options },
  ];
  const deleted = (
    remove: () => Promise<unknown>,
    fallbackHref: string,
  ): Verb => [
    async () => {
      await remove();
      if (!ctx.isActive()) return;
      settleDeletedResourcePanes({
        workspace: ctx.workspace(),
        deletedRef: ref,
        fallbackHref,
      });
    },
  ];
  const deleteChat = async () => {
    const owner = getConversationCommands(ctx.accountId, id);
    const present = (outcome: CommandOutcome) => {
      if (!ctx.isActive()) return;
      if (outcome.kind === "Gone") {
        settleDeletedResourcePanes({ workspace: ctx.workspace(), deletedRef: ref, fallbackHref: "/conversations" });
      } else if (outcome.kind !== "Settled" && outcome.kind !== "Handled") {
        const state = owner.getSnapshot();
        if (outcome.kind === "Failed" || state.kind === "Idle" || state.command.kind !== "DeleteChat") {
          ctx.feedback.offer({ key: `chat-command-result:${id}`, content: outcome.feedback, announcement: "Polite" });
        } else {
          ctx.observeChatCommand({ id, title: facts.label, owner, present });
        }
      }
    };
    present(await deleteConversation(ctx.accountId, id));
  };
  const overlay = (next: Overlay): Verb => [
    () => ctx.overlays.open(next),
    { tracked: false },
  ];
  // What had focus when the verb ran (the trigger, the menu closed first).
  const focusReturn = () => {
    const active = document.activeElement;
    const anchor = active instanceof HTMLElement ? active : null;
    return {
      anchor: () => anchor,
      fallback: () => findPaneLandmarkFocusTarget(originPaneId()),
    };
  };
  const metadata = (triggerEl: HTMLButtonElement | null) => {
    const focused = document.activeElement;
    const pane =
      triggerEl?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId ??
      triggerEl?.closest<HTMLElement>("[data-pane-chrome-for]")?.dataset
        .paneChromeFor ??
      originPaneId();
    ctx.overlays.open({
      kind: "Metadata",
      mediaId: id,
      returnFocusTo:
        focused instanceof HTMLElement && focused !== document.body
          ? focused
          : triggerEl,
      fallback: () => findPaneChromeFocusTarget(pane),
    });
  };

  const verbs: Record<SimpleKind, Verb> = {
    Open: [follow("Follow"), { tracked: false }],
    OpenInNewPane: [follow("Fork"), { tracked: false }],
    MediaMetadata: [
      ({ triggerEl }) => metadata(triggerEl),
      { tracked: false },
    ],
    PlayNext: [
      () => {
        // After the playing episode's row (the server puts it first without one).
        const playing = playingEpisode(ctx.player.state)?.media_id;
        return ctx.lectern.place({ mediaId: id, title: facts.label,
          placement: playing !== undefined && playing !== id
            ? { kind: "After", media_id: playing }
            : { kind: "First" },
        });
      },
      {
        disabledReason: ctx.lectern.pending.has(id)
          ? "finish checking the pending lectern change first."
          : ctx.lectern.revision === null
            ? "load the current lectern before changing it."
            : undefined,
      },
    ],
    ResetProgress: [() => ctx.consumption.resetProgress(id)],
    LibraryPlacement: [
      () => {
        const { anchor, fallback } = focusReturn();
        ctx.openLibraryPlacement(
          [{ kind: ref.startsWith("podcast:") ? "Podcast" : "Media", id }],
          { anchor, returnFocusFallback: fallback },
        );
      },
      { tracked: false },
    ],
    Share: [
      () => {
        const { anchor, fallback } = focusReturn();
        ctx.openShare(resourceShareTarget(ref), {
          returnFocusTo: anchor,
          returnFocusFallback: fallback,
        });
      },
      { tracked: false },
    ],
    Chat: [
      () =>
        openAsyncResult(ctx, facts.label, "Adopt", async () => {
          const conversationId = await createConversationAbout(ref);
          return conversationId === null
            ? null
            : {
                href: `/conversations/${conversationId}`,
                labelHint: "Chat",
                title: "chat created",
                openLabel: "open chat",
              };
        }),
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
    EditAuthors: overlay({ kind: "Authors", mediaId: id }),
    LibrarySettings: overlay({ kind: "LibrarySettings", libraryId: id }),
    PodcastSettings: overlay({ kind: "PodcastSettings", podcastId: id }),
    RefreshPodcast: [
      () => requestPodcastRefresh({ kind: "Podcast", podcast_id: id }),
    ],
    RetryPodcastBackfill: [() => retryPodcastSubscriptionBackfill(id)],
    RemoveMedia: deleted(() => deleteMedia(id), "/libraries"),
    DeleteLibrary: deleted(() => deleteLibrary(id), "/libraries"),
    DeleteConversation: [deleteChat, { confirmation: null }],
    DeletePage: deleted(() => deletePage(id), "/notes"),
    LearnHighlight: [
      () =>
        openAsyncResult(ctx, facts.label, "Follow", async () => {
          const learned = await learnDossier(ref, crypto.randomUUID());
          return {
            href: artifactPaneHref(learned.artifact_ref),
            labelHint: "Dossier",
            title: {
              BuildAccepted: "dossier requested",
              Opened: "dossier available",
            }[learned.kind],
            openLabel: "open dossier",
          };
        }),
    ],
    RegenerateArtifact: [
      () =>
        createDossierBuild(
          { kind: "Artifact", artifactRef: ref },
          null,
          crypto.randomUUID(),
        ),
    ],
    EditPageTitle: entry({ kind: "EditPageTitle", pageId: id }),
    EditNoteBody: entry({ kind: "EditNoteBody", noteBlockId: id }),
    EditHighlight: entry({ kind: "EditHighlight", highlightId: id }),
    EditHighlightBounds: entry({
      kind: "EditHighlightBounds",
      highlightId: id,
    }),
    DeleteHighlight: entry({ kind: "DeleteHighlight", highlightId: id }),
    ForkMessage: entry({ kind: "ForkMessage", messageId: id }),
    WalkMessageSources: entry({ kind: "WalkMessageSources", messageId: id }),
    RerunMessage: entry({ kind: "RerunMessage", messageId: id }),
    RegenerateMessage: entry({ kind: "RegenerateMessage", messageId: id }),
    DeleteMessage: entry({ kind: "DeleteMessage", messageId: id }, { confirmation: null }),
  };

  const download = (
    action: Extract<Action, { kind: "Download" }>,
  ): ActionDescriptor => {
    const states = ACTION_CATALOG.Download.states;
    // Android answers on the bridge; its modeled refusal is an advisory.
    const call =
      (op: string, args: Record<string, unknown> = {}) =>
      async () => {
        try {
          await offlineCall(op, { mediaId: id, ...args });
        } catch (error) {
          if (!ctx.isActive()) return;
          const code = error instanceof Error ? error.message : "";
          ctx.feedback.offer({
            key: `download:${id}`,
            announcement: "Polite",
            content: {
              tone: "Danger",
              title:
                code === "Storage"
                  ? "Not enough device storage for this download."
                  : code === "Unsupported"
                    ? "This episode’s audio can’t be downloaded."
                    : "The download couldn’t be changed. Try again.",
            },
          });
        }
      };
    const enqueue = call("enqueue", {
      kind: action.media_kind,
      title: action.title,
      url: action.audio_url,
    });
    const { offline } = ctx;
    if (offline.kind !== "Ready")
      return make("Download", action.blocked, enqueue, {
        blocked: offline.kind === "Loading" ? "Loading" : "UnsupportedOnDevice",
      });
    const requiresOnline = ctx.online ? undefined : "RequiresOnline";
    const item = offline.items.find((candidate) => candidate.mediaId === id);
    switch (item?.state) {
      case undefined:
        return make("Download", action.blocked, enqueue, {
          blocked: requiresOnline,
          confirmation:
            action.media_kind === "web_article"
              ? {
                  title: "Download text-only copy?",
                  body: "Downloaded web articles include readable text but not images.",
                }
              : undefined,
        });
      case "Queued":
      case "Downloading":
        return make("Download", action.blocked, call("cancel"), {
          state: states.Downloading,
        });
      case "Ready":
        return make("Download", action.blocked, call("remove"), {
          state: states.Ready,
          confirmation:
            item.progress !== null && item.progress.kind !== "Canonical"
              ? {
                  title: "Remove downloaded copy?",
                  body: "Remove this copy and its position saved on this device. That position has not reached Nexus.",
                }
              : undefined,
        });
      case "Failed":
        return make("Download", action.blocked, call("retry"), {
          state: states.Failed,
          blocked: requiresOnline,
        });
      case "Removing":
        return make("Download", action.blocked, call("remove"), {
          state: states.Ready,
          blocked: "Busy",
        });
    }
  };

  const admissionRecovery = (
    kind: "SourceRefresh" | "MetadataResearch",
    actionId: "RefreshSource" | "RetryMetadata",
  ): ActionDescriptor | null => {
    const pending = ctx.admissions.pending(kind, id);
    if (pending === null) return null;
    const cleanup = pending.kind === "Cleanup";
    const disabledReason = pending.kind === "Sending"
      ? "this request is being sent"
      : pending.kind === "Blocked" && !pending.canConfirm
        ? pending.content.message ?? pending.content.title
        : !cleanup && !ctx.online ? BLOCKED_COPY.RequiresOnline : undefined;
    return make(actionId, null, () => cleanup
      ? ctx.admissions.retryCleanup(pending.key)
      : ctx.admissions.confirm(pending.key), {
      state: { label: cleanup ? "retry cleanup" : "confirm request", icon: ACTION_CATALOG[actionId].icon },
      disabledReason,
    });
  };

  const project = (action: Action): ActionDescriptor => {
    const { blocked } = action;
    switch (action.kind) {
      case "OpenSource": {
        const {
          onSelect: _,
          state: __,
          ...rest
        } = make("OpenSource", blocked, () => {});
        return { ...rest, kind: "link", href: action.href };
      }
      case "Playback": {
        const player = ctx.player.state;
        const loaded =
          player.kind === "Loaded" &&
          player.source.kind === "Episode" &&
          player.source.descriptor.media_id === id;
        const phase =
          loaded && (player.phase === "Paused" || player.phase === "Ended")
            ? player.phase
            : "Idle";
        // playAudio resumes the loaded episode, or starts at the server's resume point.
        const descriptor = action.player_descriptor;
        return make(
          "Playback",
          blocked,
          () => ctx.player.commands.playAudio(descriptor),
          { state: ACTION_CATALOG.Playback.states[phase] },
        );
      }
      case "Consumption": {
        const { finished, episode } = action;
        const states = ACTION_CATALOG.Consumption.states;
        return make(
          "Consumption",
          blocked,
          () =>
            finished
              ? ctx.consumption.markUnread(id)
              : ctx.consumption.finish(id, { leaveLectern: false }),
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
        return make(
          "Transcript",
          blocked,
          opens
            ? follow("Follow")
            : async () => {
                await apiFetch(`/api/media/${id}/transcript/request`, {
                  method: "POST",
                });
                if (!ctx.isActive()) return;
                // Imports shows the transcript's work; open panes follow it again.
                publishImportsInvalidation();
              },
          {
            state: ACTION_CATALOG.Transcript.states[state],
            tracked: !opens,
            blocked:
              state === "queued" || state === "running"
                ? "Processing"
                : state === "unavailable"
                  ? "TemporarilyUnavailable"
                  : undefined,
          },
        );
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
      case "PodcastSubscription": {
        const { subscribed } = action;
        const states = ACTION_CATALOG.PodcastSubscription.states;
        return make(
          "PodcastSubscription",
          blocked,
          () =>
            subscribed
              ? unsubscribeFromPodcast(id)
              : ctx.overlays.open({ kind: "Subscribe", podcastId: id }),
          {
            state: subscribed ? states.Subscribed : states.Unsubscribed,
            tracked: subscribed,
          },
        );
      }
      case "RetryMetadata": {
        const recovery = admissionRecovery("MetadataResearch", "RetryMetadata");
        if (recovery !== null) return recovery;
        const { retry } = action;
        return make(
          "RetryMetadata",
          blocked,
          async () => {
            if (retry.status !== "allowed") return;
            const result = await ctx.admissions.admit({ kind: "MetadataResearch", mediaId: id, request: { expected_job_id: retry.expected_job_id } });
            if (!ctx.isActive()) return;
            if (result.kind === "LocalFailure") ctx.feedback.offer({ key: `metadata-admission:${id}`, content: result.content, announcement: "Polite" });
          },
          {
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
        const recovery = admissionRecovery("SourceRefresh", "RefreshSource");
        if (recovery !== null) return recovery;
        return make(
          "RefreshSource",
          blocked,
          async () => {
            if (action.expected_attempt_id === null) return;
            const result = await ctx.admissions.admit({ kind: "SourceRefresh", mediaId: id, request: { expected_attempt_id: action.expected_attempt_id } });
            if (!ctx.isActive()) return;
            if (result.kind === "LocalFailure") ctx.feedback.offer({ key: `source-admission:${id}`, content: result.content, announcement: "Polite" });
          },
          {
            blocked: ctx.online ? undefined : "RequiresOnline",
            disabledReason: action.expected_attempt_id === null
              ? "source refresh requires a settled source attempt"
              : blocked !== null && blocked !== "PermissionDenied"
                ? "source refresh is unavailable in the current state"
                : undefined,
          },
        );
      }
      case "ReviewMetadataResult":
        return make("ReviewMetadataResult", blocked, () =>
          submitMetadataResultReview(id, action.job_id),
        );
      case "Recovery":
        return make(action.offer.kind, blocked, () =>
          recoverMedia(id, action.offer),
        );
      case "HighlightNote": {
        const noteBlockId = action.note_block_id;
        const states = ACTION_CATALOG.HighlightNote.states;
        const [execute, options] = entry({
          kind: "EditHighlightNote",
          highlightId: id,
          noteBlockId,
        });
        return make("HighlightNote", blocked, execute, {
          ...options,
          state: noteBlockId === null ? states.Absent : states.Present,
        });
      }
      default: {
        const [execute, options] = verbs[action.kind];
        return make(action.kind, blocked, execute, options);
      }
    }
  };

  // Catalog order is menu order; a separator starts each new group.
  const byId = new Map(
    facts.actions.map((action) => {
      const descriptor = project(action);
      return [descriptor.id, descriptor] as const;
    }),
  );
  const menu: ActionDescriptor[] = [];
  let group: string | undefined;
  for (const [actionId, catalogEntry] of Object.entries(ACTION_CATALOG)) {
    const descriptor = byId.get(actionId);
    if (!descriptor) continue;
    const separatorBefore = group !== undefined && group !== catalogEntry.group;
    menu.push({ ...descriptor, separatorBefore: separatorBefore || undefined });
    group = catalogEntry.group;
  }
  return menu;
}
