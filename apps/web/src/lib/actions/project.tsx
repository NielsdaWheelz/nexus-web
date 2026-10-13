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
import {
  artifactPaneHref,
  createDossierBuild,
  learnDossier,
} from "@/lib/dossiers/dossierApi";
import { recoverMedia, requestSourceRefresh } from "@/lib/imports/api";
import {
  assumeLecternItemId,
  assumeMediaId,
  playerDescriptorFromWire,
} from "@/lib/lectern/contract";
import { deleteMemberLibrary } from "@/lib/libraries/client";
import { deleteMedia } from "@/lib/media/mediaLibraries";
import {
  metadataResearchLabel,
  metadataRetryBlockedCopy,
} from "@/lib/media/mediaMetadataCopy";
import {
  requestMetadataResearch,
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
  readonly checked?: boolean;
  /** A client fact blocking the verb; the server's reason wins. */
  readonly blocked?: BlockedReason;
  /** Copy that explains a block better than the generic reason. */
  readonly disabledReason?: string;
  readonly confirmation?: Confirmation;
  readonly tracked?: boolean;
  readonly restoreFocusOnClose?: boolean;
}
type Verb = readonly [
  execute: (detail: ActionSelectDetail) => unknown,
  options?: Options,
];

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
  const mediaId = assumeMediaId(id);
  const { lectern } = ctx;
  // A verb acts from the pane active when it runs.
  const originPaneId = () => ctx.workspace().state.active_primary_pane_id;
  const activate = (
    request: Omit<WorkspaceTargetActivationRequest, "originPaneId">,
  ) =>
    ctx
      .workspace()
      .activateWorkspaceTarget({ ...request, originPaneId: originPaneId() });

  const lecternBlocked = (adding: boolean): BlockedReason | undefined => {
    const { resource } = lectern;
    if (resource.status === "error") return "TemporarilyUnavailable";
    if (resource.status !== "ready") return "Loading";
    if (lectern.busy) return "Busy";
    if (adding && resource.data.atCapacity) return "CapacityReached";
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
      restoreFocusOnClose: options.restoreFocusOnClose,
      state:
        options.checked === undefined
          ? undefined
          : { kind: "toggle", pressed: options.checked },
      onSelect: (detail) =>
        run({
          ref,
          id: actionId,
          label: entry.label,
          title: facts.label,
          confirmation: options.confirmation ?? entry.confirmation ?? null,
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
  const go = (href: string, labelHint: string, kind: "Follow" | "Adopt") =>
    activate({
      target: { href, labelHint },
      disposition: { kind },
    });
  // An edit whose state lives in a mounted pane: go there and hand it the entry.
  const entry = (paneEntry: WorkspacePaneEntry): Verb => [
    () =>
      activation.href !== null &&
      activate({
        target: { href: activation.href },
        disposition: { kind: "Follow" },
        paneEntryActivation: {
          activationId: crypto.randomUUID(),
          entry: paneEntry,
        },
      }),
    { tracked: false },
  ];
  const deleted = (
    remove: () => Promise<unknown>,
    fallbackHref: string,
  ): Verb => [
    async () => {
      await remove();
      settleDeletedResourcePanes({
        workspace: ctx.workspace(),
        deletedRef: ref,
        fallbackHref,
      });
    },
  ];
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
    const pane =
      triggerEl?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId ??
      triggerEl?.closest<HTMLElement>("[data-pane-chrome-for]")?.dataset
        .paneChromeFor ??
      originPaneId();
    ctx.overlays.open({
      kind: "Metadata",
      mediaId: id,
      returnFocusTo: triggerEl,
      fallback: () => findPaneChromeFocusTarget(pane),
    });
  };

  const verbs: Record<SimpleKind, Verb> = {
    Open: [follow("Follow"), { tracked: false }],
    OpenInNewPane: [follow("Fork"), { tracked: false }],
    MediaMetadata: [
      ({ triggerEl }) => metadata(triggerEl),
      { tracked: false, restoreFocusOnClose: false },
    ],
    PlayNext: [
      () => {
        // After the playing episode's row (when it is another media), else first.
        const playing = playingEpisode(ctx.player.state)?.media_id;
        const row = lectern
          .getCanonicalSnapshot()
          ?.items.find(
            (item) =>
              item.mediaSummary.media_id === playing && playing !== mediaId,
          );
        return lectern.placeItems({
          mediaIds: [mediaId],
          placement: row
            ? { kind: "After", itemId: row.itemId }
            : { kind: "First" },
        });
      },
      { blocked: lecternBlocked(true) },
    ],
    ResetProgress: [
      () => lectern.resetProgress(mediaId),
      { blocked: lecternBlocked(false) },
    ],
    LibraryPlacement: [
      () => {
        const { anchor, fallback } = focusReturn();
        ctx.openLibraryPlacement(
          { kind: ref.startsWith("podcast:") ? "Podcast" : "Media", id },
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
      async () => {
        const conversationId = await createConversationAbout(ref);
        if (conversationId !== null)
          go(`/conversations/${conversationId}`, "Chat", "Adopt");
      },
    ],
    LinkResource: [
      () => ctx.linkComposer.openResourceLink(ref),
      { tracked: false },
    ],
    DownloadOriginal: [
      async () => {
        const response = await apiFetch<
          ApiJson<"/media/{media_id}/file", "get">
        >(`/api/media/${id}/file`, { cache: "no-store" });
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
    DeleteLibrary: deleted(() => deleteMemberLibrary(id), "/libraries"),
    DeleteConversation: deleted(() => deleteConversation(id), "/conversations"),
    DeletePage: deleted(() => deletePage(id), "/notes"),
    LearnHighlight: [
      async () => {
        const learned = await learnDossier(ref, crypto.randomUUID());
        go(artifactPaneHref(learned.artifact_ref), "Dossier", "Follow");
      },
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
    DeleteMessage: entry({ kind: "DeleteMessage", messageId: id }),
  };

  const download = (
    action: Extract<Action, { kind: "Download" }>,
  ): ActionDescriptor => {
    const states = ACTION_CATALOG.Download.states;
    // Android answers on the bridge; a refusal is a hud, never a defect.
    const call =
      (op: string, args: Record<string, unknown> = {}) =>
      async () => {
        try {
          await offlineCall(op, { mediaId: id, ...args });
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          ctx.feedback.publish({
            kind: "Hud",
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
        checked: false,
        blocked: offline.kind === "Loading" ? "Loading" : "UnsupportedOnDevice",
      });
    const requiresOnline = ctx.online ? undefined : "RequiresOnline";
    const item = offline.items.find((candidate) => candidate.mediaId === id);
    switch (item?.state) {
      case undefined:
        return make("Download", action.blocked, enqueue, {
          checked: false,
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
          checked: false,
        });
      case "Ready":
        return make("Download", action.blocked, call("remove"), {
          state: states.Ready,
          checked: true,
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
          checked: false,
          blocked: requiresOnline,
        });
      case "Removing":
        return make("Download", action.blocked, call("remove"), {
          state: states.Ready,
          checked: true,
          blocked: "Busy",
        });
    }
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
          player.source.descriptor.media_id === mediaId;
        const phase =
          loaded && (player.phase === "Paused" || player.phase === "Ended")
            ? player.phase
            : "Idle";
        // playAudio resumes the loaded episode, or starts at the server's resume point.
        const descriptor = playerDescriptorFromWire(action.player_descriptor);
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
          async () => {
            if (finished) return lectern.setUnread(mediaId);
            const before = lectern.getCanonicalSnapshot() ?? { items: [] };
            const { finishId } = await lectern.ensureMediaFinished(mediaId);
            ctx.offerCompletionUndo({ mediaId, before, finishId, done: false });
          },
          {
            state: episode
              ? finished
                ? states.EpisodePlayed
                : states.EpisodeUnplayed
              : finished
                ? states.DocumentFinished
                : states.DocumentIncomplete,
            checked: finished,
            blocked: lecternBlocked(false),
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
            : () =>
                apiFetch(`/api/media/${id}/transcript/request`, {
                  method: "POST",
                }),
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
        const itemId = action.lectern_item_id;
        const states = ACTION_CATALOG.LecternMembership.states;
        // An unacknowledged add owns its frozen command: the menu checks it
        // instead of sending another (fresh membership facts cannot settle it).
        const request =
          itemId === null ? lectern.ensureRequests.get(mediaId) : undefined;
        if (request) {
          const unconfirmed = request.kind === "Unconfirmed";
          return {
            kind: "command",
            id: "LecternMembership",
            label: request.kind === "Sending" ? "adding…" : "check add",
            icon: createElement(states.Absent.icon, {
              size: 16,
              "aria-hidden": true,
            }),
            disabled: !unconfirmed || undefined,
            onSelect: () => {
              if (request.kind === "Unconfirmed") request.check();
            },
          };
        }
        return make(
          "LecternMembership",
          blocked,
          () =>
            itemId === null
              ? lectern.ensureItem({ mediaId, title: facts.label })
              : lectern.removeItem(assumeLecternItemId(itemId)),
          {
            state: itemId === null ? states.Absent : states.Present,
            checked: itemId !== null,
            blocked: lecternBlocked(itemId === null),
          },
        );
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
            checked: subscribed,
            tracked: subscribed,
          },
        );
      }
      case "RetryMetadata": {
        const { retry } = action;
        return make(
          "RetryMetadata",
          blocked,
          ({ triggerEl }) =>
            retry.status === "allowed" &&
            requestMetadataResearch(id, retry.expected_job_id, {
              feedback: ctx.feedback,
              showMetadata: () => metadata(triggerEl),
            }),
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
      case "RefreshSource":
        return make(
          "RefreshSource",
          blocked,
          ({ triggerEl }) =>
            requestSourceRefresh(id, action.expected_attempt_id, {
              feedback: ctx.feedback,
              showMetadata: () => metadata(triggerEl),
            }),
          {
            blocked: ctx.online ? undefined : "RequiresOnline",
            disabledReason:
              blocked !== null && blocked !== "PermissionDenied"
                ? "source refresh is unavailable in the current state"
                : undefined,
          },
        );
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
