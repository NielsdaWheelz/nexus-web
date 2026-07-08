import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  E_WALKNOTE_NO_FRAGMENT,
  SESSION_STORAGE_KEY,
  loadFromSessionStorage,
  saveToSessionStorage,
  type WalknoteWaypoint,
} from "./walknoteSession";

const WAYPOINT_A: WalknoteWaypoint = {
  id: "wp-1",
  media_id: "media-1",
  position_ms: 12_000,
  recorded_at: "2026-07-08T10:00:00.000Z",
  voice_text: null,
  voice_status: "idle",
};

const WAYPOINT_B: WalknoteWaypoint = {
  id: "wp-2",
  media_id: "media-1",
  position_ms: 45_000,
  recorded_at: "2026-07-08T10:01:00.000Z",
  voice_text: "Interesting point about recursion",
  voice_status: "done",
};

function makeSessionStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => store.clear()),
    store,
  };
}

describe("walknoteSession storage helpers", () => {
  let mockStorage: ReturnType<typeof makeSessionStorage>;

  beforeEach(() => {
    mockStorage = makeSessionStorage();
    vi.stubGlobal("sessionStorage", mockStorage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads an empty array when storage is empty", () => {
    expect(loadFromSessionStorage()).toEqual([]);
  });

  it("loads waypoints persisted by saveToSessionStorage (round-trip)", () => {
    const waypoints = [WAYPOINT_A, WAYPOINT_B];
    saveToSessionStorage(waypoints);
    const loaded = loadFromSessionStorage();
    expect(loaded).toEqual(waypoints);
    expect(mockStorage.setItem).toHaveBeenCalledWith(
      SESSION_STORAGE_KEY,
      JSON.stringify(waypoints)
    );
  });

  it("returns empty array when stored JSON is corrupt", () => {
    mockStorage.store.set(SESSION_STORAGE_KEY, "{invalid json");
    expect(loadFromSessionStorage()).toEqual([]);
  });

  it("persists an update to an existing waypoint correctly", () => {
    const waypoints: WalknoteWaypoint[] = [
      { ...WAYPOINT_A, voice_status: "done", voice_text: "hello" },
    ];
    saveToSessionStorage(waypoints);
    const loaded = loadFromSessionStorage();
    expect(loaded[0]?.voice_text).toBe("hello");
    expect(loaded[0]?.voice_status).toBe("done");
  });

  it("persists removal (save with empty array clears session)", () => {
    saveToSessionStorage([WAYPOINT_A]);
    saveToSessionStorage([]);
    expect(loadFromSessionStorage()).toEqual([]);
  });

  it("handles sessionStorage being unavailable (throws on write)", () => {
    mockStorage.setItem.mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    expect(() => saveToSessionStorage([WAYPOINT_A])).not.toThrow();
  });

  it("handles sessionStorage being unavailable (throws on read)", () => {
    mockStorage.getItem.mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    expect(loadFromSessionStorage()).toEqual([]);
  });
});

describe("E_WALKNOTE_NO_FRAGMENT", () => {
  it("is a non-empty string constant", () => {
    expect(typeof E_WALKNOTE_NO_FRAGMENT).toBe("string");
    expect(E_WALKNOTE_NO_FRAGMENT.length).toBeGreaterThan(0);
  });
});
