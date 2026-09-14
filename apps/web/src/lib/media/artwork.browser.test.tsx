import { afterEach, expect, it, vi } from "vitest";
import { artworkFixture as fixture } from "./__tests__/artworkFixtures";
import { ArtworkReader, type ArtworkLease } from "./artwork";
import { buildMediaImageProxySrc } from "./imageProxy";
import { observeArtwork } from "./observeArtwork";

const originalFetch = globalThis.fetch;
const leases: ArtworkLease[] = [];

afterEach(() => {
  for (const lease of leases.splice(0)) lease.release();
  vi.unstubAllGlobals();
});

function encoded(name: string) {
  const image = fixture.cases.find((candidate) => candidate.name === name);
  if (!image)
    throw new Error(`Missing independently specified artwork ${name}`);
  const bytes = Uint8Array.from(atob(image.base64), (character) =>
    character.charCodeAt(0),
  );
  return { image, bytes };
}

function response(name: string): Response {
  const { image, bytes } = encoded(name);
  return new Response(bytes, {
    headers: {
      "content-type": image.type,
      "content-length": String(image.bytes),
      "x-nexus-image-width": String(image.width),
      "x-nexus-image-height": String(image.height),
    },
  });
}

function acquire(
  reader: ArtworkReader,
  name: string,
  width: number,
  height: number,
) {
  const lease = reader.acquire(
    buildMediaImageProxySrc(`https://images.example/${name}`),
    width,
    height,
  );
  leases.push(lease);
  return lease;
}

it("shares artwork only while consumed, releases its URL, and retries refused image admission", async () => {
  const reader = new ArtworkReader({ maxDimension: 6, residentPixels: 36 });
  let requests = 0;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).startsWith("/api/media/image"))
        return originalFetch(input, init);
      requests += 1;
      if (requests === 1)
        return new Response(
          JSON.stringify({
            error: {
              code: "E_READ_CAPACITY",
              message: "Occupied",
            },
          }),
          {
            status: 503,
            headers: { "content-type": "application/json", "retry-after": "0" },
          },
        );
      return response("rotated-jpeg");
    },
  );
  const first = acquire(reader, "cover", 6, 6);
  const second = acquire(reader, "cover", 6, 6);
  await expect.poll(() => first.read().kind).toBe("Ready");
  expect(requests, "simultaneous consumers duplicated their source read").toBe(
    2,
  );
  const ready = first.read();
  if (ready.kind !== "Ready") throw new Error("Artwork did not finish");
  expect(second.read()).toEqual(ready);
  expect(
    [ready.width, ready.height],
    "rotation distorted the derivative",
  ).toEqual([2, 6]);
  first.release();
  const stillConsumed = new Image();
  stillConsumed.src = ready.url;
  await stillConsumed.decode();
  expect([stillConsumed.naturalWidth, stillConsumed.naturalHeight]).toEqual([
    2, 6,
  ]);
  second.release();
  const retired = new Image();
  retired.src = ready.url;
  await expect(
    retired.decode(),
    "last consumer retained its object URL",
  ).rejects.toThrow();
  const successor = acquire(reader, "cover", 6, 6);
  await expect.poll(() => successor.read().kind).toBe("Ready");
  expect(
    requests,
    "inactive artwork became an independent freshness cache",
  ).toBe(3);
});

it("makes animated artwork a bounded static first frame and admits the next demand after release", async () => {
  const reader = new ArtworkReader({ maxDimension: 4, residentPixels: 16 });
  let requests = 0;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).startsWith("/api/media/image"))
        return originalFetch(input, init);
      requests += 1;
      return response("animated-gif");
    },
  );
  const first = acquire(reader, "first", 4, 4);
  const next = acquire(reader, "next", 4, 4);
  await expect.poll(() => first.read().kind).toBe("Ready");
  expect(next.read().kind).toBe("Loading");
  expect(requests, "unadmitted artwork allocated its source bytes").toBe(1);
  const ready = first.read();
  if (ready.kind !== "Ready") throw new Error("Artwork did not finish");
  const displayed = new Image();
  displayed.src = ready.url;
  await displayed.decode();
  const bitmap = await createImageBitmap(displayed);
  try {
    expect([bitmap.width, bitmap.height]).toEqual([4, 2]);
    const canvas = new OffscreenCanvas(4, 2);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Browser did not provide the artwork canvas");
    context.drawImage(bitmap, 0, 0);
    expect(
      Array.from(context.getImageData(0, 0, 1, 1).data),
      "artwork did not preserve the red first frame",
    ).toEqual([255, 0, 0, 255]);
  } finally {
    bitmap.close();
  }
  first.release();
  await expect.poll(() => next.read().kind).toBe("Ready");
  expect(requests).toBe(2);
});

it("cancels a retired source and lets a replacement consumer acquire its own read", async () => {
  const reader = new ArtworkReader({ maxDimension: 6, residentPixels: 36 });
  const request: { signal: AbortSignal | null } = { signal: null };
  let requests = 0;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).startsWith("/api/media/image"))
        return originalFetch(input, init);
      requests += 1;
      if (requests > 1) return response("rotated-jpeg");
      request.signal = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    },
  );
  const first = acquire(reader, "cover", 6, 6);
  const second = acquire(reader, "cover", 6, 6);
  await expect.poll(() => request.signal !== null).toBe(true);
  first.release();
  expect(request.signal?.aborted).toBe(false);
  second.release();
  expect(request.signal?.aborted).toBe(true);
  const successor = acquire(reader, "cover", 6, 6);
  await expect.poll(() => successor.read().kind).toBe("Ready");
  expect(requests).toBe(2);
});

it("keys display demand on a size bucket, so an in-bucket resize reads nothing", async () => {
  const reader = new ArtworkReader({
    maxDimension: 1024,
    residentPixels: 1024 ** 2,
  });
  let requests = 0;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).startsWith("/api/media/image"))
        return originalFetch(input, init);
      requests += 1;
      return response("rotated-jpeg");
    },
  );
  const image = document.createElement("img");
  const css = (pixels: number) => `${pixels / window.devicePixelRatio}px`;
  image.style.width = css(200);
  image.style.height = css(200);
  document.body.append(image);
  let resized: (() => void) | null = null;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(
        callback: (entries: { isIntersecting: boolean }[]) => void,
      ) {
        queueMicrotask(() => callback([{ isIntersecting: true }]));
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const retire = observeArtwork(
    image,
    buildMediaImageProxySrc("https://images.example/cover"),
    reader,
  );
  try {
    if (resized === null) throw new Error("Display demand did not observe its box");
    const deliver: () => void = resized;
    await expect.poll(() => image.getAttribute("aria-busy")).toBe("false");
    expect(requests).toBe(1);
    const derivative = image.getAttribute("src");
    image.style.width = css(240);
    image.style.height = css(220);
    deliver();
    expect(
      image.getAttribute("src"),
      "an in-bucket resize discarded its derivative",
    ).toBe(derivative);
    expect(image.getAttribute("aria-busy")).toBe("false");
    expect(requests, "an in-bucket resize re-read its source").toBe(1);
    image.style.width = css(300);
    image.style.height = css(300);
    deliver();
    expect(image.getAttribute("aria-busy")).toBe("true");
    await expect.poll(() => image.getAttribute("aria-busy")).toBe("false");
    expect(requests, "a bucket step read more than its own source").toBe(2);
  } finally {
    retire();
    image.remove();
  }
});

it("reads a healthy cover while another source stalls", async () => {
  const reader = new ArtworkReader({ maxDimension: 6, residentPixels: 72 });
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).startsWith("/api/media/image"))
        return originalFetch(input, init);
      if (!String(input).endsWith("stalled")) return response("rotated-jpeg");
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      );
    },
  );
  const stalled = acquire(reader, "stalled", 6, 6);
  const healthy = acquire(reader, "cover", 6, 6);
  await expect.poll(() => healthy.read().kind).toBe("Ready");
  expect(
    stalled.read().kind,
    "a stalled source resolved without its bytes",
  ).toBe("Loading");
});

it("admits a passed-over demand before any later arrival", async () => {
  const reader = new ArtworkReader({ maxDimension: 16, residentPixels: 256 });
  const requests: string[] = [];
  const pending = new Map<string, (value: Response) => void>();
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).startsWith("/api/media/image"))
        return originalFetch(input, init);
      const name = decodeURIComponent(String(input)).split("/").slice(-1)[0];
      if (name === undefined) throw new Error("Artwork read lost its source");
      requests.push(name);
      return new Promise<Response>((resolve) => pending.set(name, resolve));
    },
  );
  const small = acquire(reader, "small", 4, 4);
  const large = acquire(reader, "large", 16, 16);
  const second = acquire(reader, "second", 4, 4);
  await expect.poll(() => requests.length).toBe(1);
  pending.get("small")?.(response("rotated-jpeg"));
  await expect.poll(() => small.read().kind).toBe("Ready");
  await expect
    .poll(() => requests)
    .toEqual(["small", "second"]);
  pending.get("second")?.(response("rotated-jpeg"));
  await expect.poll(() => second.read().kind).toBe("Ready");
  acquire(reader, "late", 4, 4);
  small.release();
  second.release();
  await expect
    .poll(() => requests, {
      message: "a later arrival overtook the passed-over demand",
    })
    .toEqual(["small", "second", "large"]);
  pending.get("large")?.(response("rotated-jpeg"));
  await expect.poll(() => large.read().kind).toBe("Ready");
});
