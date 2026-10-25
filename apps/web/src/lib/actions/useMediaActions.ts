"use client";

/** Shared media commands read the account runtime, never the lazy resource menu. */
import { installedApp, remoteReady } from "@/lib/native/admission";
import { createElement } from "react";
import { Library, ListMinus, ListPlus, Pause, Play } from "lucide-react";
import type { ActionButtonSpec } from "@/lib/actions/inlineActions";
import { useActionRuntime, useBusyActionIds } from "@/lib/actions/ResourceActionsProvider";
import { usePlaybackSource } from "./playbackSource";
import { projectLecternAction, projectPlaybackAction } from "@/lib/actions/project";
import { compareRevision } from "@/lib/collections/order";
import { ApiError, requestWithDeadline } from "@/lib/api/client";
import { browsePreviewHref, fetchBrowsePreview } from "@/lib/browse/api";
import { useLibraryPlacementController } from "@/lib/libraries/placementController";
import { buildMediaImageProxySrc } from "@/lib/media/imageProxy";
import type { MediaSubject } from "@/lib/media/mediaSummary";
import type { PlayerDescriptor } from "@/lib/player/playerRuntime";
import { continuationRecoveryLabel } from "./mediaContinuation";

export function useMediaActions(subject: MediaSubject, knownDescriptor: PlayerDescriptor | null): readonly ActionButtonSpec[] {
  const { ctx, run } = useActionRuntime();
  const source = usePlaybackSource();
  const placement = useLibraryPlacementController();
  const operation = subject.kind === "External" ? ctx.mediaContinuations.forSubject(subject.target) : null;
  // A completed acquisition provides canonical identity for this sealed target.
  const admittedId = subject.kind === "External" && operation?.phase === "complete" ? operation.finalMediaId : null;
  const mediaId = subject.kind === "Stored" ? subject.summary.media_id : admittedId;
  const title = subject.kind === "Stored" ? subject.summary.title : subject.title;
  const kind = subject.kind === "Stored" ? subject.summary.media_kind : subject.media_kind;
  if (knownDescriptor !== null && (subject.kind !== "Stored" || knownDescriptor.media_id !== subject.summary.media_id))
    throw new Error("media actions descriptor does not match stored subject");
  const ref = subject.kind === "Stored" ? `media:${subject.summary.media_id}`
    : admittedId !== null ? `media:${admittedId}` : `external:${subject.target}`;
  const busy = useBusyActionIds(ref);
  const { read, receipts, pending } = ctx.lectern;
  const request = mediaId === null ? undefined : pending.get(mediaId);
  const receipt = mediaId === null ? undefined : receipts.get(mediaId);
  const newerReceipt = receipt !== undefined && (read.status !== "ready" || compareRevision(receipt.order_revision, read.data.order_revision) > 0);
  const present = newerReceipt ? receipt.present : read.status === "ready"
    ? read.data.items.some(item => item.media_summary.media_id === mediaId) : null;
  const sharedItem = mediaId === null || read.status !== "ready" ? null
    : read.data.items.find(item => item.media_summary.media_id === mediaId) ?? null;
  const sharedDescriptor = sharedItem?.activation.kind === "FooterAudio" ? sharedItem.activation.descriptor : null;
  const descriptor = knownDescriptor ?? sharedDescriptor;
  const creatingLibrary = subject.kind === "External" && placement.hasPendingExternalCreation(subject.target);
  const disconnected = installedApp && !ctx.online;
  const holding = creatingLibrary || operation !== null && operation.phase !== "complete";
  const creationFailed = subject.kind === "External" && placement.hasFailedExternalCreation(subject.target);
  const heldReason = creationFailed ? "this item's library wasn’t created; retry it from manage libraries"
    : creatingLibrary ? "finish creating this item's library first"
    : operation?.failure ? operation.failure.content.title : "finish this item's import first";
  // A failed continuation keeps its recovery on the control for its destination.
  const recovery = operation !== null && operation.failure !== null ? {
    destination: operation.destination.kind,
    label: continuationRecoveryLabel(operation, operation.failure),
    invoke: () => { if (!installedApp || remoteReady()) ctx.mediaContinuations.recover(operation.intentId); },
  } : null;
  const actions: ActionButtonSpec[] = [];
  if (kind === "podcast_episode") {
    const state = ctx.player.state;
    const loadedPreview = state.kind === "Loaded" && subject.kind === "External" &&
      state.source.kind === "Preview" && state.source.descriptor.target === subject.target;
    const loaded = state.kind === "Loaded" && (loadedPreview || mediaId !== null &&
      state.source.kind === "Episode" && state.source.descriptor.media_id === mediaId);
    const pendingPlayback = ctx.player.pendingPlayback;
    const pending = pendingPlayback !== null && (
      mediaId !== null && pendingPlayback.kind === "Episode" && pendingPlayback.mediaId === mediaId ||
      subject.kind === "External" && pendingPlayback.kind === "Preview" && pendingPlayback.target === subject.target);
    const playing = pending || loaded && (state.phase === "Playing" || state.phase === "Buffering");
    const verb = playing ? "pause" : loaded && state.phase === "Ended" ? "replay" : loaded ? "resume" : "play";
    const available = pending || loaded || (subject.kind === "Stored" ? subject.summary.can_play : true);
    const updateRequired = state.kind === "Unavailable" && state.reason === "UpdateRequired";
    const label = verb;
    if (mediaId !== null && !loadedPreview) {
      const projected = projectPlaybackAction({ mediaId, title, descriptor, blocked: null, playbackSource: source, ctx, run });
      actions.push({ controlKey: "Playback", hasPopup: null, id: "Playback", menuLabel: projected.label, accessibleLabel: `${projected.label}: ${title}`, icon: projected.icon, busy: false,
        disabled: projected.disabled === true || !available,
        disabledReason: projected.disabledReason ?? (available ? null : "audio unavailable"),
        invoke: ({ trigger }) => { if (available) projected.onSelect({ triggerEl: trigger, openIntent: "default" }); },
      });
    } else actions.push({ controlKey: "Playback", hasPopup: null, id: "Playback", menuLabel: label, accessibleLabel: `${label}: ${title}`, icon: createElement(playing ? Pause : Play), busy: false,
      disabled: updateRequired || !available,
      disabledReason: updateRequired ? "update nexus for android to play audio" : available ? null : "audio unavailable",
      invoke: () => {
        if (updateRequired || !available) return;
        if (playing) { ctx.player.commands.pause(); return; }
        run({ ref, id: "Playback", title, label, tracked: false, confirmation: null, execute: async () => {
          if (subject.kind !== "External") return;
          return ctx.player.commands.playPreviewAudio({ target: subject.target, resolveDescriptor: async () => {
            const signal = ctx.sessionSignal();
            const target = subject.target;
            const preview = await requestWithDeadline({ signal, timeoutMs: 2_000,
              request: requestSignal => fetchBrowsePreview(target, requestSignal),
            });
            signal.throwIfAborted();
            if (preview.kind !== "Episode" || preview.kind_facts.audio_href.trim() === "")
              throw new ApiError(409, "E_AUDIO_UNAVAILABLE", "audio unavailable");
            return { target: preview.target, title: preview.title,
              previewHref: browsePreviewHref(preview.target), source: preview.source, sourceHref: preview.source_href,
              audioUrl: preview.kind_facts.audio_href,
              imageUrl: preview.image === null ? null : buildMediaImageProxySrc(preview.image),
              durationMs: preview.kind_facts.duration_seconds === null ? null : preview.kind_facts.duration_seconds * 1000,
            };
          } });
        } });
      },
    });
  }
  if (mediaId !== null) {
    const intent = present === null ? null : present ? "Remove" : "Ensure";
    const projected = projectLecternAction({ mediaId, title, intent, blocked: null, ctx, busy, run });
    const label = request === undefined && present !== null && ctx.lectern.revision !== null
      ? present ? "remove from lectern" : "add to lectern" : projected.label;
    actions.push({ controlKey: "LecternMembership", hasPopup: null, id: "LecternMembership", menuLabel: label, accessibleLabel: `${label}: ${title}`,
      icon: createElement((request?.intent.kind ?? intent) === "Remove" ? ListMinus : ListPlus),
      disabled: projected.disabled === true,
      disabledReason: projected.disabledReason ?? null,
      busy: busy.has("LecternMembership") || (request !== undefined && request.phase !== "Unconfirmed"),
      invoke: ({ trigger }) => {
        if (projected.disabled) return;
        projected.onSelect({ triggerEl: trigger, openIntent: "default" });
      },
    });
  } else {
    if (recovery?.destination === "Lectern") actions.push({ controlKey: "LecternMembership", hasPopup: null, id: "LecternMembership",
      menuLabel: recovery.label, accessibleLabel: `${recovery.label}: ${title}`, icon: createElement(ListPlus), disabled: disconnected, disabledReason: disconnected ? "requires a connection" : null, busy: false,
      invoke: recovery.invoke });
    else actions.push({ controlKey: "LecternMembership", hasPopup: null, id: "LecternMembership", menuLabel: "add to lectern", accessibleLabel: `add to lectern: ${title}`, icon: createElement(ListPlus),
      disabled: holding || disconnected, disabledReason: disconnected ? "requires a connection" : holding ? heldReason : null, busy: holding && recovery === null,
      invoke: () => { if (subject.kind === "External" && !holding && (!installedApp || remoteReady())) ctx.mediaContinuations.start(subject, { kind: "Lectern" }, null); },
    });
  }
  if (kind === "podcast_episode" && mediaId === null) {
    const heldRecovery = recovery?.destination === "All" ? recovery : null;
    const label = heldRecovery?.label ?? "add to all";
    actions.push({ controlKey: "AddEpisodeToAll", hasPopup: null, id: "AddEpisodeToAll", menuLabel: label,
      accessibleLabel: `${label}: ${title}`, icon: createElement(ListPlus),
      disabled: disconnected || holding && heldRecovery === null,
      disabledReason: disconnected ? "requires a connection" : holding && heldRecovery === null ? heldReason : null,
      busy: holding && heldRecovery === null,
      invoke: () => {
        if (heldRecovery) { heldRecovery.invoke(); return; }
        if (subject.kind === "External" && !holding && (!installedApp || remoteReady()))
          ctx.mediaContinuations.start(subject, { kind: "All" }, null);
      },
    });
  }
  if (recovery?.destination === "Library") actions.push({ controlKey: "LibraryPlacement", hasPopup: "dialog", id: "LibraryPlacement",
    menuLabel: recovery.label, accessibleLabel: `${recovery.label}: ${title}`, icon: createElement(Library), disabled: disconnected, disabledReason: disconnected ? "requires a connection" : null, busy: false,
    invoke: recovery.invoke });
  // A failed library creation keeps "manage libraries" open: its editor holds the retry.
  else actions.push({ controlKey: "LibraryPlacement", hasPopup: "dialog", id: "LibraryPlacement", menuLabel: "manage libraries", accessibleLabel: `manage libraries: ${title}`, icon: createElement(Library),
    disabled: holding && !creationFailed || disconnected,
    disabledReason: disconnected ? "requires a connection" : holding && !creationFailed ? heldReason : null, busy: holding && !creationFailed && recovery === null,
    invoke: ({ trigger, returnFocus }) => {
      if (holding && !creationFailed || installedApp && !remoteReady()) return;
      const options = { anchor: () => trigger, returnFocusFallback: returnFocus };
      if (mediaId !== null) placement.openLibraryPlacement([{ kind: "Media", id: mediaId }], options);
      else if (subject.kind === "External") placement.openExternalLibraryPlacement({ target: subject.target, pending: holding && !creationFailed,
        choose: (library, sessionKey) => ctx.mediaContinuations.start(subject, { kind: "Library", library }, sessionKey),
      }, options);
    },
  });
  return actions;
}
