"use client";

import { apiFetch, isApiError, type ApiError } from "@/lib/api/client";
import { requestWithRetry } from "@/lib/api/retryPolicy";
import { decodeResourceActionSnapshotResolveResponse } from "@/lib/actions/resourceActionSnapshot";
import { publishConversationIndexChange } from "@/lib/conversations/indexRevision";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import type { FeedbackContent } from "@/components/feedback/Feedback";

const SNAPSHOT_RESOLVE_PATH = "/api/resource-items/action-snapshots/resolve";

export type DestructiveResourceActionKind =
  "RemoveMedia" | "DeleteLibrary" | "DeleteConversation";

export type CachedDestructiveActionObservation =
  "Missing" | "Present" | "Unconfirmed";

export type DestructiveActionSettlement =
  | { readonly kind: "Committed"; readonly evidence: "Acknowledged" }
  | { readonly kind: "Committed"; readonly evidence: "ObservedMissing" }
  | { readonly kind: "NotCommitted"; readonly commandError: ApiError }
  | {
      readonly kind: "Unconfirmed";
      readonly commandError: ApiError;
      readonly observationError: ApiError;
    };

/**
 * These are the only browser/BFF failures that leave command delivery or its
 * response unknowable. Same-system defects and authoritative HTTP rejections
 * remain their existing error paths.
 */
export function isAmbiguousDestructiveActionError(
  error: unknown,
): error is ApiError {
  return (
    isApiError(error) &&
    (error.code === "E_NETWORK" ||
      error.code === "E_UPSTREAM" ||
      error.code === "E_UPSTREAM_TIMEOUT")
  );
}

/** Fresh exact-one canonical read; it never depends on cache retention. */
export async function observeCanonicalResourceMissing(
  ref: CanonicalResourceRef,
): Promise<boolean> {
  const controller = new AbortController();
  let snapshots: ReturnType<typeof decodeResourceActionSnapshotResolveResponse>;
  try {
    snapshots = await requestWithRetry(async (signal) => {
      const response = await apiFetch<{ data: unknown }>(
        SNAPSHOT_RESOLVE_PATH,
        {
          method: "POST",
          body: JSON.stringify({ refs: [ref] }),
          signal,
        },
      );
      return decodeResourceActionSnapshotResolveResponse(response.data);
    }, controller.signal);
  } finally {
    controller.abort();
  }
  if (snapshots.length !== 1 || snapshots[0]?.ref !== ref) {
    // justify-defect: this read is the destructive commit witness; accepting a
    // reordered or substituted subject could settle the wrong resource.
    throw new TypeError(
      `Destructive action observation did not return exactly ${ref}`,
    );
  }
  return snapshots[0].missing;
}

/**
 * Publish the domain projection event omitted when the command committed but
 * its response was lost before the owning client could decode it.
 */
export function publishObservedDestructiveActionCommit(
  kind: DestructiveResourceActionKind,
): void {
  switch (kind) {
    case "RemoveMedia":
    case "DeleteLibrary":
      publishLibraryPlacementChange("Unknown");
      return;
    case "DeleteConversation":
      publishConversationIndexChange();
      return;
  }
}

export function unconfirmedDestructiveActionFeedback(
  settlement: Extract<DestructiveActionSettlement, { kind: "Unconfirmed" }>,
): FeedbackContent {
  return {
    tone: "Danger",
    title: "Deletion status couldn’t be confirmed",
    message:
      "Reconnect and refresh before trying again. The delete was not retried.",
    requestId:
      settlement.observationError.requestId ??
      settlement.commandError.requestId,
  };
}

/**
 * Resolve one destructive command without ever replaying it. A fresh canonical
 * action snapshot is the commit witness: every supported deletion makes its
 * subject immediately unreadable, including Media in durable teardown.
 */
export async function settleDestructiveAction(input: {
  readonly command: () => Promise<unknown>;
  readonly observeMissing: () => Promise<boolean>;
}): Promise<DestructiveActionSettlement> {
  try {
    await input.command();
    return { kind: "Committed", evidence: "Acknowledged" };
  } catch (error) {
    if (!isAmbiguousDestructiveActionError(error)) throw error;

    try {
      return (await input.observeMissing())
        ? { kind: "Committed", evidence: "ObservedMissing" }
        : { kind: "NotCommitted", commandError: error };
    } catch (observationError) {
      if (!isAmbiguousDestructiveActionError(observationError)) {
        throw observationError;
      }
      return {
        kind: "Unconfirmed",
        commandError: error,
        observationError,
      };
    }
  }
}
