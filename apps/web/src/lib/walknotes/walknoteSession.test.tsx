import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import {
  SESSION_STORAGE_KEY,
  WalknoteSessionProvider,
  useWalknoteSession,
} from "./walknoteSession";

function wrapper({ children }: { children: ReactNode }) {
  return createElement(WalknoteSessionProvider, null, children);
}

beforeEach(() => {
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
});

afterEach(() => {
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
});

describe("useWalknoteSession — hook operations", () => {
  it("addWaypoint returns a non-empty id and appends the waypoint to the list", () => {
    const { result } = renderHook(() => useWalknoteSession(), { wrapper });

    let id: string;
    act(() => {
      id = result.current.addWaypoint("media-1", 12_000);
    });

    expect(id!).toBeTruthy();
    expect(result.current.waypoints).toHaveLength(1);
    expect(result.current.waypoints[0]).toMatchObject({
      id: id!,
      media_id: "media-1",
      position_ms: 12_000,
      voice_status: "idle",
      voice_text: null,
    });
  });

  it("updateWaypointVoice patches voice_status and voice_text on the identified waypoint", () => {
    const { result } = renderHook(() => useWalknoteSession(), { wrapper });

    let id: string;
    act(() => {
      id = result.current.addWaypoint("media-1", 30_000);
    });

    act(() => {
      result.current.updateWaypointVoice(id!, "done", "Great insight here");
    });

    const waypoint = result.current.waypoints.find((w) => w.id === id!);
    expect(waypoint?.voice_status).toBe("done");
    expect(waypoint?.voice_text).toBe("Great insight here");
  });

  it("removeWaypoint removes the waypoint with the given id", () => {
    const { result } = renderHook(() => useWalknoteSession(), { wrapper });

    let idA: string;
    let idB: string;
    act(() => {
      idA = result.current.addWaypoint("media-1", 10_000);
      idB = result.current.addWaypoint("media-1", 20_000);
    });

    act(() => {
      result.current.removeWaypoint(idA!);
    });

    expect(result.current.waypoints).toHaveLength(1);
    expect(result.current.waypoints[0]?.id).toBe(idB!);
  });

  it("persists waypoints across a re-mount (session storage round-trip)", () => {
    const { result: first, unmount } = renderHook(() => useWalknoteSession(), {
      wrapper,
    });

    let id: string;
    act(() => {
      id = first.current.addWaypoint("media-2", 55_000);
    });

    expect(first.current.waypoints).toHaveLength(1);
    unmount();

    // Re-mount a fresh provider over the same sessionStorage
    const { result: second } = renderHook(() => useWalknoteSession(), {
      wrapper,
    });

    expect(second.current.waypoints).toHaveLength(1);
    expect(second.current.waypoints[0]?.id).toBe(id!);
    expect(second.current.waypoints[0]?.media_id).toBe("media-2");
    expect(second.current.waypoints[0]?.position_ms).toBe(55_000);
  });
});
