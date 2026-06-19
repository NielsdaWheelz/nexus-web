/**
 * AddPanel — focused component tests (real Chromium, real providers, fetch boundary
 * stubbed). Recovers the high-value behavior that lived in the deleted
 * `__tests__/components/AddContentTray.test.tsx` (606 lines) after the universal-launcher
 * cutover re-homed the tray's URL-add / multi-file-upload queue / OPML internals into
 * `AddPanel.tsx`. These mount the panel directly with stub `onOpen`/`onClose`/`onBack`
 * callbacks (its new contract) and assert the user-visible queue states + the AC-9
 * `onOpen({ kind: "href", … })` dispatch contract.
 *
 * Obsolete tray-only cases (OPEN_ADD_CONTENT_EVENT open/close, window-paste capture,
 * mobile-sheet popstate dismissal) belong to the Launcher surface and are covered by
 * `Launcher.test.tsx`; they are intentionally dropped here.
 *
 * No vi.mock of internal modules: every seam (`/api/media/from-url`,
 * `/api/media/upload/init` + `/api/media/{id}/ingest`, `/api/libraries/writable-destinations`,
 * the held upload PUT, `/api/podcasts/import/opml`) is stubbed at the fetch boundary.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import AddPanel from "./AddPanel";
import type { AddSeed, LauncherActionTarget } from "@/lib/launcher/model";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFile(name: string, type: string) {
  return new File(["file contents"], name, { type });
}

// The URL <textarea> is controlled; setting its value via change mirrors a paste/type.
function typeUrls(value: string) {
  fireEvent.change(screen.getByLabelText("URLs"), { target: { value } });
}

function submitUrls(value: string) {
  typeUrls(value);
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
}

function renderAddPanel(
  seed: AddSeed = { mode: "url" },
): {
  onOpen: ReturnType<typeof vi.fn<(target: LauncherActionTarget) => void>>;
  onClose: ReturnType<typeof vi.fn<() => void>>;
  onBack: ReturnType<typeof vi.fn<() => void>>;
} {
  const onOpen = vi.fn<(target: LauncherActionTarget) => void>();
  const onClose = vi.fn<() => void>();
  const onBack = vi.fn<() => void>();
  render(
    withRenderEnvironment(
      <FeedbackProvider>
        <AddPanel seed={seed} onOpen={onOpen} onClose={onClose} onBack={onBack} />
      </FeedbackProvider>,
    ),
  );
  return { onOpen, onClose, onBack };
}

// Default fetch stub: empty writable-libraries list + a per-URL accepted from-url response.
function stubDefaultApi() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/libraries/writable-destinations") {
      return jsonResponse({ data: [], page: { next_cursor: null } });
    }
    if (url.pathname === "/api/media/from-url" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { url: string };
      const isOne = body.url.includes("one");
      return jsonResponse({
        data: {
          media_id: isOne ? "media-one" : "media-two",
          source_attempt_id: isOne ? "attempt-one" : "attempt-two",
          source_type: isOne ? "remote_pdf_url" : "remote_epub_url",
          source_attempt_status: "queued",
          idempotency_outcome: "created",
          processing_status: "pending",
          ingest_enqueued: true,
        },
      });
    }
    throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
  });
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("innerWidth", 1280);
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// URL add → queue rows reach "Added"
// ---------------------------------------------------------------------------

describe("AddPanel — URL add queue", () => {
  it("enqueues a row that reaches 'Added' on a successful URL add", async () => {
    stubDefaultApi();
    renderAddPanel();

    submitUrls("https://example.com/one.pdf");

    const queue = await screen.findByLabelText("Ingestion queue");
    expect(within(queue).getByText("https://example.com/one.pdf")).toBeInTheDocument();
    await waitFor(() => {
      expect(within(queue).getByLabelText("Success")).toBeInTheDocument();
    });
    expect(within(queue).getByText("Added")).toBeInTheDocument();
  });

  it("enqueues one row per URL when multiple URLs are submitted", async () => {
    stubDefaultApi();
    renderAddPanel();

    submitUrls("https://example.com/one.pdf\nhttps://example.com/two.epub");

    const queue = await screen.findByLabelText("Ingestion queue");
    expect(within(queue).getByText("https://example.com/one.pdf")).toBeInTheDocument();
    expect(within(queue).getByText("https://example.com/two.epub")).toBeInTheDocument();
    await waitFor(() => {
      expect(within(queue).getAllByLabelText("Success")).toHaveLength(2);
    });
  });

  it("shows a validation error and does not enqueue when the field has no URL", async () => {
    stubDefaultApi();
    renderAddPanel();

    submitUrls("not a url");

    expect(
      await screen.findByText("Paste one or more http:// or https:// URLs."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Ingestion queue")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AC-9 dispatch routing: a single successful add (autoOpen) → onOpen(href) then onClose
// ---------------------------------------------------------------------------

describe("AddPanel — single-add dispatch (AC-9)", () => {
  it("calls onOpen with the media href then onClose after one successful submitted URL", async () => {
    stubDefaultApi();
    const { onOpen, onClose } = renderAddPanel();

    submitUrls("https://example.com/one.pdf");

    await waitFor(() => {
      expect(onOpen).toHaveBeenCalledWith({
        kind: "href",
        href: "/media/media-one",
        externalShell: false,
      });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT auto-open when multiple URLs are submitted at once", async () => {
    stubDefaultApi();
    const { onOpen, onClose } = renderAddPanel();

    submitUrls("https://example.com/one.pdf\nhttps://example.com/two.epub");

    const queue = await screen.findByLabelText("Ingestion queue");
    await waitFor(() => {
      expect(within(queue).getAllByLabelText("Success")).toHaveLength(2);
    });
    // A batch add never dispatches/closes; the user picks Open per-row.
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Per-row "Open" button
// ---------------------------------------------------------------------------

describe("AddPanel — per-row Open", () => {
  it("the queue row's Open button calls onOpen with the media href and leaves other rows queued", async () => {
    // Two URLs both add; their Open buttons should each carry their own href and
    // selecting one must not abandon the rest of the queue.
    stubDefaultApi();
    const { onOpen, onClose } = renderAddPanel();

    submitUrls("https://example.com/one.pdf\nhttps://example.com/two.epub");

    const queue = await screen.findByLabelText("Ingestion queue");
    await waitFor(() => {
      expect(within(queue).getAllByLabelText("Success")).toHaveLength(2);
    });

    const openButtons = within(queue).getAllByRole("button", { name: "Open" });
    expect(openButtons).toHaveLength(2);
    fireEvent.click(openButtons[0]);

    expect(onOpen).toHaveBeenCalledWith({
      kind: "href",
      href: "/media/media-one",
      externalShell: false,
    });
    // Per-row Open is not the autoOpen path, so it must not dismiss the launcher,
    // and the second row's contents stay present.
    expect(onClose).not.toHaveBeenCalled();
    expect(within(queue).getByText("https://example.com/two.epub")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Provider failures
// ---------------------------------------------------------------------------

describe("AddPanel — failures", () => {
  it("surfaces the provider error title and the backend request id on a rejected URL add", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/libraries/writable-destinations") {
        return jsonResponse({ data: [], page: { next_cursor: null } });
      }
      if (url.pathname === "/api/media/from-url" && init?.method === "POST") {
        return jsonResponse(
          {
            error: {
              code: "E_X_PROVIDER_CREDITS_DEPLETED",
              message: "X imports are temporarily unavailable.",
              request_id: "req-x-2",
            },
          },
          503,
        );
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });
    renderAddPanel();

    submitUrls("https://x.com/ada/status/1234567890");

    expect(await screen.findByText("X imports are temporarily unavailable")).toBeInTheDocument();
    expect(screen.getByText("Nexus request ID: req-x-2")).toBeInTheDocument();
    // A hard provider failure is retryable.
    expect(
      screen.getByRole("button", { name: "Retry https://x.com/ada/status/1234567890" }),
    ).toBeInTheDocument();
  });

  it("keeps an accepted-but-failed source as 'Saved, but ingestion failed' with Open and no Retry", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/libraries/writable-destinations") {
        return jsonResponse({ data: [], page: { next_cursor: null } });
      }
      if (url.pathname === "/api/media/from-url" && init?.method === "POST") {
        return jsonResponse({
          data: {
            media_id: "media-failed",
            source_attempt_id: "attempt-failed",
            source_type: "x_author_thread",
            source_attempt_status: "failed",
            idempotency_outcome: "created",
            processing_status: "failed",
            ingest_enqueued: false,
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });
    renderAddPanel();

    submitUrls("https://x.com/ada/status/1234567890");

    expect(await screen.findByText("Saved, but ingestion failed")).toBeInTheDocument();
    const queue = screen.getByLabelText("Ingestion queue");
    expect(within(queue).getByRole("button", { name: "Open" })).toBeInTheDocument();
    expect(
      within(queue).queryByRole("button", {
        name: "Retry https://x.com/ada/status/1234567890",
      }),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Library multi-select wiring (batch picker, per-row override, per-item library_ids)
// ---------------------------------------------------------------------------

describe("AddPanel — library multi-select wiring", () => {
  type FromUrlCall = { url: string; library_ids: string[] };

  // Stub writable-destinations + capture each from-url body's library_ids.
  function stubWithLibraries(calls: FromUrlCall[]) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/libraries/writable-destinations") {
        return jsonResponse({
          data: [
            { id: "lib-research", name: "Research", color: "#0ea5e9", created_at: "", updated_at: "" },
            { id: "lib-books", name: "Books", color: "#22c55e", created_at: "", updated_at: "" },
          ],
          page: { next_cursor: null },
        });
      }
      if (url.pathname === "/api/media/from-url" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { url: string; library_ids: string[] };
        calls.push({ url: body.url, library_ids: body.library_ids });
        return jsonResponse({
          data: {
            media_id: `media-${calls.length}`,
            source_attempt_id: `attempt-${calls.length}`,
            source_type: "generic_web_url",
            source_attempt_status: "queued",
            idempotency_outcome: "created",
            processing_status: "pending",
            ingest_enqueued: true,
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });
  }

  // The batch "Also add to" picker and per-row "Libraries" picker are both
  // LibraryDestinationPickers; their combobox accessible name is their label.
  it("applies the batch picker to subsequently enqueued items but not to previously enqueued ones", async () => {
    const calls: FromUrlCall[] = [];
    stubWithLibraries(calls);
    renderAddPanel();

    // 1. Enqueue first item under the default (empty) batch selection.
    submitUrls("https://example.com/first.pdf");
    await waitFor(() => {
      expect(calls.find((c) => c.url === "https://example.com/first.pdf")).toBeDefined();
    });

    // 2. Add "Research" to the batch picker.
    const input = screen.getByRole("combobox", { name: "Also add to" });
    fireEvent.focus(input);
    fireEvent.click(await screen.findByRole("option", { name: "Research" }));

    // 3. Enqueue another item; it should pick up "Research" only.
    submitUrls("https://example.com/second.pdf");
    await waitFor(() => {
      expect(calls.find((c) => c.url === "https://example.com/second.pdf")).toBeDefined();
    });

    expect(
      calls.find((c) => c.url === "https://example.com/first.pdf")?.library_ids,
    ).toEqual([]);
    expect(
      calls.find((c) => c.url === "https://example.com/second.pdf")?.library_ids,
    ).toEqual(["lib-research"]);
  });

  it("lets a per-row override change library_ids independently of the batch", async () => {
    const calls: FromUrlCall[] = [];
    const heldResponses: Array<() => void> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/libraries/writable-destinations") {
        return jsonResponse({
          data: [
            { id: "lib-research", name: "Research", color: "#0ea5e9", created_at: "", updated_at: "" },
            { id: "lib-books", name: "Books", color: "#22c55e", created_at: "", updated_at: "" },
          ],
          page: { next_cursor: null },
        });
      }
      if (url.pathname === "/api/media/from-url" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { url: string; library_ids: string[] };
        calls.push({ url: body.url, library_ids: body.library_ids });
        // Hold the response so the third item stays queued while we override its libraries.
        return new Promise<Response>((resolve) => {
          heldResponses.push(() =>
            resolve(
              jsonResponse({
                data: {
                  media_id: `media-${calls.length}`,
                  source_attempt_id: `attempt-${calls.length}`,
                  source_type: "generic_web_url",
                  source_attempt_status: "queued",
                  idempotency_outcome: "created",
                  processing_status: "pending",
                  ingest_enqueued: true,
                },
              }),
            ),
          );
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });
    renderAddPanel();

    // Three URLs; MAX_ACTIVE_UPLOADS=2 keeps the third queued (showing its per-row picker).
    submitUrls(
      "https://example.com/first.pdf\nhttps://example.com/second.pdf\nhttps://example.com/third.pdf",
    );

    const queue = await screen.findByLabelText("Ingestion queue");
    await waitFor(() => {
      expect(calls.length).toBe(2);
    });
    expect(within(queue).getByText("https://example.com/third.pdf")).toBeInTheDocument();

    // Override the queued third row to "Books" (its per-row picker is labelled "Libraries").
    const rowPicker = within(queue).getByRole("combobox", { name: "Libraries" });
    fireEvent.focus(rowPicker);
    const rowListbox = await within(queue).findByRole("listbox", { name: "Libraries" });
    fireEvent.click(await within(rowListbox).findByRole("option", { name: "Books" }));
    await waitFor(() => {
      expect(within(queue).getByRole("button", { name: "Remove Books" })).toBeInTheDocument();
    });

    // Release the in-flight responses so the third item is picked up next.
    for (const release of heldResponses.splice(0)) {
      release();
    }
    await waitFor(() => {
      expect(calls.length).toBe(3);
    });
    for (const release of heldResponses.splice(0)) {
      release();
    }

    expect(
      calls.find((c) => c.url === "https://example.com/third.pdf")?.library_ids,
    ).toEqual(["lib-books"]);
    expect(
      calls.find((c) => c.url === "https://example.com/first.pdf")?.library_ids,
    ).toEqual([]);
    expect(
      calls.find((c) => c.url === "https://example.com/second.pdf")?.library_ids,
    ).toEqual([]);
  });

  it("submits each queue item with its own library_ids as the batch changes between adds", async () => {
    const calls: FromUrlCall[] = [];
    stubWithLibraries(calls);
    renderAddPanel();

    // Batch = Research, then add alpha.
    const input = screen.getByRole("combobox", { name: "Also add to" });
    fireEvent.focus(input);
    fireEvent.click(await screen.findByRole("option", { name: "Research" }));
    submitUrls("https://example.com/alpha.pdf");
    await waitFor(() => {
      expect(calls.find((c) => c.url === "https://example.com/alpha.pdf")).toBeDefined();
    });

    // Swap batch to Books (deselect Research, select Books), then add beta.
    fireEvent.focus(input);
    fireEvent.click(await screen.findByRole("option", { name: "Research" }));
    fireEvent.click(await screen.findByRole("option", { name: "Books" }));
    submitUrls("https://example.com/beta.pdf");
    await waitFor(() => {
      expect(calls.find((c) => c.url === "https://example.com/beta.pdf")).toBeDefined();
    });

    expect(
      calls.find((c) => c.url === "https://example.com/alpha.pdf")?.library_ids,
    ).toEqual(["lib-research"]);
    expect(
      calls.find((c) => c.url === "https://example.com/beta.pdf")?.library_ids,
    ).toEqual(["lib-books"]);
  });
});

// ---------------------------------------------------------------------------
// Concurrency gating (MAX_ACTIVE_UPLOADS)
// ---------------------------------------------------------------------------

describe("AddPanel — concurrency gating", () => {
  it("keeps the (N+1)th item Queued while N held uploads are in flight (MAX_ACTIVE_UPLOADS)", async () => {
    const calls: string[] = [];
    const heldResponses: Array<() => void> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/libraries/writable-destinations") {
        return jsonResponse({ data: [], page: { next_cursor: null } });
      }
      if (url.pathname === "/api/media/from-url" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { url: string };
        calls.push(body.url);
        return new Promise<Response>((resolve) => {
          heldResponses.push(() =>
            resolve(
              jsonResponse({
                data: {
                  media_id: `media-${calls.length}`,
                  source_attempt_id: `attempt-${calls.length}`,
                  source_type: "generic_web_url",
                  source_attempt_status: "queued",
                  idempotency_outcome: "created",
                  processing_status: "pending",
                  ingest_enqueued: true,
                },
              }),
            ),
          );
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });
    renderAddPanel();

    // MAX_ACTIVE_UPLOADS is 2; the third URL must stay Queued until a slot frees.
    submitUrls(
      "https://example.com/first.pdf\nhttps://example.com/second.pdf\nhttps://example.com/third.pdf",
    );

    const queue = await screen.findByLabelText("Ingestion queue");
    // Only two requests fire while both slots are held.
    await waitFor(() => {
      expect(calls.length).toBe(2);
    });
    // Exactly one row is still "Queued" (the third); the first two are "Adding...".
    // A queued row exposes a Remove affordance keyed to its URL, so target that.
    expect(within(queue).getAllByText("Queued")).toHaveLength(1);
    expect(within(queue).getAllByText("Adding...")).toHaveLength(2);
    expect(
      within(queue).getByRole("button", { name: "Remove https://example.com/third.pdf" }),
    ).toBeInTheDocument();
    // The first two URLs are the only Remove-less rows; the third never fired yet.
    expect(
      within(queue).queryByRole("button", { name: "Remove https://example.com/first.pdf" }),
    ).not.toBeInTheDocument();
    expect(calls).not.toContain("https://example.com/third.pdf");

    // Free the slots; the third item is then picked up.
    for (const release of heldResponses.splice(0)) {
      release();
    }
    await waitFor(() => {
      expect(calls).toContain("https://example.com/third.pdf");
    });
    for (const release of heldResponses.splice(0)) {
      release();
    }
  });
});

// ---------------------------------------------------------------------------
// OPML mode
// ---------------------------------------------------------------------------

describe("AddPanel — OPML mode", () => {
  it("renders OpmlImportPanel for the opml seed and shows the import summary", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/libraries/writable-destinations") {
        return jsonResponse({ data: [], page: { next_cursor: null } });
      }
      if (url.pathname === "/api/podcasts/import/opml" && init?.method === "POST") {
        return jsonResponse({
          data: {
            total: 2,
            imported: 1,
            skipped_already_subscribed: 1,
            skipped_invalid: 0,
            errors: [],
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });
    renderAddPanel({ mode: "opml" });

    expect(screen.getByText("Import podcast subscriptions from an OPML file.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Import OPML file"), {
      target: { files: [makeFile("podcasts.opml", "application/xml")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import OPML" }));

    expect(await screen.findByText("Import summary")).toBeInTheDocument();
    expect(screen.getByText("Imported: 1")).toBeInTheDocument();
    expect(screen.getByText("Already followed: 1")).toBeInTheDocument();
  });

  it("switches to the OPML tab from the content seed", async () => {
    stubDefaultApi();
    renderAddPanel({ mode: "url" });

    // Content view shows the URL field; OPML view shows the OPML import control.
    expect(screen.getByLabelText("URLs")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "OPML" }));

    expect(await screen.findByLabelText("Import OPML file")).toBeInTheDocument();
    expect(screen.queryByLabelText("URLs")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Back affordance
// ---------------------------------------------------------------------------

describe("AddPanel — navigation", () => {
  it("invokes onBack when the Back button is pressed", () => {
    stubDefaultApi();
    const { onBack } = renderAddPanel();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
