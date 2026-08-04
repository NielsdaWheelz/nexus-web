import { describe, expect, it } from "vitest";
import { absent, present } from "@/lib/api/presence";
import {
  assumeAppHref,
  assumeLecternItemId,
  assumeMediaId,
  type FooterAudioActivation,
  type LecternItem,
  type LecternSnapshot,
  type MediaId,
  type PlayerDescriptor,
} from "@/lib/lectern/contract";
import {
  EMPTY_HISTORY,
  naturalEndAdvance,
  playExplicit,
  previous,
  type AudioSession,
  type PlayerHistory,
  type PlayerOrigin,
  type PlayerSessionState,
} from "@/lib/player/playerSession";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";

const ids = new Map<string, string>();

function stableUuid(key: string): string {
  const existing = ids.get(key);
  if (existing) return existing;
  const value = `00000000-0000-4000-8000-${(ids.size + 1).toString(16).padStart(12, "0")}`;
  ids.set(key, value);
  return value;
}

function mediaId(key: string): MediaId {
  return assumeMediaId(stableUuid(`media:${key}`));
}

function origin(key: string): PlayerOrigin {
  return { kind: "Lectern", itemId: assumeLecternItemId(stableUuid(`item:${key}`)) };
}

function activation(): FooterAudioActivation {
  return {
    kind: "FooterAudio",
    streamUrl: "https://external.invalid/audio.mp3",
    sourceUrl: "https://external.invalid/source",
    positionMs: 0,
    writeRevision: 0,
    resetEpoch: 0,
    playbackRate: {
      value: 1,
      source: "Product",
      podcastPreference: absent(),
    },
    pauseShorteningMode: absent(),
    consumptionOverrideRevision: absent(),
    durationMs: present(120_000),
    artworkUrl: absent(),
    chapters: [],
  };
}

function descriptor(key: string): PlayerDescriptor {
  return {
    mediaId: mediaId(key),
    title: `Title ${key}`,
    subtitle: absent(),
    activation: activation(),
  };
}

function item(key: string): LecternItem {
  const id = mediaId(key);
  return {
    itemId: assumeLecternItemId(stableUuid(`item:${key}`)),
    mediaId: id,
    kind: "podcast_episode",
    title: `Title ${key}`,
    subtitle: absent(),
    href: assumeAppHref(`/media/${id}`),
    addedAt: "2025-11-17T21:05:45+00:00",
    consumption: {
      state: "Unread",
      progress: absent(),
      progressResettable: false,
    },
    activation: activation(),
    actionTarget: routeResourceActionSubject({
      scheme: "media",
      id,
      href: `/media/${id}`,
    }),
  };
}

function active(key: string): PlayerSessionState {
  return {
    kind: "Active",
    session: { descriptor: descriptor(key), origin: origin(key) },
    phase: "Playing",
  };
}

const snapshot = (...keys: string[]): LecternSnapshot => ({
  items: keys.map(item),
});

describe("player session boundary", () => {
  it("replacing media records one back entry and invalidates forward history", () => {
    const history: PlayerHistory = {
      back: [descriptor("older")],
      forward: [descriptor("stale-forward")],
    };

    const result = playExplicit(active("current"), history, descriptor("next"), snapshot("next"));

    expect(result).toEqual({
      state: {
        kind: "Active",
        session: { descriptor: descriptor("next"), origin: origin("next") },
        phase: "Buffering",
      },
      history: {
        back: [descriptor("older"), descriptor("current")],
        forward: [],
      },
      effect: { kind: "StartSession" },
    });
  });

  it("uses the exact 3-second boundary for back versus restart", () => {
    const history: PlayerHistory = { back: [descriptor("previous")], forward: [] };

    expect(previous(active("current"), history, 3_001, snapshot()).effect).toEqual({
      kind: "RestartCurrent",
    });
    const boundary = previous(active("current"), history, 3_000, snapshot());
    expect(boundary.state).toMatchObject({
      kind: "Active",
      session: { descriptor: descriptor("previous"), origin: { kind: "Direct" } },
    });
    expect(boundary.history).toEqual({
      back: [],
      forward: [descriptor("current")],
    });
  });

  it("retains an ended session when no canonical successor exists", () => {
    const session: AudioSession = {
      descriptor: descriptor("last"),
      origin: origin("last"),
    };

    expect(naturalEndAdvance(session, EMPTY_HISTORY, absent())).toEqual({
      state: { kind: "PausedAtEnd", session },
      history: EMPTY_HISTORY,
      effect: { kind: "None" },
    });
  });
});
