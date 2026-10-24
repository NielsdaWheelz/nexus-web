/** Catalog availability is a modeled local outcome, never a remote deletion. */
import type { FeedbackContent } from "@/components/feedback/Feedback";

export function catalogErrorFeedback(error: { readonly code: string }): FeedbackContent | null {
  switch (error.code) {
    case "E_CATALOG_COVERAGE":
      return { tone: "Neutral", title: "not in the saved catalog" };
    case "E_CATALOG_UNAVAILABLE":
      return { tone: "Neutral", title: "catalog not ready on this device", message: "connect to save your lists for offline browsing." };
    case "E_CATALOG_INVALID":
      return { tone: "Warning", title: "saved catalog couldn’t be opened", message: "connect and save your catalog again." };
    case "E_CATALOG_INCOMPATIBLE":
      return { tone: "Warning", title: "saved catalog needs an online rebuild", message: "connect and save your catalog again." };
    case "E_CATALOG_IO":
      return { tone: "Warning", title: "saved catalog couldn’t be read", message: "retry, or connect and save your catalog again." };
    case "E_CATALOG_TOO_LARGE":
      return { tone: "Warning", title: "catalog is too large to save", message: "the saved catalog was not replaced." };
    default:
      return null;
  }
}
