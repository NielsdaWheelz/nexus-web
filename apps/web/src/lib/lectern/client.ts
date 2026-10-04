/** native responses cross the HTTP boundary once, then acquire domain identities. */

import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import { decodeCollectionRevision } from "@/lib/api/collectionPage";
import type { ApiJson } from "@/lib/api/wire";
import {
  lecternItemFromWire,
  lecternSnapshotFromWire,
  parseCompletionHandle,
  parseLecternItemId,
  parseMediaId,
  type ConsumptionCommand,
  type ConsumptionResult,
  type LecternCommand,
  type LecternResult,
  type LecternSnapshot,
} from "@/lib/lectern/contract";
import { parseReaderCursorSnapshot } from "@/lib/reader/readerProgress";

export async function getLectern(options: {
  signal?: AbortSignal;
  cache?: RequestCache;
} = {}): Promise<LecternSnapshot> {
  const body = await apiFetch<ApiJson<"/lectern", "get">>("/api/lectern", options);
  return decodeApiPayload(
    body,
    (response) => lecternSnapshotFromWire(response.data),
    "GET /api/lectern",
  );
}

export async function postLecternCommand(
  command: LecternCommand,
  signal?: AbortSignal,
): Promise<LecternResult> {
  const body = await apiFetch<ApiJson<"/lectern/commands", "post">>(
    "/api/lectern/commands",
    { method: "POST", body: JSON.stringify(command), signal },
  );
  return decodeApiPayload(
    body,
    (response): LecternResult => {
      const { outcome, lectern } = response.data;
      return {
        outcome: outcome.kind === "Placed"
          ? { ...outcome, itemIds: outcome.itemIds.map(parseLecternItemId) }
          : outcome.kind === "Removed"
            ? { ...outcome, itemId: parseLecternItemId(outcome.itemId) }
            : outcome,
        lectern: lecternSnapshotFromWire(lectern),
      };
    },
    "POST /api/lectern/commands",
  );
}

export async function postConsumptionCommand(
  command: ConsumptionCommand,
  signal?: AbortSignal,
): Promise<ConsumptionResult> {
  const body = await apiFetch<ApiJson<"/consumption/commands", "post">>(
    "/api/consumption/commands",
    { method: "POST", body: JSON.stringify(command), signal },
  );
  return decodeApiPayload(
    body,
    (response): ConsumptionResult => {
      const result = response.data;
      const outcome = result.outcome;
      return {
        outcome: outcome.kind === "Removed"
          ? {
              ...outcome,
              itemId: parseLecternItemId(outcome.itemId),
              nextItemId: outcome.nextItemId.kind === "Present"
                ? { kind: "Present", value: parseLecternItemId(outcome.nextItemId.value) }
                : outcome.nextItemId,
            }
          : outcome,
        lectern: lecternSnapshotFromWire(result.lectern),
        nextItem: result.nextItem.kind === "Present"
          ? { kind: "Present", value: lecternItemFromWire(result.nextItem.value) }
          : result.nextItem,
        progressState: result.progressState.kind === "Present"
          ? {
              kind: "Present",
              value: {
                ...result.progressState.value,
                mediaId: parseMediaId(result.progressState.value.mediaId),
                readerCursor: parseReaderCursorSnapshot(result.progressState.value.readerCursor),
              },
            }
          : result.progressState,
        completionHandle: result.completionHandle.kind === "Present"
          ? { kind: "Present", value: parseCompletionHandle(result.completionHandle.value) }
          : result.completionHandle,
        libraryEntriesCollectionRevision: decodeCollectionRevision(
          result.libraryEntriesCollectionRevision,
        ),
      };
    },
    "POST /api/consumption/commands",
  );
}
