export type MediaPaneFindError =
  | { readonly kind: "OriginUnavailable" }
  | { readonly kind: "RequestUnavailable" };

export function mediaPaneFindErrorMessage(error: MediaPaneFindError): string {
  switch (error.kind) {
    case "OriginUnavailable":
      return "Reading position is unavailable.";
    case "RequestUnavailable":
      return "Find request unavailable. Retry.";
  }
}
