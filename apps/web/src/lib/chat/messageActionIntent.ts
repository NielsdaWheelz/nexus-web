"use client";

import { useEffect } from "react";
import {
  createMountedActionHandoff,
  MOUNTED_ACTION_ACCEPTED,
  MOUNTED_ACTION_DEFERRED,
  type CommittingMountedActionIntentBase,
  type MountedActionIntentBase,
  type MountedActionRequest,
} from "@/lib/actions/mountedActionHandoff";
import type { CanonicalResourceRef } from "@/lib/sharing/types";

// Message actions from the resource menu are handed to the mounted message row
// that owns them, by the message's canonical ref.

export type SettleDeletedMessageConversation = (input: {
  readonly conversationRef: CanonicalResourceRef;
  readonly conversationDeleted: boolean;
}) => void;

export type MessageActionIntent =
  | (MountedActionIntentBase &
      (
        | { readonly kind: "ForkMessage" }
        | { readonly kind: "WalkMessageSources" }
      ))
  | (CommittingMountedActionIntentBase &
      (
        | { readonly kind: "RerunMessage" }
        | { readonly kind: "RegenerateMessage" }
      ))
  | (CommittingMountedActionIntentBase & {
      readonly kind: "DeleteMessage";
      readonly settleDeletedConversation: SettleDeletedMessageConversation;
    });

export type MessageActionMutationOutcome = "Committed" | "Failed";

/**
 * Settle one committing message interaction exactly once: a failure or a
 * rejected mutation aborts; a committed one settles even if its projection fails.
 */
export async function settleMessageActionMutation(
  intent: Extract<MessageActionIntent, CommittingMountedActionIntentBase>,
  mutation: () => Promise<MessageActionMutationOutcome>,
): Promise<void> {
  let outcome: MessageActionMutationOutcome;
  try {
    outcome = await mutation();
  } catch (error) {
    intent.onAborted();
    throw error;
  }
  if (outcome === "Failed") intent.onAborted();
  else await intent.onCommitted();
}

const handoff = createMountedActionHandoff<MessageActionIntent>();

export function requestMessageActionIntent(
  intent: MessageActionIntent,
): MountedActionRequest {
  return handoff.request(intent);
}

export function useMessageActionIntentOwner(
  ref: CanonicalResourceRef | null,
  accept: (intent: MessageActionIntent) => boolean,
): void {
  useEffect(() => {
    if (ref === null) return;
    return handoff.subscribe(ref, (intent) =>
      accept(intent) ? MOUNTED_ACTION_ACCEPTED : MOUNTED_ACTION_DEFERRED,
    );
  }, [accept, ref]);
}
