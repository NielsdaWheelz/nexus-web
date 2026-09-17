import {
  decodeCamelCaseMediaRecoveryOffer,
  type MediaRecoveryOffer,
} from "@/lib/imports/importsClient";
import {
  decodeCamelCaseResourceActivation,
  type ResourceActivation,
} from "@/lib/resources/activation";
import {
  decodePlayerDescriptor,
  type PlayerDescriptor,
} from "@/lib/lectern/contract";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import {
  expectArray,
  expectBoolean,
  expectCanonicalUuid,
  expectExactRecord,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";

// Decoded, same-system mirror of the camelCase wire contract for
// `POST /resource-items/action-snapshots/resolve`. This decode is STRICT: the
// server and this client ship together, so any unknown discriminator is wire
// drift, not an older peer — silently downgrading it would hide a real defect.

export type ServerActionAvailability =
  | { readonly kind: "Available" }
  | {
      readonly kind: "Blocked";
      readonly reason:
        | "PermissionDenied"
        | "Locked"
        | "Processing"
        | "TemporarilyUnavailable";
    };

export type ResourceActionCapability =
  | {
      readonly kind:
        | "Open"
        | "OpenInNewPane"
        | "Share"
        | "Chat"
        | "PlayNext"
        | "DownloadOriginal"
        | "RefreshSource"
        | "RetryMetadata"
        | "EditAuthors"
        | "ResetProgress"
        | "LibrarySettings"
        | "DeleteLibrary"
        | "PodcastSettings"
        | "RefreshPodcast"
        | "RetryPodcastBackfill"
        | "DeleteConversation"
        | "RemoveMedia"
        | "LibraryPlacement"
        | "OfflineAudio"
        | "ForkMessage"
        | "WalkMessageSources"
        | "RerunMessage"
        | "RegenerateMessage"
        | "DeleteMessage"
        | "EditHighlight"
        | "LinkHighlight"
        | "LearnHighlight"
        | "EditHighlightBounds"
        | "DeleteHighlight"
        | "EditPageTitle"
        | "DeletePage"
        | "EditNoteBody"
        | "RenameContributor"
        | "RegenerateArtifact"
        | "MakeArtifactRevisionCurrent";
      readonly availability: ServerActionAvailability;
    }
  | {
      readonly kind: "OpenSource";
      readonly availability: ServerActionAvailability;
      readonly href: string;
    }
  | {
      /**
       * The one recovery this media is currently offered, computed by the same
       * owner policy the Imports pane reads (contract D7). It carries the exact
       * identity the viewer's menu rendered, so the command it plans conflicts
       * rather than acting on work the reader never saw.
       */
      readonly kind: "Recovery";
      readonly availability: ServerActionAvailability;
      readonly offer: MediaRecoveryOffer;
    }
  | {
      readonly kind: "OfflineReading";
      readonly availability: ServerActionAvailability;
      readonly requestedTitle: string;
      readonly mediaKind: "web_article" | "epub" | "pdf";
    }
  | {
      readonly kind: "Playback";
      readonly availability: ServerActionAvailability;
      readonly playerDescriptor: PlayerDescriptor;
    }
  | {
      readonly kind: "Consumption";
      readonly availability: ServerActionAvailability;
      readonly state: "Unread" | "InProgress" | "Finished";
    }
  | {
      readonly kind: "EpisodeConsumption";
      readonly availability: ServerActionAvailability;
      readonly state: "Unplayed" | "Played";
    }
  | {
      readonly kind: "PodcastSubscription";
      readonly availability: ServerActionAvailability;
      readonly state: "Subscribed" | "Unsubscribed";
    }
  | {
      readonly kind: "LecternMembership";
      readonly availability: ServerActionAvailability;
      readonly state: "Absent";
    }
  | {
      readonly kind: "LecternMembership";
      readonly availability: ServerActionAvailability;
      readonly state: "Present";
      readonly lecternItemId: string;
    }
  | {
      readonly kind: "Transcript";
      readonly availability: ServerActionAvailability;
      readonly state:
        | "NotRequested"
        | "Queued"
        | "Running"
        | "Ready"
        | "Partial"
        | "Unavailable"
        | "FailedQuota"
        | "FailedProvider";
      readonly coverage: "None" | "Partial" | "Full";
    }
  | {
      readonly kind: "HighlightNote";
      readonly availability: ServerActionAvailability;
      readonly state: "Absent";
    }
  | {
      readonly kind: "HighlightNote";
      readonly availability: ServerActionAvailability;
      readonly state: "Present";
      readonly noteBlockId: string;
    };

export interface ResourceActionSnapshot {
  readonly ref: CanonicalResourceRef;
  readonly activation: ResourceActivation;
  readonly missing: boolean;
  readonly capabilities: readonly ResourceActionCapability[];
}

function decodeServerActionAvailability(
  raw: unknown,
  name: string,
): ServerActionAvailability {
  const record = expectRecord(raw, name);
  const kind = expectString(record.kind, `${name}.kind`);
  switch (kind) {
    case "Available":
      expectExactRecord(record, ["kind"], name);
      return { kind: "Available" };
    case "Blocked":
      expectExactRecord(record, ["kind", "reason"], name);
      return {
        kind: "Blocked",
        reason: expectOneOf(
          record.reason,
          [
            "PermissionDenied",
            "Locked",
            "Processing",
            "TemporarilyUnavailable",
          ] as const,
          `${name}.reason`,
        ),
      };
    default:
      // justify-defect: server and client ship together; an unknown
      // availability discriminator is wire drift and must not silently read as
      // an available action.
      throw new TypeError(`${name}.kind must be Available or Blocked`);
  }
}

function decodeResourceActionCapability(
  raw: unknown,
  name: string,
): ResourceActionCapability {
  const record = expectRecord(raw, name);
  const kind = expectString(record.kind, `${name}.kind`);
  switch (kind) {
    case "OfflineReading": {
      expectExactRecord(record, ["kind", "availability", "requestedTitle", "mediaKind"], name);
      const requestedTitle = expectString(record.requestedTitle, `${name}.requestedTitle`);
      if (
        Array.from(requestedTitle).length < 1 ||
        Array.from(requestedTitle).length > 512 ||
        requestedTitle.trim().length === 0
      ) {
        throw new TypeError(`${name}.requestedTitle must be bounded`);
      }
      return {
        kind,
        availability: decodeServerActionAvailability(record.availability, `${name}.availability`),
        requestedTitle,
        mediaKind: expectOneOf(
          record.mediaKind,
          ["web_article", "epub", "pdf"] as const,
          `${name}.mediaKind`,
        ),
      };
    }
    case "Recovery": {
      expectExactRecord(record, ["kind", "availability", "offer"], name);
      return {
        kind,
        availability: decodeServerActionAvailability(
          record.availability,
          `${name}.availability`,
        ),
        offer: decodeCamelCaseMediaRecoveryOffer(record.offer, `${name}.offer`),
      };
    }
    case "OpenSource": {
      expectExactRecord(record, ["kind", "availability", "href"], name);
      return {
        kind,
        availability: decodeServerActionAvailability(
          record.availability,
          `${name}.availability`,
        ),
        href: expectString(record.href, `${name}.href`),
      };
    }
    case "Playback": {
      expectExactRecord(
        record,
        ["kind", "availability", "playerDescriptor"],
        name,
      );
      return {
        kind,
        availability: decodeServerActionAvailability(
          record.availability,
          `${name}.availability`,
        ),
        playerDescriptor: decodePlayerDescriptor(record.playerDescriptor),
      };
    }
    case "Open":
    case "OpenInNewPane":
    case "Share":
    case "Chat":
    case "PlayNext":
    case "DownloadOriginal":
    case "RefreshSource":
    case "RetryMetadata":
    case "EditAuthors":
    case "ResetProgress":
    case "LibrarySettings":
    case "DeleteLibrary":
    case "PodcastSettings":
    case "RefreshPodcast":
    case "RetryPodcastBackfill":
    case "DeleteConversation":
    case "RemoveMedia":
    case "LibraryPlacement":
    case "OfflineAudio":
    case "ForkMessage":
    case "WalkMessageSources":
    case "RerunMessage":
    case "RegenerateMessage":
    case "DeleteMessage":
    case "EditHighlight":
    case "LinkHighlight":
    case "LearnHighlight":
    case "EditHighlightBounds":
    case "DeleteHighlight":
    case "EditPageTitle":
    case "DeletePage":
    case "EditNoteBody":
    case "RenameContributor":
    case "RegenerateArtifact":
    case "MakeArtifactRevisionCurrent": {
      expectExactRecord(record, ["kind", "availability"], name);
      return {
        kind,
        availability: decodeServerActionAvailability(
          record.availability,
          `${name}.availability`,
        ),
      };
    }
    case "Consumption": {
      expectExactRecord(record, ["kind", "availability", "state"], name);
      return {
        kind,
        availability: decodeServerActionAvailability(
          record.availability,
          `${name}.availability`,
        ),
        state: expectOneOf(
          record.state,
          ["Unread", "InProgress", "Finished"] as const,
          `${name}.state`,
        ),
      };
    }
    case "EpisodeConsumption": {
      expectExactRecord(record, ["kind", "availability", "state"], name);
      return {
        kind,
        availability: decodeServerActionAvailability(
          record.availability,
          `${name}.availability`,
        ),
        state: expectOneOf(
          record.state,
          ["Unplayed", "Played"] as const,
          `${name}.state`,
        ),
      };
    }
    case "PodcastSubscription": {
      expectExactRecord(record, ["kind", "availability", "state"], name);
      return {
        kind,
        availability: decodeServerActionAvailability(
          record.availability,
          `${name}.availability`,
        ),
        state: expectOneOf(
          record.state,
          ["Subscribed", "Unsubscribed"] as const,
          `${name}.state`,
        ),
      };
    }
    case "LecternMembership": {
      const availability = decodeServerActionAvailability(
        record.availability,
        `${name}.availability`,
      );
      const state = expectOneOf(
        record.state,
        ["Absent", "Present"] as const,
        `${name}.state`,
      );
      if (state === "Absent") {
        expectExactRecord(record, ["kind", "availability", "state"], name);
        return { kind, availability, state };
      }
      expectExactRecord(
        record,
        ["kind", "availability", "state", "lecternItemId"],
        name,
      );
      return {
        kind,
        availability,
        state,
        lecternItemId: expectCanonicalUuid(
          record.lecternItemId,
          `${name}.lecternItemId`,
        ),
      };
    }
    case "Transcript": {
      expectExactRecord(
        record,
        ["kind", "availability", "state", "coverage"],
        name,
      );
      return {
        kind,
        availability: decodeServerActionAvailability(
          record.availability,
          `${name}.availability`,
        ),
        state: expectOneOf(
          record.state,
          [
            "NotRequested",
            "Queued",
            "Running",
            "Ready",
            "Partial",
            "Unavailable",
            "FailedQuota",
            "FailedProvider",
          ] as const,
          `${name}.state`,
        ),
        coverage: expectOneOf(
          record.coverage,
          ["None", "Partial", "Full"] as const,
          `${name}.coverage`,
        ),
      };
    }
    case "HighlightNote": {
      const availability = decodeServerActionAvailability(
        record.availability,
        `${name}.availability`,
      );
      const state = expectOneOf(
        record.state,
        ["Absent", "Present"] as const,
        `${name}.state`,
      );
      if (state === "Absent") {
        expectExactRecord(record, ["kind", "availability", "state"], name);
        return { kind, availability, state };
      }
      expectExactRecord(
        record,
        ["kind", "availability", "state", "noteBlockId"],
        name,
      );
      return {
        kind,
        availability,
        state,
        noteBlockId: expectCanonicalUuid(record.noteBlockId, `${name}.noteBlockId`),
      };
    }
    default:
      // justify-defect: this closed capability union has no open extension
      // point; an unknown kind is same-system wire drift and must surface as a
      // defect rather than being dropped from the menu.
      throw new TypeError(`${name}.kind is not a known capability: ${kind}`);
  }
}

function decodeResourceActionSnapshot(
  raw: unknown,
  name: string,
): ResourceActionSnapshot {
  const value = expectExactRecord(
    raw,
    ["ref", "activation", "missing", "capabilities"],
    name,
  );
  const ref = assumeCanonicalResourceRef(expectString(value.ref, `${name}.ref`));
  const activation = decodeCamelCaseResourceActivation(
    value.activation,
    `${name}.activation`,
  );
  if (activation.resourceRef !== ref) {
    // justify-defect: one snapshot cannot safely identify two canonical
    // resources at once.
    throw new TypeError(
      `${name}.ref must equal ${name}.activation.resourceRef`,
    );
  }
  const missing = expectBoolean(value.missing, `${name}.missing`);
  const capabilities = expectArray(
    value.capabilities,
    (capability, index) =>
      decodeResourceActionCapability(
        capability,
        `${name}.capabilities[${index}]`,
      ),
    `${name}.capabilities`,
  );
  if (missing && capabilities.length > 0) {
    // justify-defect: the resolve contract returns a missing resource with no
    // capabilities; a missing snapshot carrying actions is wire corruption.
    throw new TypeError(`${name} is missing but carries capabilities`);
  }
  if (missing && activation.kind !== "none") {
    // justify-defect: a resource cannot be both missing and routeable; the
    // snapshot is the only owner of both facts and must publish one truth.
    throw new TypeError(`${name} is missing but carries an activation`);
  }
  return {
    ref,
    activation,
    missing,
    capabilities,
  };
}

export function decodeResourceActionSnapshotResolveResponse(
  raw: unknown,
): readonly ResourceActionSnapshot[] {
  const name = "ResourceActionSnapshotResolveResponse";
  const value = expectExactRecord(raw, ["snapshots"], name);
  return expectArray(
    value.snapshots,
    (snapshot, index) =>
      decodeResourceActionSnapshot(snapshot, `${name}.snapshots[${index}]`),
    `${name}.snapshots`,
  );
}
