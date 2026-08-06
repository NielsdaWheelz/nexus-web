"use client";

import { useEffect } from "react";
import {
  createMountedActionHandoff,
  MOUNTED_ACTION_ACCEPTED,
  MOUNTED_ACTION_DEFERRED,
  type CommittingMountedActionIntentBase,
  type MountedActionRequest,
} from "@/lib/actions/mountedActionHandoff";
import type { CanonicalResourceRef } from "@/lib/sharing/types";

export type PodcastActionIntent = CommittingMountedActionIntentBase & {
  readonly kind: "RefreshPodcast";
};

const handoff = createMountedActionHandoff<PodcastActionIntent>();

export function requestPodcastActionIntent(
  intent: PodcastActionIntent,
): MountedActionRequest {
  return handoff.request(intent);
}

export function usePodcastActionIntentOwner(
  ref: CanonicalResourceRef | null,
  accept: (intent: PodcastActionIntent) => boolean,
): void {
  useEffect(() => {
    if (ref === null) return;
    return handoff.subscribe(ref, (intent) =>
      accept(intent) ? MOUNTED_ACTION_ACCEPTED : MOUNTED_ACTION_DEFERRED,
    );
  }, [accept, ref]);
}

export function notifyPodcastActionIntentOwnerReady(
  ref: CanonicalResourceRef,
): void {
  handoff.notifyReady(ref);
}
