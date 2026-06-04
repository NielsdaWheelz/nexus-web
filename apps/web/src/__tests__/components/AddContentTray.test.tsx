import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AddContentTray from "@/components/AddContentTray";
import { OPEN_ADD_CONTENT_EVENT } from "@/components/addContentEvents";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function openTray(mode: "content" | "quick-note" | "opml" = "content") {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(OPEN_ADD_CONTENT_EVENT, {
        detail: { mode },
      })
    );
  });
}

function makeFile(name: string, type: string) {
  return new File(["file contents"], name, { type });
}

function dispatchPaste(target: EventTarget, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & {
    clipboardData?: {
      types: string[];
      getData: (type: string) => string;
    };
  };
  event.clipboardData = {
    types: ["text/plain", "text/uri-list"],
    getData: (type: string) => (type === "text/plain" || type === "text/uri-list" ? text : ""),
  };
  target.dispatchEvent(event);
}

describe("AddContentTray", () => {
  beforeEach(() => {
    document.body.style.overflow = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/libraries/writable-destinations") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/media/from-url" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return jsonResponse({
          data: {
            media_id: body.url.includes("one.pdf") ? "media-one" : "media-two",
            idempotency_outcome: "created",
          },
        });
      }
      if (url.pathname === "/api/notes/pages" && init?.method === "POST") {
        return jsonResponse({
          data: {
            id: "page-new",
            title: "Untitled",
            description: null,
            revision: 1,
            blocks: [],
          },
        });
      }
      if (url.pathname.endsWith("/quick-capture") && init?.method === "POST") {
        return jsonResponse({
          data: {
            id: "block-new",
            page_id: "page-today",
            parent_block_id: null,
            order_key: "a",
            block_kind: "bullet",
            body_pm_json: { type: "paragraph" },
            body_markdown: "captured text",
            body_text: "captured text",
            collapsed: false,
            revision: 1,
            children: [],
          },
        });
      }
      if (url.pathname === "/api/podcasts/import/opml" && (init?.method ?? "GET") === "POST") {
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
  });

  afterEach(() => {
    document.body.style.overflow = "";
    vi.restoreAllMocks();
  });

  it("opens on OPEN_ADD_CONTENT_EVENT and closes on Close or Escape", async () => {
    render(<AddContentTray />);

    openTray();

    expect(await screen.findByRole("dialog", { name: "Add content" })).toBeInTheDocument();
    expect(screen.getByText("Upload files or paste links.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Add content" })).not.toBeInTheDocument();
    });

    openTray("opml");
    expect(await screen.findByRole("dialog", { name: "Add content" })).toBeInTheDocument();
    expect(
      screen.getByText("Import podcast subscriptions from an OPML file.")
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Add content" })).not.toBeInTheDocument();
    });
  });

  it("pastes multiple URLs outside inputs and shows both completed adds", async () => {
    render(
      <>
        <AddContentTray />
        <input aria-label="outside input" />
      </>
    );

    dispatchPaste(window, "https://example.com/one.pdf\nhttps://example.com/two.epub");

    await waitFor(() => {
      expect(screen.getAllByLabelText("Success")).toHaveLength(2);
    });
    expect(screen.getByText("https://example.com/one.pdf")).toBeInTheDocument();
    expect(screen.getByText("https://example.com/two.epub")).toBeInTheDocument();
  });

  it("renders the OPML import summary", async () => {
    render(<AddContentTray />);

    openTray("opml");

    expect(await screen.findByRole("dialog", { name: "Add content" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Import OPML file"), {
      target: { files: [makeFile("podcasts.opml", "application/xml")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import OPML" }));

    expect(await screen.findByText("Import summary")).toBeInTheDocument();
    expect(screen.getByText("Imported: 1")).toBeInTheDocument();
    expect(screen.getByText("Already followed: 1")).toBeInTheDocument();
  });

  it("creates pages and quick-captures to today from the tray", async () => {
    render(<AddContentTray />);

    openTray();

    expect(await screen.findByRole("dialog", { name: "Add content" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New page" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Add content" })).not.toBeInTheDocument();
    });

    openTray("quick-note");
    fireEvent.change(await screen.findByLabelText("Quick note to today"), {
      target: { value: "captured text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));

    expect(await screen.findByText("Added to today.")).toBeInTheDocument();
  });

  describe("library multi-select wiring", () => {
    type FromUrlCall = { url: string; library_ids: string[] };

    function setupFetchWithLibraries(calls: FromUrlCall[]) {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/libraries/writable-destinations") {
          return jsonResponse({
            data: [
              { id: "lib-research", name: "Research", color: "#0ea5e9" },
              { id: "lib-books", name: "Books", color: "#22c55e" },
            ],
            page: { next_cursor: null },
          });
        }
        if (url.pathname === "/api/media/from-url" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as {
            url: string;
            library_ids: string[];
          };
          calls.push({ url: body.url, library_ids: body.library_ids });
          return jsonResponse({
            data: {
              media_id: `media-${calls.length}`,
              idempotency_outcome: "created",
            },
          });
        }
        throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
      });
    }

    async function selectBatchLibrary(name: string) {
      const dialog = await screen.findByRole("dialog", { name: "Add content" });
      const input = within(dialog).getByRole("combobox", { name: "Also add to" });
      fireEvent.focus(input);
      fireEvent.click(await screen.findByRole("option", { name }));
      fireEvent.keyDown(input, { key: "Escape" });
    }

    it("applies the batch picker to subsequently enqueued items but not to previously enqueued ones", async () => {
      const calls: FromUrlCall[] = [];
      setupFetchWithLibraries(calls);

      render(<AddContentTray />);

      openTray();
      await screen.findByRole("dialog", { name: "Add content" });

      // 1. Enqueue first item under the default empty batch selection.
      dispatchPaste(window, "https://example.com/first.pdf");
      await waitFor(() => {
        expect(
          calls.find((call) => call.url === "https://example.com/first.pdf")
        ).toBeDefined();
      });

      // 2. Change batch picker to add "Research".
      await selectBatchLibrary("Research");

      // 3. Enqueue another item; this one should pick up "Research" only.
      dispatchPaste(window, "https://example.com/second.pdf");
      await waitFor(() => {
        expect(
          calls.find((call) => call.url === "https://example.com/second.pdf")
        ).toBeDefined();
      });

      const firstCall = calls.find(
        (call) => call.url === "https://example.com/first.pdf"
      );
      const secondCall = calls.find(
        (call) => call.url === "https://example.com/second.pdf"
      );

      expect(firstCall?.library_ids).toEqual([]);
      expect(secondCall?.library_ids).toEqual(["lib-research"]);
    });

    it("lets a per-row override change library_ids independently of the batch", async () => {
      const calls: FromUrlCall[] = [];
      const heldResponses: Array<() => void> = [];
      vi.restoreAllMocks();
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/libraries/writable-destinations") {
          return jsonResponse({
            data: [
              { id: "lib-research", name: "Research", color: "#0ea5e9" },
              { id: "lib-books", name: "Books", color: "#22c55e" },
            ],
            page: { next_cursor: null },
          });
        }
        if (url.pathname === "/api/media/from-url" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as {
            url: string;
            library_ids: string[];
          };
          calls.push({ url: body.url, library_ids: body.library_ids });
          // Hold the response so we can interact with the queue while items are in flight.
          return new Promise<Response>((resolve) => {
            heldResponses.push(() =>
              resolve(
                jsonResponse({
                  data: {
                    media_id: `media-${calls.length}`,
                    idempotency_outcome: "created",
                  },
                })
              )
            );
          });
        }
        throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
      });

      render(<AddContentTray />);

      openTray();
      await screen.findByRole("dialog", { name: "Add content" });

      // Enqueue three URLs; MAX_ACTIVE_UPLOADS=2 keeps the third one queued
      // (and therefore showing its per-row library picker chip).
      dispatchPaste(
        window,
        "https://example.com/first.pdf\nhttps://example.com/second.pdf\nhttps://example.com/third.pdf"
      );

      // The third row stays queued while the held responses are pending.
      await waitFor(() => {
        expect(
          screen.getByText("https://example.com/third.pdf")
        ).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(calls.length).toBe(2);
      });

      const removeButton = screen.getByRole("button", {
        name: "Remove https://example.com/third.pdf",
      });
      const queue = screen.getByLabelText("Ingestion queue");
      expect(removeButton).toBeInTheDocument();
      const rowPicker = within(queue).getByRole("combobox", { name: "Libraries" });
      fireEvent.focus(rowPicker);
      fireEvent.click(await screen.findByRole("option", { name: "Books" }));

      // The row's chip should now reflect the override.
      await waitFor(() => {
        expect(
          within(queue).getByRole("button", { name: "Remove Books" })
        ).toBeInTheDocument();
      });

      // Release the held responses; the third item will be picked up next.
      for (const release of heldResponses) {
        release();
      }
      heldResponses.length = 0;

      await waitFor(() => {
        expect(calls.length).toBe(3);
      });

      const overriddenCall = calls.find(
        (call) => call.url === "https://example.com/third.pdf"
      );
      const firstCall = calls.find(
        (call) => call.url === "https://example.com/first.pdf"
      );
      const secondCall = calls.find(
        (call) => call.url === "https://example.com/second.pdf"
      );

      expect(overriddenCall?.library_ids).toEqual(["lib-books"]);
      expect(firstCall?.library_ids).toEqual([]);
      expect(secondCall?.library_ids).toEqual([]);

      // Release any remaining queued response.
      for (const release of heldResponses) {
        release();
      }
    });

    it("submits each queue item with its own library_ids", async () => {
      const calls: FromUrlCall[] = [];
      setupFetchWithLibraries(calls);

      render(<AddContentTray />);

      openTray();
      await screen.findByRole("dialog", { name: "Add content" });

      await selectBatchLibrary("Research");

      dispatchPaste(window, "https://example.com/alpha.pdf");
      await waitFor(() => {
        expect(
          calls.find((c) => c.url === "https://example.com/alpha.pdf")
        ).toBeDefined();
      });

      const dialog = await screen.findByRole("dialog", { name: "Add content" });
      const batchInput = within(dialog).getByRole("combobox", { name: "Also add to" });
      fireEvent.focus(batchInput);
      fireEvent.click(await screen.findByRole("option", { name: "Research" }));
      fireEvent.click(await screen.findByRole("option", { name: "Books" }));

      dispatchPaste(window, "https://example.com/beta.pdf");
      await waitFor(() => {
        expect(
          calls.find((c) => c.url === "https://example.com/beta.pdf")
        ).toBeDefined();
      });

      const alpha = calls.find(
        (c) => c.url === "https://example.com/alpha.pdf"
      );
      const beta = calls.find((c) => c.url === "https://example.com/beta.pdf");

      expect(alpha?.library_ids).toEqual(["lib-research"]);
      expect(beta?.library_ids).toEqual(["lib-books"]);
    });
  });
});
