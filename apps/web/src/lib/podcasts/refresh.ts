import { apiFetch } from "@/lib/api/client";
import { decodePresence } from "@/lib/api/presence";
import { sseClientDirect } from "@/lib/api/sse-client";
import { fetchStreamToken } from "@/lib/api/streamToken";
import { isAbortError } from "@/lib/errors";
import {
  decodePodcastRefreshRunHandle,
  decodePodcastRefreshRunStatus,
  type PodcastRefreshCounts,
  type PodcastRefreshProgress,
  type PodcastRefreshResult,
  type PodcastRefreshRunHandle,
  type PodcastRefreshRunSnapshot,
  type PodcastRefreshRunStatus,
  type PodcastRefreshScope,
} from "@/lib/podcasts/types";
import {
  expectExactRecord,
  expectNonnegativeInteger,
  expectString,
} from "@/lib/validation";

interface PodcastRefreshRunAdmission {
  readonly refreshRunHandle: PodcastRefreshRunHandle;
  readonly status: PodcastRefreshRunStatus;
  readonly requestedCount: number;
}

type PodcastRefreshSseEvent =
  | { readonly type: "state"; readonly data: PodcastRefreshRunSnapshot }
  | { readonly type: "done"; readonly data: PodcastRefreshRunSnapshot };

interface RunPodcastRefreshOptions {
  readonly signal: AbortSignal;
  readonly onProgress: (progress: PodcastRefreshProgress) => void;
}

const OBSERVATION_LOST_ANNOUNCEMENT =
  "Refresh is still running; showing the latest available data";

function decodePodcastRefreshRunAdmission(
  raw: unknown,
): PodcastRefreshRunAdmission {
  const data = expectExactRecord(
    expectExactRecord(raw, ["data"], "PodcastRefreshRunAdmission").data,
    ["refreshRunHandle", "status", "requestedCount"],
    "PodcastRefreshRunAdmission.data",
  );
  return {
    refreshRunHandle: decodePodcastRefreshRunHandle(
      data.refreshRunHandle,
      "refreshRunHandle",
    ),
    status: decodePodcastRefreshRunStatus(data.status, "status"),
    requestedCount: expectNonnegativeInteger(
      data.requestedCount,
      "requestedCount",
    ),
  };
}

function decodePodcastRefreshRunSnapshot(
  raw: unknown,
  context: string,
): PodcastRefreshRunSnapshot {
  const data = expectExactRecord(
    raw,
    [
      "refreshRunHandle",
      "status",
      "requestedCount",
      "finishedCount",
      "succeededCount",
      "sourceLimitedCount",
      "failedCount",
      "skippedCount",
      "newEpisodeCount",
      "startedAt",
      "completedAt",
    ],
    context,
  );
  return {
    refreshRunHandle: decodePodcastRefreshRunHandle(
      data.refreshRunHandle,
      `${context}.refreshRunHandle`,
    ),
    status: decodePodcastRefreshRunStatus(
      data.status,
      `${context}.status`,
    ),
    requestedCount: expectNonnegativeInteger(
      data.requestedCount,
      `${context}.requestedCount`,
    ),
    finishedCount: expectNonnegativeInteger(
      data.finishedCount,
      `${context}.finishedCount`,
    ),
    succeededCount: expectNonnegativeInteger(
      data.succeededCount,
      `${context}.succeededCount`,
    ),
    sourceLimitedCount: expectNonnegativeInteger(
      data.sourceLimitedCount,
      `${context}.sourceLimitedCount`,
    ),
    failedCount: expectNonnegativeInteger(
      data.failedCount,
      `${context}.failedCount`,
    ),
    skippedCount: expectNonnegativeInteger(
      data.skippedCount,
      `${context}.skippedCount`,
    ),
    newEpisodeCount: expectNonnegativeInteger(
      data.newEpisodeCount,
      `${context}.newEpisodeCount`,
    ),
    startedAt: expectString(data.startedAt, `${context}.startedAt`),
    completedAt: decodePresence(data.completedAt, (value) =>
      expectString(value, `${context}.completedAt.value`),
    ),
  };
}

function decodePodcastRefreshSseEvent(
  type: string,
  data: unknown,
  expectedHandle: PodcastRefreshRunHandle,
): PodcastRefreshSseEvent {
  if (type !== "state" && type !== "done") {
    throw new Error(`Unknown SSE event type: ${type}`);
  }
  let snapshot: PodcastRefreshRunSnapshot;
  try {
    snapshot = decodePodcastRefreshRunSnapshot(
      data,
      `Podcast refresh ${type}`,
    );
  } catch {
    throw new Error("Invalid SSE payload for podcast refresh run");
  }
  if (
    snapshot.refreshRunHandle !== expectedHandle ||
    (type === "done" && snapshot.status === "Running")
  ) {
    throw new Error("Invalid SSE payload for podcast refresh run");
  }
  return { type, data: snapshot };
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function terminalAnnouncement(
  kind: Exclude<PodcastRefreshRunStatus, "Running">,
  counts: PodcastRefreshCounts,
): string {
  if (
    counts.requestedCount === 0 ||
    counts.skippedCount === counts.requestedCount
  ) {
    return "Nothing to refresh";
  }

  const limitations: string[] = [];
  if (counts.sourceLimitedCount > 0) {
    limitations.push(
      `${countLabel(counts.sourceLimitedCount, "feed", "feeds")} source-limited`,
    );
  }
  if (counts.failedCount > 0) {
    limitations.push(
      `${countLabel(counts.failedCount, "feed", "feeds")} failed`,
    );
  }
  if (counts.skippedCount > 0) {
    limitations.push(
      `${countLabel(counts.skippedCount, "subscription", "subscriptions")} no longer active`,
    );
  }
  if (limitations.length > 0) {
    const discoveries =
      counts.newEpisodeCount > 0
        ? `${countLabel(counts.newEpisodeCount, "new episode", "new episodes")}; `
        : "";
    return `${discoveries}${counts.requestedCount} checked; ${limitations.join("; ")}`;
  }

  if (kind === "Failed") {
    return "Refresh failed";
  }
  return counts.newEpisodeCount > 0
    ? countLabel(counts.newEpisodeCount, "new episode", "new episodes")
    : "Up to date";
}

function terminalResult(
  snapshot: PodcastRefreshRunSnapshot,
): PodcastRefreshResult {
  if (snapshot.status === "Running") {
    throw new Error("A running Podcast refresh snapshot is not terminal");
  }
  const counts = countsFromSnapshot(snapshot);
  return {
    kind: snapshot.status,
    ...counts,
    announcement: terminalAnnouncement(snapshot.status, counts),
  };
}

function countsFromSnapshot(
  snapshot: PodcastRefreshRunSnapshot,
): PodcastRefreshCounts {
  const {
    requestedCount,
    finishedCount,
    succeededCount,
    sourceLimitedCount,
    failedCount,
    skippedCount,
    newEpisodeCount,
  } = snapshot;
  return {
    requestedCount,
    finishedCount,
    succeededCount,
    sourceLimitedCount,
    failedCount,
    skippedCount,
    newEpisodeCount,
  };
}

function reportProgress(
  onProgress: RunPodcastRefreshOptions["onProgress"],
  counts: PodcastRefreshCounts,
): void {
  onProgress({
    finishedCount: counts.finishedCount,
    requestedCount: counts.requestedCount,
  });
}

function observationLostResult(
  counts: PodcastRefreshCounts,
): PodcastRefreshResult {
  return {
    kind: "ObservationLost",
    ...counts,
    announcement: OBSERVATION_LOST_ANNOUNCEMENT,
  };
}

function abortError(signal: AbortSignal): Error {
  return isAbortError(signal.reason) && signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Podcast refresh observation was aborted", "AbortError");
}

async function getPodcastRefreshRun(
  handle: PodcastRefreshRunHandle,
  signal: AbortSignal,
): Promise<PodcastRefreshRunSnapshot> {
  const response = await apiFetch<unknown>(
    `/api/podcasts/refresh-runs/${encodeURIComponent(handle)}`,
    { cache: "no-store", signal },
  );
  const snapshot = decodePodcastRefreshRunSnapshot(
    expectExactRecord(response, ["data"], "PodcastRefreshRunSnapshot").data,
    "PodcastRefreshRunSnapshot.data",
  );
  if (snapshot.refreshRunHandle !== handle) {
    throw new Error("Podcast refresh snapshot handle does not match its route");
  }
  return snapshot;
}

function observePodcastRefreshRun(
  handle: PodcastRefreshRunHandle,
  initialCounts: PodcastRefreshCounts,
  { signal, onProgress }: RunPodcastRefreshOptions,
): Promise<PodcastRefreshResult> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let reconciliationStarted = false;
    let latestCounts = initialCounts;

    const cleanup = () => signal.removeEventListener("abort", handleAbort);
    const resolveOnce = (result: PodcastRefreshResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handleAbort = () => rejectOnce(abortError(signal));

    const reconcileOnce = async () => {
      if (settled || reconciliationStarted) return;
      reconciliationStarted = true;
      try {
        const snapshot = await getPodcastRefreshRun(handle, signal);
        if (signal.aborted) {
          rejectOnce(abortError(signal));
          return;
        }
        latestCounts = countsFromSnapshot(snapshot);
        reportProgress(onProgress, latestCounts);
        resolveOnce(
          snapshot.status === "Running"
            ? observationLostResult(countsFromSnapshot(snapshot))
            : terminalResult(snapshot),
        );
      } catch (error) {
        if (signal.aborted || isAbortError(error)) {
          rejectOnce(abortError(signal));
          return;
        }
        resolveOnce(observationLostResult(latestCounts));
      }
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    if (signal.aborted) {
      handleAbort();
      return;
    }
    sseClientDirect<PodcastRefreshSseEvent>({
      initialConnection: async () => {
        const connection = await fetchStreamToken();
        return {
          url: `${connection.stream_base_url}/stream/podcast-refresh-runs/${encodeURIComponent(handle)}/events`,
          token: connection.token,
        };
      },
      signal,
      decode: (type, data) =>
        decodePodcastRefreshSseEvent(type, data, handle),
      isTerminal: (event) => event.type === "done",
      onEvent: (event) => {
        if (settled) return;
        latestCounts = countsFromSnapshot(event.data);
        reportProgress(onProgress, latestCounts);
        if (event.type === "done") {
          resolveOnce(terminalResult(event.data));
        }
      },
      onError: () => {
        void reconcileOnce();
      },
      onComplete: (terminalEventSeen) => {
        if (!terminalEventSeen) void reconcileOnce();
      },
    });
  });
}

export async function runPodcastRefresh(
  scope: PodcastRefreshScope,
  options: RunPodcastRefreshOptions,
): Promise<PodcastRefreshResult> {
  if (options.signal.aborted) {
    throw abortError(options.signal);
  }

  let admission: PodcastRefreshRunAdmission;
  try {
    admission = decodePodcastRefreshRunAdmission(
      await apiFetch<unknown>("/api/podcasts/refresh-runs", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(scope),
        signal: options.signal,
      }),
    );
  } catch (error) {
    if (options.signal.aborted || isAbortError(error)) {
      throw abortError(options.signal);
    }
    throw error;
  }
  if (options.signal.aborted) {
    throw abortError(options.signal);
  }

  const initialCounts = {
    requestedCount: admission.requestedCount,
    finishedCount: 0,
    succeededCount: 0,
    sourceLimitedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    newEpisodeCount: 0,
  };
  reportProgress(options.onProgress, initialCounts);
  if (options.signal.aborted) {
    throw abortError(options.signal);
  }

  if (admission.status !== "Running") {
    if (admission.requestedCount > 0) {
      let snapshot: PodcastRefreshRunSnapshot;
      try {
        snapshot = await getPodcastRefreshRun(
          admission.refreshRunHandle,
          options.signal,
        );
      } catch (error) {
        if (options.signal.aborted || isAbortError(error)) {
          throw abortError(options.signal);
        }
        throw error;
      }
      if (options.signal.aborted) {
        throw abortError(options.signal);
      }
      if (
        snapshot.status === "Running" ||
        snapshot.status !== admission.status
      ) {
        throw new Error(
          "Terminal Podcast refresh admission did not resolve to its terminal snapshot",
        );
      }
      reportProgress(options.onProgress, countsFromSnapshot(snapshot));
      return terminalResult(snapshot);
    }
    if (admission.status !== "Complete") {
      throw new Error("An empty Podcast refresh run must be Complete");
    }
    return {
      kind: admission.status,
      ...initialCounts,
      announcement: terminalAnnouncement(admission.status, initialCounts),
    };
  }

  return observePodcastRefreshRun(
    admission.refreshRunHandle,
    initialCounts,
    options,
  );
}
