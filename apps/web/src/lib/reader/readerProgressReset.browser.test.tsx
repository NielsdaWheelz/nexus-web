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

it("a committed reset advances the writer baseline before subsequent movement", async () => {
  const accountId = crypto.randomUUID();
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const port = runtime.createPort(MEDIA_ID);
  let cursor: ReaderCursorSnapshot = { state: "Positioned", revision: 2, source, locator: page(7) };
  const reset = { state: "Empty", revision: 3 } as const;
  const writes: { baseRevision: number; locator: ReaderResumeState }[] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { baseRevision: number; locator: ReaderResumeState };
      writes.push(body);
      cursor = { state: "Positioned", revision: 4, source, locator: body.locator };
    }
    return Response.json({ data: { accountId, readerGeneration: 2, cursor } });
  });
  const view = render(<Reader port={port} movement={page(3)} reset={reset} commitReset={() => { cursor = reset; }} capability={{
    state: "Readable", mediaId: MEDIA_ID, locatorKind: "pdf", source,
  }} />);
  await waitFor(() => expect(screen.getByLabelText("Progress authority")).toHaveTextContent("ready"));
  await userEvent.click(screen.getByRole("button", { name: "Install committed reset" }));
  await waitFor(() => expect(screen.getByLabelText("Reset installed")).toHaveTextContent("true"));
  await userEvent.click(screen.getByRole("button", { name: "Move reader" }));
  await port.flush(MEDIA_ID);
  expect(writes, "reset reused a pre-reset baseline").toMatchObject([{ baseRevision: 3, locator: page(3) }]);
  view.unmount();
  runtime.close();
});
