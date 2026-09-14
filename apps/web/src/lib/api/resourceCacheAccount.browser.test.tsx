import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useContext, useState } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { ResourceCacheContext, ResourceCacheProvider, type ResourceCache } from "./resourceCache";
import { useResource } from "./useResource";
import { READER_CAPACITY } from "@/lib/reader/readerCapacity";
import { dispatchReaderPulse, readPendingReaderPulse, retainPendingReaderPulse, type ReaderPulseInput } from "@/lib/reader/pulseEvent";

const mediaId = "11111111-1111-4111-8111-111111111111";
const input: ReaderPulseInput = { mediaId, locator: { type: "web_text_offsets", media_id: mediaId,
  fragment_id: "22222222-2222-4222-8222-222222222222", start_offset: 0, end_offset: 8,
  text_quote_selector: { exact: "original", prefix: "", suffix: "" } },
  snippet: null, highlightBehavior: "pulse", focusBehavior: "scroll_into_view" };
const observed: { cache: ResourceCache | null } = { cache: null };

function Seed({ name }: { name: string }) {
  const resource = useResource<{ data: string }>({ cacheKey: name, path: (key) => `/api/${key}` });
  return <output aria-label={name}>{resource.status === "ready" ? resource.data.data : resource.status}</output>;
}
function AccountContent() {
  observed.cache = useContext(ResourceCacheContext);
  const [delayed, setDelayed] = useState(false);
  return <><Seed name="shared" /><button type="button" onClick={() => setDelayed(true)}>Open delayed reader</button>
    {delayed && <Seed name="delayed" />}</>;
}
function Account({ id }: { id: string }) {
  return <ResourceCacheProvider key={id} value={{ shared: { data: `${id} seeded source` }, delayed: { data: `${id} delayed seed` } }}
    publicationLimits={READER_CAPACITY.cache}><AccountContent /></ResourceCacheProvider>;
}

afterEach(() => { observed.cache = null; vi.unstubAllGlobals(); });

it("keeps account seeds correct through strict replay and a delayed same-key reader", async () => {
  let account = "A";
  vi.stubGlobal("fetch", async (request: RequestInfo | URL) => {
    const path = new URL(String(request), window.location.origin).pathname;
    return new Response(JSON.stringify({ data: `${account} live ${path.slice(5)}` }), { headers: { "Content-Type": "application/json" } });
  });
  expect(renderToString(<StrictMode><Account id="A" /></StrictMode>), "server first paint lost its addressed source seed").toContain("A seeded source");
  const view = render(<Account id="A" />, { reactStrictMode: true });
  // Strict replay revalidates the first consumer and drops an unclaimed late
  // seed. Both fetch the actual account origin; neither borrows another account.
  await waitFor(() => expect(screen.getByLabelText("shared")).toHaveTextContent("A live shared"));
  fireEvent.click(screen.getByRole("button", { name: "Open delayed reader" }));
  await waitFor(() => expect(screen.getByLabelText("delayed")).toHaveTextContent("A live delayed"));
  const oldCache = observed.cache;
  account = "B";
  view.rerender(<Account id="B" />);
  expect(observed.cache, "account replacement reused its predecessor's resource cache").not.toBe(oldCache);
  await waitFor(() => expect(screen.getByLabelText("shared")).toHaveTextContent("B live shared"));
  fireEvent.click(screen.getByRole("button", { name: "Open delayed reader" }));
  await waitFor(() => expect(screen.getByLabelText("delayed")).toHaveTextContent("B live delayed"));
});

it("withdraws the old account's pending source before a replacement can receive it", async () => {
  const held: { finish: (() => void) | null } = { finish: null };
  vi.stubGlobal("fetch", async (request: RequestInfo | URL) => {
    const path = new URL(String(request), window.location.origin).pathname;
    if (path === "/held-account-source") return new Promise<Response>((resolve) => { held.finish = () => resolve(new Response("settled")); });
    return new Response(JSON.stringify({ data: "live source" }), { headers: { "Content-Type": "application/json" } });
  });
  const view = render(<Account id="A" />, { reactStrictMode: true });
  await waitFor(() => expect(screen.getByLabelText("shared")).toHaveTextContent("live source"));
  const cache = observed.cache;
  if (cache === null) throw new Error("Actual account cache was not mounted");
  const admitted = cache.retainReaderSourceInput(input);
  if (admitted.kind !== "Acquired") throw new Error("Source fixture exhausted account admission");
  const target = { ...input, paneId: "old-account-pane" };
  dispatchReaderPulse(target, admitted.lease);
  const controller = new AbortController();
  const read = fetch("/held-account-source", { signal: controller.signal }).then((response) => response.text()).then(() => {});
  expect(retainPendingReaderPulse(target, () => { controller.abort(); return read; })).toBe(true);
  try {
    view.rerender(<Account id="B" />);
    expect(readPendingReaderPulse(target.paneId, mediaId), "retired account kept an undelivered source quote").toBeNull();
    expect(controller.signal.aborted).toBe(true);
    const replacement = observed.cache;
    if (replacement === null || replacement === cache) throw new Error("Replacement account did not acquire its own cache");
    const next = replacement.retainReaderSourceInput(input);
    if (next.kind !== "Acquired") throw new Error("Replacement source was refused");
    dispatchReaderPulse({ ...input, paneId: "new-account-pane" }, next.lease);
    if (held.finish === null) throw new Error("Old source read was not held");
    held.finish();
    await act(async () => { await read; });
    expect(readPendingReaderPulse("new-account-pane", mediaId)?.locator, "old retirement removed replacement-account input").toEqual(input.locator);
    view.unmount();
    expect(readPendingReaderPulse("new-account-pane", mediaId)).toBeNull();
  } finally { held.finish?.(); await read; view.unmount(); cache.clear(); }
});
