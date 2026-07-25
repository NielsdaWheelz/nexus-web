import { afterEach, describe, expect, it, vi } from "vitest";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { parseMediaRef } from "./activityContract";
import { ActivityRecorder } from "./activityRecorder";

vi.mock("@/lib/auth/UnauthenticatedApiBoundary", () => ({
  handleUnauthenticatedApiError: vi.fn(),
}));

const mediaRef = parseMediaRef("media:00000000-0000-4000-8000-000000000001");

afterEach(() => vi.unstubAllGlobals());

function recorderAt(nowRef: { value: number }, uploads: Array<{ body: string; keepalive: boolean }>, diagnostic = vi.fn()) {
  let id = 0;
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${(++id).toString().padStart(12, "0")}` });
  return new ActivityRecorder({
    now: () => nowRef.value,
    wallNow: () => 1_700_000_000_000 + nowRef.value,
    upload: async (input) => {
      uploads.push(input);
      return { kind: "Accepted" };
    },
    diagnostic,
  });
}

function reading(eligible: boolean) {
  return {
    mediaRef,
    modality: "Reading" as const,
    deviceClass: "Desktop" as const,
    eligible,
    measurement: { progress: 0.2, wordPosition: 4 },
  };
}

describe("ActivityRecorder", () => {
  it("does not count an ineligible interval after a reader lane closes", async () => {
    const now = { value: 0 };
    const uploads: Array<{ body: string; keepalive: boolean }> = [];
    const recorder = recorderAt(now, uploads);
    recorder.setCaptureReady(true);
    recorder.registerObserver("reader", reading(true));
    now.value = 100;
    recorder.observe("reader", reading(false));
    await new Promise((resolve) => setTimeout(resolve));
    now.value = 1_000;
    recorder.observe("reader", reading(true));
    now.value = 1_010;
    recorder.observe("reader", reading(false));
    await new Promise((resolve) => setTimeout(resolve));

    const durations = uploads.flatMap((upload) => {
      const body = JSON.parse(upload.body) as { batch: { spans: Array<{ durationMs: number }> } };
      return body.batch.spans.map((span) => span.durationMs);
    });
    expect(durations).toEqual([100, 10]);
  });

  it("closes an unregistered lane with its latest measurement", async () => {
    const now = { value: 0 };
    const uploads: Array<{ body: string; keepalive: boolean }> = [];
    const recorder = recorderAt(now, uploads);
    recorder.setCaptureReady(true);
    const unregister = recorder.registerObserver("reader", reading(true));
    now.value = 10_000;
    recorder.observe("reader", {
      ...reading(true),
      measurement: { progress: 0.5, wordPosition: 40 },
    });
    unregister();
    await new Promise((resolve) => setTimeout(resolve));

    const span = (
      JSON.parse(uploads[0]!.body) as {
        batch: {
          spans: Array<{
            durationMs: number;
            wordStart: { kind: string; value: number };
            wordEnd: { kind: string; value: number };
          }>;
        };
      }
    ).batch.spans[0]!;
    expect(span).toMatchObject({
      durationMs: 10_000,
      wordStart: { kind: "Present", value: 4 },
      wordEnd: { kind: "Present", value: 40 },
    });
  });

  it("drops sub-millisecond churn instead of emitting zero-duration spans", async () => {
    const now = { value: 0 };
    const uploads: Array<{ body: string; keepalive: boolean }> = [];
    const recorder = recorderAt(now, uploads);
    recorder.setCaptureReady(true);
    recorder.registerObserver("reader", reading(true));
    now.value = 0.5;
    recorder.observe("reader", reading(false));
    await new Promise((resolve) => setTimeout(resolve));

    expect(uploads).toEqual([]);
  });

  it("waits for viewport hydration and splits an active span at the viewport-class boundary", async () => {
    const now = { value: 0 };
    const uploads: Array<{ body: string; keepalive: boolean }> = [];
    const recorder = recorderAt(now, uploads);
    recorder.registerObserver("reader", reading(true));

    now.value = 100;
    recorder.setCaptureReady(true);
    now.value = 1_100;
    recorder.observe("reader", {
      ...reading(true),
      deviceClass: "Mobile",
    });
    now.value = 3_100;
    recorder.observe("reader", {
      ...reading(false),
      deviceClass: "Mobile",
    });
    await new Promise((resolve) => setTimeout(resolve));

    const batches = uploads.map(
      ({ body }) =>
        JSON.parse(body) as {
          deviceClass: "Desktop" | "Mobile";
          batch: { spans: Array<{ durationMs: number }> };
        },
    );
    expect(batches.map((batch) => batch.deviceClass)).toEqual([
      "Desktop",
      "Mobile",
    ]);
    expect(
      batches.map((batch) => batch.batch.spans[0]?.durationMs),
    ).toEqual([1_000, 2_000]);
  });

  it("records PDF Reading time with absent word endpoints", async () => {
    const now = { value: 0 };
    const uploads: Array<{ body: string; keepalive: boolean }> = [];
    const recorder = recorderAt(now, uploads);
    recorder.setCaptureReady(true);
    recorder.registerObserver("pdf", {
      ...reading(true),
      measurement: { progress: 0.25 },
    });
    now.value = 100;
    recorder.observe("pdf", {
      ...reading(false),
      measurement: { progress: 0.5 },
    });
    await new Promise((resolve) => setTimeout(resolve));
    const span = (JSON.parse(uploads[0]!.body) as { batch: { spans: Array<Record<string, unknown>> } })
      .batch.spans[0]!;
    expect(span).toMatchObject({
      durationMs: 100,
      wordStart: { kind: "Absent" },
      wordEnd: { kind: "Absent" },
    });
  });

  it("stops an ambiguous lane once, then restarts from the sole eligible observer", async () => {
    const now = { value: 0 };
    const uploads: Array<{ body: string; keepalive: boolean }> = [];
    const diagnostic = vi.fn();
    const recorder = recorderAt(now, uploads, diagnostic);
    recorder.setCaptureReady(true);
    recorder.registerObserver("a", reading(true));
    recorder.registerObserver("b", reading(true));
    now.value = 10;
    recorder.observe("a", reading(true));
    expect(diagnostic).toHaveBeenCalledTimes(1);
    recorder.observe("b", reading(false));
    now.value = 20;
    recorder.observe("a", reading(false));
    await Promise.resolve();

    const spans = JSON.parse(uploads.at(-1)!.body) as { batch: { spans: Array<{ durationMs: number }> } };
    expect(spans.batch.spans).toEqual([expect.objectContaining({ durationMs: 10 })]);
  });

  it("replays the exact in-flight body once with keepalive on page hide", async () => {
    const now = { value: 0 };
    const uploads: Array<{ body: string; keepalive: boolean }> = [];
    let resolve!: (value: { kind: "Accepted" }) => void;
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000001" });
    const recorder = new ActivityRecorder({
      now: () => now.value,
      wallNow: () => 1_700_000_000_000 + now.value,
      upload: (input) => {
        uploads.push(input);
        return new Promise((res) => { resolve = res; });
      },
    });
    recorder.setCaptureReady(true);
    recorder.registerObserver("reader", reading(true));
    now.value = 10;
    recorder.observe("reader", reading(false));
    await Promise.resolve();
    recorder.flushForPageHide();
    expect(uploads).toHaveLength(2);
    expect(uploads[1]).toMatchObject({ body: uploads[0]?.body, keepalive: true });
    resolve({ kind: "Accepted" });
  });

  it("discards a suspension gap instead of clamping it into a maximum span", async () => {
    const now = { value: 0 };
    const uploads: Array<{ body: string; keepalive: boolean }> = [];
    const recorder = recorderAt(now, uploads);
    recorder.setCaptureReady(true);
    recorder.registerObserver("reader", reading(true));
    now.value = 36_000;
    recorder.observe("reader", reading(false));
    await new Promise((resolve) => setTimeout(resolve));
    expect(uploads).toEqual([]);
  });

  it("keeps the immutable retry bytes and yields the one in-flight slot to another lane", async () => {
    const now = { value: 0 };
    const uploads: Array<{ body: string; keepalive: boolean }> = [];
    let resolveFirst!: (outcome: { kind: "Accepted" }) => void;
    let calls = 0;
    vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${(++calls).toString().padStart(12, "0")}` });
    const recorder = new ActivityRecorder({
      now: () => now.value,
      wallNow: () => 1_700_000_000_000 + now.value,
      upload: (input) => {
        uploads.push(input);
        return uploads.length === 1
          ? new Promise((resolve) => { resolveFirst = resolve; })
          : Promise.resolve({ kind: "Accepted" as const });
      },
    });
    recorder.setCaptureReady(true);
    recorder.registerObserver("one", reading(true));
    recorder.registerObserver("two", {
      ...reading(true),
      mediaRef: parseMediaRef("media:00000000-0000-4000-8000-000000000002"),
    });
    now.value = 10;
    recorder.observe("one", reading(false));
    recorder.observe("two", { ...reading(false), mediaRef: parseMediaRef("media:00000000-0000-4000-8000-000000000002") });
    await Promise.resolve();
    expect(uploads).toHaveLength(1);
    resolveFirst({ kind: "Accepted" });
    await new Promise((resolve) => setTimeout(resolve));
    expect(uploads).toHaveLength(2);
  });

  it("degrades a frozen lane when its bounded second buffer overflows", async () => {
    const now = { value: 0 };
    const uploads: Array<{ body: string; keepalive: boolean }> = [];
    const diagnostic = vi.fn();
    let resolve!: (outcome: { kind: "Accepted" }) => void;
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000001" });
    const recorder = new ActivityRecorder({
      now: () => now.value,
      wallNow: () => 1_700_000_000_000 + now.value,
      upload: (input) => {
        uploads.push(input);
        return new Promise((next) => { resolve = next; });
      },
      diagnostic,
    });
    recorder.setCaptureReady(true);
    recorder.registerObserver("reader", reading(true));
    now.value = 1;
    recorder.observe("reader", reading(false));
    await Promise.resolve();
    for (let index = 0; index <= 120; index += 1) {
      now.value += 1;
      recorder.observe("reader", reading(true));
      now.value += 1;
      recorder.observe("reader", reading(false));
    }
    expect(diagnostic).toHaveBeenCalledWith("capture-degraded");
    expect(uploads).toHaveLength(1);
    resolve({ kind: "Accepted" });
  });

  it("stops a lane on a terminal visibility outcome", async () => {
    const now = { value: 0 };
    const uploads: Array<{ body: string; keepalive: boolean }> = [];
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000001" });
    const recorder = new ActivityRecorder({
      now: () => now.value,
      wallNow: () => 1_700_000_000_000 + now.value,
      upload: async (input) => {
        uploads.push(input);
        return { kind: "VisibilityLost" };
      },
    });
    recorder.setCaptureReady(true);
    recorder.registerObserver("reader", reading(true));
    now.value = 1;
    recorder.observe("reader", reading(false));
    await new Promise((resolve) => setTimeout(resolve));
    now.value = 2;
    recorder.observe("reader", reading(true));
    now.value = 3;
    recorder.observe("reader", reading(false));
    await new Promise((resolve) => setTimeout(resolve));
    expect(uploads).toHaveLength(1);
  });

  it("hands a terminal authentication outcome to the existing auth boundary", async () => {
    const now = { value: 0 };
    const recorder = new ActivityRecorder({
      now: () => now.value,
      wallNow: () => 1_700_000_000_000 + now.value,
      upload: async () => ({ kind: "AuthenticationLost" }),
    });
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000001" });
    recorder.setCaptureReady(true);
    recorder.registerObserver("reader", reading(true));
    now.value = 1;
    recorder.observe("reader", reading(false));
    await new Promise((resolve) => setTimeout(resolve));
    expect(handleUnauthenticatedApiError).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401, code: "E_UNAUTHENTICATED" }),
    );
  });
});
