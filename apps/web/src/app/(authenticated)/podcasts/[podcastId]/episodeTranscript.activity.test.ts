import { describe, expect, it } from "vitest";
import {
  deriveEpisodeState,
  decodeEpisodePublicationDate,
  decodeEpisodeTimingFacts,
  type PodcastEpisodeMedia,
} from "./episodeTranscript";

type EpisodeTiming = NonNullable<PodcastEpisodeMedia["listening_state"]>;

function timing(overrides: Partial<EpisodeTiming> = {}): EpisodeTiming {
  return {
    position_ms: 30_000,
    duration_ms: 120_000,
    playback_speed: 1,
    is_completed: false,
    ...overrides,
  };
}

describe("decodeEpisodeTimingFacts", () => {
  it("constructs rich fraction and minute facts", () => {
    expect(decodeEpisodeTimingFacts(timing())).toEqual({
      totalMinutes: { kind: "Present", value: { value: 2 } },
      fraction: { kind: "Present", value: { value: 0.25 } },
      remainingMinutes: { kind: "Present", value: { value: 2 } },
    });
  });

  it.each([
    { position_ms: Number.NaN },
    { position_ms: -1 },
    { position_ms: 1.5 },
    { duration_ms: Number.NaN },
    { duration_ms: 0 },
    { duration_ms: 1.5 },
    { position_ms: 121_000 },
  ])("rejects malformed timing %p", (overrides) => {
    expect(() => decodeEpisodeTimingFacts(timing(overrides))).toThrow();
  });
});

describe("decodeEpisodePublicationDate", () => {
  it("decodes an exact source instant and explicit absence", () => {
    expect(decodeEpisodePublicationDate("2026-07-20T12:30:00Z")).toEqual({
      kind: "Present",
      value: "2026-07-20T12:30:00Z",
    });
    expect(decodeEpisodePublicationDate(null)).toEqual({ kind: "Absent" });
  });

  it.each(["2026-02-30", "2026-07-20T24:00:00Z", "last Tuesday"])(
    "rejects malformed source date %s",
    (value) => {
      expect(() => decodeEpisodePublicationDate(value)).toThrow();
    },
  );
});

describe("deriveEpisodeState", () => {
  function episode(
    episodeState: PodcastEpisodeMedia["episode_state"],
    listeningState: PodcastEpisodeMedia["listening_state"] = null,
  ): PodcastEpisodeMedia {
    return {
      episode_state: episodeState,
      listening_state: listeningState,
    } as PodcastEpisodeMedia;
  }

  it.each(["unplayed", "in_progress", "played"] as const)(
    "uses the explicit %s state",
    (state) => {
      expect(deriveEpisodeState(episode(state))).toBe(state);
    },
  );

  it("derives only an explicitly absent state from listening facts", () => {
    expect(deriveEpisodeState(episode(null))).toBe("unplayed");
    expect(deriveEpisodeState(episode(null, timing()))).toBe("in_progress");
    expect(
      deriveEpisodeState(
        episode(null, timing({ position_ms: 120_000, is_completed: true })),
      ),
    ).toBe("played");
  });

  it("rejects an unknown non-null wire state", () => {
    expect(() =>
      deriveEpisodeState(episode("future" as PodcastEpisodeMedia["episode_state"])),
    ).toThrow("Unsupported episode_state: future");
  });
});
