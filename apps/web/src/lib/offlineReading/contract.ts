import { decodePresence, type Presence } from "@/lib/api/presence";
import {
  expectArray,
  expectCanonicalRfcUuid as canonicalUuid,
  expectExactRecord,
  expectIsoInstant,
  expectNonnegativeInteger,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";
import {
  parseReaderCursorSnapshot,
  parseReaderCursorSource,
} from "@/lib/reader/readerProgress";
import {
  parseReaderResumeState,
  type ReaderResumeState,
} from "@/lib/reader/types";
import type {
  ReaderProgressSaveResult,
  ReaderProgressView,
} from "@/lib/reader/ReaderProgressPort";

export const OFFLINE_READING_PROTOCOL_VERSION = 1 as const;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const LEASE_READER_PATH_RE =
  /^\/nexus-offline\/lease\/[0-9a-f]{32}\/descriptor\.json$/;

export type NetworkPolicy = "UnmeteredOnly" | "AnyConnected";
export type ReadingRejectedCode =
  | "InvalidRequest"
  | "Unsupported"
  | "NotConnected"
  | "NotFound"
  | "Busy"
  | "AuthorizationRequired"
  | "ContentChanged"
  | "Failed";

export type ReadingTransferState =
  | { readonly kind: "Preparing" }
  | {
      readonly kind: "Queued";
      readonly reason:
        | "WaitingForUnmetered"
        | "Capacity"
        | "Scheduler"
        | "Preparation"
        | "ServerCapacity";
    }
  | { readonly kind: "Authorizing" }
  | {
      readonly kind: "Downloading";
      readonly receivedBytes: number;
      readonly totalBytes: number;
    }
  | { readonly kind: "Verifying" }
  | {
      readonly kind: "Restarting";
      readonly attempt: number;
      readonly reason: "Interrupted" | "PolicyChanged";
    }
  | {
      readonly kind: "Failed";
      readonly reason:
        | "AuthorizationRequired"
        | "SourceUnavailable"
        | "ContentChanged"
        | "TooLarge"
        | "LowSpace"
        | "Network"
        | "SystemStopped"
        | "Integrity"
        | "UnsupportedPackage"
        | "RecoveryRequired"
        | "Server";
    };

export type ReadingAvailability =
  | ReadingTransferState
  | {
      readonly kind: "Ready";
      readonly sizeBytes: number;
      readonly installedAt: string;
      readonly readerGeneration: number;
      readonly readerRevisionKey: string;
      readonly progress: ReaderProgressView;
    }
  | { readonly kind: "UpgradeRequired" }
  | { readonly kind: "UpgradeBlockedByStorage" }
  | { readonly kind: "UpgradeFailed" }
  | { readonly kind: "Removing" };

export interface ReadingSnapshot {
  readonly binding: Presence<{
    readonly accountId: string;
    readonly authorizationRequired: boolean;
  }>;
  readonly networkPolicy: NetworkPolicy;
  readonly items: readonly {
    readonly mediaId: string;
    readonly title: string;
    readonly mediaKind: "Pdf" | "Epub" | "WebArticle";
    readonly availability: ReadingAvailability;
  }[];
}

interface ReadingCommandBase {
  readonly protocolVersion: typeof OFFLINE_READING_PROTOCOL_VERSION;
  readonly requestId: string;
}

export type ReadingCommand =
  | (ReadingCommandBase & {
      readonly kind:
        | "ConnectHosted"
        | "ConnectOffline"
        | "GetSnapshot"
        | "OpenHosted"
        | "LogoutAndPurge";
    })
  | (ReadingCommandBase & {
      readonly kind: "Enqueue";
      readonly mediaId: string;
      readonly readerGeneration: number;
      readonly requestedTitle: string;
      readonly mediaKind: "Pdf" | "Epub" | "WebArticle";
    })
  | (ReadingCommandBase & {
      readonly kind:
        "Cancel" | "Retry" | "Remove" | "OpenReading" | "OpenDownloadedCopy";
      readonly mediaId: string;
    })
  | (ReadingCommandBase & {
      readonly kind: "CloseReading";
      readonly leaseId: string;
    })
  | (ReadingCommandBase & {
      readonly kind: "SaveReaderProgress";
      readonly mediaId: string;
      readonly readerGeneration: number;
      readonly readerRevisionKey: string;
      readonly locator: ReaderResumeState;
    })
  | (ReadingCommandBase & {
      readonly kind: "ResolveReaderProgress";
      readonly mediaId: string;
      readonly readerGeneration: number;
      readonly readerRevisionKey: string;
      readonly expected: ReaderProgressView;
      readonly choice: "Canonical" | "Device";
    })
  | (ReadingCommandBase & {
      readonly kind: "SetNetworkPolicy";
      readonly policy: NetworkPolicy;
    });

export type ReadingReplyOutcome =
  | { readonly kind: "Connected"; readonly snapshot: ReadingSnapshot }
  | { readonly kind: "Snapshot"; readonly snapshot: ReadingSnapshot }
  | {
      readonly kind: "OpenedReading";
      readonly leaseId: string;
      readonly readerGeneration: number;
      readonly readerRevisionKey: string;
      readonly readerUrl: string;
      readonly progress: ReaderProgressView;
      readonly installedAt: string;
    }
  | {
      readonly kind: "ReaderProgressSaved";
      readonly result: ReaderProgressSaveResult;
    }
  | { readonly kind: "Accepted" }
  | { readonly kind: "Rejected"; readonly code: ReadingRejectedCode };

/**
 * One inbound frame from the native capability: a correlated reply, or one of
 * the two pushed events.
 *
 * `ReadingEvent` in the protocol contract carries `SnapshotChanged` and
 * `OpenReadingRequested`. The second is the TB-16 App-Link handoff: while the
 * packaged shelf is the active surface, native asks it to open an exact
 * installed media ID locally instead of tearing the shelf down. It carries no
 * durable state, so it is an event rather than a snapshot field.
 */
export type ReadingInbound =
  | {
      readonly kind: "Reply";
      readonly requestId: string;
      readonly outcome: ReadingReplyOutcome;
    }
  | {
      readonly kind: "SnapshotChanged";
      readonly snapshot: ReadingSnapshot;
    }
  | {
      readonly kind: "OpenReadingRequested";
      readonly mediaId: string;
    };

function positiveInteger(raw: unknown, name: string): number {
  const value = expectNonnegativeInteger(raw, name);
  if (value === 0) throw new TypeError(`${name} must be positive`);
  return value;
}

function sha256Hex(raw: unknown, name: string): string {
  const value = expectString(raw, name);
  if (!SHA256_HEX_RE.test(value))
    throw new TypeError(`${name} must be lowercase SHA-256 hex`);
  return value;
}

function readerLocator(raw: unknown, name: string): ReaderResumeState {
  const value = parseReaderResumeState(raw);
  if (value === null || value.kind === "transcript") {
    throw new TypeError(`${name} must be document reader progress`);
  }
  return value;
}

function progressView(raw: unknown, name: string): ReaderProgressView {
  const kind = expectOneOf(
    expectRecord(raw, name).kind,
    [
      "Canonical",
      "Pending",
      "Conflict",
      "ContentChanged",
      "SourceUnavailable",
    ] as const,
    `${name}.kind`,
  );
  const record = expectExactRecord(
    raw,
    kind === "Canonical"
      ? ["kind", "snapshot"]
      : kind === "Conflict"
        ? ["kind", "canonical", "source", "device"]
        : ["kind", "baseline", "source", "device"],
    name,
  );
  if (kind === "Canonical")
    return { kind, snapshot: parseReaderCursorSnapshot(record.snapshot) };
  const source = parseReaderCursorSource(record.source);
  if (source.kind === "Timeline")
    throw new TypeError(
      "Downloaded reader position cannot have a timeline source",
    );
  const device = readerLocator(record.device, `${name}.device`);
  if (kind === "ContentChanged" || kind === "SourceUnavailable") {
    return {
      kind,
      source,
      device,
      baseline: parseReaderCursorSnapshot(record.baseline),
    };
  }
  if (source.kind === "Unresolved")
    throw new TypeError(
      "Pending reader intent must identify its selected publication",
    );
  return kind === "Conflict"
    ? {
        kind,
        source,
        device,
        canonical: parseReaderCursorSnapshot(record.canonical),
      }
    : {
        kind,
        source,
        device,
        baseline: parseReaderCursorSnapshot(record.baseline),
      };
}

function progressSaveResult(raw: unknown): ReaderProgressSaveResult {
  const kind = expectRecord(raw, "progress result").kind;
  if (kind === "Canonical" || kind === "Conflict") {
    const view = progressView(raw, "progress result");
    if (view.kind !== "Canonical" && view.kind !== "Conflict")
      throw new TypeError("Invalid saved reader progress");
    return view;
  }
  if (
    kind === "DurablyPending" ||
    kind === "ContentChanged" ||
    kind === "SourceUnavailable"
  ) {
    const record = expectExactRecord(raw, ["kind", "view"], "progress result");
    const view = progressView(record.view, "progress result.view");
    if (kind === "DurablyPending" && view.kind === "Pending")
      return { kind, view };
    if (kind === "ContentChanged" && view.kind === "ContentChanged")
      return { kind, view };
    if (kind === "SourceUnavailable" && view.kind === "SourceUnavailable")
      return { kind, view };
  }
  throw new TypeError("Unsupported progress save result");
}

function availability(raw: unknown, name: string): ReadingAvailability {
  const kind =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).kind
      : undefined;
  switch (kind) {
    case "Preparing":
    case "Authorizing":
    case "Verifying":
    case "UpgradeRequired":
    case "UpgradeBlockedByStorage":
    case "UpgradeFailed":
    case "Removing":
      expectExactRecord(raw, ["kind"], name);
      return { kind };
    case "Queued": {
      const value = expectExactRecord(raw, ["kind", "reason"], name);
      return {
        kind,
        reason: expectOneOf(
          value.reason,
          [
            "WaitingForUnmetered",
            "Capacity",
            "Scheduler",
            "Preparation",
            "ServerCapacity",
          ] as const,
          `${name}.reason`,
        ),
      };
    }
    case "Downloading": {
      const value = expectExactRecord(
        raw,
        ["kind", "receivedBytes", "totalBytes"],
        name,
      );
      const receivedBytes = expectNonnegativeInteger(
        value.receivedBytes,
        `${name}.receivedBytes`,
      );
      const totalBytes = expectNonnegativeInteger(
        value.totalBytes,
        `${name}.totalBytes`,
      );
      if (receivedBytes > totalBytes)
        throw new TypeError(`${name} received too many bytes`);
      return { kind, receivedBytes, totalBytes };
    }
    case "Restarting": {
      const value = expectExactRecord(raw, ["kind", "attempt", "reason"], name);
      return {
        kind,
        attempt: positiveInteger(value.attempt, `${name}.attempt`),
        reason: expectOneOf(
          value.reason,
          ["Interrupted", "PolicyChanged"] as const,
          `${name}.reason`,
        ),
      };
    }
    case "Failed": {
      const value = expectExactRecord(raw, ["kind", "reason"], name);
      return {
        kind,
        reason: expectOneOf(
          value.reason,
          [
            "AuthorizationRequired",
            "SourceUnavailable",
            "ContentChanged",
            "TooLarge",
            "LowSpace",
            "Network",
            "SystemStopped",
            "Integrity",
            "UnsupportedPackage",
            "RecoveryRequired",
            "Server",
          ] as const,
          `${name}.reason`,
        ),
      };
    }
    case "Ready": {
      const value = expectExactRecord(
        raw,
        [
          "kind",
          "sizeBytes",
          "installedAt",
          "readerGeneration",
          "readerRevisionKey",
          "progress",
        ],
        name,
      );
      return {
        kind,
        sizeBytes: expectNonnegativeInteger(
          value.sizeBytes,
          `${name}.sizeBytes`,
        ),
        installedAt: expectIsoInstant(value.installedAt, `${name}.installedAt`),
        readerGeneration: positiveInteger(
          value.readerGeneration,
          `${name}.readerGeneration`,
        ),
        readerRevisionKey: sha256Hex(
          value.readerRevisionKey,
          `${name}.readerRevisionKey`,
        ),
        progress: progressView(value.progress, `${name}.progress`),
      };
    }
    default:
      throw new TypeError(`${name} has unsupported availability`);
  }
}

export function decodeReadingSnapshot(raw: unknown): ReadingSnapshot {
  const value = expectExactRecord(
    raw,
    ["binding", "networkPolicy", "items"],
    "reading snapshot",
  );
  return {
    binding: decodePresence(value.binding, (binding) => {
      const record = expectExactRecord(
        binding,
        ["accountId", "authorizationRequired"],
        "reading binding",
      );
      if (typeof record.authorizationRequired !== "boolean") {
        throw new TypeError(
          "reading binding.authorizationRequired must be boolean",
        );
      }
      return {
        accountId: canonicalUuid(record.accountId, "reading binding.accountId"),
        authorizationRequired: record.authorizationRequired,
      };
    }),
    networkPolicy: expectOneOf(
      value.networkPolicy,
      ["UnmeteredOnly", "AnyConnected"] as const,
      "networkPolicy",
    ),
    items: expectArray(
      value.items,
      (item, index) => {
        const record = expectExactRecord(
          item,
          ["mediaId", "title", "mediaKind", "availability"],
          `items[${index}]`,
        );
        const title = expectString(record.title, `items[${index}].title`);
        if (Array.from(title).length < 1 || Array.from(title).length > 512) {
          throw new TypeError(`items[${index}].title must be bounded`);
        }
        const mediaKind = expectOneOf(
          record.mediaKind,
          ["Pdf", "Epub", "WebArticle"] as const,
          `items[${index}].mediaKind`,
        );
        const itemAvailability = availability(
          record.availability,
          `items[${index}].availability`,
        );
        return {
          mediaId: canonicalUuid(record.mediaId, `items[${index}].mediaId`),
          title,
          mediaKind,
          availability: itemAvailability,
        };
      },
      "reading snapshot.items",
    ),
  };
}

export function decodeReadingInbound(raw: unknown): ReadingInbound {
  const top = expectExactRecord(
    raw,
    "requestId" in (typeof raw === "object" && raw !== null ? raw : {})
      ? ["protocolVersion", "requestId", "outcome"]
      : ["protocolVersion", "event"],
    "offline reading inbound",
  );
  if (top.protocolVersion !== OFFLINE_READING_PROTOCOL_VERSION) {
    throw new TypeError("Unsupported offline reading protocol");
  }
  if ("requestId" in top) {
    const requestId = canonicalUuid(top.requestId, "requestId");
    const rawOutcome = top.outcome;
    const outcomeKind =
      typeof rawOutcome === "object" &&
      rawOutcome !== null &&
      !Array.isArray(rawOutcome)
        ? (rawOutcome as Record<string, unknown>).kind
        : undefined;
    let outcome: ReadingReplyOutcome;
    switch (outcomeKind) {
      case "Connected":
      case "Snapshot": {
        const record = expectExactRecord(
          rawOutcome,
          ["kind", "snapshot"],
          "reading outcome",
        );
        outcome = {
          kind: outcomeKind,
          snapshot: decodeReadingSnapshot(record.snapshot),
        };
        break;
      }
      case "OpenedReading": {
        const record = expectExactRecord(
          rawOutcome,
          [
            "kind",
            "leaseId",
            "readerGeneration",
            "readerRevisionKey",
            "readerUrl",
            "progress",
            "installedAt",
          ],
          "reading outcome",
        );
        outcome = {
          kind: outcomeKind,
          leaseId: canonicalUuid(record.leaseId, "leaseId"),
          readerGeneration: positiveInteger(
            record.readerGeneration,
            "readerGeneration",
          ),
          readerRevisionKey: sha256Hex(
            record.readerRevisionKey,
            "readerRevisionKey",
          ),
          readerUrl: decodeInternalReaderUrl(record.readerUrl),
          progress: progressView(record.progress, "opened progress"),
          installedAt: expectIsoInstant(record.installedAt, "installedAt"),
        };
        break;
      }
      case "ReaderProgressSaved": {
        const record = expectExactRecord(
          rawOutcome,
          ["kind", "result"],
          "reading outcome",
        );
        outcome = {
          kind: outcomeKind,
          result: progressSaveResult(record.result),
        };
        break;
      }
      case "Accepted":
        expectExactRecord(rawOutcome, ["kind"], "reading outcome");
        outcome = { kind: outcomeKind };
        break;
      case "Rejected": {
        const record = expectExactRecord(
          rawOutcome,
          ["kind", "code"],
          "reading outcome",
        );
        outcome = {
          kind: outcomeKind,
          code: expectOneOf(
            record.code,
            [
              "InvalidRequest",
              "Unsupported",
              "NotConnected",
              "NotFound",
              "Busy",
              "AuthorizationRequired",
              "ContentChanged",
              "Failed",
            ] as const,
            "reading rejection code",
          ),
        };
        break;
      }
      default:
        throw new TypeError("Unsupported offline reading reply");
    }
    return { kind: "Reply", requestId, outcome };
  }
  const eventKind =
    typeof top.event === "object" && top.event !== null
      ? (top.event as Record<string, unknown>).kind
      : undefined;
  if (eventKind === "SnapshotChanged") {
    const event = expectExactRecord(
      top.event,
      ["kind", "snapshot"],
      "reading event",
    );
    return {
      kind: "SnapshotChanged",
      snapshot: decodeReadingSnapshot(event.snapshot),
    };
  }
  if (eventKind === "OpenReadingRequested") {
    const event = expectExactRecord(
      top.event,
      ["kind", "mediaId"],
      "reading event",
    );
    return {
      kind: "OpenReadingRequested",
      mediaId: canonicalUuid(event.mediaId, "reading event.mediaId"),
    };
  }
  throw new TypeError("Unsupported reading event");
}

export function decodeInternalReaderUrl(raw: unknown): string {
  const value = expectString(raw, "readerUrl");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "appassets.androidplatform.net" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !LEASE_READER_PATH_RE.test(url.pathname)
  ) {
    throw new TypeError("readerUrl must be an exact APK lease capability");
  }
  return value;
}
