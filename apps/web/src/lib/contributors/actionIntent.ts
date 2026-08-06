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

export type ContributorActionIntent = CommittingMountedActionIntentBase & {
  readonly kind: "RenameContributor";
};

const handoff = createMountedActionHandoff<ContributorActionIntent>();

export function requestContributorActionIntent(
  intent: ContributorActionIntent,
): MountedActionRequest {
  return handoff.request(intent);
}

export function useContributorActionIntentOwner(
  ref: CanonicalResourceRef | null,
  accept: (intent: ContributorActionIntent) => boolean,
): void {
  useEffect(() => {
    if (ref === null) return;
    return handoff.subscribe(ref, (intent) =>
      accept(intent) ? MOUNTED_ACTION_ACCEPTED : MOUNTED_ACTION_DEFERRED,
    );
  }, [accept, ref]);
}

export function notifyContributorActionIntentOwnerReady(
  ref: CanonicalResourceRef,
): void {
  handoff.notifyReady(ref);
}
