import { apiCommand204, apiFetch } from "@/lib/api/client";
import {
  decodeCollectionRevision,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { isRecord } from "@/lib/validation";

export type LibraryPlacementTarget =
  | { readonly kind: "Media"; readonly id: string }
  | { readonly kind: "Podcast"; readonly id: string };

export interface LibraryPlacementIdentity {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
}

export type LibraryPlacementDestination =
  | { readonly kind: "SavedInNexus" }
  | {
      readonly kind: "Library";
      readonly library: LibraryPlacementIdentity;
    };

export type LibraryPlacementRelation =
  | { readonly kind: "Absent" }
  | { readonly kind: "Direct" }
  | {
      readonly kind: "Inherited";
      readonly provenance: readonly LibraryPlacementIdentity[];
    };

export type LibraryPlacementBlockedReason =
  "RequiresAdmin" | "RequiresSubscription" | "SystemManaged" | "Inherited";

export type LibraryPlacementAvailability =
  | { readonly kind: "Available" }
  | {
      readonly kind: "Blocked";
      readonly reason: LibraryPlacementBlockedReason;
    };

export interface LibraryPlacementOption {
  readonly destination: LibraryPlacementDestination;
  readonly relation: LibraryPlacementRelation;
  readonly availability: LibraryPlacementAvailability;
}

export type LibraryPlacementDestinationKey =
  "SavedInNexus" | `Library:${string}`;

export class LibraryPlacementContractDefect extends Error {
  constructor(message: string) {
    // justify-defect: malformed owned placement responses are code/schema
    // mismatches. Command status mismatches are guarded by apiCommand204.
    super(message);
    this.name = "LibraryPlacementContractDefect";
  }
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key))
  ) {
    throw new LibraryPlacementContractDefect(
      `Invalid ${context}: expected exactly [${expected.join(", ")}]`,
    );
  }
}

function requireRecord(
  value: unknown,
  context: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new LibraryPlacementContractDefect(
      `Invalid ${context}: expected an object`,
    );
  }
  return value;
}

function decodeIdentity(
  raw: unknown,
  context: string,
): LibraryPlacementIdentity {
  const value = requireRecord(raw, context);
  requireExactKeys(value, ["id", "name", "color"], context);
  const ref =
    typeof value.id === "string"
      ? parseResourceRef(`library:${value.id}`)
      : null;
  if (
    ref === null ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0 ||
    (value.color !== null && typeof value.color !== "string")
  ) {
    throw new LibraryPlacementContractDefect(
      `Invalid ${context}: invalid field`,
    );
  }
  return { id: ref.id, name: value.name, color: value.color };
}

function decodeDestination(raw: unknown): LibraryPlacementDestination {
  const value = requireRecord(raw, "library placement destination");
  switch (value.kind) {
    case "SavedInNexus":
      requireExactKeys(value, ["kind"], "SavedInNexus destination");
      return { kind: "SavedInNexus" };
    case "Library":
      requireExactKeys(value, ["kind", "library"], "Library destination");
      return {
        kind: "Library",
        library: decodeIdentity(value.library, "Library destination.library"),
      };
    default:
      throw new LibraryPlacementContractDefect(
        "Invalid library placement destination kind",
      );
  }
}

function decodeRelation(raw: unknown): LibraryPlacementRelation {
  const value = requireRecord(raw, "library placement relation");
  switch (value.kind) {
    case "Absent":
      requireExactKeys(value, ["kind"], "Absent relation");
      return { kind: "Absent" };
    case "Direct":
      requireExactKeys(value, ["kind"], "Direct relation");
      return { kind: "Direct" };
    case "Inherited": {
      requireExactKeys(value, ["kind", "provenance"], "Inherited relation");
      if (!Array.isArray(value.provenance) || value.provenance.length === 0) {
        throw new LibraryPlacementContractDefect(
          "Invalid Inherited relation.provenance",
        );
      }
      const provenance = value.provenance.map((entry, index) =>
        decodeIdentity(entry, `Inherited relation.provenance[${index}]`),
      );
      if (new Set(provenance.map(({ id }) => id)).size !== provenance.length) {
        throw new LibraryPlacementContractDefect(
          "Invalid Inherited relation: duplicate provenance library id",
        );
      }
      return { kind: "Inherited", provenance };
    }
    default:
      throw new LibraryPlacementContractDefect(
        "Invalid library placement relation kind",
      );
  }
}

const BLOCKED_REASONS = new Set<LibraryPlacementBlockedReason>([
  "RequiresAdmin",
  "RequiresSubscription",
  "SystemManaged",
  "Inherited",
]);

function decodeAvailability(raw: unknown): LibraryPlacementAvailability {
  const value = requireRecord(raw, "library placement availability");
  switch (value.kind) {
    case "Available":
      requireExactKeys(value, ["kind"], "Available placement availability");
      return { kind: "Available" };
    case "Blocked":
      requireExactKeys(
        value,
        ["kind", "reason"],
        "Blocked placement availability",
      );
      if (
        typeof value.reason !== "string" ||
        !BLOCKED_REASONS.has(value.reason as LibraryPlacementBlockedReason)
      ) {
        throw new LibraryPlacementContractDefect(
          "Invalid Blocked placement availability.reason",
        );
      }
      return {
        kind: "Blocked",
        reason: value.reason as LibraryPlacementBlockedReason,
      };
    default:
      throw new LibraryPlacementContractDefect(
        "Invalid library placement availability kind",
      );
  }
}

export function libraryPlacementDestinationKey(
  destination: LibraryPlacementDestination,
): LibraryPlacementDestinationKey {
  return destination.kind === "SavedInNexus"
    ? "SavedInNexus"
    : `Library:${destination.library.id}`;
}

type CreatedLibraryPlacementDecision =
  | {
      readonly kind: "Add";
      readonly destination: LibraryPlacementDestination;
    }
  | { readonly kind: "DoNotAdd" };

/** Reauthorize Create-and-add from the post-create placement inventory. */
export function decideCreatedLibraryPlacement(input: {
  readonly placements: readonly LibraryPlacementOption[];
  readonly libraryId: string;
}): CreatedLibraryPlacementDecision {
  const option = input.placements.find(
    ({ destination }) =>
      destination.kind === "Library" &&
      destination.library.id === input.libraryId,
  );
  if (!option) {
    throw new LibraryPlacementContractDefect(
      "Created Library is missing from the canonical placement inventory",
    );
  }
  return option.availability.kind === "Available" &&
    option.relation.kind === "Absent"
    ? { kind: "Add", destination: option.destination }
    : { kind: "DoNotAdd" };
}

export function decodeLibraryPlacements(
  raw: unknown,
): LibraryPlacementOption[] {
  const envelope = requireRecord(raw, "library placements response");
  requireExactKeys(envelope, ["data"], "library placements envelope");
  if (!Array.isArray(envelope.data)) {
    throw new LibraryPlacementContractDefect(
      "Invalid library placements response.data: expected an array",
    );
  }

  const placements = envelope.data.map((entry, index) => {
    const value = requireRecord(entry, `library placement[${index}]`);
    requireExactKeys(
      value,
      ["destination", "relation", "availability"],
      `library placement[${index}]`,
    );
    const option: LibraryPlacementOption = {
      destination: decodeDestination(value.destination),
      relation: decodeRelation(value.relation),
      availability: decodeAvailability(value.availability),
    };
    const inheritedRelation = option.relation.kind === "Inherited";
    const inheritedAvailability =
      option.availability.kind === "Blocked" &&
      option.availability.reason === "Inherited";
    if (inheritedRelation !== inheritedAvailability) {
      throw new LibraryPlacementContractDefect(
        `Invalid library placement[${index}]: inherited relation and availability disagree`,
      );
    }
    if (
      option.destination.kind === "SavedInNexus" &&
      (option.relation.kind === "Inherited" ||
        option.availability.kind !== "Available")
    ) {
      throw new LibraryPlacementContractDefect(
        `Invalid library placement[${index}]: SavedInNexus must be directly mutable`,
      );
    }
    return option;
  });

  const keys = placements.map(({ destination }) =>
    libraryPlacementDestinationKey(destination),
  );
  if (new Set(keys).size !== keys.length) {
    throw new LibraryPlacementContractDefect(
      "Invalid library placements response: duplicate destination",
    );
  }
  return placements;
}

function listPath(target: LibraryPlacementTarget) {
  switch (target.kind) {
    case "Media":
      return `/api/media/${target.id}/libraries` as const;
    case "Podcast":
      return `/api/podcasts/${target.id}/libraries` as const;
  }
}

export async function listLibraryPlacements(
  target: LibraryPlacementTarget,
  { signal }: { signal?: AbortSignal } = {},
): Promise<LibraryPlacementOption[]> {
  const placements = decodeLibraryPlacements(
    await apiFetch<unknown>(listPath(target), { signal }),
  );
  if (
    target.kind === "Podcast" &&
    placements.some(({ destination }) => destination.kind === "SavedInNexus")
  ) {
    throw new LibraryPlacementContractDefect(
      "Invalid Podcast placement inventory: SavedInNexus is Media-only",
    );
  }
  return placements;
}

function requireNamedDestination(
  target: LibraryPlacementTarget,
  destination: LibraryPlacementDestination,
): LibraryPlacementIdentity {
  if (destination.kind === "Library") return destination.library;
  throw new LibraryPlacementContractDefect(
    `${target.kind} placement command requires a named Library destination`,
  );
}

export async function addLibraryPlacement(input: {
  readonly target: LibraryPlacementTarget;
  readonly destination: LibraryPlacementDestination;
  readonly clientMutationId: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const { target, destination, clientMutationId, signal } = input;
  switch (target.kind) {
    case "Media":
      if (destination.kind === "SavedInNexus") {
        await apiCommand204(`/api/media/${target.id}/saved-in-nexus`, {
          method: "PUT",
          signal,
        });
        publishLibraryPlacementChange("Unknown");
        return;
      }
      await addMediaToLibraries(target.id, [destination.library.id], {
        signal,
      });
      return;
    case "Podcast": {
      const library = requireNamedDestination(target, destination);
      const response = await apiFetch<unknown>(
        `/api/libraries/${library.id}/podcasts/${target.id}`,
        {
          method: "PUT",
          headers: { "Idempotency-Key": clientMutationId },
          signal,
        },
      );
      decodePodcastPlacementAddition(response);
      publishLibraryPlacementChange([library.id]);
      return;
    }
  }
}

function decodePodcastPlacementAddition(raw: unknown): CollectionRevision {
  const envelope = requireRecord(raw, "PodcastPlacementAdditionOut envelope");
  requireExactKeys(envelope, ["data"], "PodcastPlacementAdditionOut envelope");
  const data = requireRecord(envelope.data, "PodcastPlacementAdditionOut.data");
  requireExactKeys(
    data,
    ["outcome", "libraryEntriesCollectionRevision"],
    "Podcast placement addition data",
  );
  if (data.outcome !== "Added" && data.outcome !== "AlreadyPresent") {
    throw new LibraryPlacementContractDefect(
      "Invalid PodcastPlacementAdditionOut outcome",
    );
  }
  return decodeCollectionRevision(data.libraryEntriesCollectionRevision);
}

export async function removeLibraryPlacement(input: {
  readonly target: LibraryPlacementTarget;
  readonly destination: LibraryPlacementDestination;
  readonly clientMutationId: string;
  readonly signal?: AbortSignal;
}): Promise<CollectionRevision> {
  const { target, destination, clientMutationId, signal } = input;
  let response: unknown;
  let changedLibraryIds: string[] | "Unknown" = [];
  switch (target.kind) {
    case "Media":
      if (destination.kind === "SavedInNexus") {
        changedLibraryIds = "Unknown";
        response = await apiFetch<unknown>(
          `/api/media/${target.id}/saved-in-nexus`,
          { method: "DELETE", signal },
        );
      } else {
        changedLibraryIds = [destination.library.id];
        response = await apiFetch<unknown>(
          `/api/media/${target.id}/libraries/${destination.library.id}`,
          { method: "DELETE", signal },
        );
      }
      break;
    case "Podcast": {
      const library = requireNamedDestination(target, destination);
      changedLibraryIds = [library.id];
      response = await apiFetch<unknown>(
        `/api/libraries/${library.id}/podcasts/${target.id}`,
        {
          method: "DELETE",
          headers: { "Idempotency-Key": clientMutationId },
          signal,
        },
      );
      break;
    }
  }

  const envelope = requireRecord(response, "LibraryEntryRemovalOut envelope");
  requireExactKeys(envelope, ["data"], "LibraryEntryRemovalOut envelope");
  const data = requireRecord(envelope.data, "LibraryEntryRemovalOut.data");
  requireExactKeys(
    data,
    target.kind === "Podcast"
      ? ["outcome", "libraryEntriesCollectionRevision"]
      : ["libraryEntriesCollectionRevision"],
    "Library placement removal data",
  );
  if (
    target.kind === "Podcast" &&
    data.outcome !== "Removed" &&
    data.outcome !== "AlreadyAbsent"
  ) {
    throw new LibraryPlacementContractDefect(
      "Invalid PodcastPlacementRemovalOut outcome",
    );
  }
  const revision = decodeCollectionRevision(
    data.libraryEntriesCollectionRevision,
  );
  if (changedLibraryIds === "Unknown" || changedLibraryIds.length > 0) {
    publishLibraryPlacementChange(changedLibraryIds);
  }
  return revision;
}

export async function addMediaToLibraries(
  mediaId: string,
  libraryIds: readonly string[],
  { signal }: { signal?: AbortSignal } = {},
): Promise<void> {
  await apiCommand204(`/api/media/${mediaId}/libraries`, {
    method: "POST",
    body: JSON.stringify({ library_ids: libraryIds }),
    signal,
  });
  publishLibraryPlacementChange([...libraryIds]);
}

// Add Content owns an authorized intake session and patches only its local
// projection after a confirmed named-Library command.
export function projectLibraryPlacement(
  placements: readonly LibraryPlacementOption[],
  destination: LibraryPlacementDestination,
  relation: Extract<LibraryPlacementRelation, { kind: "Absent" | "Direct" }>,
): LibraryPlacementOption[] {
  const key = libraryPlacementDestinationKey(destination);
  return placements.map((placement) =>
    libraryPlacementDestinationKey(placement.destination) === key
      ? { ...placement, relation }
      : placement,
  );
}
