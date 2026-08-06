"use client";

import { useEffect } from "react";
import {
  createMountedActionHandoff,
  MOUNTED_ACTION_ACCEPTED,
  MOUNTED_ACTION_DEFERRED,
  type CommittingMountedActionIntentBase,
  type DestructiveCommittingMountedActionIntentBase,
  type DestructiveMountedMutationOutcome,
  type MountedActionIntentBase,
  type MountedActionRequest,
} from "@/lib/actions/mountedActionHandoff";
import type { CanonicalResourceRef } from "@/lib/sharing/types";

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
  | (DestructiveCommittingMountedActionIntentBase & {
      readonly kind: "DeleteMessage";
      readonly settleDeletedConversation: SettleDeletedMessageConversation;
    });

export type MessageActionMutationOutcome = "Committed" | "Failed";

export type ExecuteDeleteMessageMutation = (
  command: () => Promise<unknown>,
  projectCommitted: (
    evidence: "Acknowledged" | "ObservedMissing",
  ) => void | Promise<void>,
) => Promise<DestructiveMountedMutationOutcome>;

export interface DeletedMessageConversationSettlement {
  readonly conversationRef: CanonicalResourceRef;
  readonly messageEvidence: "Acknowledged" | "ObservedMissing";
  readonly receiptConversationDeleted: boolean | "Unknown";
}

export type SettleDeletedMessageConversation = (
  input: DeletedMessageConversationSettlement,
) => Promise<void>;

export type DeleteMessageMutation = (
  messageId: string,
  execute: ExecuteDeleteMessageMutation,
  settleConversation: SettleDeletedMessageConversation,
) => Promise<void>;

export type CommittingMessageActionIntent = Extract<
  MessageActionIntent,
  CommittingMountedActionIntentBase
>;

/**
 * Settle one committing message interaction exactly once. Domain failures and
 * unexpected mutation rejection abort; reconciliation failures remain a single
 * committed terminal callback and are allowed to propagate.
 */
export async function settleMessageActionMutation(
  intent: CommittingMessageActionIntent,
  mutation: () => Promise<MessageActionMutationOutcome>,
): Promise<void> {
  let outcome: MessageActionMutationOutcome;
  try {
    outcome = await mutation();
  } catch (error) {
    intent.onAborted();
    throw error;
  }
  if (outcome === "Failed") {
    intent.onAborted();
    return;
  }
  await intent.onCommitted();
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
