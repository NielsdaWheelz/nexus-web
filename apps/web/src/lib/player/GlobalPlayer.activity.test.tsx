import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LecternProvider, useLectern } from "@/lib/lectern/LecternProvider";
import { GlobalPlayerProvider, useGlobalPlayer } from "@/lib/player/globalPlayer";
import { buildFooterDescriptor, installLecternPlayerFetchMock } from "@/__tests__/helpers/audio";

const recorder = vi.hoisted(() => ({
  registerObserver: vi.fn(() => vi.fn()),
  observe: vi.fn(),
}));

vi.mock("@/lib/consumption/activityRecorder", () => ({
  activityRecorder: () => recorder,
}));

const MEDIA_ID = "00000000-0000-4000-8000-000000000901";

function latestListeningRegistration() {
  const observations = recorder.observe.mock.calls as unknown as Array<
    [
      string,
      {
        modality: string;
        eligible: boolean;
        measurement?: { mediaPositionMs?: number };
      },
    ]
  >;
  const call = observations
    .map(([, observation]) => observation)
    .filter((observation) => observation.modality === "Listening")
    .at(-1);
  if (!call) throw new Error("Listening observer was not registered");
  return call as {
    eligible: boolean;
    modality: "Listening";
    measurement?: { mediaPositionMs?: number };
  };
}

function AudioActivityHarness() {
  const { playAudio, bindAudioElement } = useGlobalPlayer();
  const { resource } = useLectern();
  return (
    <>
      <output aria-label="lectern status">{resource.status}</output>
      <button
        type="button"
        onClick={() => playAudio(buildFooterDescriptor(MEDIA_ID, "Activity audio"))}
      >
        Play
      </button>
      <button
        type="button"
        onClick={() =>
          playAudio(
            buildFooterDescriptor(
              "00000000-0000-4000-8000-000000000902",
              "Replacement audio",
            ),
          )
        }
      >
        Replace
      </button>
      <audio ref={bindAudioElement} aria-label="Activity audio element" />
    </>
  );
}

describe("GlobalPlayer activity adapter", () => {
  beforeEach(() => {
    vi.stubGlobal("innerWidth", 1280);
    recorder.registerObserver.mockReset();
    recorder.registerObserver.mockImplementation(() => vi.fn());
    recorder.observe.mockReset();
    installLecternPlayerFetchMock();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts only on playing and closes for every owned stop event regardless of app focus", async () => {
    const view = render(
      <LecternProvider>
        <GlobalPlayerProvider>
          <AudioActivityHarness />
        </GlobalPlayerProvider>
      </LecternProvider>,
    );
    await screen.findByText("ready", { selector: '[aria-label="lectern status"]' });
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    const audio = screen.getByLabelText("Activity audio element") as HTMLAudioElement;

    fireEvent(audio, new Event("playing"));
    await waitFor(() => expect(latestListeningRegistration().eligible).toBe(true));
    audio.currentTime = 12.25;

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("blur"));
    expect(latestListeningRegistration().eligible).toBe(true);

    for (const eventName of ["waiting", "stalled", "pause", "error", "emptied", "ended"]) {
      fireEvent(audio, new Event(eventName));
      await waitFor(() => expect(latestListeningRegistration().eligible).toBe(false));
      expect(
        latestListeningRegistration().measurement?.mediaPositionMs,
      ).toBe(12_250);
      fireEvent(audio, new Event("playing"));
      await waitFor(() => expect(latestListeningRegistration().eligible).toBe(true));
    }

    const priorUnregister = recorder.registerObserver.mock.results.at(-1)
      ?.value as ReturnType<typeof vi.fn>;
    const priorCleanupCount = priorUnregister.mock.calls.length;
    const registrationsBeforeReplacement =
      recorder.registerObserver.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() =>
      expect(priorUnregister.mock.calls.length).toBeGreaterThan(
        priorCleanupCount,
      ),
    );
    await waitFor(() =>
      expect(recorder.registerObserver.mock.calls.length).toBeGreaterThan(
        registrationsBeforeReplacement,
      ),
    );

    const replacementUnregister = recorder.registerObserver.mock.results.at(-1)
      ?.value as ReturnType<typeof vi.fn>;
    const replacementCleanupCount = replacementUnregister.mock.calls.length;
    view.unmount();
    expect(replacementUnregister.mock.calls.length).toBeGreaterThan(
      replacementCleanupCount,
    );
  });

});
