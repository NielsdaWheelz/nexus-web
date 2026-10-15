import type { FeedbackContent } from "@/components/feedback/Feedback";
import {
  apiTransportFeedback,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import type { LibraryPlacementBlockedReason, PlacementRefusalCode } from "@/lib/libraries/libraryPlacement";

export function libraryPlacementBlockedReasonMessage(reason: LibraryPlacementBlockedReason): string {
  switch (reason) {
    case "RequiresAdmin": return "only a library admin can change this placement";
    case "RequiresSubscription": return "subscribe to this podcast before adding it to a library";
    case "SystemManaged": return "this system library is managed automatically";
    case "Inherited": return "this placement is inherited and cannot be removed here";
  }
}

export function libraryCreateRefusalMessage(
  code: "E_NAME_INVALID" | "E_INVALID_REQUEST" | "E_FORBIDDEN",
  title: string,
): FeedbackContent {
  switch (code) {
    case "E_NAME_INVALID":
    case "E_INVALID_REQUEST":
      return { tone: "Warning", title, message: "use a non-reserved library name between 1 and 100 characters." };
    case "E_FORBIDDEN":
      return { tone: "Warning", title, message: "your access changed. sign in and review your libraries." };
  }
}

export function libraryPlacementRefusalMessage(code: PlacementRefusalCode): FeedbackContent {
  let message: string;
  switch (code) {
    case "E_MEDIA_NOT_FOUND":
    case "E_NOT_FOUND": message = "this item is no longer available."; break;
    case "E_LIBRARY_NOT_FOUND": message = "this library is no longer available."; break;
    case "E_FORBIDDEN":
    case "E_LIBRARY_FORBIDDEN":
    case "E_DEFAULT_LIBRARY_FORBIDDEN":
    case "E_INVALID_REQUEST": message = "library access changed. review the current libraries."; break;
    case "E_MEDIA_DELETING": message = "this item is being removed and cannot be changed right now."; break;
    case "E_MEDIA_LAST_REFERENCE": message = "this item must remain in at least one library."; break;
    case "E_PODCAST_SUBSCRIPTION_REQUIRED": message = "subscribe to this podcast before adding it to a library."; break;
    case "E_PODCAST_REPLACES_EPISODES": message = "remove individually filed episodes before adding this podcast to the library."; break;
  }
  return { tone: "Warning", title: "library change refused", message };
}

export type LibraryRequest =
  | "LibraryCollectionRead"
  | "InvitationRead"
  | "LibraryRead"
  | "EntryRead"
  | "LibraryCreate"
  | "LibraryMutation"
  | "InvitationMutation"
  | "EntryMutation"
  | "PodcastMutation";

const MUTATIONS: Record<LibraryRequest, boolean> = {
  LibraryCollectionRead: false,
  InvitationRead: false,
  LibraryRead: false,
  EntryRead: false,
  LibraryCreate: true,
  LibraryMutation: true,
  InvitationMutation: true,
  EntryMutation: true,
  PodcastMutation: true,
};

const ENTRY_REQUESTS: Record<LibraryRequest, boolean> = {
  LibraryCollectionRead: false,
  InvitationRead: false,
  LibraryRead: false,
  EntryRead: true,
  LibraryCreate: false,
  LibraryMutation: false,
  InvitationMutation: false,
  EntryMutation: true,
  PodcastMutation: true,
};

const LIBRARY_SCOPED_MUTATIONS: Record<LibraryRequest, boolean> = {
  LibraryCollectionRead: false,
  InvitationRead: false,
  LibraryRead: false,
  EntryRead: false,
  LibraryCreate: false,
  LibraryMutation: true,
  InvitationMutation: true,
  EntryMutation: true,
  PodcastMutation: true,
};

/** Finite copy adapter for user-owned Library index/detail requests. */
export function libraryRequestErrorMessage(
  error: unknown,
  input: { readonly title: string; readonly request: LibraryRequest },
): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;

  const { request, title } = input;
  const requestId = error.requestId;
  const transport = apiTransportFeedback(error, title);
  if (transport) return transport;
  switch (error.code) {
    case "E_UNAUTHENTICATED":
      return {
        tone: "Warning",
        title: "sign in to choose libraries",
        message: "open nexus, sign in, then share again.",
        requestId,
      };
    case "E_LIBRARY_NOT_FOUND":
      if (request === "LibraryCreate") throw error;
      return {
        tone: "Danger",
        title,
        message: "This library is no longer available.",
        requestId,
      };
    case "E_MEDIA_NOT_FOUND":
    case "E_NOT_FOUND":
      if (!ENTRY_REQUESTS[request]) throw error;
      return {
        tone: "Danger",
        title,
        message: "This item is no longer available. Refresh the library and try again.",
        requestId,
      };
    case "E_OWNER_REQUIRED":
    case "E_OWNER_EXIT_FORBIDDEN":
    case "E_DEFAULT_LIBRARY_FORBIDDEN":
      if (request !== "LibraryMutation") throw error;
      return {
        tone: "Danger",
        title,
        message: "Your library permissions changed. Refresh Library access and try again.",
        requestId,
      };
    case "E_LIBRARY_FORBIDDEN":
      if (!LIBRARY_SCOPED_MUTATIONS[request]) throw error;
      return {
        tone: "Danger",
        title,
        message: "Your library permissions changed. Refresh Library access and try again.",
        requestId,
      };
    case "E_FORBIDDEN":
      if (!MUTATIONS[request]) throw error;
      return {
        tone: "Danger",
        title,
        message: "Your library permissions changed. Refresh Library access and try again.",
        requestId,
      };
    case "E_NAME_INVALID":
      if (request !== "LibraryCreate" && request !== "LibraryMutation") {
        throw error;
      }
      return {
        tone: "Danger",
        title,
        message: "Enter a non-reserved library name between 1 and 100 characters.",
        requestId,
      };
    case "E_INVITE_ALREADY_EXISTS":
      if (request !== "InvitationMutation") throw error;
      return {
        tone: "Danger",
        title,
        message: "This person already has a pending invitation.",
        requestId,
      };
    case "E_INVITE_MEMBER_EXISTS":
      if (request !== "InvitationMutation") throw error;
      return {
        tone: "Danger",
        title,
        message: "This person is already a library member.",
        requestId,
      };
    case "E_INVITE_NOT_PENDING":
    case "E_INVITE_NOT_FOUND":
      if (request !== "InvitationMutation") throw error;
      return {
        tone: "Danger",
        title,
        message: "This invitation is no longer pending. Refresh invitations and try again.",
        requestId,
      };
    case "E_TIMEOUT":
      if (request !== "PodcastMutation") throw error;
      return {
        tone: "Danger",
        title,
        message: "The change timed out. Try again.",
        requestId,
      };
    case "E_INVALID_REQUEST":
      if (request === "LibraryCreate") return libraryCreateRefusalMessage(error.code, title);
      if (!MUTATIONS[request]) throw error;
      return {
        tone: "Danger",
        title,
        message: "The requested change is no longer valid. Refresh the library and try again.",
        requestId,
      };
    default:
      throw error;
  }
}
