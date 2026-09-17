import type { FeedbackContent } from "@/components/feedback/Feedback";
import {
  apiTransportFeedback,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";

export type LibraryRequest =
  | "LibraryCollectionRead"
  | "InvitationRead"
  | "LibraryRead"
  | "EntryRead"
  | "LibraryCreate"
  | "LibraryMutation"
  | "InvitationMutation"
  | "EntryMutation"
  | "PlacementMutation"
  | "LecternMutation"
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
  PlacementMutation: true,
  LecternMutation: true,
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
  PlacementMutation: true,
  LecternMutation: true,
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
  PlacementMutation: true,
  LecternMutation: false,
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
    case "E_MEDIA_LAST_REFERENCE":
      if (request !== "EntryMutation" && request !== "PlacementMutation") {
        throw error;
      }
      return {
        tone: "Danger",
        title,
        message: "This item must remain in at least one library.",
        requestId,
      };
    case "E_MEDIA_DELETING":
      if (!ENTRY_REQUESTS[request] || request === "EntryRead") throw error;
      return {
        tone: "Danger",
        title,
        message: "This item is being removed and can’t be changed right now.",
        requestId,
      };
    case "E_MEDIA_NOT_READY":
      if (!ENTRY_REQUESTS[request] || request === "EntryRead") throw error;
      return {
        tone: "Danger",
        title,
        message: "This item is still preparing. Wait for it to settle, then try again.",
        requestId,
      };
    case "E_LIMIT":
      if (request !== "LecternMutation") throw error;
      return {
        tone: "Danger",
        title,
        message: "Lectern is full. Remove an item, then try again.",
        requestId,
      };
    case "E_TIMEOUT":
      if (request !== "LecternMutation" && request !== "PodcastMutation") {
        throw error;
      }
      return {
        tone: "Danger",
        title,
        message: "The change timed out. Try again.",
        requestId,
      };
    case "E_INVALID_REQUEST":
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
