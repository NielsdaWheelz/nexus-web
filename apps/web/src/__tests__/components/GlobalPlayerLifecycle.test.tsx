/**
 * Focused GlobalPlayer completion/origin lifecycle tests (spec §8 AC-1/8/11).
 * These drive the real provider + real LecternProvider through a fetch spy — no
 * internal mocks — to prove the natural-end completion, Direct end, exact-end
 * E_NOT_FOUND fallback, and failed-active-Remove origin-preservation contracts.
 *
 * Type-level guarantee (no runtime test needed): `playAudio(input: PlayerDescriptor)`
 * only accepts an activation of `kind: "FooterAudio"`; a video (`OpenPane`)
 * activation is not assignable to `PlayerDescriptor`, so a video descriptor can
 * never reach `<audio>` — the construction is a compile error, not a branch.
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import GlobalPlayerFooter from "@/components/GlobalPlayerFooter";
import {
  GlobalPlayerProvider,
  useGlobalPlayer,
} from "@/lib/player/globalPlayer";
import { LecternProvider, useLectern } from "@/lib/lectern/LecternProvider";
import { absent } from "@/lib/api/presence";
import { assumeMediaId, type LecternItem } from "@/lib/lectern/contract";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import {
  buildFooterDescriptor,
  jsonResponse,
  setAudioMetrics,
  setViewportWidth,
  FOOTER_AUDIO_LABEL,
} from "../helpers/audio";

const MEDIA_A = "11111111-1111-4111-8111-111111111111";
const MEDIA_B = "22222222-2222-4222-8222-222222222222";
const ITEM_A = "aaaaaaaa-1111-4111-8111-111111111111";
const ITEM_B = "bbbbbbbb-2222-4222-8222-222222222222";

function audioItem(
  itemId: string,
  mediaId: string,
  title: string,
): LecternItem {
  return {
    itemId: itemId as LecternItem["itemId"],
    mediaId: mediaId as LecternItem["mediaId"],
    kind: "podcast_episode",
    title,
    subtitle: absent(),
    href: `/media/${mediaId}` as LecternItem["href"],
    consumption: { state: "Unread", progress: absent(), progressResettable: false },
    activation: {
      kind: "FooterAudio",
      streamUrl: `https://cdn.example.com/${mediaId}.mp3`,
      sourceUrl: `https://example.com/${mediaId}`,
      positionMs: 0,
      writeRevision: 0,
      resetEpoch: 0,
      playbackSpeed: 1,
      durationMs: absent(),
      artworkUrl: absent(),
      chapters: [],
    },
    actionTarget: routeResourceActionSubject({
      scheme: "media",
      id: mediaId,
      href: `/media/${mediaId}`,
    }),
  };
}

// The mock starts from decoded app fixtures; the strict wire decoder derives
// `actionTarget`, so that app-only field must never be sent back over HTTP.
function lecternWireItem(item: LecternItem): Omit<LecternItem, "actionTarget"> {
  const { actionTarget: _actionTarget, ...wire } = item;
  return wire;
}

function lecternWireSnapshot(items: LecternItem[]) {
  return { items: items.map(lecternWireItem) };
}

function heartbeatResponse(init: RequestInit | undefined): Response {
  const method = init?.method ?? "GET";
  if (method === "PUT") {
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
    data: {
      positionMs: 0,
      durationMs: { kind: "Absent" },
      playbackSpeed: 1,
      writeRevision: 0,
      resetEpoch: 0,
    },
  });
}

interface MockConfig {
  snapshot: () => LecternItem[];
  onConsumption?: (body: Record<string, unknown>) => Response;
  onLectern?: (body: Record<string, unknown>) => Response;
}

function installMock(config: MockConfig) {
  const consumptionBodies: Record<string, unknown>[] = [];
  const lecternBodies: Record<string, unknown>[] = [];
  const heartbeatBodies: Record<string, unknown>[] = [];
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/lectern" && method === "GET") {
        return jsonResponse({ data: lecternWireSnapshot(config.snapshot()) });
      }
      if (url.pathname === "/api/consumption/commands" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        consumptionBodies.push(body);
        return config.onConsumption
          ? config.onConsumption(body)
          : jsonResponse({
              data: {
                outcome: { kind: "StateOnly" },
                lectern: lecternWireSnapshot(config.snapshot()),
                nextItem: { kind: "Absent" },
                progressState: { kind: "Absent" },
                completionHandle: { kind: "Absent" },
              },
            });
      }
      if (url.pathname === "/api/lectern/commands" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        lecternBodies.push(body);
        return config.onLectern
          ? config.onLectern(body)
          : jsonResponse({
              data: {
                outcome: { kind: "Ordered" },
                lectern: lecternWireSnapshot(config.snapshot()),
              },
            });
      }
      if (url.pathname.endsWith("/listening-state")) {
        if (method === "PUT") {
          heartbeatBodies.push(JSON.parse(String(init?.body ?? "{}")));
        }
        return heartbeatResponse(init);
      }
      return jsonResponse({ data: {} });
    });
  return { fetchMock, consumptionBodies, lecternBodies, heartbeatBodies };
}

function Probes() {
  const { state } = useGlobalPlayer();
  const origin = state.kind === "Absent" ? "none" : state.session.origin.kind;
  const phase = state.kind === "Active" ? state.phase : "none";
  return (
    <>
      <span data-testid="state-kind">{state.kind}</span>
      <span data-testid="state-phase">{phase}</span>
      <span data-testid="origin">{origin}</span>
    </>
  );
}

function LecternReadyProbe() {
  const { resource } = useLectern();
  return <span data-testid="lectern-status">{resource.status}</span>;
}

function Controls({
  playMediaId,
  playTitle,
}: {
  playMediaId: string;
  playTitle: string;
}) {
  const { playAudio } = useGlobalPlayer();
  const { removeItem } = useLectern();
  return (
    <>
      <button
        type="button"
        onClick={() => playAudio(buildFooterDescriptor(playMediaId, playTitle))}
      >
        Play A
      </button>
      <button
        type="button"
        onClick={() => {
          // The provider rejects a still-pending command with an AbortError on
          // unmount; swallow it so test teardown has no unhandled rejection.
          removeItem(ITEM_A as LecternItem["itemId"]).catch(() => {});
        }}
      >
        Remove A
      </button>
    </>
  );
}

function App({
  playMediaId,
  playTitle,
}: {
  playMediaId: string;
  playTitle: string;
}) {
  return (
    <LecternProvider>
      <GlobalPlayerProvider>
        <LecternReadyProbe />
        <Probes />
        <Controls playMediaId={playMediaId} playTitle={playTitle} />
        <GlobalPlayerFooter />
      </GlobalPlayerProvider>
    </LecternProvider>
  );
}

function StatusOnlyOverrideControls() {
  const { playAudio } = useGlobalPlayer();
  const { setUnread } = useLectern();
  return (
    <>
      <button
        type="button"
        onClick={() => playAudio(buildFooterDescriptor(MEDIA_A, "Override Alpha"))}
      >
        Load override A
      </button>
      <button
        type="button"
        onClick={() => playAudio(buildFooterDescriptor(MEDIA_B, "Override Bravo"))}
      >
        Load override B
      </button>
      <button
        type="button"
        onClick={() => {
          setUnread(assumeMediaId(MEDIA_A)).catch(() => {});
        }}
      >
        Mark override A unread
      </button>
    </>
  );
}

function StatusOnlyOverrideApp() {
  return (
    <LecternProvider>
      <GlobalPlayerProvider>
        <LecternReadyProbe />
        <Probes />
        <StatusOnlyOverrideControls />
        <GlobalPlayerFooter />
      </GlobalPlayerProvider>
    </LecternProvider>
  );
}

async function playAndReady() {
  await screen.findByText("ready", {
    selector: '[data-testid="lectern-status"]',
  });
  fireEvent.click(screen.getByRole("button", { name: "Play A" }));
}

describe("GlobalPlayer completion lifecycle", () => {
  beforeEach(() => {
    setViewportWidth(1280);
    window.localStorage.clear();
    // The provider autoplays on session start; stub the element transport so
    // Chromium never fetches the fake stream URL (whose async network error
    // would race the ended/completion assertions).
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("Lectern-origin natural end freezes FinishLecternItem, installs snapshot, then starts the returned next", async () => {
    let items = [
      audioItem(ITEM_A, MEDIA_A, "First"),
      audioItem(ITEM_B, MEDIA_B, "Second"),
    ];
    const { consumptionBodies } = installMock({
      snapshot: () => items,
      onConsumption: (body) => {
        // FinishLecternItem removes A, selects B, and returns the new snapshot.
        items = [audioItem(ITEM_B, MEDIA_B, "Second")];
        return jsonResponse({
          data: {
            outcome: {
              kind: "Removed",
              itemId: ITEM_A,
              nextItemId: { kind: "Present", value: ITEM_B },
            },
            lectern: lecternWireSnapshot(items),
            nextItem: {
              kind: "Present",
              value: lecternWireItem(audioItem(ITEM_B, MEDIA_B, "Second")),
            },
            progressState: { kind: "Absent" },
            completionHandle: { kind: "Absent" },
          },
        });
        void body;
      },
    });

    render(<App playMediaId={MEDIA_A} playTitle="First" />);
    await playAndReady();
    await waitFor(() =>
      expect(screen.getByTestId("origin").textContent).toBe("Lectern"),
    );

    const audio = screen.getByLabelText(FOOTER_AUDIO_LABEL) as HTMLAudioElement;
    fireEvent(audio, new Event("ended"));

    // Advances to the returned next session (proves snapshot installed before start).
    expect(await screen.findByText("Second")).toBeInTheDocument();

    const finish = consumptionBodies.find(
      (b) => b.kind === "FinishLecternItem",
    );
    expect(finish).toMatchObject({
      kind: "FinishLecternItem",
      mediaId: MEDIA_A,
      itemId: ITEM_A,
      nextCapability: "FooterAudio",
    });
    expect(typeof finish?.clientMutationId).toBe("string");
  });

  it("Direct end runs EnsureMediaFinished and holds PausedAtEnd", async () => {
    const { consumptionBodies } = installMock({ snapshot: () => [] });

    render(<App playMediaId={MEDIA_A} playTitle="Direct" />);
    await playAndReady();
    await waitFor(() =>
      expect(screen.getByTestId("origin").textContent).toBe("Direct"),
    );

    const audio = screen.getByLabelText(FOOTER_AUDIO_LABEL) as HTMLAudioElement;
    fireEvent(audio, new Event("ended"));

    await waitFor(() =>
      expect(screen.getByTestId("state-kind").textContent).toBe("PausedAtEnd"),
    );
    expect(
      consumptionBodies.some(
        (b) => b.kind === "EnsureMediaFinished" && b.mediaId === MEDIA_A,
      ),
    ).toBe(true);
  });

  it("status-only SetUnread preserves active progress and resumes a previously finished direct media", async () => {
    const { consumptionBodies, heartbeatBodies } = installMock({ snapshot: () => [] });

    render(<StatusOnlyOverrideApp />);
    await screen.findByText("ready", {
      selector: '[data-testid="lectern-status"]',
    });

    fireEvent.click(screen.getByRole("button", { name: "Load override A" }));
    const audio = screen.getByLabelText(FOOTER_AUDIO_LABEL) as HTMLAudioElement;
    setAudioMetrics(audio, { duration: 120, currentTime: 120 });
    fireEvent(audio, new Event("durationchange"));
    fireEvent(audio, new Event("timeupdate"));
    fireEvent(audio, new Event("ended"));

    await waitFor(() =>
      expect(screen.getByTestId("state-kind").textContent).toBe("PausedAtEnd"),
    );
    expect(
      consumptionBodies.some(
        (body) => body.kind === "EnsureMediaFinished" && body.mediaId === MEDIA_A,
      ),
    ).toBe(true);

    // Replay once so the Finished override starts this session at zero, then
    // establish the local resume overlay while actively playing at 42 seconds.
    fireEvent.click(screen.getByRole("button", { name: "Load override A" }));
    await waitFor(() => expect(audio.currentTime).toBe(0));
    setAudioMetrics(audio, { duration: 120, currentTime: 42 });
    fireEvent(audio, new Event("timeupdate"));
    fireEvent(audio, new Event("play"));
    fireEvent(audio, new Event("playing"));
    await waitFor(() => {
      expect(screen.getByTestId("state-kind").textContent).toBe("Active");
      expect(screen.getByTestId("state-phase").textContent).toBe("Playing");
    });

    const heartbeatsBeforeUnread = heartbeatBodies.length;
    fireEvent.click(screen.getByRole("button", { name: "Mark override A unread" }));
    await waitFor(() =>
      expect(
        consumptionBodies.some(
          (body) => body.kind === "SetUnread" && body.mediaId === MEDIA_A,
        ),
      ).toBe(true),
    );

    // Unread is status-only: it does not seek/pause, send a progress write, or
    // rotate the active heartbeat's fencing tokens.
    expect(audio.currentTime).toBe(42);
    expect(screen.getByTestId("state-kind").textContent).toBe("Active");
    expect(screen.getByTestId("state-phase").textContent).toBe("Playing");
    expect(heartbeatBodies).toHaveLength(heartbeatsBeforeUnread);

    // Replacing the session makes the next A start resolve from the preserved
    // overlay. A stale Finished override would instead force zero here.
    fireEvent.click(screen.getByRole("button", { name: "Load override B" }));
    await waitFor(() => expect(audio.currentTime).toBe(0));
    fireEvent.click(screen.getByRole("button", { name: "Load override A" }));
    await waitFor(() => expect(audio.currentTime).toBe(42));
  });

  it("exact-end E_NOT_FOUND falls back to state-only EnsureMediaFinished and stops", async () => {
    let items = [audioItem(ITEM_A, MEDIA_A, "First")];
    const { consumptionBodies } = installMock({
      snapshot: () => items,
      onConsumption: (body) => {
        if (body.kind === "FinishLecternItem") {
          // The item vanished server-side: definitive E_NOT_FOUND.
          items = [];
          return jsonResponse(
            { error: { code: "E_NOT_FOUND", message: "gone" } },
            404,
          );
        }
        return jsonResponse({
          data: {
            outcome: { kind: "StateOnly" },
            lectern: lecternWireSnapshot([]),
            nextItem: { kind: "Absent" },
            progressState: { kind: "Absent" },
            completionHandle: { kind: "Absent" },
          },
        });
      },
    });

    render(<App playMediaId={MEDIA_A} playTitle="First" />);
    await playAndReady();
    await waitFor(() =>
      expect(screen.getByTestId("origin").textContent).toBe("Lectern"),
    );

    const audio = screen.getByLabelText(FOOTER_AUDIO_LABEL) as HTMLAudioElement;
    fireEvent(audio, new Event("ended"));

    await waitFor(() =>
      expect(screen.getByTestId("state-kind").textContent).toBe("PausedAtEnd"),
    );
    expect(consumptionBodies.some((b) => b.kind === "FinishLecternItem")).toBe(
      true,
    );
    const fallback = consumptionBodies.filter(
      (b) => b.kind === "EnsureMediaFinished",
    );
    expect(fallback.length).toBe(1);
    expect(fallback[0]).toMatchObject({
      kind: "EnsureMediaFinished",
      mediaId: MEDIA_A,
    });
  });

  it("playAudio defects when invoked before the Lectern snapshot is Ready (spec §6)", () => {
    // The lectern GET never resolves, so the resource stays Loading.
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/lectern" && method === "GET") {
        return new Promise<Response>(() => {}); // never resolves
      }
      return Promise.resolve(jsonResponse({ data: {} }));
    });

    const wrapper = ({ children }: { children: ReactNode }) => (
      <LecternProvider>
        <GlobalPlayerProvider>{children}</GlobalPlayerProvider>
      </LecternProvider>
    );
    const { result } = renderHook(() => useGlobalPlayer(), { wrapper });

    expect(() =>
      result.current.playAudio(buildFooterDescriptor(MEDIA_A, "Too early")),
    ).toThrow(/Ready/);
  });

  it("failed active Remove restores the row without changing the exact origin", async () => {
    const items = [audioItem(ITEM_A, MEDIA_A, "First")];
    installMock({
      snapshot: () => items, // reconcile GET always returns A present again
      onLectern: (body) => {
        if (body.kind === "RemoveItem") {
          return jsonResponse(
            { error: { code: "E_NOT_FOUND", message: "already gone" } },
            404,
          );
        }
        return jsonResponse({
          data: {
            outcome: { kind: "Ordered" },
            lectern: lecternWireSnapshot(items),
          },
        });
      },
    });

    render(<App playMediaId={MEDIA_A} playTitle="First" />);
    await playAndReady();
    await waitFor(() =>
      expect(screen.getByTestId("origin").textContent).toBe("Lectern"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove A" }));

    // The definitive failure reconciles (row present again) and the origin is
    // preserved as the exact Lectern item.
    await waitFor(() =>
      expect(screen.getByTestId("origin").textContent).toBe("Lectern"),
    );
    expect(screen.getByTestId("state-kind").textContent).toBe("Active");
  });
});
