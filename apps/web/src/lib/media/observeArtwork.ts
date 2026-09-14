import type { ArtworkLease, ArtworkReader } from "./artwork";
import type { MediaImageProxySrc } from "./imageProxy";

// Display demand snaps up to a fixed doubling ladder of derivative sizes. A
// fluid box changes by a pixel on every layout frame; keying the lease on the
// raw box abandons an upstream read and a decoder child per frame, while a
// fixed ladder bounds a whole drag to one read per step it crosses. The rungs
// start at the smallest displayed cover so fixed-size demands stay exact.
const DISPLAY_STEPS = [32, 64, 128, 256, 512, 1024] as const;

function displayBound(pixels: number, maxDimension: number): number {
  const step = DISPLAY_STEPS.find((candidate) => candidate >= pixels);
  return step === undefined ? maxDimension : Math.min(step, maxDimension);
}

/** A mounted, page-visible image owns only its intersecting display demand. */
export function observeArtwork(image: HTMLImageElement, source: MediaImageProxySrc, reader: ArtworkReader): () => void {
  let intersects = false;
  let retired = false;
  let current: { lease: ArtworkLease; width: number; height: number; unsubscribe: () => void } | null = null;
  const release = () => {
    const owned = current;
    current = null;
    image.removeAttribute("src");
    image.removeAttribute("aria-busy");
    owned?.unsubscribe();
    owned?.lease.release();
  };
  const update = () => {
    if (retired) return;
    const box = image.getBoundingClientRect();
    const displayed = { width: Math.ceil(box.width * window.devicePixelRatio), height: Math.ceil(box.height * window.devicePixelRatio) };
    if (!intersects || displayed.width === 0 || displayed.height === 0) { release(); return; }
    const width = displayBound(displayed.width, reader.maxDimension);
    const height = displayBound(displayed.height, reader.maxDimension);
    if (current?.width === width && current.height === height) return;
    release();
    const lease = reader.acquire(source, width, height);
    const owned = { lease, width, height, unsubscribe: () => {} };
    current = owned;
    const publish = () => {
      if (current !== owned) return;
      const state = lease.read();
      image.setAttribute("aria-busy", String(state.kind === "Loading"));
      if (state.kind === "Ready") image.src = state.url;
      else image.removeAttribute("src");
    };
    owned.unsubscribe = lease.subscribe(publish);
    publish();
  };
  const intersection = new IntersectionObserver((entries) => {
    intersects = entries.at(-1)?.isIntersecting === true;
    update();
  });
  const resize = new ResizeObserver(update);
  intersection.observe(image);
  resize.observe(image);
  window.addEventListener("resize", update);
  return () => {
    retired = true;
    intersection.disconnect(); resize.disconnect();
    window.removeEventListener("resize", update);
    release();
  };
}
