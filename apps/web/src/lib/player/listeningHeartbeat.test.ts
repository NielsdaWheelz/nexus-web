import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError } from "@/lib/api/client";
import { absent, present, type Presence } from "@/lib/api/presence";
import {
  assumeMediaId,
  type ListeningStateOut,
  type MediaId,
} from "@/lib/lectern/contract";
import type { OverlayEntry } from "@/lib/player/playerSession";
import {
  createListeningHeartbeat,
  HEARTBEAT_DEADLINE_MS,
  SYNC_INTERVAL_MS,
  type HeartbeatSample,
} from "@/lib/player/listeningHeartbeat";
import { consumptionProjectionSnapshot } from "@/lib/consumption/projectionRevision";

const MEDIA: MediaId = assumeMediaId("00000000-0000-4000-8000-000000000001");

// --- Boundary fakes ---------------------------------------------------------
//
// The engine talks to the network via `apiFetch` -> `globalThis.fetch`; we mock
// only that external boundary (testing rules §7). A minimal duck-typed response
// keeps the whole async chain microtask-based, so flushing is deterministic.

function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

interface ParsedBody {
  positionMs: number;
  durationMs: Presence<number>;
  episodePlaybackRate: Presence<number>;
  expectedWriteRevision: number;
  expectedResetEpoch: number;
  heartbeatGeneration: string;
  heartbeatSequence: number;
}

function stateOut(over: Partial<ListeningStateOut> = {}): ListeningStateOut {
  return {
    positionMs: 0,
    durationMs: absent(),
    episodePlaybackRate: absent(),
    writeRevision: 0,
    resetEpoch: 0,
    ...over,
  };
}

function getEnvelope(state: ListeningStateOut): unknown {
  return { data: state };
}

function putEnvelope(state: ListeningStateOut, generation: string, sequence: number): unknown {
  return { data: { listeningState: state, heartbeatGeneration: generation, heartbeatSequence: sequence } };
}

/** A server echo: increments the write revision and returns the sent position. */
function echoSuccess(body: ParsedBody): Response {
  return fakeResponse(
    putEnvelope(
      stateOut({
        positionMs: body.positionMs,
        durationMs: body.durationMs,
        episodePlaybackRate: body.episodePlaybackRate,
        writeRevision: body.expectedWriteRevision + 1,
        resetEpoch: body.expectedResetEpoch,
      }),
      body.heartbeatGeneration,
      body.heartbeatSequence,
    ),
  );
}

/** A promise that only rejects when the request signal aborts (never resolves). */
function abortable(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new DOMException("aborted", "AbortError")),
      { once: true },
    );
  });
}

function parseBody(init: RequestInit): ParsedBody {
  return JSON.parse(init.body as string) as ParsedBody;
}

/** Flush the microtask queue (and any zero-delay timers) under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }
}

// --- Engine harness ---------------------------------------------------------

interface Harness {
  engine: ReturnType<typeof createListeningHeartbeat>;
  overlay: OverlayEntry[];
  adopted: Array<{ state: ListeningStateOut; seek: boolean }>;
  suspended: Array<{ error: ApiError; retryGet: () => void }>;
  counts: { resumed: number };
  setSample: (sample: HeartbeatSample) => void;
}

function makeEngine(opts?: {
  initial?: { writeRevision: number; resetEpoch: number; positionMs: number };
  startSample?: HeartbeatSample;
  onPersistenceResumed?: () => void;
}): Harness {
  const overlay: OverlayEntry[] = [];
  const adopted: Array<{ state: ListeningStateOut; seek: boolean }> = [];
  const suspended: Array<{ error: ApiError; retryGet: () => void }> = [];
  const counts = { resumed: 0 };
  let sample: HeartbeatSample =
    opts?.startSample ?? {
      positionMs: 1000,
      durationMs: present(120_000),
      episodePlaybackRate: present(1),
    };
  let gen = 0;
  const engine = createListeningHeartbeat({
    mediaId: MEDIA,
    initial: opts?.initial ?? { writeRevision: 0, resetEpoch: 0, positionMs: 0 },
    readSample: () => sample,
    mintGeneration: () => {
      gen += 1;
      return `gen-${gen}`;
    },
    onStateAdopted: (state, options) => adopted.push({ state, seek: options.seek }),
    onPersistenceSuspended: (error, retryGet) => suspended.push({ error, retryGet }),
    onPersistenceResumed: () => {
      counts.resumed += 1;
      opts?.onPersistenceResumed?.();
    },
    onOverlayUpdate: (entry) => overlay.push(entry),
  });
  return { engine, overlay, adopted, suspended, counts, setSample: (s) => (sample = s) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("listeningHeartbeat", () => {
  it("exposes the named cadence + deadline constants", () => {
    expect(SYNC_INTERVAL_MS).toBe(15_000);
    expect(HEARTBEAT_DEADLINE_MS).toBe(20_000);
  });

  it("sends a camelCase, revision-fenced heartbeat and installs the response", async () => {
    const bodies: ParsedBody[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init = {}) => {
      const body = parseBody(init);
      bodies.push(body);
      return Promise.resolve(echoSuccess(body));
    });
    const h = makeEngine({ initial: { writeRevision: 4, resetEpoch: 1, positionMs: 0 } });
    h.setSample({
      positionMs: 6000,
      durationMs: present(200_000),
      episodePlaybackRate: present(1.5),
    });
    const beforeRevision = consumptionProjectionSnapshot().revision;

    h.engine.tick();
    await flush();

    expect(bodies).toHaveLength(1);
    // Accepted heartbeat install publishes exactly one consumption-projection
    // revision (not flushKeepalive, which never installs).
    expect(consumptionProjectionSnapshot().revision).toBe(beforeRevision + 1);
    expect(bodies[0]).toMatchObject({
      positionMs: 6000,
      durationMs: { kind: "Present", value: 200_000 },
      episodePlaybackRate: { kind: "Present", value: 1.5 },
      expectedWriteRevision: 4,
      expectedResetEpoch: 1,
      heartbeatSequence: 0,
    });
    expect(typeof bodies[0].heartbeatGeneration).toBe("string");
    expect(h.overlay.at(-1)).toEqual({ positionMs: 6000, writeRevision: 5, resetEpoch: 1 });
  });

  it("keeps one PUT in flight and coalesces later ticks into one send of the newest sample", async () => {
    const bodies: ParsedBody[] = [];
    let putCount = 0;
    let resolveFirst: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init = {}) => {
      const body = parseBody(init);
      bodies.push(body);
      putCount += 1;
      if (putCount === 1) return new Promise<Response>((res) => (resolveFirst = res));
      return Promise.resolve(echoSuccess(body));
    });

    const h = makeEngine();
    h.setSample({
      positionMs: 1000,
      durationMs: present(120_000),
      episodePlaybackRate: present(1),
    });
    h.engine.tick();
    await flush();
    expect(bodies).toHaveLength(1);

    h.setSample({
      positionMs: 2000,
      durationMs: present(120_000),
      episodePlaybackRate: present(1),
    });
    h.engine.tick();
    h.setSample({
      positionMs: 3000,
      durationMs: present(120_000),
      episodePlaybackRate: present(1),
    });
    h.engine.tick();
    h.setSample({
      positionMs: 4000,
      durationMs: present(120_000),
      episodePlaybackRate: present(1),
    });
    h.engine.tick();
    await flush();
    expect(bodies).toHaveLength(1);

    resolveFirst?.(echoSuccess(bodies[0]));
    await flush();

    expect(bodies).toHaveLength(2);
    expect(bodies[1].positionMs).toBe(4000);
  });

  it("timeout recovery retains the local position when the reset epoch is unchanged", async () => {
    const bodies: ParsedBody[] = [];
    let putCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "GET") {
        return Promise.resolve(fakeResponse(getEnvelope(stateOut({ positionMs: 500, writeRevision: 7, resetEpoch: 0 }))));
      }
      const body = parseBody(init);
      bodies.push(body);
      putCount += 1;
      return putCount === 1
        ? abortable(init.signal)
        : Promise.resolve(echoSuccess(body));
    });
    const h = makeEngine({ initial: { writeRevision: 2, resetEpoch: 0, positionMs: 0 } });
    h.setSample({
      positionMs: 8000,
      durationMs: present(120_000),
      episodePlaybackRate: present(1),
    });
    h.engine.tick();
    await flush();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_DEADLINE_MS);
    await flush();

    expect(h.adopted).toHaveLength(0);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({
      positionMs: 8000,
      episodePlaybackRate: { kind: "Present", value: 1 },
      expectedWriteRevision: 7,
      heartbeatSequence: 0,
    });
    expect(h.overlay.at(-1)).toEqual({ positionMs: 8000, writeRevision: 8, resetEpoch: 0 });
  });

  it("resends the dirty sample after network-failure recovery", async () => {
    const bodies: ParsedBody[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "GET") {
        return Promise.resolve(
          fakeResponse(
            getEnvelope(
              stateOut({
                positionMs: 100,
                writeRevision: 4,
                resetEpoch: 0,
              }),
            ),
          ),
        );
      }
      const body = parseBody(init);
      bodies.push(body);
      return bodies.length === 1
        ? Promise.reject(new TypeError("network down"))
        : Promise.resolve(echoSuccess(body));
    });
    const h = makeEngine();
    h.setSample({
      positionMs: 7100,
      durationMs: present(120_000),
      episodePlaybackRate: present(1.8),
    });

    h.engine.tick();
    await flush();

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({
      positionMs: 7100,
      episodePlaybackRate: { kind: "Present", value: 1.8 },
      expectedWriteRevision: 4,
      heartbeatSequence: 0,
    });
  });

  it("timeout recovery adopts canonical state when the reset epoch changed", async () => {
    const canonical = stateOut({ positionMs: 0, writeRevision: 9, resetEpoch: 4 });
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "GET") return Promise.resolve(fakeResponse(getEnvelope(canonical)));
      parseBody(init);
      return abortable(init.signal);
    });
    const h = makeEngine({ initial: { writeRevision: 2, resetEpoch: 0, positionMs: 0 } });
    h.setSample({
      positionMs: 8000,
      durationMs: present(120_000),
      episodePlaybackRate: present(1),
    });
    h.engine.tick();
    await flush();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_DEADLINE_MS);
    await flush();

    expect(h.adopted).toEqual([{ state: canonical, seek: true }]);
    expect(h.overlay.at(-1)).toEqual({ positionMs: 0, writeRevision: 9, resetEpoch: 4 });
  });

  it("recovers via GET when the server rejects a stale revision (409)", async () => {
    const bodies: ParsedBody[] = [];
    let putCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "GET") {
        return Promise.resolve(fakeResponse(getEnvelope(stateOut({ positionMs: 4200, writeRevision: 11, resetEpoch: 0 }))));
      }
      const body = parseBody(init);
      bodies.push(body);
      putCount += 1;
      return putCount === 1
        ? Promise.resolve(
            fakeResponse(
              {
                error: {
                  code: "E_STALE_LISTENING_REVISION",
                  message: "stale",
                },
              },
              409,
            ),
          )
        : Promise.resolve(echoSuccess(body));
    });
    const h = makeEngine({ initial: { writeRevision: 2, resetEpoch: 0, positionMs: 0 } });
    h.setSample({
      positionMs: 4200,
      durationMs: present(120_000),
      episodePlaybackRate: present(1),
    });
    h.engine.tick();
    await flush();

    expect(putCount).toBe(2);
    expect(bodies[1]).toMatchObject({
      positionMs: 4200,
      expectedWriteRevision: 11,
      expectedResetEpoch: 0,
      heartbeatSequence: 0,
    });
    expect(h.suspended).toHaveLength(0);
    expect(h.overlay.at(-1)).toEqual({ positionMs: 4200, writeRevision: 12, resetEpoch: 0 });
  });

  it("suspends persistence on a failed recovery GET and resumes only after retryGet succeeds", async () => {
    const bodies: ParsedBody[] = [];
    const keepaliveBodies: ParsedBody[] = [];
    const recoveryOrder: string[] = [];
    let getShouldFail = true;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "GET") {
        if (getShouldFail) return Promise.reject(new TypeError("network down"));
        return Promise.resolve(fakeResponse(getEnvelope(stateOut({ positionMs: 0, writeRevision: 3, resetEpoch: 0 }))));
      }
      const body = parseBody(init);
      if (init.keepalive) {
        keepaliveBodies.push(body);
        return Promise.resolve(fakeResponse({ data: {} }));
      }
      bodies.push(body);
      if (bodies.length === 1) {
        return Promise.resolve(fakeResponse({ error: { code: "E_STALE_LISTENING_REVISION", message: "stale" } }, 409));
      }
      recoveryOrder.push("resend");
      return Promise.resolve(echoSuccess(body));
    });

    const h = makeEngine({
      onPersistenceResumed: () => recoveryOrder.push("resumed"),
    });
    h.engine.tick(); // -> 409 -> recovery GET fails -> Suspended
    await flush();
    expect(h.suspended).toHaveLength(1);
    const sentBeforeSuspend = bodies.length;

    h.setSample({
      positionMs: 9000,
      durationMs: present(120_000),
      episodePlaybackRate: present(1.8),
    });
    h.engine.tick();
    h.engine.tick();
    await flush();
    expect(bodies.length).toBe(sentBeforeSuspend); // no heartbeats while suspended
    h.engine.flushKeepalive();
    await flush();
    expect(keepaliveBodies).toHaveLength(1);

    getShouldFail = false;
    h.suspended[0].retryGet();
    await flush();
    expect(h.counts.resumed).toBe(1);
    expect(bodies.length).toBe(sentBeforeSuspend + 1);
    expect(bodies.at(-1)).toMatchObject({
      positionMs: 9000,
      episodePlaybackRate: { kind: "Present", value: 1.8 },
      expectedWriteRevision: 3,
    });
    expect(recoveryOrder).toEqual(["resend", "resumed"]);
  });

  it("suppresses every unestablished sample, including a pre-play seek", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const h = makeEngine({
      startSample: {
        positionMs: 30_000,
        durationMs: present(120_000),
        episodePlaybackRate: absent(),
      },
    });

    h.engine.tick();
    h.engine.flushKeepalive();
    await flush();

    expect(fetch).not.toHaveBeenCalled();
  });

  it("retires a dirty pre-reset sample when recovery observes a newer reset epoch", async () => {
    let putCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "GET") {
        return Promise.resolve(
          fakeResponse(
            getEnvelope(
              stateOut({
                positionMs: 0,
                writeRevision: 8,
                resetEpoch: 2,
              }),
            ),
          ),
        );
      }
      putCount += 1;
      parseBody(init);
      return Promise.resolve(
        fakeResponse(
          {
            error: {
              code: "E_STALE_LISTENING_REVISION",
              message: "stale",
            },
          },
          409,
        ),
      );
    });
    const h = makeEngine({
      initial: { writeRevision: 1, resetEpoch: 1, positionMs: 20_000 },
    });

    h.engine.tick();
    await flush();

    expect(putCount).toBe(1);
    expect(h.adopted).toEqual([
      {
        state: stateOut({
          positionMs: 0,
          writeRevision: 8,
          resetEpoch: 2,
        }),
        seek: true,
      },
    ]);
  });

  it("drainAndStop resolves within the deadline when the in-flight PUT hangs", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init = {}) => {
      parseBody(init);
      return abortable(init.signal);
    });
    const h = makeEngine();
    h.engine.tick();
    await flush();

    let resolved = false;
    const drain = h.engine.drainAndStop(5000).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(resolved).toBe(true);
    await drain;
  });

  it("stops sending after stop()", async () => {
    const bodies: ParsedBody[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init = {}) => {
      const body = parseBody(init);
      bodies.push(body);
      return Promise.resolve(echoSuccess(body));
    });
    const h = makeEngine();
    h.engine.stop();
    h.engine.tick();
    await flush();
    expect(bodies).toHaveLength(0);
  });
});
