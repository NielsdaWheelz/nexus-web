import { useEffect, useMemo, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { ResourceCache } from "@/lib/api/resourceCache";
import { useResource } from "@/lib/api/useResource";
import { createDocumentReaderSession, type ReaderSessionLoad } from "./DocumentReaderSession";
import { createHostedReaderSource } from "./ReaderDocumentSource";
import { HostedReaderProgressRuntime } from "./hostedReaderProgress";
import { READER_CAPACITY, type ReaderCapacity } from "./readerCapacity";
import { useDocumentReaderWindow, type ReaderNavigationCompletion } from "./useDocumentReaderWindow";

const TEXTS = ["first", "later", "third", "forth"] as const;

function json(value: unknown): Response {
  const body = new TextEncoder().encode(JSON.stringify(value));
  return new Response(body, { headers: { "Content-Type": "application/json", "Content-Length": String(body.byteLength) } });
}
function representation({ bytes, hash }: { bytes: Uint8Array<ArrayBuffer>; hash: Uint8Array<ArrayBuffer> }): Response {
  return new Response(bytes, { headers: {
    "Content-Type": "application/json", "Content-Length": String(bytes.byteLength),
    "Content-Digest": `sha-256=:${btoa(String.fromCharCode(...hash))}:`, "X-Nexus-Reader-Generation": "2",
  } });
}
async function digested(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return { bytes, hash: new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)) };
}

/** Four addressed units of one hosted publication, each five code points long. */
async function hostedPublication(mediaId: string) {
  const members = await Promise.all(TEXTS.map(async (text, ordinal) => {
    const member = await digested({
      fragment_id: mediaId, fragment_idx: 0, fragment_document_start_cp: 0, fragment_length_cp: TEXTS.length * 5,
      document_word_start: ordinal, starts_in_word: false, epub_target: null, document_embeds: [],
      start_cp: ordinal * 5, end_cp: ordinal * 5 + 5, render_start_cp: ordinal * 5, render_end_cp: ordinal * 5 + 5,
      canonical_text: text, word_boundaries: [ordinal * 5, ordinal * 5 + 5], assets: [], table_contexts: [],
      render_nodes: [{ kind: "Element", parent: null, namespace: "html", name: "p", attributes: [] }, { kind: "Text", parent: 0, text }],
    });
    return { ...member, ref: { key: `units/${ordinal}.json`, bytes: member.bytes.byteLength,
      sha256: Array.from(member.hash, (byte) => byte.toString(16).padStart(2, "0")).join("") } };
  }));
  const descriptor = await digested({ media_id: mediaId, reader_generation: 2, reader_contract_version: 1,
    kind: "web_article", title: "Reader", canonical_length: TEXTS.length * 5, unit_count: TEXTS.length,
    first_unit_ref: members[0]!.ref, contents_ref: null, table_metadata_ref: null,
    index_ref: { key: "index/0.json", bytes: 1, sha256: "a".repeat(64) } });
  return { members, descriptor };
}

/** Installs the publication transport; unit reads in `held` stay pending until released. */
function stubHostedReader({ mediaId, accountId, members, descriptor, held }: {
  mediaId: string; accountId: string; held: readonly number[];
} & Awaited<ReturnType<typeof hostedPublication>>) {
  const pending = new Map<number, () => void>();
  let resolveReads = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/reader-publication")) return representation(descriptor);
    if (path.endsWith("/offline-reader-state")) return json({ data: { accountId, readerGeneration: 2, cursor: { state: "Empty", revision: 0 } } });
    if (path.endsWith("/resolve")) {
      resolveReads += 1;
      const key: unknown = JSON.parse(String(init?.body)).target.unit_key;
      const ordinal = members.findIndex((member) => member.ref.key === key);
      if (ordinal < 0) throw new Error(`Unexpected resolve target: ${String(key)}`);
      return json({ data: { kind: "Unit", unit_ref: members[ordinal]!.ref, ordinal,
        previous_ref: ordinal === 0 ? null : members[ordinal - 1]!.ref,
        next_ref: ordinal === members.length - 1 ? null : members[ordinal + 1]!.ref,
        fragment_id: mediaId, start_cp: ordinal * 5, end_cp: ordinal * 5 + 5 } });
    }
    const member = path.match(/\/units\/(\d+)\.json$/);
    if (member !== null) {
      const ordinal = Number(member[1]);
      const unit = members[ordinal];
      if (unit === undefined) throw new Error(`Unexpected unit member: ${path}`);
      if (!held.includes(ordinal)) return representation(unit);
      return new Promise<Response>((resolve) => pending.set(ordinal, () => resolve(representation(unit))));
    }
    throw new Error(`Unexpected external request: ${path}`);
  });
  return {
    isPending: (ordinal: number) => pending.has(ordinal),
    reads: () => resolveReads,
    release(ordinal: number) { pending.get(ordinal)?.(); pending.delete(ordinal); },
    releaseAll() { for (const finish of pending.values()) finish(); pending.clear(); },
  };
}

function Reader({ mediaId, accountId, capacity, runtime }: {
  mediaId: string; accountId: string; capacity: ReaderCapacity; runtime: HostedReaderProgressRuntime;
}) {
  const session = useMemo(() => createDocumentReaderSession({ mediaId, capacity,
    source: createHostedReaderSource({ accountId, cache: new ResourceCache({}, capacity.cache), capacity }),
    progress: runtime.createPort(mediaId),
  }), [mediaId, accountId, capacity, runtime]);
  const initial = useResource<ReaderSessionLoad>({ cacheKey: mediaId, load: (signal) => session.load(signal, { fresh: null, cold: null }) });
  // The production body refuses a retirement that would detach a pinned root.
  const reader = useDocumentReaderWindow({ session, initial, retryInitial: () => {},
    retireUnits: (units) => !units.some((item) => item.lease.pinned) });
  const [completion, setCompletion] = useState<Record<string, string>>({});
  useEffect(() => () => session.close(), [session]);
  const record = (name: string) => (result: ReaderNavigationCompletion | null) => setCompletion((old) => ({
    ...old, [name]: result === null ? "None" : result.kind === "Capacity" ? `Capacity:${result.reason}` : result.kind,
  }));
  return <>
    {reader.units.map((item) => <p key={item.address.unit_ref.key}>{item.unit.canonical_text}</p>)}
    <output aria-label="Capacity">{reader.capacity === null ? "none" : reader.capacity.reason}</output>
    <output aria-label="Navigation completion">{completion.navigate ?? "Waiting"}</output>
    <output aria-label="Neighbour completion">{completion.neighbour ?? "Waiting"}</output>
    {TEXTS.map((_, ordinal) => <button key={ordinal}
      onClick={() => { void reader.navigate({ kind: "Unit", unit_key: `units/${ordinal}.json` }).then(record("navigate")); }}>
      Navigate {ordinal}
    </button>)}
    <button onClick={() => { void reader.loadNeighbor("Next").then(record("neighbour")); }}>Load next</button>
    <button onClick={() => { reader.units[0]?.lease.pin("Selection", true); }}>Pin first</button>
    <button onClick={() => {
      // The viewport maintainer activates the surviving unit before retiring.
      const [retiring, surviving] = reader.units;
      if (retiring === undefined || surviving === undefined) return;
      reader.setActiveUnit(surviving.lease);
      reader.releaseUnit(retiring.lease);
    }}>Retire first</button>
  </>;
}

async function mounted(capacity: ReaderCapacity, held: readonly number[]) {
  const mediaId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const transport = stubHostedReader({ mediaId, accountId, held, ...(await hostedPublication(mediaId)) });
  const view = render(<Reader mediaId={mediaId} accountId={accountId} capacity={capacity} runtime={runtime} />);
  return { transport, close() { transport.releaseAll(); view.unmount(); runtime.close(); } };
}

afterEach(() => vi.unstubAllGlobals());

it("settles the superseded navigation without allowing its late unit to complete the new preview", async () => {
  const reader = await mounted(READER_CAPACITY, [1]);
  try {
    await screen.findByText("first");
    await userEvent.click(screen.getByRole("button", { name: "Navigate 1" }));
    await waitFor(() => expect(reader.transport.isPending(1)).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Navigate 0" }));
    await waitFor(() => expect(screen.getByLabelText("Navigation completion"), "superseded navigation never settled").toHaveTextContent("Ready"));
    reader.transport.release(1);
    await screen.findByText("first");
    expect(screen.queryByText("later")).not.toBeInTheDocument();
  } finally { reader.close(); }
});

it("keeps the previous unit readable until the replacement has been admitted", async () => {
  const reader = await mounted(READER_CAPACITY, [1]);
  try {
    await screen.findByText("first");
    await userEvent.click(screen.getByRole("button", { name: "Navigate 1" }));
    await waitFor(() => expect(reader.transport.isPending(1)).toBe(true));
    expect(screen.getByText("first"), "navigation retired the readable window before its replacement arrived").toBeVisible();
    reader.transport.release(1);
    expect(await screen.findByText("later")).toBeVisible();
    await waitFor(() => expect(screen.queryByText("first")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Navigation completion")).toHaveTextContent("Ready");
    expect(screen.getByLabelText("Capacity")).toHaveTextContent("none");
  } finally { reader.close(); }
});

it("admits a navigation beside a pinned unit instead of refusing it for pins", async () => {
  const reader = await mounted(READER_CAPACITY, []);
  try {
    await screen.findByText("first");
    await userEvent.click(screen.getByRole("button", { name: "Pin first" }));
    await userEvent.click(screen.getByRole("button", { name: "Navigate 1" }));
    expect(await screen.findByText("later")).toBeVisible();
    expect(screen.getByText("first"), "a pinned selection lost its unit to the replacement").toBeVisible();
    expect(screen.getByLabelText("Navigation completion")).toHaveTextContent("Ready");
    expect(screen.getByLabelText("Capacity")).toHaveTextContent("none");
  } finally { reader.close(); }
});

it("keeps a refused speculation out of the window's capacity state and resumes once the window moves", async () => {
  const capacity: ReaderCapacity = { ...READER_CAPACITY, view: { ...READER_CAPACITY.view, maxUnits: 2 } };
  const reader = await mounted(capacity, []);
  try {
    await screen.findByText("first");
    await userEvent.click(screen.getByRole("button", { name: "Load next" }));
    expect(await screen.findByText("later")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Load next" }));
    await waitFor(() => expect(screen.getByLabelText("Neighbour completion")).toHaveTextContent("Capacity:Leases"));
    expect(screen.getByLabelText("Capacity"), "a speculative shortage latched into the reader's chrome").toHaveTextContent("none");
    expect(screen.queryByText("third")).not.toBeInTheDocument();
    const refusedReads = reader.transport.reads();
    await userEvent.click(screen.getByRole("button", { name: "Load next" }));
    await waitFor(() => expect(screen.getByLabelText("Neighbour completion")).toHaveTextContent("Capacity:Leases"));
    expect(reader.transport.reads(), "a standing refusal re-issued its speculation without a new window").toBe(refusedReads);
    await userEvent.click(screen.getByRole("button", { name: "Retire first" }));
    await waitFor(() => expect(screen.queryByText("first")).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Load next" }));
    expect(await screen.findByText("third")).toBeVisible();
    expect(screen.getByLabelText("Capacity")).toHaveTextContent("none");
  } finally { reader.close(); }
});

it("refuses speculation while an explicit navigation is still pending", async () => {
  const reader = await mounted(READER_CAPACITY, [2]);
  try {
    await screen.findByText("first");
    await userEvent.click(screen.getByRole("button", { name: "Navigate 2" }));
    await waitFor(() => expect(reader.transport.isPending(2)).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Load next" }));
    await waitFor(() => expect(screen.getByLabelText("Neighbour completion")).toHaveTextContent("None"));
    reader.transport.release(2);
    await waitFor(() => expect(screen.getByLabelText("Navigation completion"),
      "speculation superseded the reader's own navigation").toHaveTextContent("Ready"));
    expect(await screen.findByText("third")).toBeVisible();
  } finally { reader.close(); }
});
