import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { commands, settings, timeline } = vi.hoisted(() => ({
  commands: new Proxy(
    {},
    {
      get: () => vi.fn(),
    },
  ),
  settings: {
    volume: 1,
    playbackRate: {
      scope: {
        kind: "Canonical",
        episodeRate: { kind: "Absent" },
        podcastPreference: {
          kind: "Present",
          value: { podcastId: "podcast-1", value: { kind: "Absent" } },
        },
      },
      preferred: 1,
      temporaryNormal: false,
      base: 1,
      observed: 1,
      remember: { kind: "Ready" },
    },
    outputEffects: {},
    outputEffectsAvailable: false,
    pauseShortening: {
      kind: "Available",
      deviceDefaultMode: "Off",
      podcastOverride: { kind: "Present", value: "Natural" },
      sessionOverride: { kind: "Absent" },
      effectiveMode: "Natural",
      provenance: "Podcast",
      mutation: {
        kind: "Failed",
        scope: "Podcast",
        retryable: true,
        error: {
          tone: "Danger",
          title: "Pause shortening wasn’t saved",
          message: "Retry the save.",
        },
        retry: vi.fn(),
      },
    },
  },
  timeline: {
    positionMs: 0,
    durationMs: 60_000,
    bufferedMs: 0,
    currentChapter: { kind: "Absent" },
    pauseShorteningSavedOnDeviceMs: { kind: "Absent" },
  },
}));

vi.mock("@/lib/player/globalPlayer", () => ({
  usePlayerCommands: () => commands,
  usePlayerSettings: () => settings,
  usePlayerTimeline: () => timeline,
}));

vi.mock("./PlayerOutputEffectsControls", () => ({
  default: () => null,
}));

import { PlayerPlaybackPanel } from "./PlayerPlaybackControls";

describe("PlayerPlaybackPanel feedback ownership", () => {
  it("renders pause failure visually without duplicating the global live owner", () => {
    render(<PlayerPlaybackPanel podcastTitle="Podcast" />);

    expect(screen.getByText("Pause shortening wasn’t saved")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
