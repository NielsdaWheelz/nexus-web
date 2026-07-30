import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  usePlayerCapture,
  type PlayerCaptureController,
} from "@/lib/walknotes/usePlayerCapture";

const mocks = vi.hoisted(() => ({
  canTranscribe: true,
  waypoints: [{ id: "waypoint-a" }, { id: "waypoint-b" }],
  addWaypoint: vi.fn(() => "waypoint-new"),
  updateWaypointVoice: vi.fn(),
  recorderStart: vi.fn<() => Promise<void>>(),
  recorderStop: vi.fn(),
  transcribeAudio: vi.fn(),
}));

vi.mock("@/lib/billing/useBillingAccount", () => ({
  useBillingAccount: () => ({
    account: { can_transcribe: mocks.canTranscribe },
  }),
}));

vi.mock("@/lib/walknotes/walknoteSession", () => ({
  useWalknoteSession: () => ({
    waypoints: mocks.waypoints,
    addWaypoint: mocks.addWaypoint,
    updateWaypointVoice: mocks.updateWaypointVoice,
  }),
}));

vi.mock("@/lib/walknotes/useVoiceRecorder", () => ({
  useVoiceRecorder: () => ({
    start: mocks.recorderStart,
    stop: mocks.recorderStop,
  }),
}));

vi.mock("@/lib/walknotes/transcribeAudio", () => ({
  transcribeAudio: mocks.transcribeAudio,
}));

let capture: PlayerCaptureController | null = null;

function CaptureHarness() {
  capture = usePlayerCapture();
  return (
    <button
      type="button"
      onPointerDown={(event) =>
        capture!.handlePointerDown(event, {
          mediaId: "media-1",
          positionMs: 12_345.9,
        })
      }
      onPointerUp={() => capture!.handlePointerUp()}
      onPointerCancel={() => capture!.handlePointerCancel()}
    >
      Capture
    </button>
  );
}

async function fireHold(): Promise<void> {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Capture" }), {
    pointerId: 7,
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
}

describe("usePlayerCapture", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.canTranscribe = true;
    mocks.recorderStart.mockResolvedValue();
    mocks.recorderStop.mockResolvedValue({
      blob: new Blob(["voice"], { type: "audio/webm" }),
      durationMs: 700,
    });
    mocks.transcribeAudio.mockResolvedValue("Remember this");
  });

  afterEach(() => {
    capture = null;
    vi.useRealTimers();
  });

  it("captures a tap at the pointer-down playback snapshot", () => {
    render(<CaptureHarness />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Capture" }), {
      pointerId: 7,
    });
    fireEvent.pointerUp(screen.getByRole("button", { name: "Capture" }), {
      pointerId: 7,
    });

    expect(mocks.addWaypoint).toHaveBeenCalledOnce();
    expect(mocks.addWaypoint).toHaveBeenCalledWith("media-1", 12_345);
    expect(mocks.recorderStart).not.toHaveBeenCalled();
  });

  it("records, transcribes, and completes a held Capture", async () => {
    render(<CaptureHarness />);
    await fireHold();

    expect(mocks.addWaypoint).toHaveBeenCalledWith("media-1", 12_345);
    expect(mocks.updateWaypointVoice).toHaveBeenCalledWith(
      "waypoint-new",
      "recording",
    );
    expect(capture!.isRecording).toBe(true);
    expect(capture!.announcement).toBe("Recording");

    fireEvent.pointerUp(screen.getByRole("button", { name: "Capture" }), {
      pointerId: 7,
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.recorderStop).toHaveBeenCalledOnce();
    expect(mocks.transcribeAudio).toHaveBeenCalledOnce();
    expect(mocks.updateWaypointVoice).toHaveBeenLastCalledWith(
      "waypoint-new",
      "done",
      "Remember this",
    );
    expect(capture!.isRecording).toBe(false);
    expect(capture!.announcement).toBe("");
  });

  it("falls back to a tap-only waypoint when voice is unavailable", async () => {
    mocks.canTranscribe = false;
    render(<CaptureHarness />);
    await fireHold();

    fireEvent.pointerUp(screen.getByRole("button", { name: "Capture" }), {
      pointerId: 7,
    });

    expect(mocks.addWaypoint).toHaveBeenCalledOnce();
    expect(mocks.addWaypoint).toHaveBeenCalledWith("media-1", 12_345);
    expect(mocks.recorderStart).not.toHaveBeenCalled();
  });

  it("dismisses immediately while microphone startup finishes in the background", async () => {
    let resolveStart: (() => void) | null = null;
    mocks.recorderStart.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );
    render(<CaptureHarness />);
    act(() => capture!.openReview());
    await fireHold();
    expect(capture!.isRecording).toBe(true);

    act(() => capture!.closeForPlayerDismissal());
    expect(capture!.reviewOpen).toBe(false);
    expect(capture!.isRecording).toBe(false);
    expect(mocks.recorderStop).not.toHaveBeenCalled();

    await act(async () => {
      resolveStart!();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.recorderStop).toHaveBeenCalledOnce();
    expect(mocks.updateWaypointVoice).toHaveBeenLastCalledWith(
      "waypoint-new",
      "done",
      "Remember this",
    );
  });

  it("owns review state, count, and materialization announcements", () => {
    render(<CaptureHarness />);
    expect(capture!.waypointCount).toBe(2);

    act(() => {
      capture!.openReview();
      capture!.announceMaterialized(1);
    });
    expect(capture!.reviewOpen).toBe(true);
    expect(capture!.announcement).toBe("1 highlight created");

    act(() => capture!.closeReview());
    expect(capture!.reviewOpen).toBe(false);
  });
});
