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

export type PageActionIntent =
  | (CommittingMountedActionIntentBase & { readonly kind: "EditPageTitle" })
  | (DestructiveCommittingMountedActionIntentBase & {
      readonly kind: "DeletePage";
    });

export type NoteBlockActionIntent = CommittingMountedActionIntentBase & {
  readonly kind: "EditNoteBody";
};

const pageHandoff = createMountedActionHandoff<PageActionIntent>();
const noteBlockHandoff = createMountedActionHandoff<NoteBlockActionIntent>();

export function requestPageActionIntent(
  intent: PageActionIntent,
): MountedActionRequest {
  return pageHandoff.request(intent);
}

export function usePageActionIntentOwner(
  ref: CanonicalResourceRef | null,
  accept: (intent: PageActionIntent) => boolean,
): void {
  useEffect(() => {
    if (ref === null) return;
    return pageHandoff.subscribe(ref, (intent) =>
      accept(intent) ? MOUNTED_ACTION_ACCEPTED : MOUNTED_ACTION_DEFERRED,
    );
  }, [accept, ref]);
}

export function notifyPageActionIntentOwnerReady(
  ref: CanonicalResourceRef,
): void {
  pageHandoff.notifyReady(ref);
}

export function requestNoteBlockActionIntent(
  intent: NoteBlockActionIntent,
): MountedActionRequest {
  return noteBlockHandoff.request(intent);
}

export function useNoteBlockActionIntentOwner(
  ref: CanonicalResourceRef | null,
  accept: (intent: NoteBlockActionIntent) => boolean,
): void {
  useEffect(() => {
    if (ref === null) return;
    return noteBlockHandoff.subscribe(ref, (intent) =>
      accept(intent) ? MOUNTED_ACTION_ACCEPTED : MOUNTED_ACTION_DEFERRED,
    );
  }, [accept, ref]);
}

export function notifyNoteBlockActionIntentOwnerReady(
  ref: CanonicalResourceRef,
): void {
  noteBlockHandoff.notifyReady(ref);
}
