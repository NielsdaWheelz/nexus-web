import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import GlobalPlayerFooter from "@/components/GlobalPlayerFooter";
import { GlobalPlayerProvider, useGlobalPlayer } from "@/lib/player/globalPlayer";
import { LecternProvider, useLectern } from "@/lib/lectern/LecternProvider";
import { assumeMediaId } from "@/lib/lectern/client";
import {
  buildFooterDescriptor,
  installLecternPlayerFetchMock,
  jsonResponse,
  setAudioMetrics,
  setViewportWidth,
  FOOTER_AUDIO_LABEL,
} from "../helpers/audio";

function installIntervalHarness() {
  const handlers = new Map<number, { delay: number; handler: TimerHandler }>();
  let nextId = 1;

  const setIntervalSpy = vi.spyOn(window, "setInterval").mockImplementation((handler, delay) => {
    const intervalId = nextId;
    nextId += 1;
    handlers.set(intervalId, { delay: Number(delay), handler });
    return intervalId as unknown as ReturnType<typeof window.setInterval>;
  });

  const clearIntervalSpy = vi.spyOn(window, "clearInterval").mockImplementation((intervalId) => {
    handlers.delete(Number(intervalId));
  });

  return {
    setIntervalSpy,
    clearIntervalSpy,
    run(delay: number): boolean {
      let invoked = false;
      for (const { delay: registeredDelay, handler } of handlers.values()) {
        if (registeredDelay !== delay || typeof handler !== "function") continue;
        handler();
        invoked = true;
      }
      return invoked;
    },
  };
}

function listeningStatePuts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- justify-eslint-override: fetch mock calls are intentionally untyped test data.
  fetchSpy: { mock: { calls: any[][] } },
): Array<[input: string, init?: RequestInit]> {
  return fetchSpy.mock.calls.filter(
    (args) =>
      String(args[0]).includes("/listening-state") &&
      (args[1]?.method ?? "GET") === "PUT",
  ) as Array<[string, RequestInit?]>;
}

const DESCRIPTOR_A = buildFooterDescriptor("media-123", "Episode Alpha", {
  positionMs: 45_000,
  playbackSpeed: 1.75,
});
const DESCRIPTOR_B = buildFooterDescriptor("media-456", "Episode Beta");

function PersistenceProbe() {
  const { persistence } = useGlobalPlayer();
  return <span data-testid="persistence">{persistence.kind}</span>;
}

function LecternReadyProbe() {
  const { resource } = useLectern();
  return <span data-testid="lectern-status">{resource.status}</span>;
}

function Harness() {
  const { playAudio } = useGlobalPlayer();
  return (
    <>
      <button type="button" onClick={() => playAudio(DESCRIPTOR_A)}>Load episode A</button>
      <button type="button" onClick={() => playAudio(DESCRIPTOR_B)}>Load episode B</button>
      <PersistenceProbe />
      <LecternReadyProbe />
      <GlobalPlayerFooter />
    </>
  );
}

function App() {
  return (
    <LecternProvider>
      <GlobalPlayerProvider>
        <Harness />
      </GlobalPlayerProvider>
    </LecternProvider>
  );
}

async function loadA() {
  await screen.findByText("ready", { selector: '[data-testid="lectern-status"]' });
  fireEvent.click(screen.getByRole("button", { name: "Load episode A" }));
}

describe("GlobalPlayer listening heartbeat", () => {
  beforeEach(() => {
    setViewportWidth(1280);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends a fenced camelCase heartbeat on the 15s cadence and on pause", async () => {
    const { fetchMock } = installLecternPlayerFetchMock();
    const intervals = installIntervalHarness();

    render(<App />);
    await loadA();

    const audio = screen.getByLabelText(FOOTER_AUDIO_LABEL) as HTMLAudioElement;
    setAudioMetrics(audio, { duration: 120, currentTime: 30, playbackRate: 1.5 });
    fireEvent(audio, new Event("durationchange"));
    fireEvent(audio, new Event("timeupdate"));
    fireEvent(audio, new Event("play"));

    await waitFor(() =>
      expect(intervals.setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 15_000),
    );
    expect(intervals.run(15_000)).toBe(true);

    await waitFor(() => expect(listeningStatePuts(fetchMock).length).toBeGreaterThanOrEqual(1));
    const [url, init] = listeningStatePuts(fetchMock)[0];
    expect(String(url)).toContain("/api/media/media-123/listening-state");
    const body = JSON.parse(String(init?.body ?? "{}"));
    expect(body).toMatchObject({
      positionMs: expect.any(Number),
      playbackSpeed: expect.any(Number),
      deviceId: expect.any(String),
      expectedWriteRevision: expect.any(Number),
      expectedResetEpoch: expect.any(Number),
      heartbeatSequence: expect.any(Number),
    });
    expect(typeof body.heartbeatGeneration).toBe("string");
    expect(body.durationMs).toHaveProperty("kind");

    const before = listeningStatePuts(fetchMock).length;
    fireEvent(audio, new Event("pause"));
    await waitFor(() => expect(listeningStatePuts(fetchMock).length).toBeGreaterThan(before));
  });

  it("flushes the outgoing media's heartbeat on a session switch", async () => {
    const { fetchMock } = installLecternPlayerFetchMock();

    render(<App />);
    await loadA();

    const audio = screen.getByLabelText(FOOTER_AUDIO_LABEL) as HTMLAudioElement;
    setAudioMetrics(audio, { duration: 120, currentTime: 15 });
    fireEvent(audio, new Event("durationchange"));
    fireEvent(audio, new Event("timeupdate"));

    fireEvent.click(screen.getByRole("button", { name: "Load episode B" }));

    await waitFor(() =>
      expect(
        listeningStatePuts(fetchMock).some(([url]) =>
          String(url).includes("/api/media/media-123/listening-state"),
        ),
      ).toBe(true),
    );
  });

  it("applies the descriptor resume seek and speed on Direct play", async () => {
    installLecternPlayerFetchMock();
    render(<App />);
    await loadA();

    const audio = screen.getByLabelText(FOOTER_AUDIO_LABEL) as HTMLAudioElement;
    fireEvent(audio, new Event("loadedmetadata"));

    await waitFor(() => {
      expect(Math.floor(audio.currentTime)).toBe(45);
      expect(audio.playbackRate).toBeCloseTo(1.75, 3);
    });
  });

  it("suspends persistence when heartbeat GET recovery fails (playback continues)", async () => {
    // Lectern GET succeeds; every listening-state PUT/GET fails, forcing the
    // engine through recovery into Suspended.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/lectern" && method === "GET") {
        return jsonResponse({ data: { items: [] } });
      }
      if (url.pathname.endsWith("/listening-state")) {
        throw new TypeError("network down");
      }
      return jsonResponse({ data: {} });
    });
    const intervals = installIntervalHarness();

    render(<App />);
    await loadA();

    const audio = screen.getByLabelText(FOOTER_AUDIO_LABEL) as HTMLAudioElement;
    setAudioMetrics(audio, { duration: 120, currentTime: 10 });
    fireEvent(audio, new Event("durationchange"));
    fireEvent(audio, new Event("timeupdate"));
    fireEvent(audio, new Event("play"));

    await waitFor(() =>
      expect(intervals.setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 15_000),
    );
    intervals.run(15_000);

    await waitFor(() =>
      expect(screen.getByTestId("persistence").textContent).toBe("Suspended"),
    );
    // Playback is unaffected: the dock is still mounted.
    expect(screen.getByRole("region", { name: "Media player" })).toBeInTheDocument();
  });

  it("drains the in-flight heartbeat BEFORE issuing the active-media SetUnread command", async () => {
    // spec §5.4: "Before active-media Unread, the provider closes and drains the
    // old generation ... then issues the command." The fetch order must show the
    // heartbeat PUT resolving before the SetUnread consumption POST.
    const MEDIA = "33333333-3333-4333-8333-333333333333";
    const order: string[] = [];
    let releasePut!: () => void;
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve;
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/lectern" && method === "GET") {
        return jsonResponse({ data: { items: [] } });
      }
      if (url.pathname === "/api/consumption/commands" && method === "POST") {
        order.push("setUnread");
        return jsonResponse({
          data: {
            outcome: { kind: "StateOnly" },
            lectern: { items: [] },
            nextItem: { kind: "Absent" },
            listeningStates: [
              {
                mediaId: MEDIA,
                state: {
                  positionMs: 0,
                  durationMs: { kind: "Absent" },
                  playbackSpeed: 1,
                  writeRevision: 5,
                  resetEpoch: 1,
                },
              },
            ],
          },
        });
      }
      if (url.pathname.endsWith("/listening-state")) {
        if (method === "PUT") {
          order.push("heartbeatPut");
          await putGate; // hang until released so the drain has something to await
          const body = JSON.parse(String(init?.body ?? "{}"));
          return jsonResponse({
            data: {
              listeningState: {
                positionMs: body.positionMs,
                durationMs: body.durationMs,
                playbackSpeed: body.playbackSpeed,
                writeRevision: 1,
                resetEpoch: 0,
              },
              heartbeatGeneration: body.heartbeatGeneration,
              heartbeatSequence: body.heartbeatSequence,
            },
          });
        }
        return jsonResponse({
          data: { positionMs: 0, durationMs: { kind: "Absent" }, playbackSpeed: 1, writeRevision: 0, resetEpoch: 0 },
        });
      }
      return jsonResponse({ data: {} });
    });
    const intervals = installIntervalHarness();

    function DrainHarness() {
      const { playAudio } = useGlobalPlayer();
      const { setUnread } = useLectern();
      return (
        <>
          <button
            type="button"
            onClick={() => playAudio(buildFooterDescriptor(MEDIA, "Drainable"))}
          >
            Load drain
          </button>
          <button
            type="button"
            onClick={() => {
              setUnread(assumeMediaId(MEDIA)).catch(() => {});
            }}
          >
            Mark unread
          </button>
          <LecternReadyProbe />
          <GlobalPlayerFooter />
        </>
      );
    }

    render(
      <LecternProvider>
        <GlobalPlayerProvider>
          <DrainHarness />
        </GlobalPlayerProvider>
      </LecternProvider>,
    );

    await screen.findByText("ready", { selector: '[data-testid="lectern-status"]' });
    fireEvent.click(screen.getByRole("button", { name: "Load drain" }));

    const audio = screen.getByLabelText(FOOTER_AUDIO_LABEL) as HTMLAudioElement;
    setAudioMetrics(audio, { duration: 120, currentTime: 30 });
    fireEvent(audio, new Event("durationchange"));
    fireEvent(audio, new Event("timeupdate"));
    fireEvent(audio, new Event("play"));

    await waitFor(() =>
      expect(intervals.setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 15_000),
    );
    intervals.run(15_000); // fire one heartbeat -> PUT in flight (hangs)
    await waitFor(() => expect(order).toContain("heartbeatPut"));

    fireEvent.click(screen.getByRole("button", { name: "Mark unread" }));
    // Give the command a chance to (wrongly) race ahead: while the heartbeat PUT
    // hangs, the SetUnread POST must NOT be sent.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(order).toEqual(["heartbeatPut"]);

    // Release the heartbeat: the drain completes, then the command is issued.
    releasePut();
    await waitFor(() => expect(order).toContain("setUnread"));
    expect(order.indexOf("heartbeatPut")).toBeLessThan(order.indexOf("setUnread"));
  });
});
