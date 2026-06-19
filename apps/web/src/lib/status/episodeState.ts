import type { PillTone } from "@/components/ui/Pill";

export type EpisodeState = "unplayed" | "in_progress" | "played";

/** Returns a pill for noteworthy episode states; null when played (no chip needed). */
export function episodeStatePill(
  state: EpisodeState,
): { tone: PillTone; label: string } | null {
  switch (state) {
    case "unplayed":
      return { tone: "accent", label: "New" };
    case "in_progress":
      return { tone: "info", label: "In progress" };
    case "played":
      return null;
    default: {
      const _exhaustive: never = state;
      return null;
    }
  }
}
