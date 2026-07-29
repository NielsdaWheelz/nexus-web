import { apiFetch } from "@/lib/api/client";
import {
  decodeCollectionRevision,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";
import { isRecord } from "@/lib/validation";

export class MediaLibraryContractDefect extends Error {
  constructor(message: string) {
    // justify-defect: malformed owned media response bodies are code/schema
    // mismatches.
    super(message);
    this.name = "MediaLibraryContractDefect";
  }
}

export type MediaDeleteResult =
  | {
      kind: "Removed";
      removedFromLibraryIds: string[];
      remainingReferenceCount: number;
      libraryEntriesCollectionRevision: CollectionRevision;
    }
  | {
      kind: "Hidden";
      removedFromLibraryIds: string[];
      remainingReferenceCount: number;
      libraryEntriesCollectionRevision: CollectionRevision;
    }
  | { kind: "Deleting" };

export type MediaRemovalOutcome =
  | { kind: "Cancelled" }
  | { kind: "Completed"; result: MediaDeleteResult };

function requireExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  context: string,
): void {
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => !expectedKeys.includes(key))
  ) {
    throw new MediaLibraryContractDefect(
      `Invalid ${context}: expected exactly [${expectedKeys.join(", ")}]`,
    );
  }
}

// Same-system strict decode: the backend produces exactly this camelCase tagged
// union; any other shape is a code/schema-mismatch defect.
function decodeMediaDeleteResult(raw: unknown): MediaDeleteResult {
  if (!isRecord(raw) || !isRecord(raw.data)) {
    throw new MediaLibraryContractDefect(
      "Invalid MediaDeleteResult envelope: expected { data: {...} }",
    );
  }
  requireExactKeys(raw, ["data"], "MediaDeleteResult envelope");
  const data = raw.data;
  if (data.kind === "Deleting") {
    requireExactKeys(data, ["kind"], "MediaDeleteResult.Deleting");
    return { kind: "Deleting" };
  }
  if (data.kind === "Removed" || data.kind === "Hidden") {
    requireExactKeys(
      data,
      [
        "kind",
        "removedFromLibraryIds",
        "remainingReferenceCount",
        "libraryEntriesCollectionRevision",
      ],
      `MediaDeleteResult.${data.kind}`,
    );
    const ids = data.removedFromLibraryIds;
    const count = data.remainingReferenceCount;
    if (
      !Array.isArray(ids) ||
      !ids.every((id): id is string => typeof id === "string") ||
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 0
    ) {
      throw new MediaLibraryContractDefect(
        `Invalid MediaDeleteResult.${data.kind}: bad fields`,
      );
    }
    return {
      kind: data.kind,
      removedFromLibraryIds: ids,
      remainingReferenceCount: count,
      libraryEntriesCollectionRevision: decodeCollectionRevision(
        data.libraryEntriesCollectionRevision,
      ),
    };
  }
  throw new MediaLibraryContractDefect(
    `Invalid MediaDeleteResult.kind: ${JSON.stringify(data.kind)}`,
  );
}

async function deleteMedia(mediaId: string): Promise<MediaDeleteResult> {
  const response = await apiFetch<unknown>(`/api/media/${mediaId}`, {
    method: "DELETE",
  });
  const result = decodeMediaDeleteResult(response);
  // Deletion removes placements across libraries (Removed/Hidden report the
  // affected ids; Deleting will remove them asynchronously); the exact set is
  // not enumerated here, so publish Unknown so every mounted pane reconciles.
  publishLibraryPlacementChange("Unknown");
  return result;
}

export async function confirmAndDeleteMedia({
  mediaId,
  mediaTitle,
  confirmRemoval,
}: {
  mediaId: string;
  mediaTitle: string;
  confirmRemoval: (message: string) => boolean;
}): Promise<MediaRemovalOutcome> {
  if (
    !confirmRemoval(
      `Delete "${mediaTitle}" from All and libraries you manage? This cannot be undone.`,
    )
  ) {
    return { kind: "Cancelled" };
  }
  return {
    kind: "Completed",
    result: await deleteMedia(mediaId),
  };
}
