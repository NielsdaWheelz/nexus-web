import { describe, expect, it } from "vitest";
import { absent, present } from "@/lib/api/presence";
import {
  assumeAppHref,
  assumeLecternItemId,
  assumeMediaId,
  type Activation,
  type FooterAudioActivation,
  type LecternItem,
  type LecternItemId,
  type LecternSnapshot,
  type MediaId,
  type PlayerDescriptor,
} from "@/lib/lectern/client";
import {
  applySnapshotInstall,
  descriptorFromLecternItem,
  EMPTY_HISTORY,
  getStartPositionMs,
  manualNext,
  mintCompletionAttempt,
  naturalEndAdvance,
  playExplicit,
  previous,
  resolveOriginForPlay,
  type AudioSession,
  type OverlayEntry,
  type PlayerHistory,
  type PlayerOrigin,
  type PlayerSessionState,
} from "@/lib/player/playerSession";

// --- Deterministic id + fixture helpers -------------------------------------

const idRegistry = new Map<string, string>();
let idCounter = 0;
function stableUuid(key: string): string {
  const existing = idRegistry.get(key);
  if (existing !== undefined) return existing;
  idCounter += 1;
  const value = `00000000-0000-4000-8000-${idCounter.toString(16).padStart(12, "0")}`;
  idRegistry.set(key, value);
  return value;
}
function mediaId(key: string): MediaId {
  return assumeMediaId(stableUuid(`m:${key}`));
}
function itemId(key: string): LecternItemId {
  return assumeLecternItemId(stableUuid(`i:${key}`));
}

function footerAudio(positionMs = 0): FooterAudioActivation {
  return {
    kind: "FooterAudio",
    streamUrl: "https://cdn.example/stream.mp3",
    sourceUrl: "https://example/source",
    positionMs,
    writeRevision: 0,
    resetEpoch: 0,
    playbackSpeed: 1,
    durationMs: present(120_000),
    artworkUrl: absent(),
    chapters: [],
  };
}

function audioItem(itemKey: string, mediaKey: string, positionMs = 0): LecternItem {
  return {
    itemId: itemId(itemKey),
    mediaId: mediaId(mediaKey),
    title: `Title ${mediaKey}`,
    subtitle: absent(),
    href: assumeAppHref(`/media/${mediaKey}`),
    consumption: { state: "Unread", progress: absent() },
    activation: footerAudio(positionMs),
  };
}

function withActivation(item: LecternItem, activation: Activation): LecternItem {
  return { ...item, activation };
}

function descriptor(mediaKey: string, positionMs = 0): PlayerDescriptor {
  return {
    mediaId: mediaId(mediaKey),
    title: `Title ${mediaKey}`,
    subtitle: absent(),
    activation: footerAudio(positionMs),
  };
}

function snapshot(items: LecternItem[]): LecternSnapshot {
  return { items };
}

function activeState(
  mediaKey: string,
  origin: PlayerOrigin,
  positionMs = 0,
): PlayerSessionState {
  return {
    kind: "Active",
    session: { descriptor: descriptor(mediaKey, positionMs), origin },
    phase: "Playing",
  };
}

const lectern = (itemKey: string): PlayerOrigin => ({ kind: "Lectern", itemId: itemId(itemKey) });
const direct: PlayerOrigin = { kind: "Direct" };

// --- resolveOriginForPlay ----------------------------------------------------

describe("resolveOriginForPlay", () => {
  it("returns a Lectern origin when an exact-media row is present", () => {
    const snap = snapshot([audioItem("iA", "A")]);
    expect(resolveOriginForPlay(descriptor("A"), snap)).toEqual(lectern("iA"));
  });

  it("returns Direct when no row matches the media", () => {
    const snap = snapshot([audioItem("iA", "A")]);
    expect(resolveOriginForPlay(descriptor("B"), snap)).toEqual(direct);
  });

  it("picks the first matching row when multiple rows share the media and no hint is given", () => {
    const snap = snapshot([audioItem("i1", "M"), audioItem("i2", "M")]);
    expect(resolveOriginForPlay(descriptor("M"), snap)).toEqual(lectern("i1"));
  });

  it("picks the exact itemId hint when multiple rows share the media", () => {
    const snap = snapshot([audioItem("i1", "M"), audioItem("i2", "M")]);
    expect(resolveOriginForPlay(descriptor("M"), snap, itemId("i2"))).toEqual(lectern("i2"));
  });

  it("falls back to the first matching row when the hint is not present", () => {
    const snap = snapshot([audioItem("i1", "M"), audioItem("i2", "M")]);
    expect(resolveOriginForPlay(descriptor("M"), snap, itemId("absent"))).toEqual(lectern("i1"));
  });
});

// --- playExplicit ------------------------------------------------------------

describe("playExplicit", () => {
  const snap = snapshot([audioItem("iA", "A"), audioItem("iB", "B")]);

  it("pushes the outgoing descriptor to back and clears forward when replacing a different session", () => {
    const state = activeState("A", lectern("iA"));
    const history: PlayerHistory = { back: [descriptor("Z")], forward: [descriptor("Y")] };
    const result = playExplicit(state, history, descriptor("B"), snap);
    expect(result.state).toEqual({
      kind: "Active",
      session: { descriptor: descriptor("B"), origin: lectern("iB") },
      phase: "Buffering",
    });
    expect(result.history.back).toEqual([descriptor("Z"), descriptor("A")]);
    expect(result.history.forward).toEqual([]);
    expect(result.effect).toEqual({ kind: "StartSession" });
  });

  it("does not touch history when there is no current session", () => {
    const result = playExplicit({ kind: "Absent" }, EMPTY_HISTORY, descriptor("A"), snap);
    expect(result.history).toEqual({ back: [], forward: [] });
    expect(result.state.kind).toBe("Active");
  });

  it("does not push history when replaying the same media", () => {
    const state = activeState("A", lectern("iA"));
    const history: PlayerHistory = { back: [descriptor("Z")], forward: [descriptor("Y")] };
    const result = playExplicit(state, history, descriptor("A"), snap);
    expect(result.history).toBe(history);
  });

  it("creates a new session when playing from PausedAtEnd", () => {
    const paused: PlayerSessionState = {
      kind: "PausedAtEnd",
      session: { descriptor: descriptor("A"), origin: lectern("iA") },
    };
    const result = playExplicit(paused, EMPTY_HISTORY, descriptor("B"), snap);
    expect(result.state).toEqual({
      kind: "Active",
      session: { descriptor: descriptor("B"), origin: lectern("iB") },
      phase: "Buffering",
    });
    expect(result.history.back).toEqual([descriptor("A")]);
  });
});

// --- previous ----------------------------------------------------------------

describe("previous", () => {
  const snap = snapshot([audioItem("iA", "A")]);

  it("restarts the current audio strictly after the 3s threshold (3001ms)", () => {
    const state = activeState("A", lectern("iA"));
    const history: PlayerHistory = { back: [descriptor("Z")], forward: [] };
    const result = previous(state, history, 3001, snap);
    expect(result.effect).toEqual({ kind: "RestartCurrent" });
    expect(result.history).toBe(history);
    expect(result.state.kind).toBe("Active");
  });

  it("pops back and pushes current forward at the 3s boundary (3000ms)", () => {
    const state = activeState("A", lectern("iA"));
    const history: PlayerHistory = { back: [descriptor("Z")], forward: [] };
    const result = previous(state, history, 3000, snap);
    expect(result.effect).toEqual({ kind: "StartSession" });
    expect(result.state).toMatchObject({ kind: "Active", session: { descriptor: descriptor("Z") } });
    expect(result.history.back).toEqual([]);
    expect(result.history.forward).toEqual([descriptor("A")]);
  });

  it("restarts when the back stack is empty even below the threshold", () => {
    const state = activeState("A", lectern("iA"));
    const result = previous(state, EMPTY_HISTORY, 500, snap);
    expect(result.effect).toEqual({ kind: "RestartCurrent" });
  });

  it("re-resolves the popped descriptor's origin from the snapshot (Direct when absent)", () => {
    const state = activeState("A", lectern("iA"));
    const history: PlayerHistory = { back: [descriptor("GONE")], forward: [] };
    const result = previous(state, history, 0, snap);
    expect(result.state).toMatchObject({ session: { origin: { kind: "Direct" } } });
  });
});

// --- manualNext --------------------------------------------------------------

describe("manualNext", () => {
  it("pops forward and pushes current to back when forward history exists", () => {
    const snap = snapshot([audioItem("iA", "A")]);
    const state = activeState("A", lectern("iA"));
    const history: PlayerHistory = { back: [descriptor("Z")], forward: [descriptor("Y")] };
    const result = manualNext(state, history, snap);
    expect(result.state).toMatchObject({ session: { descriptor: descriptor("Y") } });
    expect(result.history.back).toEqual([descriptor("Z"), descriptor("A")]);
    expect(result.history.forward).toEqual([]);
    expect(result.effect).toEqual({ kind: "StartSession" });
  });

  it("selects the first footer audio strictly after an exact Lectern origin", () => {
    const snap = snapshot([audioItem("iA", "A"), audioItem("iB", "B"), audioItem("iC", "C")]);
    const state = activeState("A", lectern("iA"));
    const result = manualNext(state, EMPTY_HISTORY, snap);
    expect(result.state).toMatchObject({
      kind: "Active",
      session: { descriptor: descriptor("B"), origin: lectern("iB") },
    });
    expect(result.history.back).toEqual([descriptor("A")]);
    expect(result.history.forward).toEqual([]);
  });

  it("excludes the current media when selecting the suffix (multi-row same media)", () => {
    const snap = snapshot([audioItem("iA", "A"), audioItem("iA2", "A"), audioItem("iB", "B")]);
    const state = activeState("A", lectern("iA"));
    const result = manualNext(state, EMPTY_HISTORY, snap);
    expect(result.state).toMatchObject({ session: { descriptor: descriptor("B") } });
  });

  it("skips Readable rows and selects the next footer audio", () => {
    const snap = snapshot([
      audioItem("iA", "A"),
      withActivation(audioItem("iR", "R"), { kind: "Readable" }),
      audioItem("iB", "B"),
    ]);
    const state = activeState("A", lectern("iA"));
    const result = manualNext(state, EMPTY_HISTORY, snap);
    expect(result.state).toMatchObject({ session: { descriptor: descriptor("B") } });
  });

  it("does not wrap: returns None when nothing follows the origin", () => {
    const snap = snapshot([audioItem("iA", "A"), audioItem("iC", "C")]);
    const state = activeState("C", lectern("iC"));
    const result = manualNext(state, EMPTY_HISTORY, snap);
    expect(result.effect).toEqual({ kind: "None" });
    expect(result.state).toBe(state);
  });

  it("selects from the head for a Direct origin, excluding the current media", () => {
    const snap = snapshot([audioItem("iA", "A"), audioItem("iB", "B")]);
    const state = activeState("A", direct);
    const result = manualNext(state, EMPTY_HISTORY, snap);
    expect(result.state).toMatchObject({ session: { descriptor: descriptor("B"), origin: lectern("iB") } });
  });
});

// --- naturalEndAdvance -------------------------------------------------------

describe("naturalEndAdvance", () => {
  const endedSession: AudioSession = { descriptor: descriptor("A"), origin: lectern("iA") };

  it("advances to the returned next item, pushes outgoing to back, and clears forward without consuming it", () => {
    const history: PlayerHistory = { back: [descriptor("Z")], forward: [descriptor("Y")] };
    const result = naturalEndAdvance(endedSession, history, present(audioItem("iB", "B")));
    expect(result.state).toEqual({
      kind: "Active",
      session: { descriptor: descriptor("B"), origin: lectern("iB") },
      phase: "Buffering",
    });
    expect(result.history.back).toEqual([descriptor("Z"), descriptor("A")]);
    // Automatic advance is a session-replacing non-history action (spec §6):
    // forward is invalidated, and the advance target is the Lectern successor,
    // never the forward entry ("never consumes forward history").
    expect(result.history.forward).toEqual([]);
    expect(result.effect).toEqual({ kind: "StartSession" });
  });

  it("retains the ended session as PausedAtEnd with no successor and unchanged history", () => {
    const history: PlayerHistory = { back: [descriptor("Z")], forward: [descriptor("Y")] };
    const result = naturalEndAdvance(endedSession, history, absent());
    expect(result.state).toEqual({ kind: "PausedAtEnd", session: endedSession });
    expect(result.history).toBe(history);
    expect(result.effect).toEqual({ kind: "None" });
  });
});

// --- applySnapshotInstall ----------------------------------------------------

describe("applySnapshotInstall", () => {
  it("preserves a Lectern origin when its item is still present (moved / reordered)", () => {
    const state = activeState("A", lectern("iA"));
    const snap = snapshot([audioItem("iX", "X"), audioItem("iA", "A")]);
    expect(applySnapshotInstall(state, snap)).toEqual(state);
  });

  it("downgrades to Direct when the item is gone", () => {
    const state = activeState("A", lectern("iA"));
    const snap = snapshot([audioItem("iX", "X")]);
    expect(applySnapshotInstall(state, snap)).toMatchObject({ session: { origin: { kind: "Direct" } } });
  });

  it("downgrades to Direct when the item's media no longer matches", () => {
    const state = activeState("A", lectern("iA"));
    const snap = snapshot([audioItem("iA", "OTHER")]);
    expect(applySnapshotInstall(state, snap)).toMatchObject({ session: { origin: { kind: "Direct" } } });
  });

  it("never upgrades a Direct origin even when a matching row exists", () => {
    const state = activeState("A", direct);
    const snap = snapshot([audioItem("iA", "A")]);
    expect(applySnapshotInstall(state, snap)).toEqual(state);
  });

  it("leaves Absent untouched", () => {
    const snap = snapshot([audioItem("iA", "A")]);
    expect(applySnapshotInstall({ kind: "Absent" }, snap)).toEqual({ kind: "Absent" });
  });

  it("takes only (state, snapshot) — no optimistic-snapshot parameter exists", () => {
    // The API shape makes it impossible to downgrade an origin from optimistic
    // (Remove/reorder) presentation: there is nowhere to pass one.
    expect(applySnapshotInstall.length).toBe(2);
  });
});

// --- getStartPositionMs ------------------------------------------------------

describe("getStartPositionMs", () => {
  const snap = snapshot([audioItem("iA", "A", 9000)]);
  const overlay: ReadonlyMap<MediaId, OverlayEntry> = new Map([
    [mediaId("A"), { positionMs: 5000, writeRevision: 2, resetEpoch: 0 }],
  ]);

  it("forces 0 for a finished override, ahead of overlay and snapshot", () => {
    expect(getStartPositionMs(mediaId("A"), { finishedOverride: true }, overlay, snap)).toBe(0);
  });

  it("prefers the overlay entry over the snapshot position", () => {
    expect(getStartPositionMs(mediaId("A"), { finishedOverride: false }, overlay, snap)).toBe(5000);
  });

  it("falls back to the snapshot FooterAudio position when no overlay entry exists", () => {
    expect(getStartPositionMs(mediaId("A"), { finishedOverride: false }, new Map(), snap)).toBe(9000);
  });

  it("returns 0 when nothing is known", () => {
    expect(getStartPositionMs(mediaId("B"), { finishedOverride: false }, new Map(), snap)).toBe(0);
  });
});

// --- mintCompletionAttempt ---------------------------------------------------

describe("mintCompletionAttempt", () => {
  function counterMint(): () => string {
    let n = 0;
    return () => {
      n += 1;
      return `mint-${n}`;
    };
  }

  it("mints a frozen FinishLecternItem body for a Lectern origin", () => {
    const session: AudioSession = { descriptor: descriptor("A"), origin: lectern("iA") };
    const attempt = mintCompletionAttempt(session, counterMint());
    expect(attempt.exactId).toBe("mint-1");
    expect(attempt.fallbackStateOnlyId).toBe("mint-2");
    expect(attempt.body).toEqual({
      kind: "FinishLecternItem",
      clientMutationId: "mint-1",
      mediaId: mediaId("A"),
      itemId: itemId("iA"),
      nextCapability: "FooterAudio",
    });
    expect(Object.isFrozen(attempt)).toBe(true);
    expect(Object.isFrozen(attempt.body)).toBe(true);
  });

  it("mints an EnsureMediaFinished body for a Direct origin", () => {
    const session: AudioSession = { descriptor: descriptor("A"), origin: direct };
    const attempt = mintCompletionAttempt(session, counterMint());
    expect(attempt.body).toEqual({
      kind: "EnsureMediaFinished",
      clientMutationId: "mint-1",
      mediaId: mediaId("A"),
    });
  });
});

// --- descriptorFromLecternItem ----------------------------------------------

describe("descriptorFromLecternItem", () => {
  it("builds a descriptor from a footer-audio row", () => {
    expect(descriptorFromLecternItem(audioItem("iA", "A", 4000))).toEqual(descriptor("A", 4000));
  });

  it("defects on a non-footer-audio row", () => {
    const readable = withActivation(audioItem("iR", "R"), { kind: "Readable" });
    expect(() => descriptorFromLecternItem(readable)).toThrow();
  });
});
