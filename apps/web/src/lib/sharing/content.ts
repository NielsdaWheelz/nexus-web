import type {
  AudienceUnavailableReason,
  ShareMode,
} from "@/lib/sharing/types";

export const SHARE_MODE_INTRO: Record<ShareMode, string> = {
  None: "Sharing is not available for this item.",
  CopyOnly: "This link does not change who can open the item.",
  CopyWithLibraryFiling:
    "Copy the Nexus link or choose which of your libraries includes this podcast.",
  ResourceGrants:
    "Copying the Nexus link does not grant access. Add a person or turn on your public link explicitly.",
  HighlightGrants:
    "Sharing this highlight includes its source media, but none of your other highlights or notes.",
  LibraryMembership:
    "Only library members can open this link. Membership is managed separately from library settings.",
};

export function audienceUnavailableMessage(
  reason: AudienceUnavailableReason,
): string {
  switch (reason) {
    case "UnsupportedSubject":
      return "Access sharing is not available for this item.";
    case "Deleting":
      return "This item is being removed, so access cannot be shared.";
    case "InsufficientAuthority":
      return "You can copy the link, but you cannot grant access.";
    case "HighlightUnresolved":
      return "This highlight cannot be opened at its exact location, so it cannot be shared.";
    case "EntitlementRequired":
      return "Your current plan does not include access sharing.";
    case "ProjectionNotReady":
      return "The public reader is still being prepared.";
    case "ProjectionUnsupported":
      return "A public link is not available for this format.";
    default: {
      const exhaustive: never = reason;
      throw new Error(`Unhandled share availability reason: ${exhaustive}`);
    }
  }
}

export function shareSubjectKind(ref: string): string {
  const scheme = ref.slice(0, ref.indexOf(":"));
  switch (scheme) {
    case "highlight":
      return "highlight";
    case "media":
      return "media";
    case "library":
      return "library";
    case "podcast":
      return "podcast";
    default:
      return "item";
  }
}

export function shareErrorMessage(error: unknown): string {
  if (error instanceof DOMException || error instanceof TypeError) {
    return "We could not reach Nexus. Check your connection and try again.";
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "Sharing could not be loaded. Try again.";
}
