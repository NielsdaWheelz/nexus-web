import type { FeedbackContent } from "@/components/feedback/Feedback";

export type PauseShorteningMode = "Off" | "Natural";
export type PauseShorteningProvenance = "Session" | "Podcast" | "Device";
export type PauseShorteningMutationScope = "Podcast" | "Device";

export type PauseShorteningMutation =
  | { kind: "Idle" }
  | { kind: "Pending"; scope: PauseShorteningMutationScope }
  | {
      kind: "Failed";
      scope: PauseShorteningMutationScope;
      retryable: boolean;
      error: FeedbackContent;
      retry: () => void;
    };

export function parsePauseShorteningMode(
  value: unknown,
  context = "pause shortening mode",
): PauseShorteningMode {
  if (value !== "Off" && value !== "Natural") {
    throw new TypeError(`${context} must be Off or Natural`);
  }
  return value;
}

export function pauseShorteningModeLabel(mode: PauseShorteningMode): string {
  return mode === "Natural" ? "Natural" : "Off";
}
