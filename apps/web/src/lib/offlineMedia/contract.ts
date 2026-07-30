import { decodePresence, type Presence } from "@/lib/api/presence";
import {
  expectArray,
  expectExactRecord,
  expectNonnegativeInteger,
  expectOneOf,
  expectString,
} from "@/lib/validation";

export const OFFLINE_MEDIA_PROTOCOL_VERSION = 1 as const;
export const OFFLINE_DOWNLOAD_SPEC_DEADLINE_MS = 35_000;
export const OFFLINE_MEDIA_TITLE_MAX_LENGTH = 512;
export const OFFLINE_MEDIA_SOURCE_URL_MAX_LENGTH = 8_192;

const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export type NetworkPolicy = "UnmeteredOnly" | "AnyConnected";
export type OfflineMediaRejectedCode =
  | "InvalidRequest"
  | "AccountMismatch"
  | "NetworkUnavailable"
  | "SourceForbidden"
  | "SourceMissing"
  | "SourceUnavailable"
  | "UnsupportedAudio"
  | "StorageInsufficient";

export interface OfflineDownloadSpec {
  readonly kind: "ProgressiveAudio";
  readonly mediaId: string;
  readonly title: string;
  readonly sourceUrl: string;
}

export type NativeLocalAvailability =
  | {
      readonly kind: "Queued";
      readonly reason:
        | "Capacity"
        | "WaitingForNetwork"
        | "WaitingForUnmetered"
        | "SystemLimit";
    }
  | {
      readonly kind: "Downloading";
      readonly bytesDownloaded: number;
      readonly totalBytes: Presence<number>;
    }
  | { readonly kind: "Restarting" }
  | {
      readonly kind: "Ready";
      readonly sizeBytes: number;
      readonly contentType: string;
      readonly updatedAt: string;
    }
  | {
      readonly kind: "Failed";
      readonly code: "DownloadFailed";
    }
  | { readonly kind: "Removing" };

export type LocalAvailability =
  | { readonly kind: "Resolving" }
  | NativeLocalAvailability;

export interface NativeOfflineMediaItem {
  readonly mediaId: string;
  readonly title: string;
  readonly state: NativeLocalAvailability;
}

interface OfflineMediaCommandBase {
  readonly requestId: string;
  readonly protocolVersion: typeof OFFLINE_MEDIA_PROTOCOL_VERSION;
}

export type OfflineMediaCommand =
  | (OfflineMediaCommandBase & {
      readonly kind: "Connect";
      readonly accountId: string;
    })
  | (OfflineMediaCommandBase & { readonly kind: "GetSnapshot" })
  | (OfflineMediaCommandBase & {
      readonly kind: "Enqueue";
      readonly spec: OfflineDownloadSpec;
    })
  | (OfflineMediaCommandBase & {
      readonly kind: "Cancel" | "Retry" | "Remove";
      readonly mediaId: string;
    })
  | (OfflineMediaCommandBase & {
      readonly kind: "SetNetworkPolicy";
      readonly policy: NetworkPolicy;
    });

export type OfflineMediaReplyOutcome =
  | {
      readonly kind: "Connected" | "Snapshot";
      readonly items: readonly NativeOfflineMediaItem[];
      readonly networkPolicy: NetworkPolicy;
    }
  | { readonly kind: "Accepted" }
  | {
      readonly kind: "Rejected";
      readonly code: OfflineMediaRejectedCode;
    };

export interface OfflineMediaReply {
  readonly requestId: string;
  readonly protocolVersion: typeof OFFLINE_MEDIA_PROTOCOL_VERSION;
  readonly outcome: OfflineMediaReplyOutcome;
}

export type OfflineMediaEvent =
  | {
      readonly protocolVersion: typeof OFFLINE_MEDIA_PROTOCOL_VERSION;
      readonly kind: "StateChanged";
      readonly mediaId: string;
      readonly state: Presence<NativeLocalAvailability>;
    }
  | {
      readonly protocolVersion: typeof OFFLINE_MEDIA_PROTOCOL_VERSION;
      readonly kind: "NetworkPolicyChanged";
      readonly policy: NetworkPolicy;
    };

export type OfflineMediaInbound =
  | { readonly kind: "Reply"; readonly reply: OfflineMediaReply }
  | { readonly kind: "Event"; readonly event: OfflineMediaEvent };

function decodeCanonicalUuid(raw: unknown, name: string): string {
  const value = expectString(raw, name);
  if (!CANONICAL_UUID_RE.test(value)) {
    throw new TypeError(`${name} must be a canonical lowercase UUID`);
  }
  return value;
}

function decodeNonemptyString(raw: unknown, name: string): string {
  const value = expectString(raw, name);
  if (value.length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
  return value;
}

function decodeBoundedNonemptyString(
  raw: unknown,
  name: string,
  maxLength: number,
): string {
  const value = decodeNonemptyString(raw, name);
  if (Array.from(value).length > maxLength) {
    throw new TypeError(`${name} must be at most ${maxLength} characters`);
  }
  return value;
}

function decodeProtocolVersion(raw: unknown): typeof OFFLINE_MEDIA_PROTOCOL_VERSION {
  if (raw !== OFFLINE_MEDIA_PROTOCOL_VERSION) {
    throw new TypeError(
      `protocolVersion must be ${OFFLINE_MEDIA_PROTOCOL_VERSION}`,
    );
  }
  return OFFLINE_MEDIA_PROTOCOL_VERSION;
}

function decodeNetworkPolicy(raw: unknown, name: string): NetworkPolicy {
  return expectOneOf(
    raw,
    ["UnmeteredOnly", "AnyConnected"] as const,
    name,
  );
}

function decodeNativeLocalAvailability(
  raw: unknown,
): NativeLocalAvailability {
  const state = expectExactRecord(
    raw,
    (() => {
      if (
        typeof raw !== "object" ||
        raw === null ||
        Array.isArray(raw) ||
        typeof (raw as Record<string, unknown>).kind !== "string"
      ) {
        return ["kind"];
      }
      switch ((raw as Record<string, unknown>).kind) {
        case "Queued":
          return ["kind", "reason"];
        case "Downloading":
          return ["kind", "bytesDownloaded", "totalBytes"];
        case "Ready":
          return ["kind", "sizeBytes", "contentType", "updatedAt"];
        case "Failed":
          return ["kind", "code"];
        case "Restarting":
        case "Removing":
          return ["kind"];
        default:
          return ["kind"];
      }
    })(),
    "offline media state",
  );

  const kind = expectOneOf(
    state.kind,
    [
      "Queued",
      "Downloading",
      "Restarting",
      "Ready",
      "Failed",
      "Removing",
    ] as const,
    "offline media state.kind",
  );
  switch (kind) {
    case "Queued":
      return {
        kind,
        reason: expectOneOf(
          state.reason,
          [
            "Capacity",
            "WaitingForNetwork",
            "WaitingForUnmetered",
            "SystemLimit",
          ] as const,
          "offline media state.reason",
        ),
      };
    case "Downloading":
      return {
        kind,
        bytesDownloaded: expectNonnegativeInteger(
          state.bytesDownloaded,
          "offline media state.bytesDownloaded",
        ),
        totalBytes: decodePresence(state.totalBytes, (value) =>
          expectNonnegativeInteger(value, "offline media state.totalBytes.value"),
        ),
      };
    case "Restarting":
      return { kind };
    case "Ready": {
      const contentType = decodeNonemptyString(
        state.contentType,
        "offline media state.contentType",
      );
      const updatedAt = expectString(
        state.updatedAt,
        "offline media state.updatedAt",
      );
      if (!ISO_INSTANT_RE.test(updatedAt) || Number.isNaN(Date.parse(updatedAt))) {
        throw new TypeError(
          "offline media state.updatedAt must be an ISO-8601 UTC instant",
        );
      }
      return {
        kind,
        sizeBytes: expectNonnegativeInteger(
          state.sizeBytes,
          "offline media state.sizeBytes",
        ),
        contentType,
        updatedAt,
      };
    }
    case "Failed":
      return {
        kind,
        code: expectOneOf(
          state.code,
          ["DownloadFailed"] as const,
          "offline media state.code",
        ),
      };
    case "Removing":
      return { kind };
  }
}

function decodeSnapshotItem(
  raw: unknown,
  index: number,
): NativeOfflineMediaItem {
  const item = expectExactRecord(
    raw,
    ["mediaId", "title", "state"],
    `offline media items[${index}]`,
  );
  const state = decodePresence(item.state, decodeNativeLocalAvailability);
  if (state.kind === "Absent") {
    throw new TypeError(
      `offline media items[${index}].state must be Present`,
    );
  }
  return {
    mediaId: decodeCanonicalUuid(
      item.mediaId,
      `offline media items[${index}].mediaId`,
    ),
    title: decodeBoundedNonemptyString(
      item.title,
      `offline media items[${index}].title`,
      OFFLINE_MEDIA_TITLE_MAX_LENGTH,
    ),
    state: state.value,
  };
}

function decodeReplyOutcome(raw: unknown): OfflineMediaReplyOutcome {
  const base = expectExactRecord(
    raw,
    (() => {
      if (
        typeof raw === "object" &&
        raw !== null &&
        !Array.isArray(raw)
      ) {
        const kind = (raw as Record<string, unknown>).kind;
        if (kind === "Connected" || kind === "Snapshot") {
          return ["kind", "items", "networkPolicy"];
        }
        if (kind === "Rejected") return ["kind", "code"];
      }
      return ["kind"];
    })(),
    "offline media reply.outcome",
  );
  const kind = expectOneOf(
    base.kind,
    ["Connected", "Snapshot", "Accepted", "Rejected"] as const,
    "offline media reply.outcome.kind",
  );
  switch (kind) {
    case "Connected":
    case "Snapshot":
      return {
        kind,
        items: expectArray(base.items, decodeSnapshotItem, "offline media items"),
        networkPolicy: decodeNetworkPolicy(
          base.networkPolicy,
          "offline media reply.outcome.networkPolicy",
        ),
      };
    case "Accepted":
      return { kind };
    case "Rejected":
      return {
        kind,
        code: expectOneOf(
          base.code,
          [
            "InvalidRequest",
            "AccountMismatch",
            "NetworkUnavailable",
            "SourceForbidden",
            "SourceMissing",
            "SourceUnavailable",
            "UnsupportedAudio",
            "StorageInsufficient",
          ] as const,
          "offline media reply.outcome.code",
        ),
      };
  }
}

function decodeReply(raw: unknown): OfflineMediaReply {
  const reply = expectExactRecord(
    raw,
    ["requestId", "protocolVersion", "outcome"],
    "offline media reply",
  );
  return {
    requestId: decodeCanonicalUuid(
      reply.requestId,
      "offline media reply.requestId",
    ),
    protocolVersion: decodeProtocolVersion(reply.protocolVersion),
    outcome: decodeReplyOutcome(reply.outcome),
  };
}

function decodeEvent(raw: unknown): OfflineMediaEvent {
  const event = expectExactRecord(
    raw,
    (() => {
      if (
        typeof raw === "object" &&
        raw !== null &&
        !Array.isArray(raw) &&
        (raw as Record<string, unknown>).kind === "StateChanged"
      ) {
        return ["protocolVersion", "kind", "mediaId", "state"];
      }
      return ["protocolVersion", "kind", "policy"];
    })(),
    "offline media event",
  );
  const protocolVersion = decodeProtocolVersion(event.protocolVersion);
  const kind = expectOneOf(
    event.kind,
    ["StateChanged", "NetworkPolicyChanged"] as const,
    "offline media event.kind",
  );
  switch (kind) {
    case "StateChanged":
      return {
        protocolVersion,
        kind,
        mediaId: decodeCanonicalUuid(
          event.mediaId,
          "offline media event.mediaId",
        ),
        state: decodePresence(event.state, decodeNativeLocalAvailability),
      };
    case "NetworkPolicyChanged":
      return {
        protocolVersion,
        kind,
        policy: decodeNetworkPolicy(
          event.policy,
          "offline media event.policy",
        ),
      };
  }
}

export function decodeOfflineDownloadSpec(raw: unknown): OfflineDownloadSpec {
  const spec = expectExactRecord(
    raw,
    ["kind", "mediaId", "title", "sourceUrl"],
    "OfflineDownloadSpec",
  );
  return {
    kind: expectOneOf(
      spec.kind,
      ["ProgressiveAudio"] as const,
      "OfflineDownloadSpec.kind",
    ),
    mediaId: decodeCanonicalUuid(
      spec.mediaId,
      "OfflineDownloadSpec.mediaId",
    ),
    title: decodeBoundedNonemptyString(
      spec.title,
      "OfflineDownloadSpec.title",
      OFFLINE_MEDIA_TITLE_MAX_LENGTH,
    ),
    sourceUrl: decodeBoundedNonemptyString(
      spec.sourceUrl,
      "OfflineDownloadSpec.sourceUrl",
      OFFLINE_MEDIA_SOURCE_URL_MAX_LENGTH,
    ),
  };
}

export function decodeOfflineDownloadSpecEnvelope(
  raw: unknown,
): OfflineDownloadSpec {
  const envelope = expectExactRecord(
    raw,
    ["data"],
    "OfflineDownloadSpecResponse",
  );
  return decodeOfflineDownloadSpec(envelope.data);
}

export function decodeOfflineMediaInbound(raw: unknown): OfflineMediaInbound {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("offline media inbound message must be an object");
  }
  if ("requestId" in raw || "outcome" in raw) {
    return { kind: "Reply", reply: decodeReply(raw) };
  }
  return { kind: "Event", event: decodeEvent(raw) };
}
