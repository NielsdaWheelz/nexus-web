export type MediaPaneFindError =
  | { readonly kind: "TargetUnavailable" }
  | { readonly kind: "RequestUnavailable" };

export function mediaPaneFindErrorMessage(error: MediaPaneFindError): string {
  switch (error.kind) {
    case "TargetUnavailable":
      return "Find target unavailable. Retry.";
    case "RequestUnavailable":
      return "Find request unavailable. Retry.";
  }
}
