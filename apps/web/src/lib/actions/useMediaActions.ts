"use client";

/** Shared media commands read the account runtime, never the lazy resource menu. */
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

export interface MediaAction {
  readonly id: "Playback" | "LecternMembership" | "LibraryPlacement";
  readonly label: string;
  readonly glyph: "Play" | "Pause" | "ListPlus" | "ListMinus" | "Library";
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly busy: boolean;
  readonly invoke: (trigger: HTMLElement | null, returnFocus: () => HTMLElement | null) => void;
}

export function useMediaActions(subject: MediaSubject, knownDescriptor: PlayerDescriptor | null): readonly MediaAction[] {
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
  const holding = creatingLibrary || operation !== null && operation.phase !== "complete";
  const heldReason = creatingLibrary ? "finish creating this item's library first" : "finish this item's import first";
  const actions: MediaAction[] = [];
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
      actions.push({ id: "Playback", label: projected.label, glyph: projected.glyph, busy: false,
        disabled: projected.disabled === true || !available,
        disabledReason: projected.disabledReason ?? (available ? null : "audio unavailable"),
        invoke: trigger => { if (available) projected.onSelect({ triggerEl: trigger, openIntent: "default" }); },
      });
    } else actions.push({ id: "Playback", label, glyph: playing ? "Pause" : "Play", busy: false,
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
    actions.push({ id: "LecternMembership", label,
      glyph: (request?.intent.kind ?? intent) === "Remove" ? "ListMinus" : "ListPlus",
      disabled: projected.disabled === true,
      disabledReason: projected.disabledReason ?? null,
      busy: busy.has("LecternMembership") || (request !== undefined && request.phase !== "Unconfirmed"),
      invoke: trigger => {
        if (projected.disabled) return;
        projected.onSelect({ triggerEl: trigger, openIntent: "default" });
      },
    });
  } else {
    const label = "add to lectern";
    actions.push({ id: "LecternMembership", label, glyph: "ListPlus",
      disabled: holding, disabledReason: holding ? heldReason : null, busy: holding,
      invoke: () => { if (subject.kind === "External" && !holding) ctx.mediaContinuations.start(subject, { kind: "Lectern" }, null); },
    });
  }
  actions.push({ id: "LibraryPlacement", label: "manage libraries", glyph: "Library", disabled: holding,
    disabledReason: holding ? heldReason : null, busy: holding,
    invoke: (trigger, fallback) => {
      if (holding) return;
      const options = { anchor: () => trigger, returnFocusFallback: fallback };
      if (mediaId !== null) placement.openLibraryPlacement([{ kind: "Media", id: mediaId }], options);
      else if (subject.kind === "External") placement.openExternalLibraryPlacement({ target: subject.target, pending: holding,
        choose: (library, sessionKey) => ctx.mediaContinuations.start(subject, { kind: "Library", library }, sessionKey),
      }, options);
    },
  });
  return actions;
}
