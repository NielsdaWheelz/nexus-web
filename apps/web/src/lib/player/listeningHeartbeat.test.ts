import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError } from "@/lib/api/client";
import { absent, present, type Presence } from "@/lib/api/presence";
import { assumeMediaId, type ListeningStateOut, type MediaId } from "@/lib/lectern/client";
import type { OverlayEntry } from "@/lib/player/playerSession";
import {
  createListeningHeartbeat,
  HEARTBEAT_DEADLINE_MS,
  SYNC_INTERVAL_MS,
  type HeartbeatSample,
} from "@/lib/player/listeningHeartbeat";

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
  playbackSpeed: number;
  dwellMsDelta: number;
  deviceId: string;
  expectedWriteRevision: number;
  expectedResetEpoch: number;
  heartbeatGeneration: string;
  heartbeatSequence: number;
}

function stateOut(over: Partial<ListeningStateOut> = {}): ListeningStateOut {
  return { positionMs: 0, durationMs: absent(), playbackSpeed: 1, writeRevision: 0, resetEpoch: 0, ...over };
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
        playbackSpeed: body.playbackSpeed,
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
}): Harness {
  const overlay: OverlayEntry[] = [];
  const adopted: Array<{ state: ListeningStateOut; seek: boolean }> = [];
  const suspended: Array<{ error: ApiError; retryGet: () => void }> = [];
  const counts = { resumed: 0 };
  let sample: HeartbeatSample =
    opts?.startSample ?? { positionMs: 1000, durationMs: present(120_000), playbackSpeed: 1 };
  let gen = 0;
  const engine = createListeningHeartbeat({
    mediaId: MEDIA,
    deviceId: "device-1",
    initial: opts?.initial ?? { writeRevision: 0, resetEpoch: 0, positionMs: 0 },
    readSample: () => sample,
    now: () => Date.now(),
    mintGeneration: () => {
      gen += 1;
      return `gen-${gen}`;
    },
    onStateAdopted: (state, options) => adopted.push({ state, seek: options.seek }),
    onPersistenceSuspended: (error, retryGet) => suspended.push({ error, retryGet }),
    onPersistenceResumed: () => {
      counts.resumed += 1;
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
    h.setSample({ positionMs: 6000, durationMs: present(200_000), playbackSpeed: 1.5 });

    h.engine.tick();
    await flush();

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      positionMs: 6000,
      durationMs: { kind: "Present", value: 200_000 },
      playbackSpeed: 1.5,
      deviceId: "device-1",
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
    h.setSample({ positionMs: 1000, durationMs: present(120_000), playbackSpeed: 1 });
    h.engine.tick();
    await flush();
    expect(bodies).toHaveLength(1);

    h.setSample({ positionMs: 2000, durationMs: present(120_000), playbackSpeed: 1 });
    h.engine.tick();
    h.setSample({ positionMs: 3000, durationMs: present(120_000), playbackSpeed: 1 });
    h.engine.tick();
    h.setSample({ positionMs: 4000, durationMs: present(120_000), playbackSpeed: 1 });
    h.engine.tick();
    await flush();
    expect(bodies).toHaveLength(1);

    resolveFirst?.(echoSuccess(bodies[0]));
    await flush();

    expect(bodies).toHaveLength(2);
    expect(bodies[1].positionMs).toBe(4000);
  });

  it("ignores a late response whose generation has been retired by adoptServerState", async () => {
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
    h.engine.tick();
    await flush();
    expect(bodies).toHaveLength(1);
    const retiredGeneration = bodies[0].heartbeatGeneration;

    const reset = stateOut({ positionMs: 0, writeRevision: 5, resetEpoch: 1 });
    h.engine.adoptServerState(reset);
    expect(h.overlay.at(-1)).toEqual({ positionMs: 0, writeRevision: 5, resetEpoch: 1 });
    const overlayCount = h.overlay.length;

    // The stale in-flight PUT (retired generation) resolves late: no install.
    resolveFirst?.(echoSuccess(bodies[0]));
    await flush();
    expect(h.overlay.length).toBe(overlayCount);
    expect(bodies[0].heartbeatGeneration).toBe(retiredGeneration);
  });

  it("caps the dwell delta at 17000ms", async () => {
    const bodies: ParsedBody[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init = {}) => {
      const body = parseBody(init);
      bodies.push(body);
      return Promise.resolve(echoSuccess(body));
    });
    const h = makeEngine();
    await vi.advanceTimersByTimeAsync(25_000);
    h.engine.tick();
    await flush();
    expect(bodies[0].dwellMsDelta).toBe(17_000);
  });

  it("discards the dwell delta of a timed-out send (at-most-once)", async () => {
    const bodies: ParsedBody[] = [];
    let putCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "GET") {
        return Promise.resolve(fakeResponse(getEnvelope(stateOut({ positionMs: 1000, writeRevision: 3, resetEpoch: 0 }))));
      }
      bodies.push(parseBody(init));
      putCount += 1;
      if (putCount === 1) return abortable(init.signal);
      return Promise.resolve(echoSuccess(bodies[bodies.length - 1]));
    });

    const h = makeEngine();
    await vi.advanceTimersByTimeAsync(15_000);
    h.engine.tick(); // send #1: dwell 15000, anchor -> 15000
    await flush();
    expect(bodies[0].dwellMsDelta).toBe(15_000);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_DEADLINE_MS); // deadline -> recovery, anchor -> 35000
    await flush();

    await vi.advanceTimersByTimeAsync(10_000); // t = 45000
    h.engine.tick(); // send #2
    await flush();
    expect(bodies).toHaveLength(2);
    expect(bodies[1].dwellMsDelta).toBe(10_000); // NOT 25000 — the timed-out delta is gone
  });

  it("timeout recovery retains the local position when the reset epoch is unchanged", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "GET") {
        return Promise.resolve(fakeResponse(getEnvelope(stateOut({ positionMs: 500, writeRevision: 7, resetEpoch: 0 }))));
      }
      parseBody(init);
      return abortable(init.signal);
    });
    const h = makeEngine({ initial: { writeRevision: 2, resetEpoch: 0, positionMs: 0 } });
    h.setSample({ positionMs: 8000, durationMs: present(120_000), playbackSpeed: 1 });
    h.engine.tick();
    await flush();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_DEADLINE_MS);
    await flush();

    expect(h.adopted).toHaveLength(0);
    expect(h.overlay.at(-1)).toEqual({ positionMs: 8000, writeRevision: 7, resetEpoch: 0 });
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
    h.setSample({ positionMs: 8000, durationMs: present(120_000), playbackSpeed: 1 });
    h.engine.tick();
    await flush();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_DEADLINE_MS);
    await flush();

    expect(h.adopted).toEqual([{ state: canonical, seek: true }]);
    expect(h.overlay.at(-1)).toEqual({ positionMs: 0, writeRevision: 9, resetEpoch: 4 });
  });

  it("recovers via GET when the server rejects a stale revision (409)", async () => {
    let putCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "GET") {
        return Promise.resolve(fakeResponse(getEnvelope(stateOut({ positionMs: 4200, writeRevision: 11, resetEpoch: 0 }))));
      }
      parseBody(init);
      putCount += 1;
      return Promise.resolve(fakeResponse({ error: { code: "E_STALE_LISTENING_REVISION", message: "stale" } }, 409));
    });
    const h = makeEngine({ initial: { writeRevision: 2, resetEpoch: 0, positionMs: 0 } });
    h.setSample({ positionMs: 4200, durationMs: present(120_000), playbackSpeed: 1 });
    h.engine.tick();
    await flush();

    expect(putCount).toBe(1);
    expect(h.suspended).toHaveLength(0);
    expect(h.overlay.at(-1)).toEqual({ positionMs: 4200, writeRevision: 11, resetEpoch: 0 });
  });

  it("suspends persistence on a failed recovery GET and resumes only after retryGet succeeds", async () => {
    const bodies: ParsedBody[] = [];
    let getShouldFail = true;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "GET") {
        if (getShouldFail) return Promise.reject(new TypeError("network down"));
        return Promise.resolve(fakeResponse(getEnvelope(stateOut({ positionMs: 0, writeRevision: 3, resetEpoch: 0 }))));
      }
      const body = parseBody(init);
      bodies.push(body);
      if (bodies.length === 1) {
        return Promise.resolve(fakeResponse({ error: { code: "E_STALE_LISTENING_REVISION", message: "stale" } }, 409));
      }
      return Promise.resolve(echoSuccess(body));
    });

    const h = makeEngine();
    h.engine.tick(); // -> 409 -> recovery GET fails -> Suspended
    await flush();
    expect(h.suspended).toHaveLength(1);
    const sentBeforeSuspend = bodies.length;

    h.engine.tick();
    h.engine.tick();
    await flush();
    expect(bodies.length).toBe(sentBeforeSuspend); // no heartbeats while suspended

    getShouldFail = false;
    h.suspended[0].retryGet();
    await flush();
    expect(h.counts.resumed).toBe(1);

    h.engine.tick();
    await flush();
    expect(bodies.length).toBe(sentBeforeSuspend + 1); // sends resume after recovery
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

  it("adoptServerState replaces the overlay, seeks, and starts a new generation", async () => {
    const bodies: ParsedBody[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init = {}) => {
      const body = parseBody(init);
      bodies.push(body);
      return Promise.resolve(echoSuccess(body));
    });
    const h = makeEngine();
    h.engine.tick();
    await flush();
    const generationBefore = bodies[0].heartbeatGeneration;

    const reset = stateOut({ positionMs: 0, writeRevision: 8, resetEpoch: 2 });
    h.engine.adoptServerState(reset);
    expect(h.adopted.at(-1)).toEqual({ state: reset, seek: true });
    expect(h.overlay.at(-1)).toEqual({ positionMs: 0, writeRevision: 8, resetEpoch: 2 });

    h.engine.tick();
    await flush();
    const last = bodies.at(-1);
    expect(last?.heartbeatGeneration).not.toBe(generationBefore);
    expect(last?.expectedWriteRevision).toBe(8);
    expect(last?.expectedResetEpoch).toBe(2);
    expect(last?.heartbeatSequence).toBe(0);
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
