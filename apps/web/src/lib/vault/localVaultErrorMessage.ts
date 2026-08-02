import type { FeedbackContent } from "@/components/feedback/Feedback";
import {
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";

export type LocalVaultOperation =
  | "LoadSettings"
  | "ConnectFolder"
  | "ExportVault"
  | "SyncVault"
  | "AutoSync";

function localVaultErrorTitle(operation: LocalVaultOperation): string {
  switch (operation) {
    case "LoadSettings":
      return "Local Vault settings couldn’t be loaded";
    case "ConnectFolder":
      return "Folder wasn’t connected";
    case "ExportVault":
      return "Vault wasn’t written";
    case "SyncVault":
      return "Vault wasn’t synced";
    case "AutoSync":
      return "Local Vault refresh failed";
  }
}

/**
 * Exhaustive product-copy adapter for the Local Vault endpoint and browser
 * filesystem channels. A null result is the user's ordinary picker cancel.
 */
export function localVaultErrorMessage(
  error: unknown,
  operation: LocalVaultOperation,
): FeedbackContent | null {
  const title = localVaultErrorTitle(operation);
  if (isApiError(error)) {
    if (isSameSystemApiDefect(error)) throw error;
    const requestId = error.requestId;
    switch (error.code) {
      case "E_NETWORK":
        return {
          tone: "Danger",
          title,
          message: "Check your connection and retry.",
          requestId,
        };
      case "E_UPSTREAM_TIMEOUT":
        return {
          tone: "Danger",
          title,
          message: "The server took too long to respond. Retry the change.",
          requestId,
        };
      case "E_RATE_LIMITED":
        return {
          tone: "Danger",
          title,
          message: "Wait a moment, then retry.",
          requestId,
        };
      case "E_INVALID_REQUEST":
        if (operation !== "SyncVault" && operation !== "AutoSync") throw error;
        return {
          tone: "Danger",
          title,
          message: "A local vault file couldn’t be applied. Fix or remove that file, then retry.",
          requestId,
        };
      case "E_MEDIA_NOT_FOUND":
        if (operation !== "SyncVault" && operation !== "AutoSync") throw error;
        return {
          tone: "Danger",
          title,
          message: "A local vault file refers to an item that no longer exists. Refresh the folder, then retry.",
          requestId,
        };
      case "E_MEDIA_NOT_READY":
        if (operation !== "SyncVault" && operation !== "AutoSync") throw error;
        return {
          tone: "Danger",
          title,
          message: "An item in this vault isn’t ready yet. Wait for processing to finish, then retry.",
          requestId,
        };
      case "E_HIGHLIGHT_CONFLICT":
        if (operation !== "SyncVault" && operation !== "AutoSync") throw error;
        return {
          tone: "Danger",
          title,
          message: "A highlight changed in Nexus. Refresh the folder, review the conflict file, then retry.",
          requestId,
        };
      default:
        throw error;
    }
  }

  if (!(error instanceof DOMException)) throw error;
  switch (error.name) {
    case "AbortError":
      if (operation === "ConnectFolder") return null;
      throw error;
    case "NotAllowedError":
    case "SecurityError":
      return {
        tone: "Danger",
        title,
        message: "Folder access was denied. Reconnect the folder and allow read and write access.",
      };
    case "InvalidStateError":
    case "NotFoundError":
      return {
        tone: "Danger",
        title,
        message: "The connected folder is no longer available. Reconnect it, then retry.",
      };
    case "NotReadableError":
      return {
        tone: "Danger",
        title,
        message: "The folder couldn’t be read. Check that it is available, then retry.",
      };
    case "NoModificationAllowedError":
      return {
        tone: "Danger",
        title,
        message: "The folder is read-only. Allow write access or connect another folder.",
      };
    case "QuotaExceededError":
      return {
        tone: "Danger",
        title,
        message: "The folder couldn’t be written because storage is full. Free space, then retry.",
      };
    case "DataCloneError":
      if (operation !== "ConnectFolder" && operation !== "LoadSettings") throw error;
      return {
        tone: "Danger",
        title,
        message: "This browser couldn’t remember the folder. Reconnect it in a supported desktop browser.",
      };
    default:
      throw error;
  }
}
