import type {
  GlobalPlayerState,
  PlayerSessionCapability,
} from "@/lib/player/globalPlayer";

type CanonicalState = Extract<
  GlobalPlayerState,
  {
    kind:
      | "Active"
      | "Completing"
      | "CompletionFailed"
      | "PlaybackFailed"
      | "PausedAtEnd";
  }
>;

type PreviewState = Extract<
  GlobalPlayerState,
  {
    kind: "PreviewAudio" | "PreviewAudioFailed" | "PreviewAudioAtEnd";
  }
>;

export type PlayerChromeModel =
  | { readonly kind: "Absent" }
  | {
      readonly kind: "RuntimeFailure";
      readonly state: Extract<GlobalPlayerState, { kind: "RuntimeFailed" }>;
    }
  | {
      readonly kind: "Canonical";
      readonly state: CanonicalState;
      readonly persistence: PlayerSessionCapability["persistence"];
      readonly nextPreview: PlayerSessionCapability["nextPreview"];
    }
  | {
      readonly kind: "Preview";
      readonly state: PreviewState;
    };

function unreachable(value: never): never {
  throw new Error(`Unhandled player state: ${JSON.stringify(value)}`);
}

export function projectPlayerChrome(
  player: PlayerSessionCapability,
): PlayerChromeModel {
  switch (player.state.kind) {
    case "Absent":
      return { kind: "Absent" };
    case "RuntimeFailed":
      return { kind: "RuntimeFailure", state: player.state };
    case "Active":
    case "Completing":
    case "CompletionFailed":
    case "PlaybackFailed":
    case "PausedAtEnd":
      return {
        kind: "Canonical",
        state: player.state,
        persistence: player.persistence,
        nextPreview: player.nextPreview,
      };
    case "PreviewAudio":
    case "PreviewAudioFailed":
    case "PreviewAudioAtEnd":
      return { kind: "Preview", state: player.state };
    default:
      return unreachable(player.state);
  }
}

export function playerTransportLocked(model: PlayerChromeModel): boolean {
  return (
    model.kind === "Canonical" &&
    (model.state.kind === "Completing" ||
      model.state.kind === "CompletionFailed")
  );
}
