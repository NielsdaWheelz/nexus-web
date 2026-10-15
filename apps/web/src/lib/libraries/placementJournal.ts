import type { PlacementCommand } from "@/lib/libraries/libraryPlacement";
import { isReservedLibraryName } from "@/lib/libraries/presentation";
import {
  expectArray,
  expectCanonicalRfcUuid,
  expectExactRecord,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";

export type StoredLibraryWork =
  | {
      kind: "Placement";
      phase: "Queued" | "Sent";
      request: PlacementCommand;
      afterCreate: string | null;
    }
  | {
      kind: "CreateLibrary";
      phase: "Queued" | "Sent";
      request: { library_id: string; name: string };
    };

function decodeCommand(raw: unknown): PlacementCommand {
  const kind = expectOneOf(
    expectRecord(raw, "command").kind,
    ["AddMedia", "RemoveMedia", "AddPodcast", "RemovePodcast"],
    "command.kind",
  );
  if (kind === "AddPodcast" || kind === "RemovePodcast") {
    const value = expectExactRecord(raw, ["kind", "clientMutationId", "podcastId", "libraryId"], "command");
    return {
      kind,
      clientMutationId: expectCanonicalRfcUuid(value.clientMutationId, "command.clientMutationId"),
      podcastId: expectCanonicalRfcUuid(value.podcastId, "command.podcastId"),
      libraryId: expectCanonicalRfcUuid(value.libraryId, "command.libraryId"),
    };
  }
  const value = expectExactRecord(raw, ["kind", "clientMutationId", "mediaId", "destination"], "command");
  const destination = expectRecord(value.destination, "destination");
  const destinationKind = expectOneOf(destination.kind, ["SavedInNexus", "Library"], "destination.kind");
  if (destinationKind === "SavedInNexus") {
    expectExactRecord(destination, ["kind"], "destination");
    return {
      kind,
      clientMutationId: expectCanonicalRfcUuid(value.clientMutationId, "command.clientMutationId"),
      mediaId: expectCanonicalRfcUuid(value.mediaId, "command.mediaId"),
      destination: { kind: "SavedInNexus" },
    };
  }
  expectExactRecord(destination, ["kind", "libraryId"], "destination");
  return {
    kind,
    clientMutationId: expectCanonicalRfcUuid(value.clientMutationId, "command.clientMutationId"),
    mediaId: expectCanonicalRfcUuid(value.mediaId, "command.mediaId"),
    destination: { kind: "Library", libraryId: expectCanonicalRfcUuid(destination.libraryId, "destination.libraryId") },
  };
}

/** Only this boundary reads persisted work. Invalid records remain untouched. */
export function readPlacementJournal(accountId: string): StoredLibraryWork[] {
  const raw = sessionStorage.getItem(`nx_library_work.v1:${accountId}`);
  if (raw === null) return [];
  const envelope = expectExactRecord(JSON.parse(raw), ["version", "work"], "library journal");
  if (envelope.version !== 1) throw new TypeError("unsupported library journal version");
  const work = expectArray(envelope.work, (raw): StoredLibraryWork => {
    const value = expectRecord(raw, "work");
    const kind = expectOneOf(value.kind, ["Placement", "CreateLibrary"], "work.kind");
    const phase = expectOneOf(value.phase, ["Queued", "Sent"], "work.phase");
    if (kind === "Placement") {
      expectExactRecord(value, ["kind", "phase", "request", "afterCreate"], "work");
      return {
        kind, phase,
        request: decodeCommand(value.request),
        afterCreate: value.afterCreate === null ? null : expectCanonicalRfcUuid(value.afterCreate, "work.afterCreate"),
      };
    }
    expectExactRecord(value, ["kind", "phase", "request"], "work");
    const request = expectExactRecord(value.request, ["library_id", "name"], "create request");
    const name = expectString(request.name, "create.name");
    if (name !== name.trim() || Array.from(name).length < 1 || Array.from(name).length > 100 || isReservedLibraryName(name)) {
      throw new TypeError("invalid stored library name");
    }
    return { kind, phase, request: { library_id: expectCanonicalRfcUuid(request.library_id, "create.library_id"), name } };
  }, "library journal.work");
  const creates = new Set<string>();
  const ids = new Set<string>();
  const targets = new Set<string>();
  for (const entry of work) {
    const id = entry.kind === "Placement" ? entry.request.clientMutationId : entry.request.library_id;
    if (ids.has(id)) throw new TypeError("duplicate library work identity");
    ids.add(id);
    if (entry.kind === "CreateLibrary") {
      creates.add(id);
      continue;
    }
    const request = entry.request;
    const target = "mediaId" in request
      ? `Media:${request.mediaId}` : `Podcast:${request.podcastId}`;
    if (entry.phase === "Sent" && targets.has(target)) throw new TypeError("sent library work is not its target’s first command");
    targets.add(target);
    if (entry.afterCreate !== null) {
      const destination = request.kind === "AddPodcast" ? request.libraryId
        : request.kind === "AddMedia" && request.destination.kind === "Library" ? request.destination.libraryId : null;
      if (entry.phase !== "Queued" || !creates.has(entry.afterCreate) || destination !== entry.afterCreate) {
        throw new TypeError("invalid library creation prerequisite");
      }
    }
  }
  return work;
}

/** One synchronous write is the admission/retirement boundary. */
export function writePlacementJournal(accountId: string, work: readonly StoredLibraryWork[]): void {
  const key = `nx_library_work.v1:${accountId}`;
  if (work.length === 0) sessionStorage.removeItem(key);
  else sessionStorage.setItem(key, JSON.stringify({ version: 1, work }));
}
