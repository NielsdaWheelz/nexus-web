"use client";

import { useEffect } from "react";
import {
  createMountedActionHandoff,
  MOUNTED_ACTION_ACCEPTED,
  MOUNTED_ACTION_DEFERRED,
  type CommittingMountedActionIntentBase,
  type DestructiveCommittingMountedActionIntentBase,
  type MountedActionRequest,
} from "@/lib/actions/mountedActionHandoff";
import type { CanonicalResourceRef } from "@/lib/sharing/types";

export type HighlightActionIntent =
  | (CommittingMountedActionIntentBase &
      (
        | { readonly kind: "EditHighlight" }
        | { readonly kind: "AddHighlightNote" }
        | {
            readonly kind: "EditHighlightNote";
            readonly noteBlockId: string;
          }
        | { readonly kind: "LinkHighlight" }
        | { readonly kind: "EditHighlightBounds" }
      ))
  | (DestructiveCommittingMountedActionIntentBase & {
      readonly kind: "DeleteHighlight";
    });

const handoff = createMountedActionHandoff<HighlightActionIntent>();

export function requestHighlightActionIntent(
  intent: HighlightActionIntent,
): MountedActionRequest {
  return handoff.request(intent);
}

export function useHighlightActionIntentOwner(
  ref: CanonicalResourceRef | null,
  accept: (intent: HighlightActionIntent) => boolean,
): void {
  useEffect(() => {
    if (ref === null) return;
    return handoff.subscribe(ref, (intent) =>
      accept(intent) ? MOUNTED_ACTION_ACCEPTED : MOUNTED_ACTION_DEFERRED,
    );
  }, [accept, ref]);
}

export function notifyHighlightActionIntentOwnerReady(
  ref: CanonicalResourceRef,
): void {
  handoff.notifyReady(ref);
}

/** A reader pane owns every Highlight currently mounted in its projection. */
export function useHighlightActionIntentOwners(
  refs: readonly CanonicalResourceRef[],
  accept: (intent: HighlightActionIntent) => boolean,
): void {
  useEffect(() => {
    const owner = (intent: HighlightActionIntent) =>
      accept(intent) ? MOUNTED_ACTION_ACCEPTED : MOUNTED_ACTION_DEFERRED;
    const unsubscribe = refs.map((ref) => handoff.subscribe(ref, owner));
    return () => {
      for (const release of unsubscribe) release();
    };
  }, [accept, refs]);
}
