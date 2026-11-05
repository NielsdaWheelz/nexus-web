"use client";

/** Shared media commands read the account runtime, never the lazy resource menu. */
import { installedApp, remoteReady } from "@/lib/native/admission";
import { createElement } from "react";
import type { ActionButtonSpec } from "@/lib/actions/inlineActions";
import { ACTION_CATALOG, admissionReason } from "@/lib/actions/catalog";
import { useActionRuntime, useBusyActionIds } from "@/lib/actions/ResourceActionsProvider";
import { usePlaybackSource } from "./playbackSource";
import { projectLecternAction, projectPlaybackAction } from "@/lib/actions/project";
import { compareRevision } from "@/lib/collections/order";
import { useLibraryPlacementController } from "@/lib/libraries/placementController";
import { mediaSubjectKind, type MediaSubject } from "@/lib/media/mediaSummary";
import type { PlayerDescriptor } from "@/lib/player/playerRuntime";
import * as Icon from "@/lib/ui/icons";
import { continuationRecovery } from "./mediaContinuation";

export function useMediaActions(subject: MediaSubject, knownDescriptor: PlayerDescriptor | null): readonly ActionButtonSpec[] {
  const { ctx, run } = useActionRuntime();
  const source = usePlaybackSource();
  const placement = useLibraryPlacementController();
  const operation = subject.kind === "External" ? ctx.mediaContinuations.forSubject(subject.target) : null;
  // A completed acquisition provides canonical identity for this sealed target.
  const admittedId = subject.kind === "External" && operation?.phase === "complete" ? operation.finalMediaId : null;
  const mediaId = subject.kind === "Stored" ? subject.summary.media_id : admittedId;
  const title = subject.kind === "Stored" ? subject.summary.title : subject.title;
  const kind = mediaSubjectKind(subject);
  if (knownDescriptor !== null && (subject.kind !== "Stored" || knownDescriptor.media_id !== subject.summary.media_id))
    throw new Error("media actions descriptor does not match stored subject");
  const ref = subject.kind === "Stored" ? `media:${subject.summary.media_id}`
    : admittedId !== null ? `media:${admittedId}` : `external:${subject.target}`;
  const busy = useBusyActionIds(ref);
  const { read, itemsById, receipts, pending } = ctx.lectern;
  const request = mediaId === null ? undefined : pending.get(mediaId);
  const receipt = mediaId === null ? undefined : receipts.get(mediaId);
  const newerReceipt = receipt !== undefined && (read.status !== "ready" || compareRevision(receipt.order_revision, read.data.order_revision) > 0);
  const sharedItem = mediaId === null ? null : itemsById.get(mediaId) ?? null;
  const present = newerReceipt ? receipt.present : read.status === "ready" ? sharedItem !== null : null;
  const sharedDescriptor = sharedItem?.activation.kind === "FooterAudio" ? sharedItem.activation.descriptor : null;
  const descriptor = knownDescriptor ?? sharedDescriptor;
  const creatingLibrary = subject.kind === "External" && placement.hasPendingExternalCreation(subject.target);
  const disconnected = installedApp && !ctx.online;
  const holding = creatingLibrary || operation !== null && operation.phase !== "complete";
  const creationFailed = subject.kind === "External" && placement.hasFailedExternalCreation(subject.target);
  // A creation that failed or a failure is durable; a creation or import under way is a wait.
  const held = creationFailed ? { reason: "this item’s library wasn’t created. retry it in libraries.", waiting: false }
    : creatingLibrary ? { reason: "a library for this item is being created.", waiting: true }
    : operation?.failure ? { reason: operation.failure.line.fact, waiting: false }
    : { reason: "this item is still importing.", waiting: true };
  // A failed continuation keeps its recovery on the control for its destination.
  const recovery = operation !== null && operation.failure !== null ? {
    destination: operation.destination.kind,
    ...continuationRecovery(operation, operation.failure),
    busy: operation.failure.unknown && operation.failure.busy,
    invoke: () => { if (!installedApp || remoteReady()) ctx.mediaContinuations.recover(operation.intentId); },
  } : null;
  const actions: ActionButtonSpec[] = [];
  if (kind === "podcast_episode" && mediaId !== null) {
    const state = ctx.player.state;
    const loaded = state.kind === "Loaded" && state.source.descriptor.media_id === mediaId;
    const available = ctx.player.pendingPlayback?.mediaId === mediaId || loaded || (subject.kind === "Stored" ? subject.summary.can_play : true);
    const projected = projectPlaybackAction({ mediaId, title, descriptor, blocked: null, playbackSource: source, ctx, run });
    actions.push({ controlKey: "Playback", hasPopup: null, id: "Playback", menuLabel: projected.label, accessibleLabel: `${projected.label}: ${title}`, icon: projected.icon, busy: false,
      disabled: projected.disabled === true || !available,
      disabledReason: projected.disabledReason ?? (available ? null : "this item has no audio."),
      waiting: projected.waiting === true,
      invoke: ({ trigger }) => { if (available) projected.onSelect({ triggerEl: trigger, openIntent: "default" }); },
    });
  }
  if (mediaId !== null) {
    const intent = present === null ? null : present ? "Remove" : "Ensure";
    const projected = projectLecternAction({ mediaId, title, intent, blocked: null, ctx, busy, run });
    const label = projected.label;
    actions.push({ controlKey: "LecternMembership", hasPopup: null, id: "LecternMembership", menuLabel: label, accessibleLabel: `${label}: ${title}`,
      icon: projected.icon,
      disabled: projected.disabled === true,
      disabledReason: projected.disabledReason ?? null,
      waiting: projected.waiting === true,
      busy: busy.has("LecternMembership") || (request !== undefined && request.phase !== "Unconfirmed"),
      invoke: ({ trigger }) => {
        if (projected.disabled) return;
        projected.onSelect({ triggerEl: trigger, openIntent: "default" });
      },
    });
  } else {
    if (recovery?.destination === "Lectern") actions.push({ controlKey: "LecternMembership", hasPopup: null, id: "LecternMembership",
      menuLabel: recovery.label, accessibleLabel: `${recovery.label}: ${title}`, icon: createElement(recovery.retry ? Icon.Again : ACTION_CATALOG.LecternMembership.icon), disabled: disconnected, disabledReason: disconnected ? admissionReason() : null, waiting: false, busy: recovery.busy,
      invoke: recovery.invoke });
    else actions.push({ controlKey: "LecternMembership", hasPopup: null, id: "LecternMembership", menuLabel: ACTION_CATALOG.LecternMembership.label, accessibleLabel: `${ACTION_CATALOG.LecternMembership.label}: ${title}`, icon: createElement(ACTION_CATALOG.LecternMembership.icon),
      disabled: holding || disconnected, disabledReason: disconnected ? admissionReason() : holding ? held.reason : null,
      waiting: !disconnected && holding && held.waiting, busy: holding && recovery === null,
      invoke: () => { if (subject.kind === "External" && !holding && (!installedApp || remoteReady())) ctx.mediaContinuations.start(subject, { kind: "Lectern" }, null); },
    });
  }
  if (kind === "podcast_episode" && mediaId === null) {
    const heldRecovery = recovery?.destination === "All" ? recovery : null;
    const label = heldRecovery?.label ?? ACTION_CATALOG.AddEpisodeToAll.label;
    actions.push({ controlKey: "AddEpisodeToAll", hasPopup: null, id: "AddEpisodeToAll", menuLabel: label,
      accessibleLabel: `${label}: ${title}`, icon: createElement(heldRecovery?.retry ? Icon.Again : ACTION_CATALOG.AddEpisodeToAll.icon),
      disabled: disconnected || holding && heldRecovery === null,
      disabledReason: disconnected ? admissionReason() : holding && heldRecovery === null ? held.reason : null,
      waiting: !disconnected && holding && heldRecovery === null && held.waiting,
      busy: heldRecovery?.busy ?? (holding && heldRecovery === null),
      invoke: () => {
        if (heldRecovery) { heldRecovery.invoke(); return; }
        if (subject.kind === "External" && !holding && (!installedApp || remoteReady()))
          ctx.mediaContinuations.start(subject, { kind: "All" }, null);
      },
    });
  }
  if (recovery?.destination === "Library") actions.push({ controlKey: "LibraryPlacement", hasPopup: operation?.failure?.review ? "dialog" : null, id: "LibraryPlacement",
    menuLabel: recovery.label, accessibleLabel: `${recovery.label}: ${title}`, icon: createElement(recovery.retry ? Icon.Again : ACTION_CATALOG.LibraryPlacement.icon), disabled: disconnected, disabledReason: disconnected ? admissionReason() : null, waiting: false, busy: recovery.busy,
    invoke: recovery.invoke });
  // A failed library creation keeps "manage libraries" open: its editor holds the retry.
  else actions.push({ controlKey: "LibraryPlacement", hasPopup: "dialog", id: "LibraryPlacement", menuLabel: ACTION_CATALOG.LibraryPlacement.label, accessibleLabel: `${ACTION_CATALOG.LibraryPlacement.label}: ${title}`, icon: createElement(ACTION_CATALOG.LibraryPlacement.icon),
    disabled: holding && !creationFailed || disconnected,
    disabledReason: disconnected ? admissionReason() : holding && !creationFailed ? held.reason : null,
    waiting: !disconnected && holding && !creationFailed && held.waiting, busy: holding && !creationFailed && recovery === null,
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
