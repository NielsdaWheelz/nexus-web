import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { expect, it, vi } from "vitest";
import ReaderContentsPage from "@/components/reader/ReaderContentsPage";
import { ResourceCache } from "@/lib/api/resourceCache";
import { useResource } from "@/lib/api/useResource";
import { createDocumentReaderSession, type ReaderSessionLoad } from "./DocumentReaderSession";
import { createHostedReaderSource } from "./ReaderDocumentSource";
import { HostedReaderProgressRuntime } from "./hostedReaderProgress";
import { READER_CAPACITY } from "./readerCapacity";
import { useReaderContents, type ReaderContents } from "./useReaderContents";

it("owns one contents page, walks its trail both ways, and rejects a withdrawn page's late completion", async () => {
  const mediaId = "11111111-1111-4111-8111-111111111111";
  const accountId = crypto.randomUUID();
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const member = async (key: string, value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return { bytes, hash, ref: { key, bytes: bytes.byteLength,
      sha256: Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("") } };
  };
  const toc = (id: string, label: string, depth: number) => ({
    id, parent_id: depth === 0 ? null : "part", section_id: id, label, depth, level: depth,
    ordinal: depth, href: `Text/chapter.xhtml#${id}`, fragment_idx: 0,
  });
  const index = { units: [], sections: [], landmarks: [], page_list: [], table_metadata: [], anchors: [] };
  const later = await member("index/contents-1.json", { ...index, toc: [toc("last", "Last chapter", 0)], next_ref: null });
  const first = await member("index/contents-0.json", { ...index,
    toc: [toc("part", "First part", 0), toc("chapter", "First chapter", 1)], next_ref: later.ref });
  const descriptor = await member("descriptor.json", { media_id: mediaId, reader_generation: 2,
    reader_contract_version: 1, kind: "epub", title: "Reader", canonical_length: 10, unit_count: 1,
    first_unit_ref: { key: "units/0.json", bytes: 1, sha256: "a".repeat(64) },
    contents_ref: first.ref, table_metadata_ref: null, index_ref: { key: "index/0.json", bytes: 1, sha256: "a".repeat(64) },
  });
  const representation = ({ bytes, hash }: typeof descriptor) => new Response(bytes, { headers: {
    "Content-Type": "application/json", "Content-Length": String(bytes.byteLength),
    "Content-Digest": `sha-256=:${btoa(String.fromCharCode(...hash))}:`, "X-Nexus-Reader-Generation": "2",
  } });
  const heldResponse: { finish: ((response: Response) => void) | null } = { finish: null };
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = String(input); paths.push(path);
    const indexKey = new URL(path, "https://reader.test").searchParams.get("after");
    if (path.endsWith("/reader-publication")) return representation(descriptor);
    if (path.endsWith("/offline-reader-state")) return Response.json({ data: { accountId, readerGeneration: 2, cursor: { state: "Empty", revision: 0 } } });
    if (indexKey === first.ref.key) return representation(first);
    if (indexKey === later.ref.key) return new Promise<Response>((resolve) => { heldResponse.finish = resolve; });
    throw new Error(`Contents fetched unrelated source: ${path}`);
  });
  const session = createDocumentReaderSession({ mediaId,
    capacity: { ...READER_CAPACITY, view: { ...READER_CAPACITY.view, maxDomNodes: 24 } },
    source: createHostedReaderSource({ accountId, cache: new ResourceCache({}, READER_CAPACITY.cache), capacity: READER_CAPACITY }),
    progress: runtime.createPort(mediaId),
  });
  const baseline = session.residency;
  function Reader() {
    const [frozen, setFrozen] = useState<ReaderContents | null>(null);
    const [retired, setRetired] = useState(false);
    const initial = useResource<ReaderSessionLoad>({ cacheKey: mediaId, load: (signal) => session.load(signal, { fresh: null, cold: null }) });
    const contents = useReaderContents({ session, first: first.ref, enabled: initial.status === "ready" && frozen === null });
    const [selected, setSelected] = useState<string | null>(null);
    return <>{retired ? null : <ReaderContentsPage contents={frozen ?? contents} activeSectionId={selected} onNavigate={setSelected} />}
      <button onClick={() => setFrozen(contents)}>Withdraw contents query</button>
      <button onClick={() => setRetired(true)}>Retire contents presentation</button>
      <output aria-label="Selected section">{selected}</output></>;
  }
  const view = render(<Reader />);
  try {
    await screen.findByRole("button", { name: "First chapter" });
    expect(paths.some((path) => new URL(path, "https://reader.test").searchParams.get("after") === later.ref.key)).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "First chapter" }));
    expect(screen.getByLabelText("Selected section")).toHaveTextContent("chapter");
    expect(screen.getByRole("button", { name: "First chapter" }), "contents selection replaced its focused control").toHaveFocus();
    expect(screen.getByRole("button", { name: "First chapter" })).toHaveAttribute("aria-current", "location");
    expect(screen.getAllByRole("listitem")[1]).toHaveAttribute("aria-level", "2");
    await userEvent.click(screen.getByRole("button", { name: "More contents" }));
    await waitFor(() => expect(heldResponse.finish).not.toBeNull());
    expect(screen.queryByRole("button", { name: "First chapter" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "First contents page" }));
    await waitFor(() => {
      const restored = screen.queryByRole("button", { name: "First chapter" });
      expect(restored, "withdrawn contents page retained its DOM admission").not.toBeNull();
      expect(restored).toBeVisible();
    });
    heldResponse.finish!(representation(later));
    heldResponse.finish = null;
    await waitFor(() => expect(screen.getByRole("button", { name: "First chapter" })).toBeVisible());
    expect(screen.queryByRole("button", { name: "Last chapter" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry contents" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Previous contents page" }),
      "the first contents page offered a page behind it").not.toBeInTheDocument();
    // Index pages are forward-linked, so backward traversal is the retained trail.
    await userEvent.click(screen.getByRole("button", { name: "More contents" }));
    await waitFor(() => expect(heldResponse.finish).not.toBeNull());
    heldResponse.finish!(representation(later));
    heldResponse.finish = null;
    await screen.findByRole("button", { name: "Last chapter" });
    await userEvent.click(screen.getByRole("button", { name: "Previous contents page" }));
    await screen.findByRole("button", { name: "First chapter" });
    expect(screen.queryByRole("button", { name: "Last chapter" }),
      "the retired contents page stayed displayed beside the page that replaced it").not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Previous contents page" }),
      "the trail kept a page the reader had already stepped back over").not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "First contents page" })).not.toBeInTheDocument();
    const shown = session.residency;
    expect(shown.domNodes).toBe(24);
    expect(shown.payloadBytes).toBeGreaterThan(baseline.payloadBytes);
    await userEvent.click(screen.getByRole("button", { name: "Withdraw contents query" }));
    expect(screen.getByRole("button", { name: "First chapter" })).toBeVisible();
    expect(session.residency, "withdrawn contents query released its still-displayed page").toEqual(shown);
    await userEvent.click(screen.getByRole("button", { name: "Retire contents presentation" }));
    expect(screen.queryByRole("button", { name: "First chapter" })).not.toBeInTheDocument();
    expect(session.residency).toEqual(baseline);
  } finally {
    heldResponse.finish?.(representation(later)); view.unmount(); session.close(); runtime.close(); vi.unstubAllGlobals();
  }
});
