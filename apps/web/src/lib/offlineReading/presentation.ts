import type {
  ReadingAvailability,
  ReadingRejectedCode,
  ReadingSnapshot,
} from "./contract";
import type { ReaderProgressView } from "@/lib/reader/ReaderProgressPort";
import { snapshotLocator } from "@/lib/reader/readerProgress";
import type { ReaderResumeState } from "@/lib/reader/types";

export type OfflineReadingMediaKind =
  ReadingSnapshot["items"][number]["mediaKind"];

/**
 * Single owner for every offline-reading sentence the product contract quotes
 * verbatim. Shelf, reader chrome, Downloads overlay and the resource-action
 * planner all read these; no surface restates one in its own words.
 */
export const OFFLINE_READING_COPY = {
  /** UI: changed source. */
  changedSourceNotice:
    "A newer source version exists. This downloaded copy and its position remain only on this device.",
  sourceUnavailableNotice:
    "The source was deleted or is unavailable. Your downloaded copy and device position remain.",
  /** TB-11: preserve both values and ask. Never "latest"/"furthest". */
  conflictNotice: "Nexus and this device have different saved locations.",
  conflictCanonicalChoice: "Use saved location from Nexus",
  conflictDeviceChoice: "Keep this device's location",
  /** UI: the device refused the position write. */
  saveFailedNotice: "Position could not be stored on this device. Try again.",
  /** UI: pending Remove confirmation. */
  pendingRemoveConfirmation:
    "Remove downloaded copy and discard this device's unsynced position.",
  removeConfirmation: "Remove this downloaded copy from this device.",
  removeConfirmationTitle: "Remove downloaded copy?",
  removeConfirmAction: "Remove downloaded copy",
  continueAction: "Continue reading",
} as const;

/**
 * Why hosted offline reading is unavailable right now. A rejected connect is a
 * routine degraded state (rolled-back server, expired WebView session, no
 * network), never a reason to tear down the workspace: installed copies stay
 * readable through the Android shelf.
 */
export function offlineReadingRejectionMessage(
  code: ReadingRejectedCode,
): string {
  switch (code) {
    case "AuthorizationRequired":
      return "Reconnect to Nexus to authorize offline downloads. Downloaded copies remain readable on this device.";
    case "NotConnected":
    case "Failed":
      return "This device could not reach offline reading. Downloaded copies remain readable on this device.";
    case "Unsupported":
      return "This Nexus app version does not support offline reading. Update the app to download documents.";
    case "ContentChanged":
      return "The source changed. Reopen Nexus to download the current version.";
    case "Busy":
      return "Offline reading is busy. Try again in a moment.";
    case "NotFound":
    case "InvalidRequest":
      return "Offline reading is unavailable on this device right now.";
  }
}

/**
 * Page/chapter context for one locator, used to qualify conflict choices.
 * `sectionLabel` resolves an EPUB section id or web fragment id to its
 * navigation label; absence of a label is absence of context, never a
 * fabricated one.
 */
export function offlineReaderLocatorContext(
  locator: ReaderResumeState | null,
  sectionLabel: (targetId: string) => string | null = () => null,
): string | null {
  if (locator === null) return null;
  switch (locator.kind) {
    case "pdf":
      return `Page ${locator.page}`;
    case "epub":
      return sectionLabel(locator.target.section_id);
    case "web":
      return sectionLabel(locator.target.fragment_id);
    case "transcript":
      return null;
  }
}

/** Conflict choice label with its page/chapter context when known. */
export function offlineReadingConflictChoiceLabel(
  choice: "Canonical" | "Device",
  context: string | null,
): string {
  const label =
    choice === "Canonical"
      ? OFFLINE_READING_COPY.conflictCanonicalChoice
      : OFFLINE_READING_COPY.conflictDeviceChoice;
  return context === null ? label : `${label} · ${context}`;
}

/** Removal confirmation body for one item, keyed on unsynced device position. */
export function offlineReadingRemoveConfirmation(
  hasUnsyncedPosition: boolean,
): string {
  return hasUnsyncedPosition
    ? OFFLINE_READING_COPY.pendingRemoveConfirmation
    : OFFLINE_READING_COPY.removeConfirmation;
}

/** True when the device holds a position Nexus has not accepted yet. */
export function offlineReadingHasUnsyncedPosition(
  progress: ReaderProgressView,
): boolean {
  return progress.kind !== "Canonical";
}

/** The locator each side of a conflict points at. */
export function offlineReadingConflictLocators(
  progress: Extract<ReaderProgressView, { kind: "Conflict" }>,
): {
  readonly canonical: ReaderResumeState | null;
  readonly device: ReaderResumeState;
} {
  return {
    canonical: snapshotLocator(progress.canonical),
    device: progress.device,
  };
}

export function formatOfflineReadingBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1_000;
  let unit: (typeof units)[number] = units[0];
  for (const nextUnit of units.slice(1)) {
    if (value < 1_000) break;
    value /= 1_000;
    unit = nextUnit;
  }
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value)} ${unit}`;
}

export function formatOfflineReadingDate(instant: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(instant));
}

export function offlineReadingKindCopy(kind: OfflineReadingMediaKind): string {
  switch (kind) {
    case "Pdf":
      return "PDF";
    case "Epub":
      return "EPUB";
    case "WebArticle":
      return "Web article";
  }
}

export function offlineReaderProgressCopy(
  progress: ReaderProgressView,
): string {
  switch (progress.kind) {
    case "Canonical":
      return "Position synced";
    case "Pending":
      return "Position saved on this device";
    case "Conflict":
      return "Position needs your choice";
    case "ContentChanged":
      return "Position kept for this downloaded version";
    case "SourceUnavailable":
      return "Position kept locally · source unavailable";
  }
}

export function offlineReadingAvailabilityCopy(
  availability: ReadingAvailability,
): string {
  switch (availability.kind) {
    case "Preparing":
      return "Preparing reading copy";
    case "Queued":
      switch (availability.reason) {
        case "WaitingForUnmetered":
          return "Queued · waiting for Wi-Fi";
        case "Capacity":
          return "Queued · another download is active";
        case "Scheduler":
          return "Queued · Android scheduling unavailable";
        case "Preparation":
          return "Preparing downloaded copy";
        case "ServerCapacity":
          return "Queued · Nexus is at capacity";
      }
    case "Authorizing":
      return "Authorizing reading copy";
    case "Downloading":
      return `${formatOfflineReadingBytes(availability.receivedBytes)} of ${formatOfflineReadingBytes(availability.totalBytes)}`;
    case "Verifying":
      return "Verifying reading copy";
    case "Restarting":
      return availability.reason === "PolicyChanged"
        ? `Restarting · network policy changed · attempt ${availability.attempt}`
        : `Restarting · interrupted · attempt ${availability.attempt}`;
    case "Failed":
      return `Download failed · ${offlineReadingFailureCopy(availability.reason)}`;
    case "Ready":
      return `${formatOfflineReadingBytes(availability.sizeBytes)} · saved ${formatOfflineReadingDate(availability.installedAt)}`;
    case "UpgradeRequired":
      return "This saved copy needs a local update before it can open. Your copy and position are preserved.";
    case "UpgradeBlockedByStorage":
      return "The local update needs more free space. Your copy and position are preserved.";
    case "UpgradeFailed":
      return "This app cannot yet update this saved copy. Your copy and position are preserved.";
    case "Removing":
      return "Removing reading copy";
  }
}

function offlineReadingFailureCopy(
  reason: Extract<ReadingAvailability, { kind: "Failed" }>["reason"],
): string {
  switch (reason) {
    case "AuthorizationRequired":
      return "sign in required";
    case "SourceUnavailable":
      return "source unavailable";
    case "ContentChanged":
      return "source changed";
    case "TooLarge":
      return "copy too large";
    case "LowSpace":
      return "not enough storage";
    case "Network":
      return "network interrupted";
    case "SystemStopped":
      return "stopped by Android";
    case "Integrity":
      return "integrity check failed";
    case "UnsupportedPackage":
      return "unsupported package";
    case "RecoveryRequired":
      return "recovery required";
    case "Server":
      return "server unavailable";
  }
}
