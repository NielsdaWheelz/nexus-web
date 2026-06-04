import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ShareCapture from "./ShareCapture";

function renderShareCapture(text: string, isShell = false) {
  return render(<ShareCapture text={text} isShell={isShell} />);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pathFor(input: RequestInfo | URL): string {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw, "http://localhost");
  return `${url.pathname}${url.search}`;
}

function parseJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("Expected JSON request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function noteBlock() {
  return {
    id: "block-1",
    page_id: "page-1",
    parent_block_id: null,
    order_key: "a0",
    block_kind: "bullet",
    body_pm_json: {},
    body_markdown: "plain note",
    body_text: "plain note",
    collapsed: false,
    revision: 1,
    children: [],
  };
}

function installShareFetch({
  fromUrl,
  createLibrary,
}: {
  fromUrl?: (body: Record<string, unknown>) => Response | Promise<Response>;
  createLibrary?: (body: Record<string, unknown>) => Response | Promise<Response>;
} = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathFor(input);
    const url = new URL(path, "http://localhost");
    const method = init?.method ?? "GET";

    if (url.pathname === "/api/libraries/writable-destinations") {
      const query = (url.searchParams.get("q") ?? "").trim();
      return jsonResponse({
        data: query
          ? []
          : [
              {
                id: "lib-research",
                name: "Research",
                color: "#0ea5e9",
                created_at: "",
                updated_at: "",
              },
            ],
        page: { next_cursor: null },
      });
    }

    if (url.pathname === "/api/libraries" && method === "POST") {
      const body = parseJsonBody(init);
      if (createLibrary) return createLibrary(body);
      return jsonResponse(
        {
          data: {
            id: "lib-created",
            name: String(body.name),
            color: null,
            created_at: "",
            updated_at: "",
          },
        },
        201,
      );
    }

    if (url.pathname === "/api/media/from-url" && method === "POST") {
      const body = parseJsonBody(init);
      if (fromUrl) return fromUrl(body);
      return jsonResponse({
        data: {
          media_id: "media-1",
          idempotency_outcome: "created",
        },
      });
    }

    if (
      url.pathname.startsWith("/api/notes/daily/") &&
      url.pathname.endsWith("/quick-capture") &&
      method === "POST"
    ) {
      return jsonResponse({ data: noteBlock() }, 201);
    }

    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fromUrlBodies(fetchMock: ReturnType<typeof installShareFetch>) {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        new URL(pathFor(input), "http://localhost").pathname === "/api/media/from-url" &&
        init?.method === "POST",
    )
    .map(([, init]) => parseJsonBody(init));
}

function quickCaptureBodies(fetchMock: ReturnType<typeof installShareFetch>) {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        new URL(pathFor(input), "http://localhost").pathname.endsWith("/quick-capture") &&
        init?.method === "POST",
    )
    .map(([, init]) => parseJsonBody(init));
}

describe("ShareCapture", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not ingest URL shares on mount", async () => {
    const fetchMock = installShareFetch();

    renderShareCapture("https://example.com/article");

    expect(screen.getByRole("heading", { name: "Save to Nexus" })).toBeInTheDocument();
    expect(fromUrlBodies(fetchMock)).toEqual([]);
  });

  it("cancels before Save without ingesting", async () => {
    const fetchMock = installShareFetch();

    renderShareCapture("https://example.com/article");

    expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute(
      "href",
      "/libraries",
    );
    expect(fromUrlBodies(fetchMock)).toEqual([]);
  });

  it("saves selected library ids in the initial from-url call", async () => {
    const fetchMock = installShareFetch();

    renderShareCapture("https://example.com/article");

    fireEvent.focus(screen.getByRole("combobox", { name: "Library destinations" }));
    const option = await screen.findByRole("option", { name: "Research" });
    fireEvent.click(option);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Saved to Nexus");
    expect(fromUrlBodies(fetchMock)).toContainEqual({
      url: "https://example.com/article",
      library_ids: ["lib-research"],
    });
  });

  it("creates a destination and saves with the created id", async () => {
    const fetchMock = installShareFetch();

    renderShareCapture("https://example.com/article");

    const input = screen.getByRole("combobox", { name: "Library destinations" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Created" } });
    fireEvent.click(await screen.findByRole("option", { name: "Create “Created”" }));
    await screen.findByRole("button", { name: "Remove Created" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(fromUrlBodies(fetchMock)).toContainEqual({
        url: "https://example.com/article",
        library_ids: ["lib-created"],
      });
    });
  });

  it("does not save while destination creation is pending", async () => {
    const fetchMock = installShareFetch({
      createLibrary: () => new Promise<Response>(() => {}),
    });

    renderShareCapture("https://example.com/article");

    const input = screen.getByRole("combobox", { name: "Library destinations" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Created" } });
    fireEvent.click(await screen.findByRole("option", { name: "Create “Created”" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(fromUrlBodies(fetchMock)).toEqual([]);
  });

  it("uses the same selected ids for every URL", async () => {
    const fetchMock = installShareFetch({
      fromUrl: (body) =>
        jsonResponse({
          data: {
            media_id: String(body.url).includes("one") ? "media-one" : "media-two",
            idempotency_outcome: "created",
          },
        }),
    });

    renderShareCapture("https://example.com/one https://example.com/two");

    fireEvent.focus(screen.getByRole("combobox", { name: "Library destinations" }));
    fireEvent.click(await screen.findByRole("option", { name: "Research" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Saved to Nexus");
    expect(fromUrlBodies(fetchMock)).toContainEqual({
      url: "https://example.com/one",
      library_ids: ["lib-research"],
    });
    expect(fromUrlBodies(fetchMock)).toContainEqual({
      url: "https://example.com/two",
      library_ids: ["lib-research"],
    });
  });

  it("retries failed URLs with the same selected ids", async () => {
    let attempt = 0;
    const fetchMock = installShareFetch({
      fromUrl: () => {
        attempt += 1;
        if (attempt === 1) {
          return jsonResponse(
            { error: { code: "E_TEST", message: "failed" } },
            500,
          );
        }
        return jsonResponse({
          data: {
            media_id: "media-1",
            idempotency_outcome: "created",
          },
        });
      },
    });

    renderShareCapture("https://example.com/article");

    fireEvent.focus(screen.getByRole("combobox", { name: "Library destinations" }));
    fireEvent.click(await screen.findByRole("option", { name: "Research" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByRole("heading", { name: "Couldn’t save" });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(fromUrlBodies(fetchMock)).toHaveLength(2);
    });
    expect(fromUrlBodies(fetchMock).at(-1)).toEqual({
      url: "https://example.com/article",
      library_ids: ["lib-research"],
    });
  });

  it("quick-captures non-URL text without showing a destination picker", async () => {
    const fetchMock = installShareFetch();

    renderShareCapture("plain note");

    await screen.findByText("Added to today");
    expect(quickCaptureBodies(fetchMock)).toContainEqual({ body_markdown: "plain note" });
    expect(screen.queryByRole("combobox", { name: "Library destinations" })).toBeNull();
  });

  it("does not render the old post-save add-libraries modal", async () => {
    installShareFetch();

    renderShareCapture("https://example.com/article");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Saved to Nexus");
    expect(screen.queryByRole("dialog", { name: "Add to libraries?" })).toBeNull();
  });

  it("uses Android shell callbacks for open and completion links", async () => {
    installShareFetch();

    renderShareCapture("https://example.com/article", true);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Saved to Nexus");
    expect(screen.getByRole("link", { name: "Open in Nexus" })).toHaveAttribute(
      "href",
      "nexus-share://open?path=%2Fmedia%2Fmedia-1",
    );
    expect(screen.getByRole("link", { name: "Done" })).toHaveAttribute(
      "href",
      "nexus-share://done",
    );
  });
});
