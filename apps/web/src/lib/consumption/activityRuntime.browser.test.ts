import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ACTIVITY_OUTBOX_DB_NAME,
  ActivityOutbox,
} from "./activityOutbox";
import {
  activityRuntime,
  createActivityRuntime,
  installNativeActivityActions,
  installNativeActivitySync,
  type ActivityRuntime,
} from "./activityRuntime";
import { ActivityRecorder } from "./activityRecorder";
import {
  parseActivityCaptureKey,
  parseMediaRef,
  type ClosedActivitySpan,
} from "./activityContract";
import type { ActivityDiagnosticDetail } from "./activityDiagnostics";
import { consumptionProjectionSnapshot } from "./projectionRevision";

const MEDIA_REF = parseMediaRef(
  "media:11111111-1111-4111-8111-111111111111",
);
const ACCOUNT_DURABLE = "10000000-0000-4000-8000-000000000001";
const ACCOUNT_RECOVERY = "10000000-0000-4000-8000-000000000002";
const ACCOUNT_REGROUP = "10000000-0000-4000-8000-000000000003";
const ACCOUNT_LIFECYCLE = "10000000-0000-4000-8000-000000000004";
const ACCOUNT_AUTH = "10000000-0000-4000-8000-000000000006";
const ACCOUNT_MEDIA = "10000000-0000-4000-8000-000000000007";
const ACCOUNT_EXPIRY = "10000000-0000-4000-8000-000000000008";
const ACCOUNT_DEFECT = "10000000-0000-4000-8000-000000000009";
const ACCOUNT_SWITCH_FROM = "10000000-0000-4000-8000-000000000011";
const ACCOUNT_SWITCH_TO = "10000000-0000-4000-8000-000000000012";
const ACCOUNT_NATIVE = "10000000-0000-4000-8000-000000000013";
const ACCOUNT_NATIVE_OTHER = "10000000-0000-4000-8000-000000000014";
const ACCOUNT_FAILED_STORAGE = "10000000-0000-4000-8000-000000000015";
const ACCOUNT_CAPACITY = "10000000-0000-4000-8000-000000000016";
const TEST_NOW_MS = Date.parse("2026-08-10T18:05:00.000Z");

type TestRuntimeOptions = NonNullable<
  Parameters<typeof createActivityRuntime>[0]
>;

function createTestActivityRuntime(
  options: TestRuntimeOptions = {},
): ActivityRuntime {
  return createActivityRuntime({ now: () => TEST_NOW_MS, ...options });
}

function closedSpan(
  captureKey: string,
  occurredAt = "2026-08-10T18:00:00.000Z",
): ClosedActivitySpan {
  return {
    captureKey: parseActivityCaptureKey(captureKey),
    mediaRef: MEDIA_REF,
    modality: "Reading",
    deviceClass: "Desktop",
    span: {
      occurredAt,
      durationMs: 5_000,
      progressStart: { kind: "Present", value: 0.25 },
      progressEnd: { kind: "Present", value: 0.3 },
      wordStart: { kind: "Present", value: 100 },
      wordEnd: { kind: "Present", value: 130 },
    },
  };
}

function errorResponse(status: number, code: string): Response {
  return Response.json(
    { error: { code, message: code } },
    { status },
  );
}

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ACTIVITY_OUTBOX_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storedSpan(
  accountId: string,
  captureKey: string,
): Promise<Record<string, unknown> | undefined> {
  const db = await database();
  const result = await new Promise<unknown>((resolve, reject) => {
    const request = db
      .transaction("spans", "readonly")
      .objectStore("spans")
      .get([accountId, captureKey]);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return result as Record<string, unknown> | undefined;
}

async function waitForSync(
  runtime: ActivityRuntime,
  kind: "Synced" | "Pending" | "Failed",
): Promise<void> {
  await vi.waitFor(() => {
    expect(runtime.snapshot().sync.kind).toBe(kind);
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(ACTIVITY_OUTBOX_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Activity test database deletion was blocked"));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("durable Consumption activity outbox", () => {
  it("retains failed rows as inspectable durable state", async () => {
    const outbox = new ActivityOutbox();
    await outbox.open();
    await outbox.enqueue(
      ACCOUNT_FAILED_STORAGE,
      closedSpan("20000000-0000-4000-8000-000000000015"),
      TEST_NOW_MS,
    );

    await outbox.markFailed(
      ACCOUNT_FAILED_STORAGE,
      ["20000000-0000-4000-8000-000000000015"],
      "Defect",
    );

    expect(await storedSpan(
      ACCOUNT_FAILED_STORAGE,
      "20000000-0000-4000-8000-000000000015",
    )).toMatchObject({ state: "Failed", failureReason: "Defect" });
    expect(await outbox.summary(ACCOUNT_FAILED_STORAGE)).toMatchObject({
      total: 1,
      pending: 0,
      failed: 1,
    });
  });

  it("blocks at capacity without evicting durable rows", async () => {
    const outbox = new ActivityOutbox(2);
    const runtime = createTestActivityRuntime({
      outbox,
      capacityLimit: 2,
      upload: async () => ({ kind: "AuthenticationLost" }),
    });
    window.history.replaceState({}, "", "/login");
    await runtime.open(ACCOUNT_CAPACITY);

    await runtime.enqueue(
      closedSpan("20000000-0000-4000-8000-000000000016"),
    );
    await runtime.enqueue(
      closedSpan("20000000-0000-4000-8000-000000000017"),
    );
    await vi.waitFor(() => {
      expect(runtime.snapshot().capture).toEqual({
        kind: "Blocked",
        reason: "CapacityReached",
      });
    });
    await runtime.enqueue(
      closedSpan("20000000-0000-4000-8000-000000000018"),
    );

    expect(await outbox.summary(ACCOUNT_CAPACITY)).toMatchObject({
      total: 2,
      pending: 2,
    });
    expect(runtime.snapshot().sync).toMatchObject({ kind: "Pending", count: 2 });
    expect(await storedSpan(
      ACCOUNT_CAPACITY,
      "20000000-0000-4000-8000-000000000016",
    )).toBeDefined();
    expect(await storedSpan(
      ACCOUNT_CAPACITY,
      "20000000-0000-4000-8000-000000000017",
    )).toBeDefined();
    expect(await storedSpan(
      ACCOUNT_CAPACITY,
      "20000000-0000-4000-8000-000000000018",
    )).toBeUndefined();
  });

  it("commits a closed span to IndexedDB before starting network delivery", async () => {
    let persistedAtNetwork: Record<string, unknown> | undefined;
    const diagnostics: ActivityDiagnosticDetail[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        persistedAtNetwork = await storedSpan(
          ACCOUNT_DURABLE,
          "20000000-0000-4000-8000-000000000001",
        );
        return new Response(null, { status: 204 });
      }),
    );
    const runtime = createTestActivityRuntime({
      activityDiagnostic: (detail) => diagnostics.push(detail),
    });
    await runtime.open(ACCOUNT_DURABLE);

    await runtime.enqueue(
      closedSpan("20000000-0000-4000-8000-000000000001"),
    );
    await waitForSync(runtime, "Synced");

    expect(persistedAtNetwork).toMatchObject({
      accountId: ACCOUNT_DURABLE,
      captureKey: "20000000-0000-4000-8000-000000000001",
      state: "Pending",
    });
    expect(diagnostics.map((detail) => detail.event)).toEqual([
      "activity_span_enqueued",
      "activity_upload_attempted",
      "activity_upload_accepted",
    ]);
    expect(diagnostics.every((detail) => !("mediaRef" in detail))).toBe(true);
    expect(diagnostics.every((detail) => !("deviceClass" in detail))).toBe(
      true,
    );
  });

  it("recovers a committed span in a new runtime after an ambiguous process stop", async () => {
    let finishAmbiguous: (response: Response) => void = () => undefined;
    const ambiguous = new Promise<Response>((resolve) => {
      finishAmbiguous = resolve;
    });
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return requests.length === 1
          ? ambiguous
          : new Response(null, { status: 204 });
      }),
    );
    const beforeStop = createTestActivityRuntime();
    await beforeStop.open(ACCOUNT_RECOVERY);
    await beforeStop.enqueue(
      closedSpan("20000000-0000-4000-8000-000000000002"),
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    const afterReload = createTestActivityRuntime();
    await afterReload.open(ACCOUNT_RECOVERY);
    await waitForSync(afterReload, "Synced");

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      mediaRef: MEDIA_REF,
      batch: {
        modality: "Reading",
        spans: [
          { captureKey: "20000000-0000-4000-8000-000000000002" },
        ],
      },
    });
    expect(await storedSpan(
      ACCOUNT_RECOVERY,
      "20000000-0000-4000-8000-000000000002",
    )).toBeUndefined();
    finishAmbiguous(new Response(null, { status: 204 }));
  });

  it("regroups stable capture keys under a new outgoing mutation id", async () => {
    let finishAmbiguous: (response: Response) => void = () => undefined;
    const ambiguous = new Promise<Response>((resolve) => {
      finishAmbiguous = resolve;
    });
    const requests: Array<{
      clientMutationId: string;
      batch: { spans: Array<{ captureKey: string }> };
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as (typeof requests)[number]);
        return requests.length === 1
          ? ambiguous
          : new Response(null, { status: 204 });
      }),
    );
    const firstRuntime = createTestActivityRuntime();
    await firstRuntime.open(ACCOUNT_REGROUP);
    await firstRuntime.enqueue(
      closedSpan("20000000-0000-4000-8000-000000000003"),
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await firstRuntime.enqueue(
      closedSpan("20000000-0000-4000-8000-000000000004"),
    );

    const recoveredRuntime = createTestActivityRuntime();
    await recoveredRuntime.open(ACCOUNT_REGROUP);
    await waitForSync(recoveredRuntime, "Synced");

    expect(requests[1].clientMutationId).not.toBe(
      requests[0].clientMutationId,
    );
    expect(requests[1].batch.spans.map((span) => span.captureKey)).toEqual([
      "20000000-0000-4000-8000-000000000003",
      "20000000-0000-4000-8000-000000000004",
    ]);
    finishAmbiguous(new Response(null, { status: 204 }));
  });

  it("cancels an ambiguous old-account upload before opening another account", async () => {
    const requests: Array<{
      batch: { spans: Array<{ captureKey: string }> };
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          requests.push(
            JSON.parse(String(init?.body)) as (typeof requests)[number],
          );
          if (requests.length > 1) {
            return new Response(null, { status: 204 });
          }
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          });
        },
      ),
    );
    const runtime = createTestActivityRuntime();
    await runtime.open(ACCOUNT_SWITCH_FROM);
    await runtime.enqueue(
      closedSpan("20000000-0000-4000-8000-000000000012"),
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    await runtime.open(ACCOUNT_SWITCH_TO);
    await runtime.enqueue(
      closedSpan("20000000-0000-4000-8000-000000000013"),
    );
    await waitForSync(runtime, "Synced");

    expect(requests).toHaveLength(2);
    expect(requests[1].batch.spans.map((span) => span.captureKey)).toEqual([
      "20000000-0000-4000-8000-000000000013",
    ]);
    expect(await storedSpan(
      ACCOUNT_SWITCH_FROM,
      "20000000-0000-4000-8000-000000000012",
    )).toMatchObject({ state: "Pending" });
  });

  it("durably stores elapsed time closed by the browser lifecycle", async () => {
    window.history.replaceState({}, "", "/login");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorResponse(401, "E_UNAUTHENTICATED")),
    );
    const runtime = createTestActivityRuntime();
    await runtime.open(ACCOUNT_LIFECYCLE);
    let monotonicNow = 10_000;
    const recorder = new ActivityRecorder({
      now: () => monotonicNow,
      wallNow: () => Date.parse("2026-08-10T18:00:00.000Z"),
      closedSpan: (span) => {
        void runtime.enqueue(span);
      },
    });
    recorder.setCaptureReady(true);
    recorder.registerObserver("reader", {
      mediaRef: MEDIA_REF,
      modality: "Reading",
      deviceClass: "Desktop",
      eligible: true,
    });

    monotonicNow = 17_500;
    recorder.closeForLifecycle("Hidden");

    await vi.waitFor(() => {
      expect(runtime.snapshot().sync.kind).toBe("Pending");
    });
    expect(runtime.snapshot().sync).toMatchObject({
      kind: "Pending",
      count: 1,
    });
  });

  it("blocks capture visibly when IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new DOMException("storage disabled", "InvalidStateError");
      },
    });
    const runtime = createTestActivityRuntime();

    await runtime.open("10000000-0000-4000-8000-000000000010");

    expect(runtime.snapshot().capture).toEqual({
      kind: "Blocked",
      reason: "StorageUnavailable",
    });
  });

  it("retains pending capture when authentication is lost", async () => {
    window.history.replaceState({}, "", "/login");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorResponse(401, "E_UNAUTHENTICATED")),
    );
    const runtime = createTestActivityRuntime();
    await runtime.open(ACCOUNT_AUTH);

    await runtime.enqueue(
      closedSpan("20000000-0000-4000-8000-000000000006"),
    );
    await waitForSync(runtime, "Pending");

    expect(runtime.snapshot().sync).toMatchObject({ kind: "Pending", count: 1 });
    expect(await storedSpan(
      ACCOUNT_AUTH,
      "20000000-0000-4000-8000-000000000006",
    )).toMatchObject({ state: "Pending" });
  });

  it("marks only media-loss rows failed and keeps later work drainable", async () => {
    const attempts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          batch: { spans: Array<{ captureKey: string }> };
        };
        const captureKey = body.batch.spans[0]?.captureKey ?? "";
        attempts.push(captureKey);
        return captureKey === "20000000-0000-4000-8000-000000000007"
          ? errorResponse(404, "E_MEDIA_NOT_FOUND")
          : new Response(null, { status: 204 });
      }),
    );
    const runtime = createTestActivityRuntime();
    await runtime.open(ACCOUNT_MEDIA);

    await runtime.enqueue(
      closedSpan("20000000-0000-4000-8000-000000000007"),
    );
    await vi.waitFor(async () => {
      expect(await storedSpan(
        ACCOUNT_MEDIA,
        "20000000-0000-4000-8000-000000000007",
      )).toMatchObject({ state: "Failed" });
    });
    await waitForSync(runtime, "Failed");
    await runtime.enqueue(
      closedSpan("20000000-0000-4000-8000-000000000008"),
    );
    await vi.waitFor(() =>
      expect(attempts).toContain(
        "20000000-0000-4000-8000-000000000008",
      ),
    );

    expect(await storedSpan(
      ACCOUNT_MEDIA,
      "20000000-0000-4000-8000-000000000007",
    )).toMatchObject({
      state: "Failed",
      failureReason: "MediaUnavailable",
    });
    expect(await storedSpan(
      ACCOUNT_MEDIA,
      "20000000-0000-4000-8000-000000000008",
    )).toBeUndefined();
    expect(
      attempts.filter((captureKey) =>
        captureKey === "20000000-0000-4000-8000-000000000007" ||
        captureKey === "20000000-0000-4000-8000-000000000008",
      ),
    ).toEqual([
      "20000000-0000-4000-8000-000000000007",
      "20000000-0000-4000-8000-000000000008",
    ]);
  });

  it("marks locally expired capture failed without sending it", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const runtime = createTestActivityRuntime();
    await runtime.open(ACCOUNT_EXPIRY);
    const expired = new Date(
      TEST_NOW_MS - 31 * 24 * 60 * 60 * 1_000,
    ).toISOString();

    await runtime.enqueue(
      closedSpan("20000000-0000-4000-8000-000000000009", expired),
    );
    await vi.waitFor(async () => {
      expect(await storedSpan(
        ACCOUNT_EXPIRY,
        "20000000-0000-4000-8000-000000000009",
      )).toMatchObject({ state: "Failed" });
    });
    await waitForSync(runtime, "Failed");

    expect(fetch).not.toHaveBeenCalled();
    expect(await storedSpan(
      ACCOUNT_EXPIRY,
      "20000000-0000-4000-8000-000000000009",
    )).toMatchObject({ state: "Failed", failureReason: "Expired" });
  });

  it("retains a same-system rejection as a defect without wedging later rows", async () => {
    const attempts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          batch: { spans: Array<{ captureKey: string }> };
        };
        const captureKey = body.batch.spans[0]?.captureKey ?? "";
        attempts.push(captureKey);
        return captureKey === "20000000-0000-4000-8000-000000000010"
          ? errorResponse(409, "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH")
          : new Response(null, { status: 204 });
      }),
    );
    const runtime = createTestActivityRuntime();
    await runtime.open(ACCOUNT_DEFECT);

    await runtime.enqueue(
      closedSpan("20000000-0000-4000-8000-000000000010"),
    );
    await waitForSync(runtime, "Failed");
    await runtime.enqueue(
      closedSpan("20000000-0000-4000-8000-000000000011"),
    );
    await vi.waitFor(() =>
      expect(attempts).toContain(
        "20000000-0000-4000-8000-000000000011",
      ),
    );

    expect(await storedSpan(
      ACCOUNT_DEFECT,
      "20000000-0000-4000-8000-000000000010",
    )).toMatchObject({ state: "Failed", failureReason: "Defect" });
    expect(await storedSpan(
      ACCOUNT_DEFECT,
      "20000000-0000-4000-8000-000000000011",
    )).toBeUndefined();
  });

  it("merges account-fenced native health and delegates native recovery actions", async () => {
    const setPaused = vi.fn(async () => undefined);
    const retryFailed = vi.fn(async () => undefined);
    const discardFailed = vi.fn(async () => undefined);
    const runtime = activityRuntime();
    await runtime.open(ACCOUNT_NATIVE);
    installNativeActivityActions(ACCOUNT_NATIVE, {
      setPaused,
      retryFailed,
      discardFailed,
    });

    installNativeActivitySync(ACCOUNT_NATIVE_OTHER, {
      capture: { kind: "Blocked", reason: "StorageUnavailable" },
      sync: { kind: "Failed", count: 9 },
      acceptedRevision: 1,
    });
    expect(runtime.snapshot()).toEqual({
      capture: { kind: "Idle" },
      sync: { kind: "Synced" },
    });

    const acceptedBeforeInstall = consumptionProjectionSnapshot().revision;
    installNativeActivitySync(ACCOUNT_NATIVE, {
      capture: { kind: "Blocked", reason: "CapacityReached" },
      sync: {
        kind: "Pending",
        count: 3,
        oldestAt: "2026-08-10T17:00:00.000Z",
      },
      acceptedRevision: 1,
    });
    const acceptedAtOne = consumptionProjectionSnapshot().revision;
    expect(acceptedAtOne).toBe(acceptedBeforeInstall + 1);
    expect(runtime.snapshot()).toEqual({
      capture: { kind: "Blocked", reason: "CapacityReached" },
      sync: {
        kind: "Pending",
        count: 3,
        oldestAt: "2026-08-10T17:00:00.000Z",
      },
    });

    installNativeActivitySync(ACCOUNT_NATIVE, {
      capture: { kind: "Paused" },
      sync: {
        kind: "Pending",
        count: 3,
        oldestAt: "2026-08-10T17:00:00.000Z",
      },
      acceptedRevision: 1,
    });
    expect(runtime.snapshot().capture).toEqual({ kind: "Paused" });

    await runtime.setPaused(true);
    await runtime.retryFailed();
    await runtime.discardFailed();
    expect(setPaused).toHaveBeenCalledOnce();
    expect(setPaused).toHaveBeenCalledWith(true);
    expect(retryFailed).toHaveBeenCalledOnce();
    expect(discardFailed).toHaveBeenCalledOnce();

    installNativeActivitySync(ACCOUNT_NATIVE, {
      capture: { kind: "Idle" },
      sync: { kind: "Failed", count: 2 },
      acceptedRevision: 2,
    });
    expect(consumptionProjectionSnapshot().revision).toBe(acceptedAtOne + 1);
    expect(runtime.snapshot().sync).toEqual({ kind: "Failed", count: 2 });
    expect(() =>
      installNativeActivitySync(ACCOUNT_NATIVE, {
        capture: { kind: "Idle" },
        sync: { kind: "Synced" },
        acceptedRevision: 1,
      }),
    ).toThrow("accepted revision regressed");

    const beforeNativeUnmount = consumptionProjectionSnapshot().revision;
    installNativeActivityActions(ACCOUNT_NATIVE, null);
    installNativeActivitySync(ACCOUNT_NATIVE, null);
    expect(consumptionProjectionSnapshot().revision).toBe(beforeNativeUnmount);
    expect(runtime.snapshot().sync).toEqual({ kind: "Synced" });
    await runtime.retryFailed();
    await runtime.discardFailed();
    expect(retryFailed).toHaveBeenCalledOnce();
    expect(discardFailed).toHaveBeenCalledOnce();
    const beforeOpeningPreinstalledAccount =
      consumptionProjectionSnapshot().revision;
    await runtime.open(ACCOUNT_NATIVE_OTHER);
    expect(consumptionProjectionSnapshot().revision).toBe(
      beforeOpeningPreinstalledAccount + 1,
    );
    expect(runtime.snapshot().sync).toEqual({ kind: "Failed", count: 9 });
    installNativeActivitySync(ACCOUNT_NATIVE_OTHER, null);
  });
});
