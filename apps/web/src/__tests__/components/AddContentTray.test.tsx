import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      if (url.pathname === "/api/libraries") {
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
});
