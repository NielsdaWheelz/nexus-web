import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { HostedReaderProgressRuntime } from "./hostedReaderProgress";
import { ReaderProgressHarness as Reader } from "./readerProgressTestHarness";
import type { ReaderCursorSnapshot } from "./readerProgress";
import type { ReaderResumeState } from "./types";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
afterEach(() => vi.unstubAllGlobals());

it("movement before a failed first authority read survives retry and becomes durable", async () => {
  const accountId = crypto.randomUUID();
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const port = runtime.createPort(MEDIA_ID);
  const movement: ReaderResumeState = {
    kind: "transcript", target: { fragment_id: "transcript-fragment" },
    locations: { text_offset: 11, progression: null, total_progression: null, position: null },
    text: { quote: null, quote_prefix: null, quote_suffix: null },
  };
  let releaseRead!: () => void;
  const heldRead = new Promise<void>((resolve) => { releaseRead = resolve; });
  let available = false;
  let cursor: ReaderCursorSnapshot = { state: "Empty", revision: 0 };
  const writes: { baseRevision: number; locator: ReaderResumeState }[] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (!available) {
      await heldRead;
      return new Response("gateway unavailable", { status: 502 });
    }
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { baseRevision: number; locator: ReaderResumeState };
      writes.push(body);
      cursor = { state: "Positioned", revision: 1, source: { kind: "Timeline" }, locator: body.locator };
    }
    return Response.json({ data: { accountId, readerGeneration: null, cursor } });
  });
  const view = render(<Reader port={port} movement={movement} capability={{
    state: "Readable", mediaId: MEDIA_ID, locatorKind: "transcript", source: { kind: "Timeline" },
  }} />);
  await userEvent.click(screen.getByRole("button", { name: "Move reader" }));
  releaseRead();
  await waitFor(() => expect(screen.getByLabelText("Progress authority")).toHaveTextContent("load_failed"), { timeout: 3_000 });
  available = true;
  await userEvent.click(screen.getByRole("button", { name: "Retry authority" }));
  await waitFor(() => expect(screen.getByLabelText("Progress authority")).toHaveTextContent("ready"));
  await port.flush(MEDIA_ID);
  expect(writes, "retry lost movement captured before the first baseline").toMatchObject([
    { baseRevision: 0, locator: movement },
  ]);
  view.unmount();
  runtime.close();
});
