import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useVoiceRecorder, E_MIC_DENIED, E_MIC_UNAVAILABLE, MAX_VOICE_NOTE_DURATION_MS } from "./useVoiceRecorder";

function makeMediaRecorderClass() {
  // We need to capture the instance created by `new MediaRecorder(...)` so tests
  // can trigger its callbacks. Use a module-level ref via a singleton-per-test.
  let latestInstance: InstanceType<typeof MockMediaRecorder> | null = null;

  class MockMediaRecorder {
    state: "inactive" | "recording" = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(_stream: MediaStream) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      latestInstance = this;
    }

    start() {
      this.state = "recording";
    }

    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
      this.onstop?.();
    }
  }

  return {
    MockMediaRecorder,
    getInstance: () => latestInstance,
  };
}

describe("useVoiceRecorder", () => {
  let getUserMediaMock: ReturnType<typeof vi.fn>;
  let mockStream: MediaStream;
  let recorderFactory: ReturnType<typeof makeMediaRecorderClass>;

  beforeEach(() => {
    vi.useFakeTimers();
    recorderFactory = makeMediaRecorderClass();
    mockStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;

    getUserMediaMock = vi.fn().mockResolvedValue(mockStream);
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: {
        getUserMedia: getUserMediaMock,
      },
    });

    vi.stubGlobal("MediaRecorder", recorderFactory.MockMediaRecorder);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts recording and returns a blob on stop", async () => {
    const { result } = renderHook(() => useVoiceRecorder());

    await act(async () => {
      await result.current.start();
    });

    expect(getUserMediaMock).toHaveBeenCalledWith({ audio: true });
    const instance = recorderFactory.getInstance();
    expect(instance).not.toBeNull();

    let recording: { blob: Blob; durationMs: number } | null = null;
    await act(async () => {
      recording = await result.current.stop();
    });

    expect(recording).not.toBeNull();
    expect(recording!.blob).toBeInstanceOf(Blob);
    expect(recording!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("throws E_MIC_DENIED when microphone is denied", async () => {
    const denied = Object.assign(new Error("NotAllowedError"), {
      name: "NotAllowedError",
    });
    getUserMediaMock.mockRejectedValue(denied);

    const { result } = renderHook(() => useVoiceRecorder());

    let caughtError: (Error & { code?: string }) | null = null;
    await act(async () => {
      try {
        await result.current.start();
      } catch (err) {
        caughtError = err as Error & { code?: string };
      }
    });

    expect(caughtError).not.toBeNull();
    expect(caughtError!.code).toBe(E_MIC_DENIED);
  });

  it("throws E_MIC_UNAVAILABLE when no microphone found", async () => {
    const notFound = Object.assign(new Error("NotFoundError"), {
      name: "NotFoundError",
    });
    getUserMediaMock.mockRejectedValue(notFound);

    const { result } = renderHook(() => useVoiceRecorder());

    let caughtError: (Error & { code?: string }) | null = null;
    await act(async () => {
      try {
        await result.current.start();
      } catch (err) {
        caughtError = err as Error & { code?: string };
      }
    });

    expect(caughtError).not.toBeNull();
    expect(caughtError!.code).toBe(E_MIC_UNAVAILABLE);
  });

  it("auto-stops recording after MAX_VOICE_NOTE_DURATION_MS", async () => {
    const { result } = renderHook(() => useVoiceRecorder());

    await act(async () => {
      await result.current.start();
    });

    const instance = recorderFactory.getInstance();
    expect(instance?.state).toBe("recording");

    await act(async () => {
      vi.advanceTimersByTime(MAX_VOICE_NOTE_DURATION_MS);
    });

    expect(recorderFactory.getInstance()?.state).toBe("inactive");
  });
});
