import { apiFetch } from "@/lib/api/client";
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
    }
  | {
      kind: "Hidden";
      removedFromLibraryIds: string[];
      remainingReferenceCount: number;
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
      ["kind", "removedFromLibraryIds", "remainingReferenceCount"],
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
  return decodeMediaDeleteResult(response);
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
