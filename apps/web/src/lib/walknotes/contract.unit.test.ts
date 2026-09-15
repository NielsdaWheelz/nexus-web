import { describe, expect, it } from "vitest";
import { decodeWalknoteSession } from "@/lib/walknotes/contract";

const WAYPOINT = {
  id: "11111111-1111-1111-1111-111111111111",
  media_id: "22222222-2222-2222-2222-222222222222",
  position_ms: 42_000,
  recorded_at: "2026-08-26T07:00:00Z",
  voice_text: "Remember this passage.",
  voice_status: "done",
} as const;

describe("Walknote session contract", () => {
  it("decodes the exact persisted waypoint shape", () => {
    expect(decodeWalknoteSession([WAYPOINT])).toEqual([WAYPOINT]);
  });

  it("rejects additive, malformed, and duplicate persisted waypoints", () => {
    expect(() =>
      decodeWalknoteSession([{ ...WAYPOINT, legacy_status: "complete" }]),
    ).toThrow(/exactly/);
    expect(() =>
      decodeWalknoteSession([{ ...WAYPOINT, media_id: "not-a-media-id" }]),
    ).toThrow(/canonical lowercase UUID/);
    expect(() =>
      decodeWalknoteSession([{ ...WAYPOINT, position_ms: -1 }]),
    ).toThrow(/nonnegative integer/);
    expect(() =>
      decodeWalknoteSession([{ ...WAYPOINT, voice_status: "complete" }]),
    ).toThrow(/one of/);
    expect(() => decodeWalknoteSession([WAYPOINT, WAYPOINT])).toThrow(
      /must be unique/,
    );
  });
});
