import {
  unicodeMetadata as metadata,
  unicodeMembers as wire,
  epubMetadata,
  epubMembers as epubWire,
} from "./__tests__/readerFixtures";
import { expect, it } from "vitest";
import { ResourceCache } from "@/lib/api/resourceCache";
import { createDocumentReaderSession } from "@/lib/reader/DocumentReaderSession";
import { READER_CAPACITY } from "@/lib/reader/readerCapacity";
import {
  OfflineReaderProgressPort,
  OfflineReaderSource,
} from "./OfflineReaderAdapters";
import {
  OfflineReadingControllerRuntime,
  type OpenedOfflineReading,
} from "./runtime";

const base =
  "https://appassets.androidplatform.net/nexus-offline/lease/018f2e745efc7d8e8a3a142857142857/";
const opened: OpenedOfflineReading = {
  leaseId: "018f2e74-5efc-7d8e-8a3a-142857142857",
  readerGeneration: metadata.manifest.readerGeneration,
  readerRevisionKey: metadata.manifest.readerRevisionKey,
  readerUrl: `${base}descriptor.json`,
  progress: { kind: "Canonical", snapshot: { state: "Empty", revision: 0 } },
  installedAt: "2026-08-13T10:00:00Z",
};

it("reads exact native publication members on demand and preserves original Unicode offsets", async () => {
  const requests: string[] = [];
  const boundary: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(base))
      throw new Error("Native reader attempted a hosted fetch");
    const key = url.slice(base.length);
    requests.push(key);
    const body = (wire.members as Record<string, string>)[key];
    if (body === undefined) return new Response("missing", { status: 404 });
    return new Response(body, {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(new TextEncoder().encode(body).length),
      },
    });
  };
  const source = new OfflineReaderSource(
    metadata.manifest.mediaId,
    opened,
    "018f2e74-5efc-7d9e-8a3a-142857142857",
    READER_CAPACITY,
    new ResourceCache({}, READER_CAPACITY.cache),
    boundary,
  );
  expect(
    requests,
    "constructing a source must not eagerly read its document",
  ).toEqual([]);
  const signal = new AbortController().signal;
  const descriptor = await source.loadDescriptor(
    metadata.manifest.mediaId,
    signal,
  );
  expect(requests, "selection materialized units before demand").toEqual([
    "descriptor.json",
  ]);
  if (descriptor.kind !== "web_article")
    throw new Error("Expected captured web publication");
  const first = await source.resolve(
    descriptor,
    { kind: "Unit", unit_key: descriptor.first_unit_ref.key },
    signal,
  );
  expect(first.kind).toBe("Unit");
  if (first.kind !== "Unit") throw new Error("Expected first unit");
  const acquired = source.acquireUnit(descriptor, first.unit_ref);
  if (acquired.kind !== "Acquired")
    throw new Error("Fixture unit did not fit its explicit profile");
  const firstUnit = await acquired.lease.promise;
  if (firstUnit.kind !== "Unit")
    throw new Error("Fixture unit read lacked admission");
  expect(firstUnit.unit.canonical_text).toBe("café 🧠\n");
  acquired.lease.release();
  expect(
    requests.filter((key) => key.startsWith("units/")),
    "unloaded unit was eagerly materialized",
  ).toEqual([first.unit_ref.key]);
  const navigation = await source.resolve(
    descriptor,
    { kind: "Navigation", target_id: "retained-cat" },
    signal,
  );
  expect(navigation).toMatchObject({
    kind: "Text",
    fragment_id: metadata.fragment_id,
    offset_cp: 7,
    local_offset_cp: 0,
    ordinal: 1,
  });
  const quote = await source.resolve(
    descriptor,
    {
      kind: "Locator",
      locator: {
        kind: "web",
        target: { fragment_id: metadata.fragment_id },
        locations: {
          text_offset: null,
          progression: null,
          total_progression: null,
          position: null,
        },
        text: { quote: "🧠\nca", quote_prefix: " ", quote_suffix: "t" },
      },
    },
    signal,
  );
  expect(quote).toMatchObject({
    kind: "Text",
    offset_cp: 5,
    local_offset_cp: 5,
    ordinal: 0,
  });
  const beforeOffsetResolve = requests.length;
  const offsetLocator = await source.resolve(
    descriptor,
    {
      kind: "Locator",
      locator: {
        kind: "web",
        target: { fragment_id: metadata.fragment_id },
        locations: {
          text_offset: 0,
          progression: null,
          total_progression: null,
          position: null,
        },
        text: { quote: null, quote_prefix: null, quote_suffix: null },
      },
    },
    signal,
  );
  expect(offsetLocator).toMatchObject({ kind: "Text", offset_cp: 0, ordinal: 0 });
  expect(
    requests.slice(beforeOffsetResolve).filter((key) => key.startsWith("index/")),
    "one navigation traversed the index chain more than once",
  ).toEqual(["index/0.json", "index/1.json"]);
  expect(source.find).toBeNull();
  const wrongGeneration = new OfflineReaderSource(
    metadata.manifest.mediaId,
    { ...opened, readerGeneration: opened.readerGeneration + 1 },
    "018f2e74-5efc-7d9e-8a3a-142857142857",
    READER_CAPACITY,
    new ResourceCache({}, READER_CAPACITY.cache),
    boundary,
  );
  const wrong = await wrongGeneration
    .loadDescriptor(metadata.manifest.mediaId, signal)
    .then(
      () => ({ kind: "Accepted" as const }),
      (error: unknown) => ({ kind: "Rejected" as const, error }),
    );
  expect(
    wrong.kind,
    "native selected generation accepted another publication",
  ).toBe("Rejected");
  if (wrong.kind === "Rejected")
    expect(wrong.error).toEqual(
      expect.objectContaining({
        message: "Offline reader publication identity mismatch",
      }),
    );
});

it("refuses advertised native member expansion before reading its body", async () => {
  let reads = 0;
  const boundary: typeof fetch = async () =>
    new Response(
      new ReadableStream(
        {
          pull(controller) {
            reads += 1;
            controller.enqueue(new Uint8Array([123]));
          },
        },
        { highWaterMark: 0 },
      ),
      {
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(READER_CAPACITY.descriptorBytes + 1),
        },
      },
    );
  const source = new OfflineReaderSource(
    metadata.manifest.mediaId,
    opened,
    "018f2e74-5efc-7d9e-8a3a-142857142857",
    READER_CAPACITY,
    new ResourceCache({}, READER_CAPACITY.cache),
    boundary,
  );
  await expect(
    source.loadDescriptor(
      metadata.manifest.mediaId,
      new AbortController().signal,
    ),
  ).rejects.toThrow("byte-length");
  expect(reads, "oversized native body was read before admission").toBe(0);
});

it("retains query admission until another consumer's native read settles after cancellation", async () => {
  const second = metadata.manifest.entries.find((entry) =>
    entry.path.endsWith("/7-10-0.json"),
  )!;
  let finishBody!: (response: Response) => void;
  let started!: () => void;
  const startedRead = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pendingBody = new Promise<Response>((resolve) => {
    finishBody = resolve;
  });
  const response = (key: string) => {
    const body = (wire.members as Record<string, string>)[key]!;
    return new Response(body, {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(new TextEncoder().encode(body).length),
      },
    });
  };
  const boundary: typeof fetch = async (input) => {
    const key = (input instanceof Request ? input.url : String(input)).slice(
      base.length,
    );
    if (key === second.path) {
      started();
      return pendingBody;
    }
    return response(key);
  };
  const capacity = READER_CAPACITY;
  const source = new OfflineReaderSource(
    metadata.manifest.mediaId,
    opened,
    "018f2e74-5efc-7d9e-8a3a-142857142857",
    capacity,
    new ResourceCache({}, capacity.cache),
    boundary,
  );
  const controller = new OfflineReadingControllerRuntime({
    start: () => () => undefined,
    send: () => {
      throw new Error("Native query attempted a progress write");
    },
  });
  const session = createDocumentReaderSession({
    mediaId: metadata.manifest.mediaId,
    source,
    progress: new OfflineReaderProgressPort(
      controller,
      metadata.manifest.mediaId,
      opened,
    ),
    capacity,
  });
  const signal = new AbortController().signal;
  const loaded = await session.load(signal, { fresh: null, cold: null });
  if (!("document" in loaded))
    throw new Error("Fixture load did not fit explicit profile");
  const descriptor = loaded.document.descriptor;
  if (descriptor.kind !== "web_article")
    throw new Error("Expected text fixture");
  const abort = new AbortController();
  const query = session.resolve(
    {
      kind: "Locator",
      locator: {
        kind: "web",
        target: { fragment_id: metadata.fragment_id },
        locations: {
          text_offset: null,
          progression: null,
          total_progression: null,
          position: null,
        },
        text: { quote: "cat", quote_prefix: null, quote_suffix: null },
      },
    },
    abort.signal,
  );
  const rejected = expect(query).rejects.toMatchObject({ name: "AbortError" });
  await startedRead;
  const held = source.acquireUnit(descriptor, {
    key: second.path,
    bytes: second.sizeBytes,
    sha256: second.sha256,
  });
  if (held.kind !== "Acquired")
    throw new Error("Independent view failed to retain its shared read");
  abort.abort();
  expect(
    await session.resolve(
      { kind: "Unit", unit_key: descriptor.first_unit_ref.key },
      signal,
    ),
    "cancellation returned scratch before shared read termination",
  ).toEqual({ kind: "Capacity", reason: "Payload" });
  finishBody(response(second.path));
  const lastUnit = await held.lease.promise;
  if (lastUnit.kind !== "Unit") throw new Error("Fixture unit read lacked admission");
  expect(lastUnit.unit.canonical_text).toBe("cat");
  await rejected;
  held.lease.release();
  expect(
    await session.resolve(
      { kind: "Unit", unit_key: descriptor.first_unit_ref.key },
      signal,
    ),
    "settled cancellation retained query admission",
  ).toMatchObject({ kind: "Unit", ordinal: 0 });
  session.close();
  controller.dispose();
});

it("resolves authored EPUB anchors without inventing sections or adjacent offsets", async () => {
  const source = new OfflineReaderSource(
    epubMetadata.manifest.mediaId,
    {
      ...opened,
      readerGeneration: epubMetadata.manifest.readerGeneration,
      readerRevisionKey: epubMetadata.manifest.readerRevisionKey,
    },
    "018f2e74-5efc-7d9e-8a3a-142857142857",
    READER_CAPACITY,
    new ResourceCache({}, READER_CAPACITY.cache),
    async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(base))
        throw new Error("EPUB source escaped its local lease");
      const body = (epubWire.members as Record<string, string>)[
        url.slice(base.length)
      ];
      if (body === undefined) return new Response("missing", { status: 404 });
      return new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(new TextEncoder().encode(body).length),
        },
      });
    },
  );
  const signal = new AbortController().signal;
  const descriptor = await source.loadDescriptor(
    epubMetadata.manifest.mediaId,
    signal,
  );
  expect(descriptor.kind).toBe("epub");
  if (descriptor.kind !== "epub")
    throw new Error("Expected actual EPUB publication");
  const cat = await source.resolve(
    descriptor,
    {
      kind: "EpubHref",
      pathname: "OEBPS/chapter.xhtml",
      anchor_id: "cat",
    },
    signal,
  );
  expect(
    cat,
    "native EPUB anchor lost its original source coordinate",
  ).toMatchObject({
    kind: "Text",
    offset_cp: 7,
    local_offset_cp: 7,
    locator: {
      kind: "epub",
      target: {
        // The hosted route names the authored section owning the anchor's
        // offset, never a coarser one; both surfaces persist the same target.
        section_id: "OEBPS/chapter.xhtml",
        href_path: "OEBPS/chapter.xhtml",
        anchor_id: "cat",
      },
    },
  });
  const chapter = await source.resolve(
    descriptor,
    {
      kind: "EpubHref",
      pathname: "OEBPS/chapter.xhtml",
      anchor_id: null,
    },
    signal,
  );
  expect(chapter).toMatchObject({ kind: "Text", offset_cp: 0 });
  const missing = await source.resolve(
    descriptor,
    {
      kind: "EpubHref",
      pathname: "OEBPS/chapter.xhtml",
      anchor_id: "absent",
    },
    signal,
  );
  expect(missing.kind, "missing EPUB anchor must stay unresolved").toBe(
    "Unresolved",
  );
});
