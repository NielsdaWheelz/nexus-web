import { render, screen, within } from "@testing-library/react";
import Link from "next/link";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import MediaImage from "@/components/ui/MediaImage";
import { useMediaSessionAdapter } from "@/lib/player/mediaSession";
import { artworkFixture as fixture } from "./__tests__/artworkFixtures";
import { ArtworkProvider, ArtworkFailureNotice } from "./ArtworkProvider";

const SOURCE = "https://images.example/shared-cover";
const originalFetch = globalThis.fetch;
afterEach(() => {
  Reflect.deleteProperty(document, "visibilityState");
  vi.unstubAllGlobals();
});

function Display() {
  const [visible, setVisible] = useState(true);
  const [playing, setPlaying] = useState(true);
  const rate = useRef(1);
  useMediaSessionAdapter({
    track: playing
      ? { title: "Current cover", image: { kind: "Remote", url: SOURCE } }
      : null,
    isPlaying: playing,
    positionEnabled: false,
    audioElement: null,
    basePlaybackRateRef: rate,
    handlers: {
      play() {},
      pause() {},
      skipBackward() {},
      skipForward() {},
      previous: null,
      next: null,
      stop() {},
      seekToSeconds() {},
    },
  });
  return (
    <>
      <button onClick={() => setVisible(false)}>Hide covers</button>
      <button onClick={() => setPlaying(false)}>Remove current track</button>
      <ArtworkFailureNotice />
      <div style={{ marginTop: visible ? 0 : 1000 }}>
        <MediaImage
          kind="proxied"
          remoteUrl={SOURCE}
          alt="First cover"
          width={32}
          height={32}
        />
        <MediaImage
          kind="proxied"
          remoteUrl={SOURCE}
          alt="Second cover"
          width={32}
          height={32}
        />
      </div>
    </>
  );
}

it("shares visible covers with current media-session artwork and releases hidden demand", async () => {
  await page.viewport(800, 600);
  const source = fixture.cases.find((item) => item.name === "rotated-jpeg");
  if (!source) throw new Error("Missing external rotated-image fixture");
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).startsWith("/api/media/image"))
        return originalFetch(input, init);
      reads += 1;
      const bytes = Uint8Array.from(atob(source.base64), (character) =>
        character.charCodeAt(0),
      );
      return new Response(bytes, {
        headers: {
          "content-type": source.type,
          "content-length": String(source.bytes),
          "x-nexus-image-width": String(source.width),
          "x-nexus-image-height": String(source.height),
        },
      });
    },
  );
  render(
    <ArtworkProvider limits={{ maxDimension: 6, residentPixels: 36 }}>
      <Display />
    </ArtworkProvider>,
  );
  const first = screen.getByRole("img", { name: "First cover" });
  const second = screen.getByRole("img", { name: "Second cover" });
  await expect
    .poll(() => ({
      ready: first.getAttribute("src")?.startsWith("blob:") === true,
      visibility: document.visibilityState,
      size: [
        first.getBoundingClientRect().width,
        first.getBoundingClientRect().height,
      ],
      session: navigator.mediaSession.metadata?.artwork,
      reads,
    }))
    .toMatchObject({
      ready: true,
      visibility: "visible",
      size: [32, 32],
      reads: 1,
    });
  const url = first.getAttribute("src");
  if (!url) throw new Error("Visible artwork omitted its owned derivative");
  await expect.poll(() => second.getAttribute("src")).toBe(url);
  expect(
    reads,
    "visible consumers and the current track duplicated their source read",
  ).toBe(1);
  expect(navigator.mediaSession.metadata?.artwork[0]?.src).toBe(url);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  document.dispatchEvent(new Event("visibilitychange"));
  await expect.poll(() => first.hasAttribute("src")).toBe(false);
  await expect.poll(() => second.hasAttribute("src")).toBe(false);
  expect(navigator.mediaSession.metadata?.artwork[0]?.src).toBe(url);
  Reflect.deleteProperty(document, "visibilityState");
  document.dispatchEvent(new Event("visibilitychange"));
  await expect.poll(() => first.getAttribute("src")).toBe(url);
  expect(
    reads,
    "returning visible cover failed to reuse the live current-track lease",
  ).toBe(1);
  await userEvent.click(screen.getByRole("button", { name: "Hide covers" }));
  await expect.poll(() => first.hasAttribute("src")).toBe(false);
  await expect.poll(() => second.hasAttribute("src")).toBe(false);
  expect(navigator.mediaSession.metadata?.artwork[0]?.src).toBe(url);
  await userEvent.click(
    screen.getByRole("button", { name: "Remove current track" }),
  );
  await expect.poll(() => navigator.mediaSession.metadata).toBeNull();
  const retired = new Image();
  retired.src = url;
  await expect(
    retired.decode(),
    "retired artwork kept its object URL",
  ).rejects.toThrow();
});

it("retries a visible failed artwork demand through its feature notice", async () => {
  await page.viewport(800, 600);
  const source = fixture.cases.find((item) => item.name === "rotated-jpeg");
  if (!source) throw new Error("Missing external rotated-image fixture");
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).startsWith("/api/media/image"))
        return originalFetch(input, init);
      reads += 1;
      if (reads === 1)
        return Response.json(
          {
            error: { code: "E_NOT_FOUND", message: "Source image is missing" },
          },
          { status: 404 },
        );
      const bytes = Uint8Array.from(atob(source.base64), (character) =>
        character.charCodeAt(0),
      );
      return new Response(bytes, {
        headers: {
          "content-type": source.type,
          "content-length": String(source.bytes),
          "x-nexus-image-width": String(source.width),
          "x-nexus-image-height": String(source.height),
        },
      });
    },
  );
  render(
    <ArtworkProvider limits={{ maxDimension: 6, residentPixels: 36 }}>
      <ArtworkFailureNotice />
      <Link href="/media/fixture" aria-label="Open media">
        <MediaImage
          kind="proxied"
          remoteUrl={SOURCE}
          alt="Recoverable cover"
          width={32}
          height={32}
        />
      </Link>
    </ArtworkProvider>,
  );
  const cover = screen.getByRole("img", { name: "Recoverable cover" });
  const retry = await screen.findByRole("button", { name: "Retry artwork" });
  expect(cover.hasAttribute("src")).toBe(false);
  expect(
    within(screen.getByRole("link", { name: "Open media" })).queryByRole("button"),
    "artwork retry inserted a nested control into its navigation target",
  ).toBeNull();
  expect(reads).toBe(1);
  await userEvent.click(retry);
  await expect
    .poll(() => cover.getAttribute("src")?.startsWith("blob:"))
    .toBe(true);
  expect(reads, "feature retry did not restart the current failed demand").toBe(
    2,
  );
  expect(screen.queryByRole("button", { name: "Retry artwork" })).toBeNull();
});
