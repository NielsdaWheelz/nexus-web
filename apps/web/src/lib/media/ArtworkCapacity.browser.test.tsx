import { render, screen } from "@testing-library/react";
import { nativeBrowserMemory } from "@/components/__tests__/browserMemory";
import { cdp, commands, page, server } from "vitest/browser";
import { afterAll, expect, it, vi } from "vitest";
import { artworkFixture as fixture } from "./__tests__/artworkFixtures";
import { ArtworkReader, type ArtworkLease } from "./artwork";
import { buildMediaImageProxySrc } from "./imageProxy";

const measurements: object[] = [];
const profiles = ["maximum-dimensions", "maximum-png-metadata"].flatMap(
  (name) =>
    [256, 512, 1024].flatMap((dimension) =>
      [1, 16].map((consumers) => ({ name, dimension, consumers })),
    ),
);

it.each(profiles)(
  "measures $name at $dimension pixels for $consumers consumers",
  async ({ name, dimension, consumers }) => {
    await page.viewport(1280, 900);
    const session = cdp();
    const originalFetch = globalThis.fetch;
    try {
      const source = fixture.cases.find((image) => image.name === name);
      if (!source) throw new Error(`Missing source allocation case ${name}`);
      await session.send("HeapProfiler.collectGarbage");
      const baseline = {
        heap: await session.send("Runtime.getHeapUsage"),
        native: await nativeBrowserMemory(),
      };
      const reader = new ArtworkReader({
        maxDimension: dimension,
        residentPixels: consumers * dimension ** 2,
      });
      const leases: ArtworkLease[] = [];
      vi.stubGlobal(
        "fetch",
        async (input: RequestInfo | URL, init?: RequestInit) => {
          if (!String(input).startsWith("/api/media/image"))
            return originalFetch(input, init);
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
      let view: ReturnType<typeof render> | null = null;
      const start = performance.now();
      try {
        for (let index = 0; index < consumers; index += 1) {
          leases.push(
            reader.acquire(
              buildMediaImageProxySrc(
                `https://images.example/${name}/${index}`,
              ),
              dimension,
              dimension,
            ),
          );
        }
        await Promise.all(
          leases.map(
            (lease) =>
              new Promise<void>((resolve, reject) => {
                const observe = () => {
                  const state = lease.read();
                  if (state.kind === "Loading") return;
                  unsubscribe();
                  if (state.kind === "Failed") reject(state.error);
                  else resolve();
                };
                const unsubscribe = lease.subscribe(observe);
                observe();
              }),
          ),
        );
        const representations = leases.map((lease) => {
          const result = lease.read();
          if (result.kind !== "Ready")
            throw new Error(
              `Artwork ${name} did not produce its bounded representation`,
            );
          return result;
        });
        view = render(
          <div
            style={{ display: "grid", gridTemplateColumns: "repeat(4,128px)" }}
          >
            {representations.map((image, index) => (
              // eslint-disable-next-line @next/next/no-img-element -- this experiment measures the browser's actual decoded surface for an already owned blob derivative
              <img
                key={image.url}
                src={image.url}
                alt={`Measured artwork ${index}`}
                width={image.width}
                height={image.height}
                style={{ width: 128, height: 128, objectFit: "contain" }}
              />
            ))}
          </div>,
        );
        for (const image of screen.getAllByRole("img")) {
          if (!(image instanceof HTMLImageElement))
            throw new Error("Artwork output did not render an image");
          await image.decode();
          expect(
            Math.max(image.naturalWidth, image.naturalHeight),
          ).toBeLessThanOrEqual(dimension);
        }
        const loaded = {
          heap: await session.send("Runtime.getHeapUsage"),
          native: await nativeBrowserMemory(),
        };
        // Each ready entry also retains an encoded derivative blob that the
        // pixel reservation does not describe; record its actual bytes.
        const derivativeBytes = await Promise.all(
          representations.map(async (image) =>
            (await (await fetch(image.url)).blob()).size,
          ),
        );
        measurements.push({
          name,
          sourceSha256: source.sha256,
          dimension,
          consumers,
          readyMs: performance.now() - start,
          baseline,
          loaded,
          derivativeBytes,
        });
      } finally {
        view?.unmount();
        for (const lease of leases) lease.release();
        vi.unstubAllGlobals();
      }
      await session.send("HeapProfiler.collectGarbage");
      Object.assign(measurements[measurements.length - 1]!, {
        released: {
          heap: await session.send("Runtime.getHeapUsage"),
          native: await nativeBrowserMemory(),
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

afterAll(async () => {
  const directory = server.config.env.NEXUS_TEST_RESULTS_DIR;
  const runId = server.config.env.NEXUS_TEST_EVIDENCE_RUN_ID;
  if (
    !/^[0-9a-f]{16}$/.test(runId) ||
    !directory.startsWith("/") ||
    !directory.endsWith(`/test-results/runs/${runId}`)
  ) {
    throw new Error(
      "Artwork experiment requires the controller-owned evidence directory",
    );
  }
  const fixtureBytes = new TextEncoder().encode(
    await commands.readFile("../../testdata/capacity/artwork.json"),
  );
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", fixtureBytes),
  );
  const evidence = JSON.stringify({
    version: 1,
    runId,
    scope:
      "unqualified artwork derivative experiment; excludes workspace and native figures; process high-water sums are conservative, not simultaneous peaks",
    fixture: {
      path: "testdata/capacity/artwork.json",
      sha256: Array.from(digest, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    },
    measurements,
  });
  if (evidence.length > 64 * 1024)
    throw new Error("Artwork experiment exceeded its bounded evidence size");
  await commands.writeFile(`${directory}/artwork-capacity.json`, evidence);
});
