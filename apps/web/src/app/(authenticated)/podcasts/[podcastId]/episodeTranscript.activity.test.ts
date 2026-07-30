import { describe, expect, it } from "vitest";
import {
  deriveEpisodeState,
  decodePodcastEpisodeMedia,
  decodeEpisodePublicationDate,
  decodeEpisodeTimingFacts,
  type PodcastEpisodeMedia,
} from "./episodeTranscript";

type EpisodeTiming = NonNullable<PodcastEpisodeMedia["listening_state"]>;

function timing(overrides: Partial<EpisodeTiming> = {}): EpisodeTiming {
  return {
    position_ms: 30_000,
    duration_ms: 120_000,
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

  it("rejects an unknown wire state", () => {
    expect(() =>
      deriveEpisodeState(episode("future" as PodcastEpisodeMedia["episode_state"])),
    ).toThrow("Unsupported episode_state: future");
  });
});

describe("decodePodcastEpisodeMedia contributor contract", () => {
  function wire(contributors: unknown[]) {
    return {
      id: "00000000-0000-4000-8000-000000000001",
      kind: "podcast_episode",
      title: "Episode",
      canonical_source_url: { kind: "Absent" },
      offline_download_eligible: false,
      processing_status: "ready_for_reading",
      transcript_state: "ready",
      transcript_coverage: "full",
      listening_state: { kind: "Absent" },
      episode_state: "unplayed",
      progress_resettable: false,
      capabilities: {
        can_retry: false,
        can_refresh_source: false,
        can_retry_metadata: false,
        can_edit_authors: true,
        can_delete: true,
      },
      contributors,
      author_mode: "automatic",
      published_date: { kind: "Absent" },
      duration_seconds: { kind: "Absent" },
      has_show_notes: false,
      playerDescriptor: { kind: "Absent" },
    };
  }

  it("accepts the exact nested shape and rejects extra or malformed fields", () => {
    const validCredit = {
      contributor_handle: "grace-hopper",
      contributor_display_name: "Grace Hopper",
      href: "/authors/grace-hopper",
      credited_name: "G. Hopper",
      role: "guest",
      raw_role: null,
      ordinal: 1,
    };
    expect(decodePodcastEpisodeMedia(wire([validCredit])).contributors).toEqual(
      [validCredit],
    );
    expect(() =>
      decodePodcastEpisodeMedia(
        wire([{ ...validCredit, unexpected: "legacy" }]),
      ),
    ).toThrow(/Podcast episode contributors/);
    expect(() =>
      decodePodcastEpisodeMedia(wire([{ ...validCredit, ordinal: "1" }])),
    ).toThrow(/ordinal/);
  });
});
