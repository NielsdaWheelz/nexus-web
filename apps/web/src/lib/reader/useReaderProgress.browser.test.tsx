import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { HostedReaderProgressRuntime } from "./hostedReaderProgress";
import { ReaderProgressHarness as Reader } from "./readerProgressTestHarness";
import type { ReaderCursorSnapshot } from "./readerProgress";
import type { ReaderResumeState } from "./types";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const source = { kind: "Publication", reader_generation: 2 } as const;
const page = (number: number): ReaderResumeState => ({
  kind: "pdf", page: number, page_progression: null, zoom: null, position: null,
});
afterEach(() => vi.unstubAllGlobals());


it("closing unknown-source content cannot replace its preserved locator", async () => {
  const accountId = crypto.randomUUID();
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const port = runtime.createPort(MEDIA_ID);
  let cursor: ReaderCursorSnapshot = {
    state: "Positioned", revision: 9, source: { kind: "Unresolved" }, locator: page(7),
  };
  const writes: { baseRevision: number; locator: ReaderResumeState }[] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { baseRevision: number; locator: ReaderResumeState };
      writes.push(body);
      cursor = { state: "Positioned", revision: 10, source, locator: body.locator };
    }
    return Response.json({ data: { accountId, readerGeneration: 2, cursor } });
  });
  const view = render(<Reader port={port} movement={page(3)} capability={{
    state: "Readable", mediaId: MEDIA_ID, locatorKind: "pdf", source,
  }} />);
  await waitFor(() => expect(screen.getByLabelText("Source status")).toHaveTextContent("ContentChanged"));
  window.dispatchEvent(new Event("pagehide"));
  await port.flush(MEDIA_ID);
  expect(writes, "closing the view invented a selected-source position").toHaveLength(0);
  expect(cursor).toMatchObject({ revision: 9, source: { kind: "Unresolved" }, locator: page(7) });
  await userEvent.click(screen.getByRole("button", { name: "Move reader" }));
  await port.flush(MEDIA_ID);
  expect(writes).toMatchObject([{ baseRevision: 9, locator: page(3) }]);
  view.unmount();
  runtime.close();
});



it("a malformed revalidation is published as a defect while the reader remains mounted", async () => {
  const accountId = crypto.randomUUID();
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const port = runtime.createPort(MEDIA_ID);
  let malformed = false;
  vi.stubGlobal("fetch", async () => Response.json({ data: {
    accountId, readerGeneration: 2, cursor: malformed ? { state: "Empty" } : { state: "Empty", revision: 0 },
  } }));
  const view = render(<Reader port={port} movement={page(3)} capability={{
    state: "Readable", mediaId: MEDIA_ID, locatorKind: "pdf", source,
  }} />);
  await waitFor(() => expect(screen.getByLabelText("Progress authority")).toHaveTextContent("ready"));
  malformed = true;
  window.dispatchEvent(new Event("online"));
  await waitFor(() => expect(screen.getByLabelText("Progress defect")).toHaveTextContent("invalid response"));
  expect(screen.getByLabelText("Progress authority")).toHaveTextContent("ready");
  view.unmount();
  runtime.close();
});
