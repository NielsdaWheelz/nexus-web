import { apiCommand204, apiKeepaliveJson, isApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { ActivityRequest, ClosedActivitySpan } from "./activityContract";

// The tab's closed spans, held in memory until the server has them. A batch is one lane (media,
// modality, device class) in occurrence order, at most 120 spans and 40 kB (the BFF takes 48).
// Network, 408, 429 and 5xx failures retry with backoff; any other refusal drops its batch, since
// sending it again cannot succeed. A tab closed offline loses what it held.

const MAX_SPANS = 120;
const MAX_BYTES = 40_000;
const COALESCE_MS = 2_000;
const RETRY_MS = [2_000, 5_000, 15_000, 60_000];
const PATH = "/api/consumption/activity";

let queue: ClosedActivitySpan[] = [];
let sending = false;
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Take the oldest lane's next batch off the queue. */
function take(): ActivityRequest | null {
  const [first] = queue;
  if (first === undefined) return null;
  const lane = (span: ClosedActivitySpan) =>
    span.mediaRef === first.mediaRef &&
    span.modality === first.modality &&
    span.deviceClass === first.deviceClass;
  const spans = queue
    .filter(lane)
    .sort(
      (a, b) => Date.parse(a.span.occurredAt) - Date.parse(b.span.occurredAt),
    )
    .slice(0, MAX_SPANS);
  while (spans.length > 1 && JSON.stringify(spans).length > MAX_BYTES)
    spans.pop();
  queue = queue.filter((span) => !spans.includes(span));
  const body = {
    modality: first.modality,
    spans: spans.map((s) => ({ captureKey: s.captureKey, ...s.span })),
  };
  return {
    mediaRef: first.mediaRef,
    deviceClass: first.deviceClass,
    batch: body as ActivityRequest["batch"],
  };
}

async function send(): Promise<void> {
  if (sending) return;
  sending = true;
  try {
    for (let request = take(); request !== null; request = take()) {
      try {
        await apiCommand204(PATH, {
          method: "POST",
          body: JSON.stringify(request),
        });
        attempt = 0;
      } catch (error) {
        const status = isApiError(error) ? error.status : 0;
        if (handleUnauthenticatedApiError(error)) return;
        if (status === 0 || status === 408 || status === 429 || status >= 500) {
          queue = [...queue, ...unpack(request)];
          schedule(RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]);
          return;
        }
        console.warn("activity_batch_refused", {
          status,
          spans: request.batch.spans.length,
        });
      }
    }
  } finally {
    sending = false;
  }
}

function unpack(request: ActivityRequest): ClosedActivitySpan[] {
  return request.batch.spans.map(({ captureKey, ...span }) => ({
    captureKey,
    mediaRef: request.mediaRef,
    deviceClass: request.deviceClass,
    modality: request.batch.modality,
    span,
  })) as ClosedActivitySpan[];
}

function schedule(delayMs: number): void {
  clearTimeout(timer);
  timer = setTimeout(() => void send(), delayMs);
}

const uploader = {
  enqueue(span: ClosedActivitySpan): void {
    queue.push(span);
    if (attempt === 0) schedule(COALESCE_MS);
  },
  /** Send now; `keepalive` hands every batch to the browser to finish after the page goes. */
  flush(options: { keepalive?: boolean } = {}): void {
    if (!options.keepalive) return schedule(0);
    for (let request = take(); request !== null; request = take()) {
      void apiKeepaliveJson(PATH, request, "POST").catch(() => undefined);
    }
  },
};

export function activityUploader(): typeof uploader {
  return uploader;
}
