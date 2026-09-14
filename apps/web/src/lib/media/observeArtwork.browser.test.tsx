import { afterEach, expect, it, vi } from "vitest";
import { ArtworkReader } from "./artwork";
import { buildMediaImageProxySrc } from "./imageProxy";
import { observeArtwork } from "./observeArtwork";

afterEach(() => vi.unstubAllGlobals());

it("withdraws queued visibility callbacks without resurrecting image demand", async () => {
  const image = document.createElement("img");
  image.style.width = "64px"; image.style.height = "64px";
  document.body.append(image);
  let deliver: ((visible: readonly boolean[]) => void) | null = null;
  // External observer queue contract: disconnect does not erase notifications
  // already queued, and a batch may contain successive states for one target.
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
      deliver = (visible) => callback(visible.map((isIntersecting) => ({
        target: image, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0,
        time: performance.now(), rootBounds: null,
        boundingClientRect: image.getBoundingClientRect(), intersectionRect: image.getBoundingClientRect(),
      })));
    }
    observe() {}
    disconnect() {}
  });
  const requests: string[] = [];
  const pending: (() => void)[] = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Promise<Response>((resolve) => pending.push(() => resolve(new Response(null, { status: 503 }))));
  });
  const reader = new ArtworkReader({ maxDimension: 64, residentPixels: 64 ** 2 });
  const source = buildMediaImageProxySrc("https://example.invalid/artwork.png");
  let release = observeArtwork(image, source, reader);
  try {
    if (deliver === null) throw new Error("External observer did not subscribe");
    const firstQueue: (visible: readonly boolean[]) => void = deliver;
    firstQueue([true, false]);
    await Promise.resolve();
    expect(requests, "last queued visibility must withdraw image demand").toEqual([]);
    release();
    firstQueue([true]);
    await Promise.resolve();
    expect(requests, "retired visibility resurrected an image request").toEqual([]);

    release = observeArtwork(image, source, reader);
    const secondQueue: (visible: readonly boolean[]) => void = deliver;
    secondQueue([true]);
    await Promise.resolve();
    expect(image.getAttribute("aria-busy")).toBe("true");
    release();
    expect(image.getAttribute("src")).toBeNull();
    expect(image.hasAttribute("aria-busy")).toBe(false);
  } finally { release(); image.remove(); for (const settle of pending) settle(); }
});
